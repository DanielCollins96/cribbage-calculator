const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const suits = ["S", "H", "D", "C"];
const suitSymbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
const deck = suits.flatMap((suit) => ranks.map((rank, index) => ({
  id: `${rank}${suit}`,
  rank,
  suit,
  order: index + 1,
  value: Math.min(index + 1, 10)
})));
const cardById = new Map(deck.map((card) => [card.id, card]));

let selected = [];
let resultRenderToken = 0;
const scoreRankCounts = new Int8Array(14);

const deckEl = document.querySelector("#deck");
const dealtCardsEl = document.querySelector("#dealtCards");
const starterCardEl = document.querySelector("#starterCard");
const playersSelect = document.querySelector("#playersSelect");
const starterSelect = document.querySelector("#starterSelect");
const cribInputs = [...document.querySelectorAll("input[name='cribOwner']")];
const resultsBody = document.querySelector("#resultsBody");
const summaryEl = document.querySelector("#summary");
const resultMetaEl = document.querySelector("#resultMeta");
const dealHintEl = document.querySelector("#dealHint");
const randomDealButton = document.querySelector("#randomDealButton");
const randomCutButton = document.querySelector("#randomCutButton");
const scanHandButton = document.querySelector("#scanHandButton");
const scanHandInput = document.querySelector("#scanHandInput");
const scanStatusEl = document.querySelector("#scanStatus");

let yoloModelPromise = null;

const yoloInputSize = 640;
const yoloConfidenceThreshold = 0.35;
const yoloIouThreshold = 0.45;
const yoloModelPath = "models/playing-cards.onnx";
const yoloLabels = [
  "10C", "10D", "10H", "10S", "2C", "2D", "2H", "2S",
  "3C", "3D", "3H", "3S", "4C", "4D", "4H", "4S",
  "5C", "5D", "5H", "5S", "6C", "6D", "6H", "6S",
  "7C", "7D", "7H", "7S", "8C", "8D", "8H", "8S",
  "9C", "9D", "9H", "9S", "AC", "AD", "AH", "AS",
  "JC", "JD", "JH", "JS", "KC", "KD", "KH", "KS",
  "QC", "QD", "QH", "QS"
];

function dealtCount() {
  return playersSelect.value === "2" ? 6 : 5;
}

function discardCount() {
  return dealtCount() - 4;
}

function cribOwner() {
  return document.querySelector("input[name='cribOwner']:checked").value;
}

function cardLabel(card) {
  return `${card.rank}${suitSymbols[card.suit]}`;
}

function isRed(card) {
  return card.suit === "H" || card.suit === "D";
}

function getCard(id) {
  return cardById.get(id);
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function combinations(items, size) {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const out = [];
  items.forEach((item, index) => {
    for (const tail of combinations(items.slice(index + 1), size - 1)) {
      out.push([item, ...tail]);
    }
  });
  return out;
}

function scoreFiveCards(hand, starter, isCrib = false) {
  let score = 0;
  scoreRankCounts.fill(0);

  const cardCount = hand.length + 1;
  for (let mask = 1; mask < 1 << cardCount; mask += 1) {
    let total = 0;
    let count = 0;
    for (let index = 0; index < cardCount; index += 1) {
      if (mask & (1 << index)) {
        total += index < hand.length ? hand[index].value : starter.value;
        count += 1;
      }
    }
    if (count >= 2 && total === 15) score += 2;
  }

  for (let index = 0; index < hand.length; index += 1) {
    scoreRankCounts[hand[index].order] += 1;
  }
  scoreRankCounts[starter.order] += 1;

  for (let index = 1; index < scoreRankCounts.length; index += 1) {
    const count = scoreRankCounts[index];
    if (count > 1) score += (count * (count - 1)) / 2 * 2;
  }

  score += runScore(scoreRankCounts);

  const flushSuit = hand[0].suit;
  let handFlush = true;
  for (let index = 1; index < hand.length; index += 1) {
    if (hand[index].suit !== flushSuit) {
      handFlush = false;
      break;
    }
  }
  if (handFlush) {
    if (starter.suit === flushSuit) score += 5;
    else if (!isCrib) score += 4;
  }

  for (let index = 0; index < hand.length; index += 1) {
    if (hand[index].rank === "J" && hand[index].suit === starter.suit) {
      score += 1;
      break;
    }
  }

  return score;
}

function runScore(counts) {
  let best = 0;

  for (let start = 1; start <= 13; start += 1) {
    if (counts[start] === 0) continue;
    let end = start;
    let multiplier = 1;
    while (end <= 13 && counts[end] > 0) {
      multiplier *= counts[end];
      end += 1;
    }
    const length = end - start;
    if (length >= 3) best = Math.max(best, length * multiplier);
  }

  return best;
}

function averageHand(keep, remainingDeck, fixedStarter) {
  if (fixedStarter) return scoreFiveCards(keep, fixedStarter);

  let total = 0;
  for (let index = 0; index < remainingDeck.length; index += 1) {
    total += scoreFiveCards(keep, remainingDeck[index]);
  }
  return total / remainingDeck.length;
}

async function averageCribAsync(discard, remainingDeck, fixedStarter, shouldContinue) {
  const fillCount = 4 - discard.length;
  let total = 0;
  let iterations = 0;
  const cribHand = Array(4);
  for (let index = 0; index < discard.length; index += 1) {
    cribHand[index] = discard[index];
  }

  async function maybeYield() {
    if (iterations % 5000 !== 0) return true;
    await yieldToBrowser();
    return shouldContinue();
  }

  async function scoreStarter(starter) {
    if (fillCount === 2) {
      for (let first = 0; first < remainingDeck.length - 1; first += 1) {
        if (!shouldContinue()) return false;
        if (remainingDeck[first].id === starter.id) continue;
        cribHand[discard.length] = remainingDeck[first];
        for (let second = first + 1; second < remainingDeck.length; second += 1) {
          if (remainingDeck[second].id === starter.id) continue;
          cribHand[discard.length + 1] = remainingDeck[second];
          total += scoreFiveCards(cribHand, starter, true);
          iterations += 1;
          if (!(await maybeYield())) return false;
        }
      }
      return true;
    }

    for (let first = 0; first < remainingDeck.length - 2; first += 1) {
      if (!shouldContinue()) return false;
      if (remainingDeck[first].id === starter.id) continue;
      cribHand[discard.length] = remainingDeck[first];
      for (let second = first + 1; second < remainingDeck.length - 1; second += 1) {
        if (remainingDeck[second].id === starter.id) continue;
        cribHand[discard.length + 1] = remainingDeck[second];
        for (let third = second + 1; third < remainingDeck.length; third += 1) {
          if (remainingDeck[third].id === starter.id) continue;
          cribHand[discard.length + 2] = remainingDeck[third];
          total += scoreFiveCards(cribHand, starter, true);
          iterations += 1;
          if (!(await maybeYield())) return false;
        }
      }
    }
    return true;
  }

  if (fixedStarter) {
    if (!(await scoreStarter(fixedStarter))) return null;
  } else {
    for (let index = 0; index < remainingDeck.length; index += 1) {
      if (!shouldContinue()) return null;
      if (!(await scoreStarter(remainingDeck[index]))) return null;
    }
  }

  return total / iterations;
}

function renderDeck() {
  if (!deckEl) return;

  const fragment = document.createDocumentFragment();
  const selectedIds = new Set(selected.filter(Boolean));
  deck.forEach((card) => {
    const button = document.createElement("button");
    button.type = "button";
    const isSelected = selectedIds.has(card.id);
    button.className = `cardButton ${isRed(card) ? "red" : ""} ${isSelected ? "selected" : ""}`;
    button.textContent = cardLabel(card);
    button.title = isSelected ? "Remove card" : "Add card";
    button.addEventListener("click", () => toggleCard(card.id));
    fragment.append(button);
  });
  deckEl.replaceChildren(fragment);
}

function renderStarterOptions() {
  const current = starterSelect.value;
  const selectedIds = new Set(selected.filter(Boolean));
  starterSelect.replaceChildren();
  const defaultOpt = new Option("Auto-average all cuts", "");
  starterSelect.add(defaultOpt);

  deck.filter((card) => !selectedIds.has(card.id)).forEach((card) => {
    starterSelect.add(new Option(cardLabel(card), card.id));
  });

  const stillValid = deck.some((card) => card.id === current && !selectedIds.has(current));
  starterSelect.value = stillValid ? current : "";
}

function renderDealtSelectors() {
  const need = dealtCount();
  const selectedIds = new Set(selected.filter(Boolean));
  dealtCardsEl.replaceChildren();
  const fragment = document.createDocumentFragment();
  dealtCardsEl.classList.toggle("empty", false);

  for (let index = 0; index < need; index += 1) {
    const current = selected[index] || "";
    const currentCard = current ? getCard(current) : null;
    const select = document.createElement("select");
    select.className = `cardSelect ${currentCard && isRed(currentCard) ? "red" : ""}`;
    select.ariaLabel = `Dealt card ${index + 1}`;
    select.add(new Option(`Card ${index + 1}`, ""));

    deck
      .filter((card) => card.id === current || !selectedIds.has(card.id))
      .forEach((card) => {
        const option = new Option(cardLabel(card), card.id);
        if (isRed(card)) option.className = "red";
        select.add(option);
      });

    select.value = current;
    select.addEventListener("change", () => {
      selected[index] = select.value;
      starterSelect.value = "";
      update();
    });
    fragment.append(select);
  }
  dealtCardsEl.appendChild(fragment);
}

function renderCardRow(el, cards, fallback) {
  el.replaceChildren();
  el.classList.toggle("empty", cards.length === 0);
  if (!cards.length) {
    el.textContent = fallback;
    return;
  }
  cards.forEach((card) => {
    const pill = document.createElement("span");
    pill.className = `pill ${isRed(card) ? "red" : ""}`;
    pill.textContent = cardLabel(card);
    el.append(pill);
  });
}

function toggleCard(id) {
  if (selected.includes(id)) {
    selected = selected.filter((cardId) => cardId !== id);
  } else if (selected.length < dealtCount()) {
    selected = [...selected, id];
  }
  update();
}

function randomDeal() {
  const need = dealtCount();
  const shuffled = [...deck];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  selected = shuffled.slice(0, need).map((card) => card.id);
  starterSelect.value = "";
  update();
}

function randomCut() {
  const selectedIds = new Set(selected.filter(Boolean));
  const cutDeck = deck.filter((card) => !selectedIds.has(card.id));
  if (selectedIds.size !== dealtCount() || cutDeck.length === 0) return;

  starterSelect.value = cutDeck[Math.floor(Math.random() * cutDeck.length)].id;
  update();
}

function setScanStatus(message, tone = "") {
  scanStatusEl.textContent = message;
  scanStatusEl.dataset.tone = tone;
}

function progressText(label, percent) {
  const width = 20;
  const filled = Math.round((percent / 100) * width);
  return `${label}: ${percent}% [${"=".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      if (window.ort) resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("The ONNX runtime could not be loaded."));
    document.head.append(script);
  });
}

async function downloadModelWithProgress(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The card detector model could not be loaded (${response.status}).`);
  }

  const total = Number(response.headers.get("content-length"));
  if (!response.body || !total) {
    setScanStatus("Downloading card detector model...");
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastPercent = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const percent = Math.min(100, Math.floor((received / total) * 100));
    if (percent !== lastPercent) {
      lastPercent = percent;
      setScanStatus(progressText("Downloading card detector model", percent));
      await yieldToBrowser();
    }
  }

  const model = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    model.set(chunk, offset);
    offset += chunk.length;
  });
  return model;
}

async function loadYoloModel() {
  if (yoloModelPromise) return yoloModelPromise;

  yoloModelPromise = (async () => {
    setScanStatus("Loading card detector runtime...");
    await loadScript("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.min.js");
    window.ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
    window.ort.env.wasm.numThreads = 1;

    let model = yoloModelPath;
    try {
      model = await downloadModelWithProgress(yoloModelPath);
    } catch (error) {
      setScanStatus("Loading card detector model...");
    }

    setScanStatus("Initializing card detector...");
    const session = await window.ort.InferenceSession.create(model, {
      executionProviders: ["wasm"]
    });

    setScanStatus("Card detector ready.");
    return { session, labels: yoloLabels };
  })();
  yoloModelPromise.catch(() => {
    yoloModelPromise = null;
  });

  return yoloModelPromise;
}

async function prepareScanImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1800;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  return canvas;
}

function yoloInputFromCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = yoloInputSize;
  canvas.height = yoloInputSize;
  const context = canvas.getContext("2d");
  const scale = Math.min(yoloInputSize / source.width, yoloInputSize / source.height);
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const padX = Math.floor((yoloInputSize - width) / 2);
  const padY = Math.floor((yoloInputSize - height) / 2);

  context.fillStyle = "rgb(114, 114, 114)";
  context.fillRect(0, 0, yoloInputSize, yoloInputSize);
  context.drawImage(source, padX, padY, width, height);

  const pixels = context.getImageData(0, 0, yoloInputSize, yoloInputSize).data;
  const data = new Float32Array(3 * yoloInputSize * yoloInputSize);
  const planeSize = yoloInputSize * yoloInputSize;

  for (let index = 0; index < planeSize; index += 1) {
    const pixelIndex = index * 4;
    data[index] = pixels[pixelIndex] / 255;
    data[planeSize + index] = pixels[pixelIndex + 1] / 255;
    data[planeSize * 2 + index] = pixels[pixelIndex + 2] / 255;
  }

  return {
    tensor: new window.ort.Tensor("float32", data, [1, 3, yoloInputSize, yoloInputSize]),
    scale,
    padX,
    padY,
    sourceWidth: source.width,
    sourceHeight: source.height
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function detectionIou(a, b) {
  const left = Math.max(a.x1, b.x1);
  const top = Math.max(a.y1, b.y1);
  const right = Math.min(a.x2, b.x2);
  const bottom = Math.min(a.y2, b.y2);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const intersection = width * height;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return intersection / Math.max(1, areaA + areaB - intersection);
}

function nonMaxSuppression(detections) {
  const selectedDetections = [];
  const sorted = detections.sort((a, b) => b.score - a.score);

  for (const detection of sorted) {
    const duplicate = selectedDetections.some((selectedDetection) => (
      detection.classIndex === selectedDetection.classIndex
      && detectionIou(detection, selectedDetection) > yoloIouThreshold
    ));
    if (!duplicate) selectedDetections.push(detection);
  }

  return selectedDetections;
}

function parseYoloRawOutput(output, metadata, labels) {
  const { data, dims } = output;
  if (dims.length !== 3) {
    throw new Error(`Unsupported YOLO output shape: ${dims.join("x")}`);
  }

  const transposed = dims[1] <= dims[2];
  const attributes = transposed ? dims[1] : dims[2];
  const predictions = transposed ? dims[2] : dims[1];
  const hasObjectness = attributes === labels.length + 5;
  const classOffset = hasObjectness ? 5 : 4;
  const detections = [];

  const valueAt = (predictionIndex, attributeIndex) => {
    if (transposed) return data[attributeIndex * predictions + predictionIndex];
    return data[predictionIndex * attributes + attributeIndex];
  };

  for (let predictionIndex = 0; predictionIndex < predictions; predictionIndex += 1) {
    let bestClassIndex = -1;
    let bestClassScore = 0;

    for (let classIndex = 0; classIndex < labels.length; classIndex += 1) {
      const score = valueAt(predictionIndex, classOffset + classIndex);
      if (score > bestClassScore) {
        bestClassScore = score;
        bestClassIndex = classIndex;
      }
    }

    const objectness = hasObjectness ? valueAt(predictionIndex, 4) : 1;
    const score = bestClassScore * objectness;
    if (score < yoloConfidenceThreshold || bestClassIndex < 0) continue;

    const centerX = valueAt(predictionIndex, 0);
    const centerY = valueAt(predictionIndex, 1);
    const width = valueAt(predictionIndex, 2);
    const height = valueAt(predictionIndex, 3);
    const x1 = clamp((centerX - width / 2 - metadata.padX) / metadata.scale, 0, metadata.sourceWidth);
    const y1 = clamp((centerY - height / 2 - metadata.padY) / metadata.scale, 0, metadata.sourceHeight);
    const x2 = clamp((centerX + width / 2 - metadata.padX) / metadata.scale, 0, metadata.sourceWidth);
    const y2 = clamp((centerY + height / 2 - metadata.padY) / metadata.scale, 0, metadata.sourceHeight);

    detections.push({
      classIndex: bestClassIndex,
      label: labels[bestClassIndex],
      score,
      x1,
      y1,
      x2,
      y2,
      centerX: (x1 + x2) / 2
    });
  }

  return nonMaxSuppression(detections);
}

function parseYoloNmsOutput(output, metadata, labels) {
  const { data, dims } = output;
  if (dims.length !== 3 || dims[2] < 6) return null;

  const detections = [];
  const rows = dims[1];
  const attributes = dims[2];

  for (let row = 0; row < rows; row += 1) {
    const offset = row * attributes;
    const score = data[offset + 4];
    const classIndex = Math.round(data[offset + 5]);
    if (score < yoloConfidenceThreshold || !labels[classIndex]) continue;

    const x1 = clamp((data[offset] - metadata.padX) / metadata.scale, 0, metadata.sourceWidth);
    const y1 = clamp((data[offset + 1] - metadata.padY) / metadata.scale, 0, metadata.sourceHeight);
    const x2 = clamp((data[offset + 2] - metadata.padX) / metadata.scale, 0, metadata.sourceWidth);
    const y2 = clamp((data[offset + 3] - metadata.padY) / metadata.scale, 0, metadata.sourceHeight);

    detections.push({
      classIndex,
      label: labels[classIndex],
      score,
      x1,
      y1,
      x2,
      y2,
      centerX: (x1 + x2) / 2
    });
  }

  return detections;
}

function parseYoloDetections(output, metadata, labels) {
  if (output.dims.length === 3 && output.dims[2] >= 6 && output.dims[2] <= 8) {
    const detections = parseYoloNmsOutput(output, metadata, labels);
    if (detections) return detections;
  }

  return parseYoloRawOutput(output, metadata, labels);
}

function yoloDetectionsToCards(detections, limit) {
  const candidates = [];
  const seen = new Set();

  detections
    .sort((a, b) => b.score - a.score || a.centerX - b.centerX)
    .forEach((detection) => {
      const card = getCard(detection.label);
      if (!card || seen.has(card.id)) return;
      seen.add(card.id);
      candidates.push({ card, detection });
    });

  const primary = candidates.slice(0, limit).sort((a, b) => a.detection.centerX - b.detection.centerX);
  return [...primary, ...candidates.slice(limit)].map((candidate) => candidate.card);
}

async function recognizeCardsFromImage(file) {
  const { session, labels } = await loadYoloModel();
  const canvas = await prepareScanImage(file);
  const input = yoloInputFromCanvas(canvas);
  const inputName = session.inputNames[0];

  setScanStatus("Detecting cards...");

  try {
    const outputs = await session.run({ [inputName]: input.tensor });
    const output = outputs[session.outputNames[0]];
    const detections = parseYoloDetections(output, input, labels);
    return yoloDetectionsToCards(detections, dealtCount());
  } catch (e) {
    console.error(e);
    throw new Error(e.message || "Card detector inference failed.");
  }
}

async function scanHand(file) {
  if (!file) return;

  scanHandButton.disabled = true;
  setScanStatus("Loading card detector...");

  try {
    const scannedCards = await recognizeCardsFromImage(file);
    const need = dealtCount();
    selected = scannedCards.slice(0, need).map((card) => card.id);
    while (selected.length < need) selected.push("");
    starterSelect.value = "";
    update();

    if (scannedCards.length === 0) {
      setScanStatus("No cards found. Try a brighter, straighter photo.", "error");
      return;
    }

    const filledCards = scannedCards.slice(0, need);
    const scannedLabels = filledCards.map(cardLabel).join(" ");
    if (scannedCards.length >= need) {
      const extra = scannedCards.length > need ? ` ${scannedCards.length - need} lower-confidence candidate${scannedCards.length - need === 1 ? "" : "s"} ignored.` : "";
      setScanStatus(`Filled ${need} cards: ${scannedLabels}.${extra}`);
    } else {
      const remaining = need - scannedCards.length;
      setScanStatus(`Filled ${scannedCards.length} card${scannedCards.length === 1 ? "" : "s"}: ${scannedLabels}. Choose ${remaining} more manually.`);
    }
  } catch (error) {
    setScanStatus(error.message || "Scan failed. Try another photo.", "error");
  } finally {
    scanHandButton.disabled = false;
    scanHandInput.value = "";
  }
}

function update() {
  const token = resultRenderToken + 1;
  resultRenderToken = token;
  const need = dealtCount();
  const discardNeed = discardCount();
  selected = selected.slice(0, need);
  while (selected.length < need) selected.push("");
  const selectedCards = selected.map(getCard).filter(Boolean);

  dealHintEl.textContent = `Select ${need} cards, then compare ${discardNeed}-card discards.`;
  renderDeck();
  renderStarterOptions();
  const starter = starterSelect.value ? getCard(starterSelect.value) : null;
  randomCutButton.disabled = selectedCards.length !== need;
  renderDealtSelectors();
  renderCardRow(starterCardEl, starter ? [starter] : [], "No cut card selected");
  renderResults(selectedCards, starter, token).catch((error) => {
    if (token !== resultRenderToken) return;
    summaryEl.textContent = error.message || "Could not score discard options.";
    resultMetaEl.textContent = "";
  });
}

async function renderResults(selectedCards, starter, token) {
  const shouldContinue = () => token === resultRenderToken;
  resultsBody.replaceChildren();

  if (selectedCards.length !== dealtCount()) {
    summaryEl.textContent = `Choose ${dealtCount() - selectedCards.length} more card${dealtCount() - selectedCards.length === 1 ? "" : "s"} to rank discard options.`;
    resultMetaEl.textContent = "";
    return;
  }

  summaryEl.textContent = "Calculating discard options...";
  resultMetaEl.textContent = "Scoring 0%";
  await yieldToBrowser();
  if (!shouldContinue()) return;

  const selectedIds = new Set(selectedCards.map((card) => card.id));
  const remainingDeck = deck.filter((card) => !selectedIds.has(card.id));
  const owner = cribOwner();
  const candidates = combinations(selectedCards, discardCount()).map((discard) => {
    const discardIds = new Set(discard.map((card) => card.id));
    const keep = selectedCards.filter((card) => !discardIds.has(card.id));
    const cutDeck = starter ? remainingDeck.filter((card) => card.id !== starter.id) : remainingDeck;
    const handAvg = averageHand(keep, remainingDeck, starter);
    return { keep, discard, cutDeck, handAvg };
  }).sort((a, b) => b.handAvg - a.handAvg);
  const rows = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const cribAvg = await averageCribAsync(candidate.discard, candidate.cutDeck, starter, shouldContinue);
    if (!shouldContinue() || cribAvg === null) return;
    const net = owner === "mine" ? candidate.handAvg + cribAvg : candidate.handAvg - cribAvg;
    rows.push({
      keep: candidate.keep,
      discard: candidate.discard,
      handAvg: candidate.handAvg,
      cribAvg,
      net
    });
    rows.sort((a, b) => b.net - a.net);

    const isDone = rows.length === candidates.length;
    renderResultSummary(rows[0], isDone);
    renderResultRows(rows);
    const progress = Math.round((rows.length / candidates.length) * 100);
    resultMetaEl.textContent = isDone
      ? resultMetaText(starter)
      : `Showing top ${Math.min(3, rows.length)} so far. Scoring ${progress}%`;
    await yieldToBrowser();
    if (!shouldContinue()) return;
  }
}

function renderResultSummary(best, isFinal) {
  summaryEl.replaceChildren();
  summaryEl.append(isFinal ? "Best discard: " : "Best so far: ");
  const strongDiscard = document.createElement("strong");
  strongDiscard.textContent = best.discard.map(cardLabel).join(" ");
  summaryEl.append(strongDiscard, ". Expected net: ");
  const strongNet = document.createElement("strong");
  strongNet.textContent = best.net.toFixed(2);
  summaryEl.append(strongNet, ".");
}

function resultMetaText(starter) {
  return starter ? `Scored with ${cardLabel(starter)} starter` : "Averaged across all possible starters";
}

function renderResultRows(rows) {
  resultsBody.replaceChildren();

  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
    fragment.append(createResultRow(row));
  });
  resultsBody.appendChild(fragment);
}

function createResultRow(row) {
  const tr = document.createElement("tr");

  const tdKeep = document.createElement("td");
  tdKeep.append(...formatCards(row.keep));

  const tdDiscard = document.createElement("td");
  tdDiscard.append(...formatCards(row.discard));

  tr.append(tdKeep);
  tr.append(tdDiscard);

  const handAvgTd = document.createElement("td");
  handAvgTd.className = "score";
  handAvgTd.textContent = row.handAvg.toFixed(2);
  const cribAvgTd = document.createElement("td");
  cribAvgTd.className = "score";
  cribAvgTd.textContent = row.cribAvg.toFixed(2);
  const netTd = document.createElement("td");
  netTd.className = "score";
  netTd.textContent = row.net.toFixed(2);

  tr.append(handAvgTd, cribAvgTd, netTd);
  return tr;
}

function formatCards(cards) {
  return cards.map((card) => {
    const span = document.createElement("span");
    span.className = `pill ${isRed(card) ? "red" : ""}`;
    span.textContent = cardLabel(card);
    return span;
  });
}

playersSelect.addEventListener("change", update);
starterSelect.addEventListener("change", update);
cribInputs.forEach((input) => input.addEventListener("change", update));
randomDealButton.addEventListener("click", randomDeal);
randomCutButton.addEventListener("click", randomCut);
scanHandButton.addEventListener("click", () => scanHandInput.click());
scanHandInput.addEventListener("change", () => scanHand(scanHandInput.files[0]));
document.querySelector("#resetButton").addEventListener("click", () => {
  selected = Array(dealtCount()).fill("");
  starterSelect.value = "";
  setScanStatus("");
  update();
});

update();
window.addEventListener("load", () => {
  loadYoloModel().catch((error) => {
    setScanStatus(error.message || "Card detector failed to load.", "error");
  });
});
