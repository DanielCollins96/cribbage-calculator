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

function forEachCombination(items, size, callback, start = 0, combo = []) {
  if (combo.length === size) {
    callback(combo);
    return;
  }

  const remaining = size - combo.length;
  for (let index = start; index <= items.length - remaining; index += 1) {
    combo.push(items[index]);
    forEachCombination(items, size, callback, index + 1, combo);
    combo.pop();
  }
}

function scoreFiveCards(hand, starter, isCrib = false) {
  const cards = [...hand, starter];
  let score = 0;

  for (let mask = 1; mask < 1 << cards.length; mask += 1) {
    let total = 0;
    let count = 0;
    for (let index = 0; index < cards.length; index += 1) {
      if (mask & (1 << index)) {
        total += cards[index].value;
        count += 1;
      }
    }
    if (count >= 2 && total === 15) score += 2;
  }

  const rankGroups = new Map();
  cards.forEach((card) => rankGroups.set(card.rank, (rankGroups.get(card.rank) || 0) + 1));
  for (const count of rankGroups.values()) {
    if (count > 1) score += (count * (count - 1)) / 2 * 2;
  }

  score += runScore(cards);

  const handFlush = hand.every((card) => card.suit === hand[0].suit);
  if (handFlush) {
    if (starter.suit === hand[0].suit) score += 5;
    else if (!isCrib) score += 4;
  }

  if (hand.some((card) => card.rank === "J" && card.suit === starter.suit)) score += 1;

  return score;
}

function runScore(cards) {
  const counts = Array(14).fill(0);
  cards.forEach((card) => { counts[card.order] += 1; });
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
  const starters = fixedStarter ? [fixedStarter] : remainingDeck;
  return starters.reduce((sum, starter) => sum + scoreFiveCards(keep, starter), 0) / starters.length;
}

function averageCrib(discard, remainingDeck, fixedStarter) {
  const starters = fixedStarter ? [fixedStarter] : remainingDeck;
  const fillCount = 4 - discard.length;
  let total = 0;
  let count = 0;

  for (const starter of starters) {
    const fillDeck = remainingDeck.filter((card) => card.id !== starter.id);
    forEachCombination(fillDeck, fillCount, (fill) => {
      total += scoreFiveCards([...discard, ...fill], starter, true);
      count += 1;
    });
  }

  return total / count;
}

function renderDeck() {
  if (!deckEl) return;

  deckEl.innerHTML = "";
  deck.forEach((card) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cardButton ${isRed(card) ? "red" : ""} ${selected.includes(card.id) ? "selected" : ""}`;
    button.textContent = cardLabel(card);
    button.title = selected.includes(card.id) ? "Remove card" : "Add card";
    button.addEventListener("click", () => toggleCard(card.id));
    deckEl.append(button);
  });
}

function renderStarterOptions() {
  const current = starterSelect.value;
  starterSelect.innerHTML = '<option value="">Auto-average all cuts</option>';
  deck.filter((card) => !selected.includes(card.id)).forEach((card) => {
    const option = document.createElement("option");
    option.value = card.id;
    option.textContent = cardLabel(card);
    starterSelect.append(option);
  });
  starterSelect.value = deck.some((card) => card.id === current && !selected.includes(current)) ? current : "";
}

function renderDealtSelectors() {
  const need = dealtCount();
  dealtCardsEl.innerHTML = "";
  dealtCardsEl.classList.toggle("empty", false);

  for (let index = 0; index < need; index += 1) {
    const current = selected[index] || "";
    const currentCard = current ? getCard(current) : null;
    const select = document.createElement("select");
    select.className = `cardSelect ${currentCard && isRed(currentCard) ? "red" : ""}`;
    select.setAttribute("aria-label", `Dealt card ${index + 1}`);
    select.innerHTML = `<option value="">Card ${index + 1}</option>`;

    deck
      .filter((card) => card.id === current || !selected.includes(card.id))
      .forEach((card) => {
        const option = document.createElement("option");
        option.value = card.id;
        option.textContent = cardLabel(card);
        if (isRed(card)) option.className = "red";
        select.append(option);
      });

    select.value = current;
    select.addEventListener("change", () => {
      selected[index] = select.value;
      starterSelect.value = "";
      update();
    });
    dealtCardsEl.append(select);
  }
}

function renderCardRow(el, cards, fallback) {
  el.innerHTML = "";
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
  resultsBody.innerHTML = "";

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
  summaryEl.innerHTML = `Best discard: <strong>${best.discard.map(cardLabel).join(" ")}</strong>. Expected net: <strong>${best.net.toFixed(2)}</strong>.`;
  resultMetaEl.textContent = starter ? `Scored with ${cardLabel(starter)} starter` : "Averaged across all possible starters";

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatCards(row.keep)}</td>
      <td>${formatCards(row.discard)}</td>
      <td class="score">${row.handAvg.toFixed(2)}</td>
      <td class="score">${row.cribAvg.toFixed(2)}</td>
      <td class="score">${row.net.toFixed(2)}</td>
    `;
    resultsBody.append(tr);
  });
}

function formatCards(cards) {
  return cards.map((card) => `<span class="pill ${isRed(card) ? "red" : ""}">${cardLabel(card)}</span>`).join(" ");
}

playersSelect.addEventListener("change", update);
starterSelect.addEventListener("change", update);
cribInputs.forEach((input) => input.addEventListener("change", update));
randomDealButton.addEventListener("click", randomDeal);
randomCutButton.addEventListener("click", randomCut);
document.querySelector("#resetButton").addEventListener("click", () => {
  selected = Array(dealtCount()).fill("");
  starterSelect.value = "";
  update();
});

update();
