import { calculateLineup } from "./calculator.js";
import {
  consensusRankingsFor,
  DATASET_META,
  PLAYER_DIRECTORY,
  POSITIONS,
  SCORING_FORMATS,
  SLOT_POSITIONS,
} from "./data.js";
import {
  copyState,
  createDefaultState,
  exportState,
  LEGACY_KEYS,
  LEGACY_STATE_KEYS,
  loadState,
  normalizeLeagueId,
  normalizeState,
  saveState,
  STORAGE_KEY,
  validateImport,
} from "./state.js";
import { computeLeaguePowerRankings, fetchLeagueRosterData } from "./sleeper.js";
import { DUEL_RANKINGS_STORAGE_KEY, loadDuelRankings } from "./duel-rankings.js";

const MAX_UNDO_STEPS = 30;
const elements = {
  status: document.querySelector("#status"),
  rankGrid: document.querySelector("#rankGrid"),
  lineupRows: document.querySelector("#lineupRows"),
  baselineSummary: document.querySelector("#baselineSummary"),
  baselineLabel: document.querySelector("#baselineLabel"),
  totalPpg: document.querySelector("#totalPpg"),
  totalVor: document.querySelector("#totalVor"),
  undoButton: document.querySelector("#undoButton"),
  clearRankingsButton: document.querySelector("#clearRankingsButton"),
  clearLineupButton: document.querySelector("#clearLineupButton"),
  addSlotButton: document.querySelector("#addSlotButton"),
  exportButton: document.querySelector("#exportButton"),
  importButton: document.querySelector("#importButton"),
  importFile: document.querySelector("#importFile"),
  teamsInput: document.querySelector("#teamsInput"),
  scoringFormatSelect: document.querySelector("#scoringFormatSelect"),
  flexShareInput: document.querySelector("#flexShareInput"),
  flexShareOutput: document.querySelector("#flexShareOutput"),
  lineupRankingSourceControl: document.querySelector("#lineupRankingSourceControl"),
  leagueRankingSourceControl: document.querySelector("#leagueRankingSourceControl"),
  datasetDetails: document.querySelector("#datasetDetails"),
  datasetLinks: document.querySelector("#datasetLinks"),
  resetButton: document.querySelector("#resetButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsCloseButton: document.querySelector("#settingsCloseButton"),
  leagueIdInput: document.querySelector("#leagueIdInput"),
  loadLeagueButton: document.querySelector("#loadLeagueButton"),
  leagueMessage: document.querySelector("#leagueMessage"),
  leagueResults: document.querySelector("#leagueResults"),
  leagueSeasonLabel: document.querySelector("#leagueSeasonLabel"),
  leagueNameLabel: document.querySelector("#leagueNameLabel"),
  leagueTeams: document.querySelector("#leagueTeams"),
  leagueCaveat: document.querySelector("#leagueCaveat"),
  confirmDialog: document.querySelector("#confirmDialog"),
  dialogTitle: document.querySelector("#dialogTitle"),
  dialogMessage: document.querySelector("#dialogMessage"),
  dialogConfirmButton: document.querySelector("#dialogConfirmButton"),
};

let state = loadState(localStorage);
let undoStack = [];
let activeTab = ["rankings", "lineup", "league"].includes(location.hash.slice(1))
  ? location.hash.slice(1)
  : "rankings";
let leagueData = null;
let leagueLoading = false;
let leagueError = null;
const expandedLeagueTeams = new Set();
let dragPayload = null;
let pointerDrag = null;
let activeViewTransition = null;
let statusTimer = null;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const searchTerms = Object.fromEntries(POSITIONS.map((position) => [position, ""]));
let duelRankings = loadDuelRankings();
const playerMetadata = new Map(POSITIONS.flatMap((position) => (
  PLAYER_DIRECTORY[position].map((player) => [
    `${position}\u0000${player.name.toLocaleLowerCase()}`,
    player,
  ])
)));

function metadataFor(position, name) {
  return playerMetadata.get(`${position}\u0000${name.toLocaleLowerCase()}`) ?? null;
}

function rankingsForSource(source, ownRankings) {
  return source === "consensus" ? consensusRankingsFor(state.settings.scoringFormat) : ownRankings;
}

function createElement(tagName, attributes = {}, children = []) {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "className") {
      element.className = value;
    } else if (name === "text") {
      element.textContent = value;
    } else if (name === "dataset") {
      Object.assign(element.dataset, value);
    } else if (name === "disabled") {
      element.disabled = Boolean(value);
    } else if (name in element && !name.startsWith("aria")) {
      element[name] = value;
    } else {
      element.setAttribute(name, String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function motionName(prefix, value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function renderWithMotion() {
  if (reducedMotion.matches || typeof document.startViewTransition !== "function") {
    renderAll();
    return;
  }
  activeViewTransition?.skipTransition?.();
  let transition;
  try {
    transition = document.startViewTransition(() => renderAll());
  } catch {
    activeViewTransition = null;
    renderAll();
    return;
  }
  activeViewTransition = transition;
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (activeViewTransition === transition) activeViewTransition = null;
    });
}

function pulseValue(element, value) {
  const changed = element.textContent !== value;
  element.textContent = value;
  if (!changed || reducedMotion.matches || !document.documentElement.classList.contains("motion-ready")) {
    return;
  }
  element.classList.remove("is-updating");
  void element.offsetWidth;
  element.classList.add("is-updating");
}

function iconButton({ label, symbol, action, position, index, disabled = false, className = "" }) {
  return createElement("button", {
    type: "button",
    className: `icon-button ${className}`.trim(),
    "aria-label": label,
    title: label,
    disabled,
    dataset: {
      action,
      ...(position ? { position } : {}),
      ...(index !== undefined ? { index: String(index) } : {}),
    },
  }, symbol);
}

function placeStatus(tabName = activeTab) {
  const host = elements.settingsDialog.open
    ? elements.settingsDialog.querySelector(".card-heading")
    : document.querySelector(`#panel-${tabName} .card-heading`);
  if (host && elements.status.parentElement !== host) host.append(elements.status);
}

function announce(message, { assertive = false } = {}) {
  clearTimeout(statusTimer);
  placeStatus();
  elements.status.textContent = message;
  elements.status.title = message;
  elements.status.setAttribute("aria-live", assertive ? "assertive" : "polite");
  elements.status.hidden = false;
  elements.status.classList.remove("is-showing");
  void elements.status.offsetWidth;
  elements.status.classList.add("is-showing");
  statusTimer = setTimeout(() => {
    elements.status.hidden = true;
    elements.status.classList.remove("is-showing");
  }, 5000);
}

function persist() {
  try {
    state = saveState(localStorage, state);
  } catch {
    announce("Changes could not be saved in this browser. Export a backup before leaving.", { assertive: true });
  }
}

function commit(message, mutator, { render = true } = {}) {
  undoStack.push(copyState(state));
  if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
  mutator(state);
  state = normalizeState(state);
  persist();
  if (render) renderWithMotion();
  announce(message);
}

function undo() {
  const previous = undoStack.pop();
  if (!previous) return;
  state = normalizeState(previous);
  persist();
  renderWithMotion();
  announce("Last change undone.");
}

function playerKey(player) {
  if (!player?.position || !player?.name) return "";
  return `${player.position}|${encodeURIComponent(player.name)}`;
}

function parsePlayerKey(value) {
  const separator = value.indexOf("|");
  if (separator < 0) return null;
  const position = value.slice(0, separator);
  try {
    const name = decodeURIComponent(value.slice(separator + 1));
    return POSITIONS.includes(position) && name ? { position, name } : null;
  } catch {
    return null;
  }
}

function positionLabel(position) {
  return position === "FLEX" ? "FLEX" : position;
}

function setActiveTab(tabName, { focus = false } = {}) {
  if (!["rankings", "lineup", "league"].includes(tabName)) return;
  const changed = activeTab !== tabName;
  activeTab = tabName;
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const selected = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  document.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${tabName}`;
    if (!panel.hidden && changed && !reducedMotion.matches) {
      panel.classList.remove("is-entering");
      void panel.offsetWidth;
      panel.classList.add("is-entering");
    }
  });
  if (!elements.status.hidden) placeStatus(tabName);
  if (location.hash !== `#${tabName}`) {
    history.replaceState(null, "", `#${tabName}`);
  }
  if (tabName === "league" && state.leagueId && !leagueData && !leagueLoading && !leagueError) {
    loadLeague();
  }
}

function renderRankings() {
  const columns = POSITIONS.map((position) => {
    const column = createElement("section", {
      className: "rank-column",
      dataset: { position },
      "aria-labelledby": `position-${position}`,
    });
    const heading = createElement("h3", {
      id: `position-${position}`,
      className: "position-heading",
    }, [
      createElement("span", { text: position }),
      createElement("small", { text: `${state.rankings[position].length} ranked` }),
    ]);

    const duelOrder = duelRankings[position];
    const duelImportButton = duelOrder?.length
      ? createElement("button", {
        type: "button",
        className: "button button-quiet duel-import-button",
        text: `Use Duel Ranker order (${duelOrder.length})`,
        title: `Reorder ${position} rankings using your saved Duel Ranker results`,
        dataset: { action: "duel-import", position },
      })
      : null;

    const rankedLabel = createElement("p", { className: "list-label", text: "Ranked players" });
    const rankList = createElement("div", {
      className: "rank-list",
      dataset: { position, dropzone: "rankings" },
      "aria-label": `${position} ranked players`,
      role: "list",
    });

    if (state.rankings[position].length === 0) {
      rankList.append(createElement("p", {
        className: "empty-list",
        text: "Add a player from the pool below.",
      }));
    } else {
      state.rankings[position].forEach((name, index) => {
        const handle = createElement("button", {
          type: "button",
          className: "drag-handle rank-drag-handle",
          "aria-label": `Drag ${name} to reorder`,
          title: "Drag to reorder",
          dataset: { position, index: String(index) },
        }, "⠿");
        const item = createElement("div", {
          className: "rank-item",
          dataset: { position, index: String(index) },
          role: "listitem",
        }, [
          handle,
          createElement("span", { className: "rank-number", text: String(index + 1) }),
          createElement("span", { className: "player-name", text: name, title: name }),
          iconButton({
            label: `Move ${name} up`,
            symbol: "↑",
            action: "rank-up",
            position,
            index,
            disabled: index === 0,
          }),
          iconButton({
            label: `Move ${name} down`,
            symbol: "↓",
            action: "rank-down",
            position,
            index,
            disabled: index === state.rankings[position].length - 1,
          }),
          iconButton({
            label: `Return ${name} to the player pool`,
            symbol: "×",
            action: "rank-remove",
            position,
            index,
            className: "remove-button",
          }),
        ]);
        item.style.viewTransitionName = motionName("player", `${position}|${name}`);
        item.style.setProperty("--item-index", String(index));
        rankList.append(item);
      });
    }

    const poolLabel = createElement("p", { className: "list-label", text: "Available player pool" });
    const poolList = createElement("div", {
      className: "pool-list",
      "aria-label": `${position} available players`,
      role: "list",
    });
    const term = searchTerms[position].trim().toLocaleLowerCase();
    const visiblePlayers = state.pool[position].filter((name) => name.toLocaleLowerCase().includes(term));

    if (visiblePlayers.length === 0) {
      poolList.append(createElement("p", {
        className: "empty-list",
        text: term ? "No players match this search." : "No available players.",
      }));
    } else {
      visiblePlayers.forEach((name) => {
        const originalIndex = state.pool[position].indexOf(name);
        const metadata = metadataFor(position, name);
        const item = createElement("div", {
          className: "pool-item",
          draggable: true,
          dataset: { position, index: String(originalIndex) },
          role: "listitem",
        }, [
          createElement("span", { className: "player-name", text: name, title: name }),
          metadata?.team
            ? createElement("span", {
              className: "team-badge",
              text: metadata.team,
              title: metadata.injuryStatus
                ? `${metadata.team} · ${metadata.injuryStatus}`
                : metadata.team,
            })
            : null,
          createElement("button", {
            type: "button",
            className: "add-player-button",
            text: "+ Rank",
            "aria-label": `Add ${name} to the end of ${position} rankings`,
            dataset: { action: "pool-add", position, index: String(originalIndex) },
          }),
        ]);
        item.style.setProperty("--item-index", String(originalIndex));
        poolList.append(item);
      });
    }

    const searchInput = createElement("input", {
      id: `pool-search-${position}`,
      className: "pool-search",
      type: "search",
      placeholder: `Search ${position} pool`,
      value: searchTerms[position],
      dataset: { action: "pool-search", position },
      "aria-label": `Search ${position} player pool`,
    });
    const addInput = createElement("input", {
      id: `add-player-${position}`,
      type: "text",
      maxlength: 100,
      placeholder: "Add missing player",
      dataset: { action: "custom-name", position },
      "aria-label": `New ${position} player name`,
    });
    const addButton = createElement("button", {
      type: "button",
      className: "button",
      text: "Add",
      dataset: { action: "custom-add", position },
      "aria-label": `Add a new ${position} player`,
    });
    const tools = createElement("div", { className: "pool-tools" }, [searchInput, addInput, addButton]);
    column.append(heading, ...(duelImportButton ? [duelImportButton] : []), rankedLabel, rankList, poolLabel, poolList, tools);
    return column;
  });

  elements.rankGrid.replaceChildren(...columns);
  elements.undoButton.disabled = undoStack.length === 0;
}

function createPositionSelect(slot, index) {
  const select = createElement("select", {
    id: `slot-position-${slot.id}`,
    className: "position-select",
    dataset: {
      action: "slot-position",
      index: String(index),
      position: slot.pos,
    },
  });
  SLOT_POSITIONS.forEach((position) => {
    select.append(createElement("option", {
      value: position,
      text: positionLabel(position),
      selected: slot.pos === position,
    }));
  });
  return select;
}

function createPlayerSelect(slot, index) {
  const select = createElement("select", {
    id: `slot-entry-${slot.id}`,
    dataset: { action: "slot-player", index: String(index) },
  });
  const eligiblePositions = slot.pos === "FLEX" ? ["RB", "WR"] : [slot.pos];
  const sourceRankings = rankingsForSource(state.lineupRankingSource, state.rankings);
  const options = eligiblePositions.flatMap((position) => (
    sourceRankings[position].map((name) => ({ position, name }))
  ));

  select.append(createElement("option", {
    value: "",
    text: options.length
      ? "Select a ranked player"
      : (state.lineupRankingSource === "consensus" ? "No consensus players available" : "Rank players first"),
  }));
  options.forEach((player) => {
    const metadata = metadataFor(player.position, player.name);
    const team = metadata?.team ? ` · ${metadata.team}` : "";
    select.append(createElement("option", {
      value: playerKey(player),
      text: slot.pos === "FLEX"
        ? `${player.position} · ${player.name}${team}`
        : `${player.name}${team}`,
      selected: playerKey(slot.player) === playerKey(player),
    }));
  });
  select.disabled = options.length === 0;
  return select;
}

function renderLineup() {
  const effectiveRankings = rankingsForSource(state.lineupRankingSource, state.rankings);
  const result = calculateLineup(state, undefined, effectiveRankings);
  const rows = state.slots.map((slot, index) => {
    const rowResult = result.rows[index];
    const row = createElement("div", {
      className: "lineup-row",
      dataset: { index: String(index), slotId: slot.id, position: slot.pos },
      role: "listitem",
    });
    const handle = createElement("button", {
      type: "button",
      className: "drag-handle slot-drag-handle",
      "aria-label": `Drag lineup slot ${index + 1} to reorder`,
      title: "Drag to reorder",
      dataset: { index: String(index) },
    }, "⠿");

    const positionSelect = createPositionSelect(slot, index);
    const positionField = createElement("div", { className: "lineup-field position-field" }, [
      createElement("label", { htmlFor: positionSelect.id, text: "Position" }),
      positionSelect,
    ]);
    const entry = createPlayerSelect(slot, index);
    const entryField = createElement("div", { className: "lineup-field entry-field" }, [
      createElement("label", { htmlFor: `slot-entry-${slot.id}`, text: "Player" }),
      entry,
    ]);
    if (rowResult.position && rowResult.rank) {
      entryField.append(createElement("span", {
        className: "entry-rank-badge",
        text: `${rowResult.position}${rowResult.rank}`,
      }));
    }

    const ppg = rowResult.ppg === null ? "–" : rowResult.ppg.toFixed(1);
    const vor = rowResult.vor === null ? "–" : rowResult.vor.toFixed(1);
    const ppgMetric = createElement("div", { className: "metric ppg-metric" }, [
      createElement("span", { className: "metric-label", text: "PPG" }),
      createElement("span", {
        className: `metric-value${rowResult.ppg === null ? " is-empty" : ""}`,
        text: ppg,
      }),
    ]);
    const vorMetric = createElement("div", { className: "metric vor-metric" }, [
      createElement("span", { className: "metric-label", text: "VOR" }),
      createElement("span", {
        className: `metric-value${rowResult.vor === null ? " is-empty" : ""}${rowResult.vor < 0 ? " is-negative" : ""}`,
        text: vor,
      }),
    ]);
    const actions = createElement("div", { className: "row-actions" }, [
      iconButton({
        label: `Move slot ${index + 1} up`,
        symbol: "↑",
        action: "slot-up",
        index,
        disabled: index === 0,
      }),
      iconButton({
        label: `Move slot ${index + 1} down`,
        symbol: "↓",
        action: "slot-down",
        index,
        disabled: index === state.slots.length - 1,
      }),
      iconButton({
        label: `Remove slot ${index + 1}`,
        symbol: "×",
        action: "slot-remove",
        index,
        className: "remove-button",
      }),
    ]);

    row.append(handle, positionField, entryField, ppgMetric, vorMetric, actions);
    row.style.viewTransitionName = motionName("slot", slot.id);
    row.style.setProperty("--item-index", String(index));
    if (rowResult.status === "duplicate") {
      row.append(createElement("p", {
        className: "row-message",
        text: "This player is already used in another lineup slot.",
      }));
    } else if (rowResult.rankWasCapped) {
      row.append(createElement("p", {
        className: "row-message is-note",
        text: `Rank ${rowResult.rank} exceeds the ${rowResult.position} dataset; rank ${rowResult.effectiveRank} is used.`,
      }));
    }
    return row;
  });

  if (rows.length === 0) {
    elements.lineupRows.replaceChildren(createElement("p", {
      className: "empty-list",
      text: "Your lineup has no slots. Add one below.",
    }));
  } else {
    elements.lineupRows.replaceChildren(...rows);
  }

  const baselineChips = POSITIONS.map((position) => {
    const baseline = result.baselines[position];
    const label = baseline.effectiveRank === null ? "—" : baseline.effectiveRank;
    const title = baseline.wasCapped
      ? `${position} requested replacement rank ${baseline.requestedRank}; capped to ${baseline.effectiveRank}`
      : `${position} replacement rank ${label}`;
    return createElement("span", {
      className: "baseline-chip",
      text: `${position} ${label}`,
      title,
      dataset: { position },
    });
  });
  elements.baselineSummary.replaceChildren(...baselineChips);
  elements.baselineLabel.textContent = `Replacement ranks · ${SCORING_FORMATS[state.settings.scoringFormat].label}`;
  pulseValue(elements.totalPpg, result.totalPpg.toFixed(1));
  pulseValue(elements.totalVor, result.totalVor.toFixed(1));
  document.querySelectorAll('input[name="lineupRankingSource"]').forEach((input) => {
    input.checked = input.value === state.lineupRankingSource;
  });
}

function renderSettings() {
  elements.teamsInput.value = String(state.settings.teams);
  elements.scoringFormatSelect.replaceChildren(...Object.entries(SCORING_FORMATS).map(([value, format]) => (
    createElement("option", {
      value,
      text: format.label,
      selected: state.settings.scoringFormat === value,
    })
  )));
  elements.flexShareInput.value = String(state.settings.flexRbShare);
  elements.flexShareOutput.value = `${state.settings.flexRbShare}%`;

  const generatedDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(DATASET_META.generatedAt));
  const details = [
    ["Dataset", DATASET_META.title],
    ["Seasons", DATASET_META.seasons],
    ["Scoring profiles", DATASET_META.scoringFormat],
    ["Source", DATASET_META.source],
    ["Finish ranking", DATASET_META.finishRank],
    ["Aggregation", DATASET_META.aggregation],
    ["Generated", generatedDate],
    ["Dataset ID", DATASET_META.id],
  ].map(([term, description]) => (
    createElement("div", {}, [
      createElement("dt", { text: term }),
      createElement("dd", { text: description }),
    ])
  ));
  elements.datasetDetails.replaceChildren(...details);
  elements.datasetLinks.replaceChildren(...DATASET_META.sourceLinks.map((source) => {
    const external = /^https?:/.test(source.url);
    return createElement("a", {
      href: source.url,
      text: source.label,
      ...(external ? { target: "_blank", rel: "noreferrer" } : {}),
    });
  }));
}

async function loadLeague() {
  const id = normalizeLeagueId(elements.leagueIdInput.value || state.leagueId);
  elements.leagueIdInput.value = id;
  if (!id) {
    leagueData = null;
    leagueError = "Enter a Sleeper League ID.";
    renderLeague();
    return;
  }

  leagueLoading = true;
  leagueError = null;
  renderLeague();
  try {
    leagueData = await fetchLeagueRosterData(id);
    expandedLeagueTeams.clear();
    if (id !== state.leagueId) {
      commit(`Loaded Sleeper league "${leagueData.leagueName}".`, (draft) => {
        draft.leagueId = id;
      }, { render: false });
    }
  } catch (error) {
    leagueData = null;
    leagueError = error instanceof Error ? error.message : "Could not load that league.";
  } finally {
    leagueLoading = false;
    renderLeague();
  }
}

function buildRosterRow(player, slotLabel) {
  if (!player) {
    return createElement("div", { className: "roster-player-row is-empty" }, [
      createElement("span", { className: "roster-slot-label", text: slotLabel }),
      createElement("span", { className: "roster-player-name is-empty-note", text: "Empty — no ranked player available" }),
    ]);
  }
  const isUnranked = player.rank === null;
  return createElement("div", { className: `roster-player-row${isUnranked ? " is-unranked" : ""}` }, [
    createElement("span", { className: "roster-slot-label", text: slotLabel }),
    createElement("span", { className: "roster-player-name", text: player.name }),
    createElement("span", {
      className: `roster-player-meta${isUnranked ? " is-unranked-badge" : ""}`,
      text: isUnranked ? "Not ranked" : `Rank ${player.rank} · ${player.ppg.toFixed(1)} PPG`,
    }),
  ]);
}

function renderLeague() {
  elements.leagueIdInput.value = state.leagueId || elements.leagueIdInput.value;

  if (leagueLoading) {
    elements.leagueMessage.textContent = "Loading league from Sleeper...";
    elements.leagueMessage.hidden = false;
    elements.leagueResults.hidden = true;
    return;
  }

  if (leagueError) {
    elements.leagueMessage.textContent = leagueError;
    elements.leagueMessage.hidden = false;
    elements.leagueResults.hidden = true;
    return;
  }

  if (!leagueData) {
    elements.leagueMessage.hidden = true;
    elements.leagueResults.hidden = true;
    return;
  }

  elements.leagueMessage.hidden = true;
  elements.leagueResults.hidden = false;

  const ranked = computeLeaguePowerRankings(leagueData, {
    rankings: rankingsForSource(state.leagueRankingSource, state.rankings),
    settings: state.settings,
  });
  const metric = state.leagueSortMetric;
  const metricKey = metric === "ppg" ? "totalPpg" : "totalVor";
  const sortedTeams = [...ranked.teams].sort((left, right) => right[metricKey] - left[metricKey]);

  elements.leagueNameLabel.textContent = ranked.leagueName;
  elements.leagueSeasonLabel.textContent = ranked.season ? `${ranked.season} season` : "Season";

  const rows = sortedTeams.map((team, index) => {
    const ppgIsPrimary = metric === "ppg";
    const benchSorted = [...team.bench].sort((left, right) => {
      if ((left.rank === null) !== (right.rank === null)) return left.rank === null ? -1 : 1;
      return (right.ppg ?? -Infinity) - (left.ppg ?? -Infinity);
    });

    return createElement("details", {
      className: "league-team",
      role: "listitem",
      dataset: { rosterId: String(team.rosterId) },
      open: expandedLeagueTeams.has(team.rosterId),
    }, [
      createElement("summary", { className: "league-team-summary" }, [
        createElement("span", { className: "league-team-rank", text: `#${index + 1}` }),
        createElement("span", { className: "league-team-name", text: team.teamName }),
        createElement("div", { className: "metric" }, [
          createElement("span", { className: "metric-label", text: "PPG" }),
          createElement("span", {
            className: `metric-value${ppgIsPrimary ? "" : " is-secondary"}`,
            text: team.totalPpg.toFixed(1),
          }),
        ]),
        createElement("div", { className: "metric" }, [
          createElement("span", { className: "metric-label", text: "VOR" }),
          createElement("span", {
            className: `metric-value${ppgIsPrimary ? " is-secondary" : ""}${team.totalVor < 0 ? " is-negative" : ""}`,
            text: team.totalVor.toFixed(1),
          }),
        ]),
        createElement("span", {
          className: "league-team-note",
          text: ppgIsPrimary
            ? `${team.filledSlots}/${team.totalSlots} starting slots filled`
            : `${team.rankedPlayers}/${team.totalPlayers} roster players ranked`,
        }),
      ]),
      createElement("div", { className: "league-team-roster" }, [
        createElement("div", { className: "roster-section" }, [
          createElement("h4", { text: "Starting lineup" }),
          ...team.starterSlots.map((slot) => buildRosterRow(slot.player, slot.slotType)),
        ]),
        createElement("div", { className: "roster-section" }, [
          createElement("h4", { text: "Bench" }),
          ...(benchSorted.length
            ? benchSorted.map((player) => buildRosterRow(player, player.position))
            : [createElement("p", { className: "roster-empty-note", text: "No bench players." })]),
        ]),
      ]),
    ]);
  });
  elements.leagueTeams.replaceChildren(...rows);

  if (ranked.unsupportedSlots.length) {
    elements.leagueCaveat.textContent = `This league uses slot types this app doesn't model (${ranked.unsupportedSlots.join(", ")}); they're left out of the replacement-rank baseline.`;
    elements.leagueCaveat.hidden = false;
  } else {
    elements.leagueCaveat.hidden = true;
  }

  document.querySelectorAll('input[name="leagueSortMetric"]').forEach((input) => {
    input.checked = input.value === metric;
  });
  document.querySelectorAll('input[name="leagueRankingSource"]').forEach((input) => {
    input.checked = input.value === state.leagueRankingSource;
  });
}

function renderAll() {
  renderRankings();
  renderLineup();
  renderSettings();
  renderLeague();
  setActiveTab(activeTab);
}

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

function returnRankedPlayerToPool(position, index) {
  const name = state.rankings[position][index];
  if (!name) return;
  commit(`${name} returned to the ${position} pool.`, (draft) => {
    draft.rankings[position].splice(index, 1);
    if (!draft.pool[position].some((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      draft.pool[position].push(name);
    }
    draft.slots.forEach((slot) => {
      if (slot.player?.position === position && slot.player.name === name) slot.player = null;
    });
  });
}

function addPoolPlayerToRankings(position, index, targetIndex = null) {
  const name = state.pool[position][index];
  if (!name) return;
  commit(`${name} added to ${position} rankings.`, (draft) => {
    draft.pool[position].splice(index, 1);
    const insertAt = targetIndex === null
      ? draft.rankings[position].length
      : Math.max(0, Math.min(targetIndex, draft.rankings[position].length));
    draft.rankings[position].splice(insertAt, 0, name);
  });
}

function applyDuelRanking(position) {
  const duelOrder = duelRankings[position];
  if (!duelOrder?.length) return;
  commit(`Applied your Duel Ranker order to ${position} rankings.`, (draft) => {
    const duelKeys = new Set(duelOrder.map((name) => name.toLocaleLowerCase()));
    const remainder = draft.rankings[position].filter((name) => !duelKeys.has(name.toLocaleLowerCase()));
    draft.rankings[position] = [...duelOrder, ...remainder];
  });
}

function addCustomPlayer(position) {
  const input = document.querySelector(`#add-player-${position}`);
  const name = input?.value.trim();
  if (!name) {
    announce("Enter a player name first.", { assertive: true });
    input?.focus();
    return;
  }
  const exists = [...state.rankings[position], ...state.pool[position]]
    .some((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (exists) {
    announce(`${name} is already in the ${position} player list.`, { assertive: true });
    input.select();
    return;
  }
  commit(`${name} added to the ${position} player pool.`, (draft) => {
    draft.pool[position].push(name);
  });
}

function updateSlot(index, updater, message = "Lineup updated.") {
  if (!state.slots[index]) return;
  commit(message, (draft) => updater(draft.slots[index]));
}

function clearDropIndicators() {
  document.querySelectorAll(".drop-before, .drop-after, .is-dragging").forEach((element) => {
    element.classList.remove("drop-before", "drop-after", "is-dragging");
  });
}

function stripCloneSemantics(element) {
  element.removeAttribute("id");
  element.removeAttribute("role");
  element.removeAttribute("aria-label");
  element.querySelectorAll("[id], [role], [aria-label]").forEach((child) => {
    child.removeAttribute("id");
    child.removeAttribute("role");
    child.removeAttribute("aria-label");
  });
  element.querySelectorAll("button, input, select, a").forEach((control) => {
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
    viewTransitionName: "none",
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
  if (scrollParent.scrollHeight > scrollParent.clientHeight + 1) {
    const rect = scrollParent.getBoundingClientRect();
    const edge = Math.min(42, rect.height / 4);
    if (clientY < rect.top + edge) scrollParent.scrollTop -= 12;
    if (clientY > rect.bottom - edge) scrollParent.scrollTop += 12;
    return;
  }
  const viewportEdge = 72;
  if (clientY < viewportEdge) window.scrollBy(0, -14);
  if (clientY > window.innerHeight - viewportEdge) window.scrollBy(0, 14);
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

function beginPointerReorder(event, {
  source,
  parent,
  itemSelector,
  fromIndex,
  onDrop,
}) {
  if (
    pointerDrag
    || !event.isPrimary
    || (event.pointerType === "mouse" && event.button !== 0)
    || !source
    || !parent
  ) return;
  const handle = event.currentTarget?.contains(event.target)
    ? event.target.closest(".drag-handle")
    : null;
  if (!handle) return;

  pointerDrag = {
    pointerId: event.pointerId,
    handle,
    source,
    parent,
    items: [...parent.querySelectorAll(itemSelector)],
    fromIndex,
    targetIndex: fromIndex,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    active: false,
    preview: null,
    onDrop,
  };
  handle.setPointerCapture?.(event.pointerId);
}

function movePointerReorder(event) {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  pointerDrag.currentX = event.clientX;
  pointerDrag.currentY = event.clientY;
  const deltaX = event.clientX - pointerDrag.startX;
  const deltaY = event.clientY - pointerDrag.startY;
  if (!pointerDrag.active && Math.hypot(deltaX, deltaY) < 5) return;

  event.preventDefault();
  activatePointerDrag();
  const tilt = Math.max(-1.5, Math.min(1.5, deltaX / 100));
  pointerDrag.preview.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) rotate(${tilt}deg) scale(1.018)`;
  autoScrollForDrag(event.clientY);
  updatePointerDropTarget(event.clientX, event.clientY);
}

function finishPointerReorder(event, { cancelled = false } = {}) {
  if (!pointerDrag || (event?.pointerId !== undefined && event.pointerId !== pointerDrag.pointerId)) return;
  const currentDrag = pointerDrag;
  pointerDrag = null;
  currentDrag.handle.releasePointerCapture?.(currentDrag.pointerId);
  if (currentDrag.active) event?.preventDefault();

  currentDrag.items.forEach((item) => {
    item.classList.remove(
      "is-dragging",
      "drag-placeholder",
      "is-drag-shifting",
      "drop-before",
      "drop-after",
    );
    item.style.removeProperty("--drag-shift");
  });
  currentDrag.parent.classList.remove("has-active-drag");
  document.body.classList.remove("is-pointer-dragging");

  if (currentDrag.preview) {
    currentDrag.preview.classList.add(
      cancelled || currentDrag.targetIndex === currentDrag.fromIndex
        ? "is-returning"
        : "is-releasing",
    );
    if (cancelled || currentDrag.targetIndex === currentDrag.fromIndex) {
      currentDrag.preview.style.transform = "translate3d(0, 0, 0) rotate(0) scale(1)";
    }
    setTimeout(() => currentDrag.preview.remove(), 190);
  }

  if (!cancelled && currentDrag.active && currentDrag.targetIndex !== currentDrag.fromIndex) {
    currentDrag.onDrop(currentDrag.targetIndex);
  }
}

function reorderRankedPlayer(position, fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const name = state.rankings[position][fromIndex];
  if (!name) return;
  commit(`${name} moved to rank ${toIndex + 1}.`, (draft) => {
    moveItem(draft.rankings[position], fromIndex, toIndex);
  });
}

function reorderSlot(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  commit(`Lineup slot moved to position ${toIndex + 1}.`, (draft) => {
    moveItem(draft.slots, fromIndex, toIndex);
  });
}

function confirmAction({ title, message, confirmLabel }) {
  elements.confirmDialog.returnValue = "";
  elements.dialogTitle.textContent = title;
  elements.dialogMessage.textContent = message;
  elements.dialogConfirmButton.textContent = confirmLabel;
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener("close", () => {
      resolve(elements.confirmDialog.returnValue === "confirm");
    }, { once: true });
  });
}

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) setActiveTab(tab.dataset.tab);
});

document.querySelector(".tabs").addEventListener("keydown", (event) => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  let nextIndex = currentIndex;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  setActiveTab(tabs[nextIndex].dataset.tab, { focus: true });
});

window.addEventListener("hashchange", () => {
  const requestedTab = location.hash.slice(1);
  if (["rankings", "lineup", "league"].includes(requestedTab)) setActiveTab(requestedTab);
});

window.addEventListener("storage", (event) => {
  if (event.key !== DUEL_RANKINGS_STORAGE_KEY) return;
  duelRankings = loadDuelRankings();
  renderRankings();
});

elements.settingsButton.addEventListener("click", () => {
  renderSettings();
  elements.settingsDialog.showModal();
});

elements.settingsCloseButton.addEventListener("click", () => {
  elements.settingsDialog.close();
});

elements.loadLeagueButton.addEventListener("click", () => {
  loadLeague();
});

elements.leagueIdInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadLeague();
  }
});

document.querySelectorAll('input[name="leagueSortMetric"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    commit(`Power rankings sorted by ${input.value.toUpperCase()}.`, (draft) => {
      draft.leagueSortMetric = input.value;
    });
  });
});

document.querySelectorAll('input[name="leagueRankingSource"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    commit(`Power rankings switched to ${input.value === "consensus" ? "consensus rankings" : "my rankings"}.`, (draft) => {
      draft.leagueRankingSource = input.value;
    });
  });
});

elements.leagueTeams.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLElement) || !details.matches(".league-team")) return;
  const rosterId = Number(details.dataset.rosterId);
  if (details.open) expandedLeagueTeams.add(rosterId);
  else expandedLeagueTeams.delete(rosterId);
}, true);

elements.rankGrid.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const { action, position } = control.dataset;
  const index = Number(control.dataset.index);
  if (!POSITIONS.includes(position)) return;

  if (action === "pool-add") addPoolPlayerToRankings(position, index);
  if (action === "rank-remove") returnRankedPlayerToPool(position, index);
  if (action === "rank-up") reorderRankedPlayer(position, index, index - 1);
  if (action === "rank-down") reorderRankedPlayer(position, index, index + 1);
  if (action === "custom-add") addCustomPlayer(position);
  if (action === "duel-import") applyDuelRanking(position);
});

elements.rankGrid.addEventListener("input", (event) => {
  if (event.target.dataset.action !== "pool-search") return;
  const { position } = event.target.dataset;
  searchTerms[position] = event.target.value;
  renderRankings();
  const replacement = document.querySelector(`#pool-search-${position}`);
  replacement?.focus();
  replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
});

elements.rankGrid.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.dataset.action === "custom-name") {
    event.preventDefault();
    addCustomPlayer(event.target.dataset.position);
  }
});

elements.rankGrid.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".rank-drag-handle");
  if (!handle) return;
  const source = handle.closest(".rank-item");
  const parent = source?.closest(".rank-list");
  const position = handle.dataset.position;
  const fromIndex = Number(handle.dataset.index);
  beginPointerReorder(event, {
    source,
    parent,
    itemSelector: ".rank-item",
    fromIndex,
    onDrop: (targetIndex) => reorderRankedPlayer(position, fromIndex, targetIndex),
  });
});

elements.rankGrid.addEventListener("dragstart", (event) => {
  const poolItem = event.target.closest(".pool-item");
  if (poolItem) {
    dragPayload = {
      type: "pool",
      position: poolItem.dataset.position,
      index: Number(poolItem.dataset.index),
    };
    poolItem.classList.add("is-dragging");
    if (event.dataTransfer) {
      const rect = poolItem.getBoundingClientRect();
      event.dataTransfer.setDragImage(
        poolItem,
        Math.max(0, Math.min(event.clientX - rect.left, rect.width)),
        Math.max(0, Math.min(event.clientY - rect.top, rect.height)),
      );
    }
  }
  if (dragPayload && event.dataTransfer) event.dataTransfer.effectAllowed = "move";
});

elements.rankGrid.addEventListener("dragover", (event) => {
  if (dragPayload?.type !== "pool") return;
  const rankList = event.target.closest(".rank-list");
  if (!rankList || rankList.dataset.position !== dragPayload.position) return;
  event.preventDefault();
  document.querySelectorAll(".rank-item.drop-before, .rank-item.drop-after").forEach((item) => {
    item.classList.remove("drop-before", "drop-after");
  });
  const item = event.target.closest(".rank-item");
  if (!item) return;
  const after = event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
  item.classList.toggle("drop-after", after);
  item.classList.toggle("drop-before", !after);
});

elements.rankGrid.addEventListener("drop", (event) => {
  if (!dragPayload) return;
  const rankList = event.target.closest(".rank-list");
  if (!rankList || rankList.dataset.position !== dragPayload.position) return;
  event.preventDefault();
  const item = event.target.closest(".rank-item");
  let targetIndex = state.rankings[dragPayload.position].length;
  if (item) {
    const after = event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
    targetIndex = Number(item.dataset.index) + (after ? 1 : 0);
  }

  const payload = dragPayload;
  clearDropIndicators();
  dragPayload = null;
  addPoolPlayerToRankings(payload.position, payload.index, targetIndex);
});

elements.rankGrid.addEventListener("dragend", () => {
  dragPayload = null;
  clearDropIndicators();
});

elements.lineupRows.addEventListener("change", (event) => {
  const action = event.target.dataset.action;
  const index = Number(event.target.dataset.index);
  if (!Number.isInteger(index) || !state.slots[index]) return;

  if (action === "slot-position") {
    updateSlot(index, (slot) => {
      slot.pos = event.target.value;
      slot.player = null;
      if (slot.pos !== "FLEX") slot.flexPos = "RB";
    });
  }
  if (action === "slot-player") {
    updateSlot(index, (slot) => {
      slot.player = parsePlayerKey(event.target.value);
    });
  }
});

elements.lineupRows.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const action = control.dataset.action;
  const index = Number(control.dataset.index);
  if (!Number.isInteger(index)) return;

  if (action === "slot-up") reorderSlot(index, index - 1);
  if (action === "slot-down") reorderSlot(index, index + 1);
  if (action === "slot-remove" && state.slots[index]) {
    commit(`Lineup slot ${index + 1} removed.`, (draft) => draft.slots.splice(index, 1));
  }
});

elements.lineupRows.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".slot-drag-handle");
  if (!handle) return;
  const source = handle.closest(".lineup-row");
  const fromIndex = Number(handle.dataset.index);
  beginPointerReorder(event, {
    source,
    parent: elements.lineupRows,
    itemSelector: ".lineup-row",
    fromIndex,
    onDrop: (targetIndex) => reorderSlot(fromIndex, targetIndex),
  });
});

window.addEventListener("pointermove", movePointerReorder, { passive: false });
window.addEventListener("pointerup", (event) => finishPointerReorder(event));
window.addEventListener("pointercancel", (event) => finishPointerReorder(event, { cancelled: true }));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pointerDrag) {
    finishPointerReorder(null, { cancelled: true });
    announce("Drag cancelled.");
  }
});

document.querySelectorAll('input[name="lineupRankingSource"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    commit(`Lineup player list switched to ${input.value === "consensus" ? "consensus rankings" : "my rankings"}.`, (draft) => {
      draft.lineupRankingSource = input.value;
    });
  });
});

elements.addSlotButton.addEventListener("click", () => {
  commit("A new lineup slot was added.", (draft) => {
    const freshSlot = normalizeState({
      rankings: draft.rankings,
      pool: draft.pool,
      slots: [{ pos: "FLEX", flexPos: "RB" }],
      settings: draft.settings,
    }).slots[0];
    draft.slots.push(freshSlot);
  });
});

elements.undoButton.addEventListener("click", undo);

elements.clearRankingsButton.addEventListener("click", async () => {
  const rankedCount = POSITIONS.reduce((sum, position) => sum + state.rankings[position].length, 0);
  if (!rankedCount) {
    announce("There are no rankings to clear.");
    return;
  }
  const confirmed = await confirmAction({
    title: "Clear all rankings?",
    message: "Ranked players will return to their position pools. Your lineup slots and settings will remain.",
    confirmLabel: "Clear rankings",
  });
  if (!confirmed) return;
  commit("All rankings were cleared.", (draft) => {
    POSITIONS.forEach((position) => {
      draft.pool[position] = [...draft.rankings[position], ...draft.pool[position]];
      draft.rankings[position] = [];
    });
    draft.slots.forEach((slot) => {
      slot.player = null;
    });
  });
});

elements.clearLineupButton.addEventListener("click", async () => {
  const confirmed = await confirmAction({
    title: "Clear lineup selections?",
    message: "All player selections will be cleared. Your lineup slot structure will remain.",
    confirmLabel: "Clear lineup",
  });
  if (!confirmed) return;
  commit("Lineup selections were cleared.", (draft) => {
    draft.slots.forEach((slot) => {
      slot.player = null;
    });
  });
});

elements.exportButton.addEventListener("click", () => {
  const blob = new Blob([exportState(state)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = createElement("a", {
    href: url,
    download: `lineup-ppg-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce("Calculator backup exported.");
});

elements.importButton.addEventListener("click", () => elements.importFile.click());

elements.importFile.addEventListener("change", async () => {
  const [file] = elements.importFile.files;
  elements.importFile.value = "";
  if (!file) return;
  if (file.size > 1_000_000) {
    announce("That backup is larger than the 1 MB import limit.", { assertive: true });
    return;
  }

  try {
    const parsed = JSON.parse(await file.text());
    const validation = validateImport(parsed);
    if (!validation.ok) {
      announce(`Backup rejected: ${validation.errors.slice(0, 3).join(" ")}`, { assertive: true });
      return;
    }
    const confirmed = await confirmAction({
      title: "Import this backup?",
      message: "The imported rankings, player pool, lineup, mode, and settings will replace the current calculator state. You can undo this once after importing.",
      confirmLabel: "Import backup",
    });
    if (!confirmed) return;
    undoStack.push(copyState(state));
    state = validation.state;
    persist();
    renderWithMotion();
    announce("Backup imported successfully.");
  } catch {
    announce("That file is not valid calculator JSON.", { assertive: true });
  }
});

elements.teamsInput.addEventListener("change", () => {
  const teams = Number(elements.teamsInput.value);
  if (!Number.isInteger(teams) || teams < 2 || teams > 32) {
    elements.teamsInput.value = String(state.settings.teams);
    announce("League size must be a whole number from 2 to 32.", { assertive: true });
    return;
  }
  commit(`League size changed to ${teams} teams.`, (draft) => {
    draft.settings.teams = teams;
  });
});

elements.scoringFormatSelect.addEventListener("change", () => {
  const scoringFormat = elements.scoringFormatSelect.value;
  if (!Object.hasOwn(SCORING_FORMATS, scoringFormat)) {
    renderSettings();
    announce("That scoring format is not available.", { assertive: true });
    return;
  }
  commit(`Scoring format changed to ${SCORING_FORMATS[scoringFormat].label}.`, (draft) => {
    draft.settings.scoringFormat = scoringFormat;
  });
});

elements.flexShareInput.addEventListener("input", () => {
  elements.flexShareOutput.value = `${elements.flexShareInput.value}%`;
  elements.flexShareOutput.classList.remove("is-updating");
  void elements.flexShareOutput.offsetWidth;
  elements.flexShareOutput.classList.add("is-updating");
});

elements.flexShareInput.addEventListener("change", () => {
  const share = Number(elements.flexShareInput.value);
  commit(`FLEX running back allocation changed to ${share}%.`, (draft) => {
    draft.settings.flexRbShare = share;
  });
});

elements.resetButton.addEventListener("click", async () => {
  const confirmed = await confirmAction({
    title: "Reset all calculator data?",
    message: "This permanently removes the calculator data saved on this device. Export a backup first if you may want it later.",
    confirmLabel: "Reset everything",
  });
  if (!confirmed) return;

  try {
    localStorage.removeItem(STORAGE_KEY);
    LEGACY_STATE_KEYS.forEach((key) => localStorage.removeItem(key));
    Object.values(LEGACY_KEYS).flat().forEach((key) => localStorage.removeItem(key));
  } catch {
    // The in-memory reset can still proceed.
  }
  undoStack = [];
  state = createDefaultState();
  persist();
  activeTab = "rankings";
  elements.settingsDialog.close();
  renderWithMotion();
  announce("All calculator data was reset.");
});

// Persist once on startup so legacy state is migrated to the versioned key.
persist();
renderAll();
requestAnimationFrame(() => document.documentElement.classList.add("motion-ready"));
