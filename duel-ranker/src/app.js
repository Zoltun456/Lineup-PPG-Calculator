import { PLAYER_POOL, POSITIONS } from "./data.js";
import { buildXlsxBlob } from "./xlsx-writer.js";

const STORAGE_KEY = "duelRankerApp_rankings_v1";
const CANCELLED = Symbol("cancelled");

const elements = {
  boardScreen: document.querySelector("#board-screen"),
  duelScreen: document.querySelector("#duel-screen"),
  positionControl: document.querySelector("#positionControl"),
  rankedCount: document.querySelector("#rankedCount"),
  rankedList: document.querySelector("#rankedList"),
  clearPositionButton: document.querySelector("#clearPositionButton"),
  poolSearch: document.querySelector("#poolSearch"),
  poolList: document.querySelector("#poolList"),
  queueList: document.querySelector("#queueList"),
  queueCount: document.querySelector("#queueCount"),
  queueEstimate: document.querySelector("#queueEstimate"),
  rankAdditionsButton: document.querySelector("#rankAdditionsButton"),
  exportButton: document.querySelector("#exportButton"),
  duelPositionLabel: document.querySelector("#duelPositionLabel"),
  candidateLabel: document.querySelector("#candidateLabel"),
  progressFill: document.querySelector("#progressFill"),
  progressLabel: document.querySelector("#progressLabel"),
  cardCandidate: document.querySelector("#cardCandidate"),
  cardIncumbent: document.querySelector("#cardIncumbent"),
  incumbentRankLabel: document.querySelector("#incumbentRankLabel"),
  tieButton: document.querySelector("#tieButton"),
  cancelDuelButton: document.querySelector("#cancelDuelButton"),
};

const teamByPositionAndName = Object.fromEntries(POSITIONS.map((position) => [
  position,
  new Map(PLAYER_POOL[position].map((player) => [player.name, player.team])),
]));

function teamFor(position, name) {
  return teamByPositionAndName[position]?.get(name) ?? "";
}

function loadRankings() {
  const fallback = Object.fromEntries(POSITIONS.map((position) => [position, []]));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    for (const position of POSITIONS) {
      const list = parsed?.[position];
      if (Array.isArray(list) && list.every((name) => typeof name === "string")) {
        fallback[position] = list.slice(0, 500);
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function saveRankings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rankings));
  } catch {
    // Private browsing or full storage — export still works from memory.
  }
}

const rankings = loadRankings();
const queues = Object.fromEntries(POSITIONS.map((position) => [position, new Set()]));
let activePosition = "QB";
let resolveCompare = null;
let comparisonsDone = 0;
let comparisonsTotal = 1;
let pointerDrag = null;

function moveItem(array, fromIndex, toIndex) {
  if (
    !Number.isInteger(fromIndex)
    || !Number.isInteger(toIndex)
    || fromIndex < 0
    || fromIndex >= array.length
    || toIndex < 0
    || toIndex >= array.length
    || fromIndex === toIndex
  ) return false;
  const [item] = array.splice(fromIndex, 1);
  array.splice(toIndex, 0, item);
  return true;
}

function reorderRanking(fromIndex, toIndex) {
  if (!moveItem(rankings[activePosition], fromIndex, toIndex)) return;
  saveRankings();
  renderBoard();
}

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
  elements.boardScreen.hidden = screen !== elements.boardScreen;
  elements.duelScreen.hidden = screen !== elements.duelScreen;
}

function playerLabel(position, name) {
  const team = teamFor(position, name);
  return team ? `${name} · ${team}` : name;
}

function estimateComparisonsFor(startLength, additionCount) {
  let length = startLength;
  let total = 0;
  for (let i = 0; i < additionCount; i++) {
    total += length > 0 ? Math.ceil(Math.log2(length + 1)) : 0;
    length++;
  }
  return Math.max(1, total);
}

function renderBoard() {
  const rankedNames = rankings[activePosition];
  const queue = queues[activePosition];

  elements.rankedCount.textContent = String(rankedNames.length);
  elements.rankedList.replaceChildren(...rankedNames.map((name, index) => (
    createElement("li", { className: "ranked-row", dataset: { index: String(index) } }, [
      createElement("button", {
        type: "button",
        className: "drag-handle",
        title: "Drag to reorder",
        "aria-label": `Drag ${name} to reorder`,
        dataset: { index: String(index) },
      }, "⠿"),
      createElement("span", { className: "ranked-index", text: String(index + 1) }),
      createElement("span", { className: "ranked-name", text: name }),
      createElement("span", { className: "ranked-team", text: teamFor(activePosition, name) }),
      createElement("button", {
        type: "button",
        className: "icon-button",
        text: "↑",
        title: `Move ${name} up`,
        "aria-label": `Move ${name} up`,
        disabled: index === 0,
        dataset: { action: "move-up", index: String(index) },
      }),
      createElement("button", {
        type: "button",
        className: "icon-button",
        text: "↓",
        title: `Move ${name} down`,
        "aria-label": `Move ${name} down`,
        disabled: index === rankedNames.length - 1,
        dataset: { action: "move-down", index: String(index) },
      }),
      createElement("button", {
        type: "button",
        className: "remove-button",
        text: "×",
        title: `Remove ${name} from your ${activePosition} ranking`,
        dataset: { name },
      }),
    ])
  )));

  const rankedKeys = new Set(rankedNames.map((name) => name.toLocaleLowerCase()));
  const query = elements.poolSearch.value.trim().toLocaleLowerCase();
  const pool = PLAYER_POOL[activePosition].filter((player) => (
    !rankedKeys.has(player.name.toLocaleLowerCase()) && !queue.has(player.name)
  ));
  const filteredPool = query
    ? pool.filter((player) => player.name.toLocaleLowerCase().includes(query))
    : pool;

  elements.poolList.replaceChildren(...filteredPool.map((player) => (
    createElement("li", {}, [
      createElement("button", {
        type: "button",
        className: "pick-item",
        dataset: { name: player.name },
        text: playerLabel(activePosition, player.name),
      }),
    ])
  )));

  const queuedNames = [...queue];
  elements.queueList.replaceChildren(...queuedNames.map((name) => (
    createElement("li", {}, [
      createElement("button", {
        type: "button",
        className: "pick-item pick-item-selected",
        dataset: { name },
        text: playerLabel(activePosition, name),
      }),
    ])
  )));

  elements.queueCount.textContent = String(queuedNames.length);
  elements.queueEstimate.textContent = queuedNames.length
    ? `About ${estimateComparisonsFor(rankedNames.length, queuedNames.length)} matchups to rank ${queuedNames.length === 1 ? "this addition" : "these additions"} against your board.`
    : "Add players above, then rank them in against your current board.";
  elements.rankAdditionsButton.disabled = queuedNames.length === 0;
  elements.rankAdditionsButton.textContent = queuedNames.length
    ? `Rank ${queuedNames.length} addition${queuedNames.length === 1 ? "" : "s"} against your board`
    : "Rank additions against your board";
  elements.clearPositionButton.disabled = rankedNames.length === 0;

  const totalRanked = POSITIONS.reduce((sum, position) => sum + rankings[position].length, 0);
  elements.exportButton.disabled = totalRanked === 0;
  elements.exportButton.textContent = `Export to Excel (${totalRanked} ranked)`;
}

elements.positionControl.addEventListener("change", (event) => {
  if (event.target.name !== "position") return;
  activePosition = event.target.value;
  elements.poolSearch.value = "";
  renderBoard();
});

elements.poolSearch.addEventListener("input", renderBoard);

elements.poolList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-name]");
  if (!button) return;
  queues[activePosition].add(button.dataset.name);
  renderBoard();
});

elements.queueList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-name]");
  if (!button) return;
  queues[activePosition].delete(button.dataset.name);
  renderBoard();
});

elements.rankedList.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".remove-button");
  if (removeButton) {
    const name = removeButton.dataset.name;
    rankings[activePosition] = rankings[activePosition].filter((candidate) => candidate !== name);
    saveRankings();
    renderBoard();
    return;
  }

  const moveButton = event.target.closest("[data-action]");
  if (!moveButton) return;
  const index = Number(moveButton.dataset.index);
  if (moveButton.dataset.action === "move-up") reorderRanking(index, index - 1);
  if (moveButton.dataset.action === "move-down") reorderRanking(index, index + 1);
});

function stripCloneSemantics(element) {
  element.removeAttribute("id");
  element.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
  element.querySelectorAll("button, input").forEach((control) => {
    control.tabIndex = -1;
  });
}

function activatePointerDrag() {
  if (!pointerDrag || pointerDrag.active) return;
  const rect = pointerDrag.source.getBoundingClientRect();
  const preview = pointerDrag.source.cloneNode(true);
  stripCloneSemantics(preview);
  preview.classList.remove("is-dragging", "drop-before", "drop-after");
  preview.classList.add("drag-preview");
  preview.setAttribute("aria-hidden", "true");
  Object.assign(preview.style, {
    position: "fixed",
    zIndex: "1000",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
  });
  document.body.append(preview);

  pointerDrag.active = true;
  pointerDrag.preview = preview;
  pointerDrag.distance = rect.height;
  pointerDrag.source.classList.add("is-dragging", "drag-placeholder");
  pointerDrag.parent.classList.add("has-active-drag");
  document.body.classList.add("is-pointer-dragging");
}

function autoScrollForDrag(clientY) {
  if (!pointerDrag?.active) return;
  const scrollParent = pointerDrag.parent;
  if (scrollParent.scrollHeight <= scrollParent.clientHeight + 1) return;
  const rect = scrollParent.getBoundingClientRect();
  const edge = Math.min(42, rect.height / 4);
  if (clientY < rect.top + edge) scrollParent.scrollTop -= 12;
  if (clientY > rect.bottom - edge) scrollParent.scrollTop += 12;
}

function updatePointerDropTarget(clientX, clientY) {
  if (!pointerDrag?.active) return;
  const parentRect = pointerDrag.parent.getBoundingClientRect();
  if (
    clientX < parentRect.left - 24
    || clientX > parentRect.right + 24
    || clientY < parentRect.top - 36
    || clientY > parentRect.bottom + 36
  ) return;

  const items = pointerDrag.items;
  const candidates = items.filter((item) => item !== pointerDrag.source);
  let targetIndex = candidates.length;
  for (let index = 0; index < candidates.length; index += 1) {
    const rect = candidates[index].getBoundingClientRect();
    const unshiftedMidpoint = rect.top + rect.height / 2
      - Number.parseFloat(candidates[index].style.getPropertyValue("--drag-shift") || "0");
    if (clientY < unshiftedMidpoint) {
      targetIndex = index;
      break;
    }
  }
  pointerDrag.targetIndex = targetIndex;

  const shiftDistance = pointerDrag.distance;
  items.forEach((item, index) => {
    let shift = 0;
    if (targetIndex < pointerDrag.fromIndex && index >= targetIndex && index < pointerDrag.fromIndex) {
      shift = shiftDistance;
    } else if (
      targetIndex > pointerDrag.fromIndex
      && index > pointerDrag.fromIndex
      && index <= targetIndex
    ) {
      shift = -shiftDistance;
    }
    item.style.setProperty("--drag-shift", `${shift}px`);
    item.classList.toggle("is-drag-shifting", shift !== 0);
    item.classList.remove("drop-before", "drop-after");
  });

  const marker = candidates[targetIndex] ?? candidates.at(-1);
  if (marker) marker.classList.add(targetIndex < candidates.length ? "drop-before" : "drop-after");
}

elements.rankedList.addEventListener("pointerdown", (event) => {
  if (
    pointerDrag
    || !event.isPrimary
    || (event.pointerType === "mouse" && event.button !== 0)
  ) return;
  const handle = event.target.closest(".drag-handle");
  if (!handle) return;
  const source = handle.closest(".ranked-row");
  const parent = elements.rankedList;
  if (!source) return;

  pointerDrag = {
    pointerId: event.pointerId,
    handle,
    source,
    parent,
    items: [...parent.querySelectorAll(".ranked-row")],
    fromIndex: Number(handle.dataset.index),
    targetIndex: Number(handle.dataset.index),
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    preview: null,
  };
  handle.setPointerCapture?.(event.pointerId);
});

window.addEventListener("pointermove", (event) => {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  const deltaX = event.clientX - pointerDrag.startX;
  const deltaY = event.clientY - pointerDrag.startY;
  if (!pointerDrag.active && Math.hypot(deltaX, deltaY) < 5) return;

  event.preventDefault();
  activatePointerDrag();
  pointerDrag.preview.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1.02)`;
  autoScrollForDrag(event.clientY);
  updatePointerDropTarget(event.clientX, event.clientY);
}, { passive: false });

function finishPointerReorder(event, { cancelled = false } = {}) {
  if (!pointerDrag || (event?.pointerId !== undefined && event.pointerId !== pointerDrag.pointerId)) return;
  const currentDrag = pointerDrag;
  pointerDrag = null;
  currentDrag.handle.releasePointerCapture?.(currentDrag.pointerId);

  currentDrag.items.forEach((item) => {
    item.classList.remove("is-dragging", "drag-placeholder", "is-drag-shifting", "drop-before", "drop-after");
    item.style.removeProperty("--drag-shift");
  });
  currentDrag.parent.classList.remove("has-active-drag");
  document.body.classList.remove("is-pointer-dragging");
  currentDrag.preview?.remove();

  if (!cancelled && currentDrag.active && currentDrag.targetIndex !== currentDrag.fromIndex) {
    reorderRanking(currentDrag.fromIndex, currentDrag.targetIndex);
  }
}

window.addEventListener("pointerup", (event) => finishPointerReorder(event));
window.addEventListener("pointercancel", (event) => finishPointerReorder(event, { cancelled: true }));

elements.clearPositionButton.addEventListener("click", () => {
  if (!rankings[activePosition].length) return;
  if (!confirm(`Clear your entire ${activePosition} ranking? This can't be undone.`)) return;
  rankings[activePosition] = [];
  saveRankings();
  renderBoard();
});

function updateProgress() {
  const pct = comparisonsTotal ? Math.min(100, Math.round((comparisonsDone / comparisonsTotal) * 100)) : 0;
  elements.progressFill.style.width = `${pct}%`;
  elements.progressLabel.textContent = `${pct}%`;
}

function askUser(candidate, incumbent, incumbentRank) {
  return new Promise((resolve) => {
    elements.cardCandidate.textContent = candidate;
    elements.cardIncumbent.textContent = incumbent;
    elements.incumbentRankLabel.textContent = `Currently #${incumbentRank}`;
    elements.cardCandidate.classList.remove("chosen", "rejected");
    elements.cardIncumbent.classList.remove("chosen", "rejected");
    resolveCompare = resolve;
  });
}

elements.cardCandidate.addEventListener("click", () => {
  if (!resolveCompare) return;
  elements.cardCandidate.classList.add("chosen");
  elements.cardIncumbent.classList.add("rejected");
  const resolve = resolveCompare;
  resolveCompare = null;
  setTimeout(() => resolve(-1), 110);
});

elements.cardIncumbent.addEventListener("click", () => {
  if (!resolveCompare) return;
  elements.cardIncumbent.classList.add("chosen");
  elements.cardCandidate.classList.add("rejected");
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
  if (resolveCompare) {
    const resolve = resolveCompare;
    resolveCompare = null;
    resolve(CANCELLED);
  }
});

// Binary-inserts `candidate` into the already-sorted `list` (best first),
// comparing it only against the players already in place — previously
// settled matchups are never revisited.
async function insertCandidate(list, candidate, position) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const outcome = await askUser(candidate, list[mid], mid + 1);
    if (outcome === CANCELLED) throw CANCELLED;
    comparisonsDone++;
    updateProgress();
    if (outcome < 0) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  list.splice(lo, 0, candidate);
}

async function rankQueuedAdditions() {
  const position = activePosition;
  const queue = [...queues[position]];
  if (!queue.length) return;

  comparisonsDone = 0;
  comparisonsTotal = estimateComparisonsFor(rankings[position].length, queue.length);
  elements.duelPositionLabel.textContent = `Ranking ${position} additions`;
  updateProgress();
  showScreen(elements.duelScreen);

  try {
    for (const candidate of queue) {
      await insertCandidate(rankings[position], candidate, position);
      queues[position].delete(candidate);
      saveRankings();
    }
  } catch (error) {
    if (error !== CANCELLED) throw error;
  }

  showScreen(elements.boardScreen);
  renderBoard();
}

elements.rankAdditionsButton.addEventListener("click", rankQueuedAdditions);

function exportRankings() {
  const sheets = POSITIONS
    .filter((position) => rankings[position].length)
    .map((position) => ({
      name: position,
      rows: [
        ["Rank", "Player", "Team"],
        ...rankings[position].map((name, index) => [index + 1, name, teamFor(position, name)]),
      ],
    }));
  if (!sheets.length) return;

  const blob = buildXlsxBlob(sheets);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "duel-ranker-rankings.xlsx";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

elements.exportButton.addEventListener("click", exportRankings);

renderBoard();
