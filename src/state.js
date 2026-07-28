import {
  DEFAULT_PLAYER_POOL,
  DEFAULT_SCORING_FORMAT,
  EXCLUDED_PLAYER_NAMES,
  POSITIONS,
  SCORING_FORMATS,
  SLOT_POSITIONS,
} from "./data.js";

export const STATE_VERSION = 3;
export const STORAGE_KEY = "lineupPpgCalc_state_v3";
export const LEGACY_STATE_KEYS = Object.freeze(["lineupPpgCalc_state_v2"]);
export const LEGACY_KEYS = Object.freeze({
  rankings: ["lineupPpgCalc_rankings_v1", "ffRankings"],
  pool: ["lineupPpgCalc_pool_v1", "ffPool"],
  slots: ["lineupPpgCalc_slots_v1", "ffSlots"],
  lineupMode: ["lineupPpgCalc_mode_v1", "ffMode"],
});

const MAX_PLAYERS_PER_POSITION = 500;
const MAX_SLOTS = 50;
const MAX_NAME_LENGTH = 100;
const EXCLUDED_NAME_KEYS = Object.freeze(Object.fromEntries(POSITIONS.map((position) => [
  position,
  new Set(EXCLUDED_PLAYER_NAMES[position].map((name) => name.toLocaleLowerCase())),
])));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const seen = new Set();
  for (const candidate of value.slice(0, MAX_PLAYERS_PER_POSITION)) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim().slice(0, MAX_NAME_LENGTH);
    const key = name.toLocaleLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      output.push(name);
    }
  }
  return output;
}

function createSlotId(index = 0) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `slot-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultSlots() {
  return [
    { pos: "QB" },
    { pos: "RB" },
    { pos: "RB" },
    { pos: "WR" },
    { pos: "WR" },
    { pos: "TE" },
    { pos: "FLEX", flexPos: "RB" },
  ].map((slot, index) => normalizeSlot(slot, index));
}

export function createDefaultState() {
  return {
    version: STATE_VERSION,
    rankings: Object.fromEntries(POSITIONS.map((position) => [position, []])),
    pool: clone(DEFAULT_PLAYER_POOL),
    slots: createDefaultSlots(),
    lineupMode: "player",
    settings: {
      teams: 12,
      flexRbShare: 50,
      scoringFormat: DEFAULT_SCORING_FORMAT,
    },
    leagueId: "",
    leagueSortMetric: "ppg",
  };
}

const MAX_LEAGUE_ID_LENGTH = 25;

export function normalizeLeagueId(value) {
  return typeof value === "string" ? value.trim().replace(/[^0-9]/g, "").slice(0, MAX_LEAGUE_ID_LENGTH) : "";
}

export function normalizeSlot(candidate, index = 0) {
  const input = candidate && typeof candidate === "object" ? candidate : {};
  const pos = SLOT_POSITIONS.includes(input.pos) ? input.pos : "QB";
  const flexPos = input.flexPos === "WR" ? "WR" : "RB";
  const rankNumber = Number(input.rank);
  const rank = Number.isInteger(rankNumber) && rankNumber > 0 && rankNumber <= 999
    ? rankNumber
    : null;

  let player = null;
  if (input.player && typeof input.player === "object") {
    const name = typeof input.player.name === "string"
      ? input.player.name.trim().slice(0, MAX_NAME_LENGTH)
      : "";
    const position = POSITIONS.includes(input.player.position)
      ? input.player.position
      : (pos === "FLEX" ? null : pos);
    if (name && position && (pos !== "FLEX" || ["RB", "WR"].includes(position))) {
      player = { name, position };
    }
  } else if (typeof input.player === "string" && input.player.trim()) {
    // Version 1 stored player names without a position.
    player = {
      name: input.player.trim().slice(0, MAX_NAME_LENGTH),
      position: pos === "FLEX" ? flexPos : pos,
    };
  }

  return {
    id: typeof input.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(input.id)
      ? input.id
      : createSlotId(index),
    pos,
    player,
    rank,
    flexPos,
  };
}

function normalizePlayerCollections(inputRankings, inputPool, { backfillDefaults }) {
  const rankings = {};
  const pool = {};

  for (const position of POSITIONS) {
    // A player leaving the bundled pool (e.g. becoming a free agent, or genuinely retiring)
    // should stop being offered to new users, but must never silently erase a ranking someone
    // already saved — that's the user's own data, not the app's to prune.
    const isEligible = (name) => !EXCLUDED_NAME_KEYS[position].has(name.toLocaleLowerCase());
    rankings[position] = uniqueStrings(inputRankings?.[position]);
    const rankedNames = new Set(rankings[position].map((name) => name.toLocaleLowerCase()));
    pool[position] = uniqueStrings(inputPool?.[position])
      .filter(isEligible)
      .filter((name) => !rankedNames.has(name.toLocaleLowerCase()));

    if (backfillDefaults) {
      const known = new Set([...rankings[position], ...pool[position]].map((name) => name.toLocaleLowerCase()));
      for (const name of DEFAULT_PLAYER_POOL[position]) {
        if (!known.has(name.toLocaleLowerCase())) {
          pool[position].push(name);
          known.add(name.toLocaleLowerCase());
        }
      }
    }
  }

  return { rankings, pool };
}

export function normalizeState(candidate, options = {}) {
  const input = candidate && typeof candidate === "object" ? candidate : {};
  const defaults = createDefaultState();
  const { rankings, pool } = normalizePlayerCollections(
    input.rankings,
    input.pool,
    { backfillDefaults: options.backfillDefaults ?? false },
  );
  const teams = Number(input.settings?.teams);
  const flexRbShare = Number(input.settings?.flexRbShare);
  const slots = Array.isArray(input.slots)
    ? input.slots.slice(0, MAX_SLOTS).map(normalizeSlot)
    : defaults.slots;
  const slotIds = new Set();
  slots.forEach((slot, index) => {
    if (slotIds.has(slot.id)) slot.id = createSlotId(index);
    slotIds.add(slot.id);
  });

  return {
    version: STATE_VERSION,
    rankings,
    pool,
    slots,
    lineupMode: input.lineupMode === "rank" ? "rank" : "player",
    settings: {
      teams: Number.isInteger(teams) && teams >= 2 && teams <= 32 ? teams : defaults.settings.teams,
      flexRbShare: Number.isFinite(flexRbShare) && flexRbShare >= 0 && flexRbShare <= 100
        ? Math.round(flexRbShare)
        : defaults.settings.flexRbShare,
      scoringFormat: Object.hasOwn(SCORING_FORMATS, input.settings?.scoringFormat)
        ? input.settings.scoringFormat
        : defaults.settings.scoringFormat,
    },
    leagueId: normalizeLeagueId(input.leagueId),
    leagueSortMetric: input.leagueSortMetric === "vor" ? "vor" : "ppg",
  };
}

export function validateImport(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, errors: ["The backup must contain a JSON object."], state: null };
  }

  if (![1, 2, STATE_VERSION, undefined].includes(candidate.version)) {
    errors.push(`Unsupported backup version: ${String(candidate.version)}.`);
  }
  if (!candidate.rankings || typeof candidate.rankings !== "object") {
    errors.push("The backup is missing rankings.");
  }
  if (!candidate.pool || typeof candidate.pool !== "object") {
    errors.push("The backup is missing the player pool.");
  }
  if (!Array.isArray(candidate.slots)) {
    errors.push("The backup is missing a valid slots array.");
  } else if (candidate.slots.length > MAX_SLOTS) {
    errors.push(`A backup cannot contain more than ${MAX_SLOTS} lineup slots.`);
  }
  if (candidate.lineupMode !== undefined && !["player", "rank"].includes(candidate.lineupMode)) {
    errors.push("The lineup mode must be player or rank.");
  }
  if (candidate.leagueId !== undefined && typeof candidate.leagueId !== "string") {
    errors.push("The League ID must be a string.");
  }
  if (candidate.leagueSortMetric !== undefined && !["ppg", "vor"].includes(candidate.leagueSortMetric)) {
    errors.push("The league sort metric must be ppg or vor.");
  }
  if (
    candidate.settings?.scoringFormat !== undefined
    && !Object.hasOwn(SCORING_FORMATS, candidate.settings.scoringFormat)
  ) {
    errors.push("The scoring format is invalid.");
  }

  for (const collectionName of ["rankings", "pool"]) {
    const collection = candidate[collectionName];
    if (!collection || typeof collection !== "object") continue;
    for (const position of POSITIONS) {
      if (collection[position] !== undefined && !Array.isArray(collection[position])) {
        errors.push(`${collectionName}.${position} must be an array.`);
        continue;
      }
      if (collection[position]?.length > MAX_PLAYERS_PER_POSITION) {
        errors.push(`${collectionName}.${position} contains too many players.`);
      }
      if (collection[position]?.some((name) => typeof name !== "string")) {
        errors.push(`${collectionName}.${position} must contain only player names.`);
      }
      if (collection[position]?.some((name) => typeof name === "string" && name.length > MAX_NAME_LENGTH)) {
        errors.push(`${collectionName}.${position} contains a player name longer than ${MAX_NAME_LENGTH} characters.`);
      }
    }
  }

  candidate.slots?.forEach((slot, index) => {
    if (!slot || typeof slot !== "object") {
      errors.push(`Slot ${index + 1} is not an object.`);
      return;
    }
    if (!SLOT_POSITIONS.includes(slot.pos)) errors.push(`Slot ${index + 1} has an invalid position.`);
    if (slot.flexPos !== undefined && slot.flexPos !== null && !["RB", "WR"].includes(slot.flexPos)) {
      errors.push(`Slot ${index + 1} has an invalid FLEX position.`);
    }
    if (slot.rank !== undefined && slot.rank !== null && slot.rank !== "") {
      const rank = Number(slot.rank);
      if (!Number.isInteger(rank) || rank < 1 || rank > 999) {
        errors.push(`Slot ${index + 1} has an invalid rank.`);
      }
    }
    if (typeof slot.player === "string") {
      if (!slot.player.trim() || slot.player.length > MAX_NAME_LENGTH) {
        errors.push(`Slot ${index + 1} has an invalid player name.`);
      }
    } else if (slot.player !== undefined && slot.player !== null) {
      if (typeof slot.player !== "object" || Array.isArray(slot.player)) {
        errors.push(`Slot ${index + 1} has an invalid player selection.`);
      } else {
        if (typeof slot.player.name !== "string" || !slot.player.name.trim() || slot.player.name.length > MAX_NAME_LENGTH) {
          errors.push(`Slot ${index + 1} has an invalid player name.`);
        }
        if (!POSITIONS.includes(slot.player.position)) {
          errors.push(`Slot ${index + 1} has an invalid player position.`);
        }
        if (slot.pos === "FLEX" && !["RB", "WR"].includes(slot.player.position)) {
          errors.push(`Slot ${index + 1} contains a player who is not FLEX eligible.`);
        }
      }
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    state: errors.length ? null : normalizeState(candidate),
  };
}

export function readLegacyState(storage) {
  const readFirst = (keys) => {
    for (const key of keys) {
      try {
        const raw = storage.getItem(key);
        if (raw !== null) return JSON.parse(raw);
      } catch {
        // Continue to the next legacy key.
      }
    }
    return null;
  };

  const wholeState = readFirst(LEGACY_STATE_KEYS);
  if (wholeState && typeof wholeState === "object") {
    return normalizeState(wholeState, { backfillDefaults: true });
  }

  const legacy = {
    rankings: readFirst(LEGACY_KEYS.rankings),
    pool: readFirst(LEGACY_KEYS.pool),
    slots: readFirst(LEGACY_KEYS.slots),
    lineupMode: readFirst(LEGACY_KEYS.lineupMode),
  };
  const hasLegacyData = Object.values(legacy).some((value) => value !== null);
  return hasLegacyData ? normalizeState(legacy, { backfillDefaults: true }) : null;
}

export function loadState(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw), { backfillDefaults: true });
  } catch {
    // Fall through to legacy migration or defaults.
  }
  return readLegacyState(storage) ?? createDefaultState();
}

export function saveState(storage, state) {
  const normalized = normalizeState(state);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function exportState(state) {
  return JSON.stringify(normalizeState(state), null, 2);
}

export function copyState(state) {
  return clone(state);
}
