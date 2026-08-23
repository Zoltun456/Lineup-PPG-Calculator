import { DEFAULT_PLAYER_POOL, PLAYER_DIRECTORY, POSITIONS } from "./data.js";
import { loadDuelRankings, saveDuelRankings } from "./duel-rankings.js";
import { buildXlsxBlob } from "./xlsx-writer.js";

const CANCELLED = Symbol("cancelled");

const elements = {
  pickScreen: document.querySelector("#pick-screen"),
  duelScreen: document.querySelector("#duel-screen"),
  resultsScreen: document.querySelector("#results-screen"),
  positionControl: document.querySelector("#positionControl"),
  poolSearch: document.querySelector("#poolSearch"),
  poolList: document.querySelector("#poolList"),
  selectedList: document.querySelector("#selectedList"),
  selectedCount: document.querySelector("#selectedCount"),
  pickEstimate: document.querySelector("#pickEstimate"),
  addAllButton: document.querySelector("#addAllButton"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  startDuelButton: document.querySelector("#startDuelButton"),
  exportFromPickButton: document.querySelector("#exportFromPickButton"),
  duelPositionLabel: document.querySelector("#duelPositionLabel"),
  progressFill: document.querySelector("#progressFill"),
  progressLabel: document.querySelector("#progressLabel"),
  cardLeft: document.querySelector("#cardLeft"),
  cardRight: document.querySelector("#cardRight"),
  tieButton: document.querySelector("#tieButton"),
  cancelDuelButton: document.querySelector("#cancelDuelButton"),
  resultsPositionLabel: document.querySelector("#resultsPositionLabel"),
  resultsList: document.querySelector("#resultsList"),
  exportButton: document.querySelector("#exportButton"),
  rankAnotherButton: document.querySelector("#rankAnotherButton"),
  redoButton: document.querySelector("#redoButton"),
  completedSummary: document.querySelector("#completedSummary"),
};

const teamByPositionAndName = Object.fromEntries(POSITIONS.map((position) => [
  position,
  new Map(PLAYER_DIRECTORY[position].map((player) => [player.name, player.team ?? ""])),
]));

function teamFor(position, name) {
  return teamByPositionAndName[position]?.get(name) ?? "";
}

const state = {
  position: "QB",
  pickSelections: Object.fromEntries(POSITIONS.map((position) => [position, new Set()])),
};
let completedRankings = loadDuelRankings();
let resultsPosition = null;
let resolveCompare = null;
let cancelRequested = false;

function createElement(tagName, attributes = {}, children = []) {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = value;
    else if (name === "dataset") Object.assign(element.dataset, value);
    else if (name === "disabled") element.disabled = Boolean(value);
    else if (name in element && !name.startsWith("aria")) element[name] = value;
    else element.setAttribute(name, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function showScreen(screen) {
  for (const candidate of [elements.pickScreen, elements.duelScreen, elements.resultsScreen]) {
    candidate.hidden = candidate !== screen;
  }
}

function estimateComparisons(n) {
  if (n <= 1) return 0;
  return Math.max(1, Math.ceil(n * Math.log2(n)));
}

function completedCount() {
  return POSITIONS.filter((position) => completedRankings[position]?.length).length;
}

function renderPickScreen() {
  const position = state.position;
  const selection = state.pickSelections[position];
  const query = elements.poolSearch.value.trim().toLocaleLowerCase();
  const pool = DEFAULT_PLAYER_POOL[position].filter((name) => !selection.has(name));
  const filteredPool = query
    ? pool.filter((name) => name.toLocaleLowerCase().includes(query))
    : pool;

  elements.poolList.replaceChildren(...filteredPool.map((name) => (
    createElement("li", {}, [
      createElement("button", {
        type: "button",
        className: "pick-item",
        dataset: { name },
        text: `${name}${teamFor(position, name) ? ` · ${teamFor(position, name)}` : ""}`,
      }),
    ])
  )));

  const selectedNames = [...selection];
  elements.selectedList.replaceChildren(...selectedNames.map((name) => (
    createElement("li", {}, [
      createElement("button", {
        type: "button",
        className: "pick-item pick-item-selected",
        dataset: { name },
        text: `${name}${teamFor(position, name) ? ` · ${teamFor(position, name)}` : ""}`,
      }),
    ])
  )));

  elements.selectedCount.textContent = String(selectedNames.length);
  elements.pickEstimate.textContent = selectedNames.length >= 2
    ? `About ${estimateComparisons(selectedNames.length)} matchups to fully rank this list.`
    : "Add at least two players to start.";
  elements.startDuelButton.disabled = selectedNames.length < 2;

  const doneCount = completedCount();
  elements.exportFromPickButton.hidden = doneCount === 0;
  elements.exportFromPickButton.textContent = `Export ranked positions to Excel (${doneCount})`;
}

elements.positionControl.addEventListener("change", (event) => {
  if (event.target.name !== "position") return;
  state.position = event.target.value;
  elements.poolSearch.value = "";
  renderPickScreen();
});

elements.poolSearch.addEventListener("input", renderPickScreen);

elements.poolList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-name]");
  if (!button) return;
  state.pickSelections[state.position].add(button.dataset.name);
  renderPickScreen();
});

elements.selectedList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-name]");
  if (!button) return;
  state.pickSelections[state.position].delete(button.dataset.name);
  renderPickScreen();
});

elements.addAllButton.addEventListener("click", () => {
  const query = elements.poolSearch.value.trim().toLocaleLowerCase();
  const selection = state.pickSelections[state.position];
  for (const name of DEFAULT_PLAYER_POOL[state.position]) {
    if (!query || name.toLocaleLowerCase().includes(query)) selection.add(name);
  }
  renderPickScreen();
});

elements.clearSelectionButton.addEventListener("click", () => {
  state.pickSelections[state.position].clear();
  renderPickScreen();
});

elements.exportFromPickButton.addEventListener("click", exportCompletedRankings);

function updateProgress(done, total) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  elements.progressFill.style.width = `${pct}%`;
  elements.progressLabel.textContent = `${pct}%`;
}

function askUser(a, b) {
  return new Promise((resolve) => {
    elements.cardLeft.textContent = a;
    elements.cardRight.textContent = b;
    elements.cardLeft.classList.remove("chosen", "rejected");
    elements.cardRight.classList.remove("chosen", "rejected");
    resolveCompare = resolve;
  });
}

elements.cardLeft.addEventListener("click", () => {
  if (!resolveCompare) return;
  elements.cardLeft.classList.add("chosen");
  elements.cardRight.classList.add("rejected");
  const resolve = resolveCompare;
  resolveCompare = null;
  setTimeout(() => resolve(-1), 110);
});

elements.cardRight.addEventListener("click", () => {
  if (!resolveCompare) return;
  elements.cardRight.classList.add("chosen");
  elements.cardLeft.classList.add("rejected");
  const resolve = resolveCompare;
  resolveCompare = null;
  setTimeout(() => resolve(1), 110);
});

elements.tieButton.addEventListener("click", () => {
  if (!resolveCompare) return;
  const resolve = resolveCompare;
  resolveCompare = null;
  resolve(0);
});

elements.cancelDuelButton.addEventListener("click", () => {
  cancelRequested = true;
  if (resolveCompare) {
    const resolve = resolveCompare;
    resolveCompare = null;
    resolve(CANCELLED);
  }
});

let comparisonsDone = 0;
let comparisonsTotal = 1;

async function merge(left, right) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const outcome = await askUser(left[i], right[j]);
    if (outcome === CANCELLED) throw CANCELLED;
    comparisonsDone++;
    updateProgress(comparisonsDone, comparisonsTotal);
    if (outcome <= 0) {
      result.push(left[i]);
      i++;
    } else {
      result.push(right[j]);
      j++;
    }
  }
  while (i < left.length) result.push(left[i++]);
  while (j < right.length) result.push(right[j++]);
  return result;
}

async function mergeSort(list) {
  if (list.length <= 1) return list;
  const mid = Math.floor(list.length / 2);
  const left = await mergeSort(list.slice(0, mid));
  const right = await mergeSort(list.slice(mid));
  return merge(left, right);
}

async function startDuel() {
  const position = state.position;
  const names = [...state.pickSelections[position]];
  if (names.length < 2) return;

  cancelRequested = false;
  comparisonsDone = 0;
  comparisonsTotal = estimateComparisons(names.length);
  elements.duelPositionLabel.textContent = `Step 2 · Ranking ${position}s`;
  updateProgress(0, comparisonsTotal);
  showScreen(elements.duelScreen);

  try {
    const ranked = await mergeSort(names);
    completedRankings[position] = ranked;
    saveDuelRankings(completedRankings);
    renderResults(position, ranked);
    showScreen(elements.resultsScreen);
  } catch (error) {
    if (error !== CANCELLED) throw error;
    showScreen(elements.pickScreen);
    renderPickScreen();
  }
}

elements.startDuelButton.addEventListener("click", startDuel);

function renderResults(position, ranked) {
  resultsPosition = position;
  elements.resultsPositionLabel.textContent = `Step 3 · Your ${position} ranking`;
  elements.resultsList.replaceChildren(...ranked.map((name) => (
    createElement("li", {}, [
      createElement("span", { className: "results-name", text: name }),
      createElement("span", { className: "results-team", text: teamFor(position, name) }),
    ])
  )));
  const doneCount = completedCount();
  elements.completedSummary.textContent = doneCount > 1
    ? `You also have completed rankings for ${doneCount - 1} other position${doneCount - 1 === 1 ? "" : "s"} — export bundles all of them into one workbook.`
    : "";
}

elements.rankAnotherButton.addEventListener("click", () => {
  showScreen(elements.pickScreen);
  renderPickScreen();
});

elements.redoButton.addEventListener("click", () => {
  if (!resultsPosition) return;
  state.position = resultsPosition;
  for (const input of elements.positionControl.querySelectorAll("input[name=position]")) {
    input.checked = input.value === resultsPosition;
  }
  startDuel();
});

function exportCompletedRankings() {
  const sheets = POSITIONS
    .filter((position) => completedRankings[position]?.length)
    .map((position) => ({
      name: position,
      rows: [
        ["Rank", "Player", "Team"],
        ...completedRankings[position].map((name, index) => [index + 1, name, teamFor(position, name)]),
      ],
    }));
  if (!sheets.length) return;

  const blob = buildXlsxBlob(sheets);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "fantasy-gut-check-rankings.xlsx";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

elements.exportButton.addEventListener("click", exportCompletedRankings);

renderPickScreen();
