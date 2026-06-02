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

let selected = [];
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

let transformersModelPromise = null;

const florenceScanPrompts = [
  "<OCR>",
  "List every visible playing card from left to right. Use only compact codes like 7H 8C 9S 10D JC QS KH.",
  "Identify all visible playing cards. Return only rank and suit codes using S H D C."
];

function preferredVisionDevices() {
  return typeof navigator !== "undefined" && navigator.gpu ? ["webgpu"] : [];
}

function florenceDtype(device) {
  if (device === "wasm") return "q4";

  return {
    embed_tokens: "fp16",
    vision_encoder: "fp16",
    encoder_model: "q4",
    decoder_model_merged: "q4",
  };
}

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
  return deck.find((card) => card.id === id);
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

function averageCrib(discard, remainingDeck, fixedStarter) {
  const fillCount = 4 - discard.length;
  let total = 0;
  let iterations = 0;
  const cribHand = Array(4);
  for (let index = 0; index < discard.length; index += 1) {
    cribHand[index] = discard[index];
  }

  function scoreStarter(starter) {
    if (fillCount === 2) {
      for (let first = 0; first < remainingDeck.length - 1; first += 1) {
        if (remainingDeck[first].id === starter.id) continue;
        cribHand[discard.length] = remainingDeck[first];
        for (let second = first + 1; second < remainingDeck.length; second += 1) {
          if (remainingDeck[second].id === starter.id) continue;
          cribHand[discard.length + 1] = remainingDeck[second];
          total += scoreFiveCards(cribHand, starter, true);
          iterations += 1;
        }
      }
      return;
    }

    for (let first = 0; first < remainingDeck.length - 2; first += 1) {
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
        }
      }
    }
  }

  if (fixedStarter) {
    scoreStarter(fixedStarter);
  } else {
    for (let index = 0; index < remainingDeck.length; index += 1) {
      scoreStarter(remainingDeck[index]);
    }
  }

  return total / iterations;
}

function renderDeck() {
  if (!deckEl) return;

  const fragment = document.createDocumentFragment();
  deck.forEach((card) => {
    const button = document.createElement("button");
    button.type = "button";
    const isSelected = selected.includes(card.id);
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
  starterSelect.replaceChildren();
  const defaultOpt = new Option("Auto-average all cuts", "");
  starterSelect.add(defaultOpt);

  deck.filter((card) => !selected.includes(card.id)).forEach((card) => {
    starterSelect.add(new Option(cardLabel(card), card.id));
  });

  const stillValid = deck.some((card) => card.id === current && !selected.includes(current));
  starterSelect.value = stillValid ? current : "";
}

function renderDealtSelectors() {
  const need = dealtCount();
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
      .filter((card) => card.id === current || !selected.includes(card.id))
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
  const shuffled = [...deck];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  playersSelect.value = "2";
  selected = shuffled.slice(0, 6).map((card) => card.id);
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

async function loadTransformers() {
  if (transformersModelPromise) return transformersModelPromise;

  transformersModelPromise = (async () => {
    const {
      Florence2ForConditionalGeneration,
      AutoProcessor,
      AutoTokenizer,
      RawImage,
      env
    } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2");

    env.allowLocalModels = false;
    env.useBrowserCache = typeof caches !== "undefined";

    const modelId = "onnx-community/Florence-2-base-ft";
    let model = null;
    let device = "";
    let lastError = null;
    const progressCallback = (p) => {
      if (p.status === "progress") {
        setScanStatus(`Downloading model: ${p.progress.toFixed(1)}%`);
      }
    };

    const devices = preferredVisionDevices();
    if (devices.length === 0) {
      throw new Error("Photo scan needs WebGPU on this static version. Select cards manually or add a server-side scanner.");
    }

    for (const candidate of devices) {
      try {
        device = candidate;
        setScanStatus(`Loading Vision Model with ${candidate.toUpperCase()}...`);
        model = await Florence2ForConditionalGeneration.from_pretrained(modelId, {
          device: candidate,
          dtype: florenceDtype(candidate),
          progress_callback: progressCallback
        });
        break;
      } catch (error) {
        lastError = error;
        throw error;
      }
    }

    if (!model) throw lastError || new Error("The vision model could not be loaded.");

    const processor = await AutoProcessor.from_pretrained(modelId);
    const tokenizer = await AutoTokenizer.from_pretrained(modelId);

    return { model, processor, tokenizer, RawImage, device };
  })();

  return transformersModelPromise;
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

function cropCanvas(source, x, y, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const context = canvas.getContext("2d");
  context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function scanImageVariants(canvas) {
  return [
    { label: "full image", canvas },
    {
      label: "card indexes",
      canvas: cropCanvas(canvas, 0, 0, canvas.width, Math.max(1, canvas.height * 0.68))
    }
  ];
}

function normalizeRank(rank) {
  const normalized = rank.toUpperCase().trim();
  const map = {
    "ACE": "A", "TWO": "2", "THREE": "3", "FOUR": "4", "FIVE": "5",
    "SIX": "6", "SEVEN": "7", "EIGHT": "8", "NINE": "9",
    "TEN": "10", "JACK": "J", "QUEEN": "Q", "KING": "K",
    "T": "10", "1O": "10", "IO": "10", "I0": "10", "10": "10"
  };
  if (map[normalized]) return map[normalized];
  if (ranks.includes(normalized)) return normalized;
  return "";
}

function normalizeSuit(suit) {
  const normalized = suit.toUpperCase();
  if (["S", "SPADE", "SPADES", "♠", "♤"].includes(normalized)) return "S";
  if (["H", "HEART", "HEARTS", "♥", "♡"].includes(normalized)) return "H";
  if (["D", "DIAMOND", "DIAMONDS", "♦", "♢"].includes(normalized)) return "D";
  if (["C", "CLUB", "CLUBS", "♣", "♧"].includes(normalized)) return "C";
  return "";
}

function addScannedCard(cards, seen, rank, suit) {
  const id = `${rank}${suit}`;
  if (!getCard(id) || seen.has(id)) return;
  seen.add(id);
  cards.push(getCard(id));
}

function parseScannedCards(rawText) {
  const directText = rawText
    .toUpperCase()
    .replace(/[♡♥]/g, "H")
    .replace(/[♢♦]/g, "D")
    .replace(/[♧♣]/g, "C")
    .replace(/[♤♠]/g, "S")
    .replace(/\b(?:1O|IO|I0)\b/g, "T")
    .replace(/10/g, "T");
  const cards = [];
  const seen = new Set();
  const directMatches = directText.matchAll(/\b(T|[A2-9JQK])\s*([SHDC])\b|\b([SHDC])\s*(T|[A2-9JQK])\b/g);

  for (const match of directMatches) {
    const rank = normalizeRank(match[1] || match[4]);
    const suit = normalizeSuit(match[2] || match[3]);
    addScannedCard(cards, seen, rank, suit);
  }

  const tokenText = rawText
    .toUpperCase()
    .replace(/SPADES?/g, " S ")
    .replace(/HEARTS?/g, " H ")
    .replace(/DIAMONDS?/g, " D ")
    .replace(/CLUBS?/g, " C ")
    .replace(/[♡♥]/g, " H ")
    .replace(/[♢♦]/g, " D ")
    .replace(/[♧♣]/g, " C ")
    .replace(/[♤♠]/g, " S ")
    .replace(/\b(?:10|1O|IO|I0)\b/g, " T ")
    .replace(/[^A-Z0-9]+/g, " ");
  const tokens = tokenText.match(/\b(?:T|[A2-9JQK]|[SHDC]|ACE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|JACK|QUEEN|KING)\b/g) || [];
  let pendingRank = "";

  for (const token of tokens) {
    const rank = normalizeRank(token);
    const suit = normalizeSuit(token);
    if (rank) {
      pendingRank = rank;
    } else if (suit && pendingRank) {
      addScannedCard(cards, seen, pendingRank, suit);
      pendingRank = "";
    }
  }

  return cards;
}

function mergeScannedCards(cardGroups) {
  const cards = [];
  const seen = new Set();

  for (const group of cardGroups) {
    for (const card of group) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push(card);
    }
  }

  return cards;
}

function florenceOutputText(result, prompt, generatedText) {
  const value = result[prompt];
  if (typeof value === "string") return value;
  if (value && Array.isArray(value.labels)) return value.labels.join(" ");
  return generatedText;
}

async function runFlorenceScanPrompt(model, processor, tokenizer, image, prompt) {
  const visionInputs = await processor(image);
  const prompts = processor.construct_prompts(prompt);
  const textInputs = tokenizer(prompts);
  const generatedIds = await model.generate({
    ...textInputs,
    ...visionInputs,
    max_new_tokens: 96
  });
  const generatedText = tokenizer.batch_decode(generatedIds, {
    skip_special_tokens: false
  })[0];
  const result = processor.post_process_generation(generatedText, prompt, image.size);
  const text = florenceOutputText(result, prompt, generatedText);
  console.info("Scan model output", { prompt, text });
  return parseScannedCards(text);
}

async function recognizeCardsFromImage(file) {
  const { model, processor, tokenizer, RawImage, device } = await loadTransformers();
  const canvas = await prepareScanImage(file);

  setScanStatus(`Analyzing image with ${device.toUpperCase()}...`);

  try {
    const scans = [];
    const variants = scanImageVariants(canvas);
    const total = variants.length * florenceScanPrompts.length;
    let completed = 0;

    for (const variant of variants) {
      const image = RawImage.fromCanvas(variant.canvas);
      for (const prompt of florenceScanPrompts) {
        completed += 1;
        setScanStatus(`Analyzing ${variant.label}... ${completed}/${total}`);
        scans.push(await runFlorenceScanPrompt(model, processor, tokenizer, image, prompt));
      }
    }

    return mergeScannedCards(scans);
  } catch (e) {
    console.error(e);
    throw new Error(e.message || "VLM inference failed.");
  }
}

async function scanHand(file) {
  if (!file) return;

  scanHandButton.disabled = true;
  setScanStatus("Loading Vision Model (~230MB)...");

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

    const scannedLabels = scannedCards.slice(0, need).map(cardLabel).join(" ");
    if (scannedCards.length >= need) {
      setScanStatus(`Scanned ${need} cards: ${scannedLabels}.`);
    } else {
      const remaining = need - scannedCards.length;
      setScanStatus(`Scanned ${scannedCards.length} card${scannedCards.length === 1 ? "" : "s"}: ${scannedLabels}. Choose ${remaining} more manually.`);
    }
  } catch (error) {
    setScanStatus(error.message || "Scan failed. Try another photo.", "error");
  } finally {
    scanHandButton.disabled = false;
    scanHandInput.value = "";
  }
}

function update() {
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
  renderResults(selectedCards, starter);
}

function renderResults(selectedCards, starter) {
  resultsBody.replaceChildren();

  if (selectedCards.length !== dealtCount()) {
    summaryEl.textContent = `Choose ${dealtCount() - selectedCards.length} more card${dealtCount() - selectedCards.length === 1 ? "" : "s"} to rank discard options.`;
    resultMetaEl.textContent = "";
    return;
  }

  const selectedIds = new Set(selectedCards.map((card) => card.id));
  const remainingDeck = deck.filter((card) => !selectedIds.has(card.id));
  const discards = combinations(selectedCards, discardCount());
  const rows = discards.map((discard) => {
    const discardIds = new Set(discard.map((card) => card.id));
    const keep = selectedCards.filter((card) => !discardIds.has(card.id));
    const cutDeck = starter ? remainingDeck.filter((card) => card.id !== starter.id) : remainingDeck;
    const handAvg = averageHand(keep, remainingDeck, starter);
    const cribAvg = averageCrib(discard, cutDeck, starter);
    const net = cribOwner() === "mine" ? handAvg + cribAvg : handAvg - cribAvg;
    return { keep, discard, handAvg, cribAvg, net };
  }).sort((a, b) => b.net - a.net);

  const best = rows[0];
  summaryEl.replaceChildren();
  summaryEl.append("Best discard: ");
  const strongDiscard = document.createElement("strong");
  strongDiscard.textContent = best.discard.map(cardLabel).join(" ");
  summaryEl.append(strongDiscard, ". Expected net: ");
  const strongNet = document.createElement("strong");
  strongNet.textContent = best.net.toFixed(2);
  summaryEl.append(strongNet, ".");

  resultMetaEl.textContent = starter ? `Scored with ${cardLabel(starter)} starter` : "Averaged across all possible starters";

  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
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
    fragment.append(tr);
  });
  resultsBody.appendChild(fragment);
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
