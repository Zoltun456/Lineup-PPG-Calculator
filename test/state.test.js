import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PLAYER_POOL, EXCLUDED_PLAYER_NAMES, POSITIONS } from "../src/data.js";
import {
  createDefaultState,
  exportState,
  loadState,
  normalizeState,
  readLegacyState,
  saveState,
  STORAGE_KEY,
  validateImport,
} from "../src/state.js";

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("default state is complete and internally consistent", () => {
  const state = createDefaultState();

  assert.equal(state.version, 3);
  assert.equal(state.slots.length, 7);
  assert.equal(state.settings.teams, 12);
  assert.equal(state.settings.flexRbShare, 50);
  assert.equal(state.settings.scoringFormat, "ppr");
  POSITIONS.forEach((position) => {
    assert.deepEqual(state.rankings[position], []);
    assert.deepEqual(state.pool[position], DEFAULT_PLAYER_POOL[position]);
  });
});

test("export and import round-trip mode, FLEX position, and settings", () => {
  const state = createDefaultState();
  state.lineupMode = "rank";
  state.settings = { teams: 10, flexRbShare: 65, scoringFormat: "halfPpr" };
  state.slots = [{
    id: "flex-slot",
    pos: "FLEX",
    player: null,
    rank: 8,
    flexPos: "WR",
  }];

  const validation = validateImport(JSON.parse(exportState(state)));
  assert.equal(validation.ok, true);
  assert.equal(validation.state.lineupMode, "rank");
  assert.equal(validation.state.settings.teams, 10);
  assert.equal(validation.state.settings.flexRbShare, 65);
  assert.equal(validation.state.settings.scoringFormat, "halfPpr");
  assert.equal(validation.state.slots[0].flexPos, "WR");
  assert.equal(validation.state.slots[0].rank, 8);
});

test("malformed and injectable imports are rejected without returning state", () => {
  const candidate = {
    rankings: { QB: [42], RB: [], WR: [], TE: [] },
    pool: { QB: [], RB: [], WR: [], TE: [] },
    slots: [{
      pos: "\" autofocus onfocus=alert(1) x=\"",
      rank: "\" autofocus onfocus=alert(1) x=\"",
    }],
    lineupMode: "other",
  };

  const validation = validateImport(candidate);
  assert.equal(validation.ok, false);
  assert.equal(validation.state, null);
  assert.ok(validation.errors.length >= 4);
});

test("normalization removes collection duplicates and duplicate slot ids", () => {
  const state = normalizeState({
    rankings: { QB: ["Alpha", " alpha "], RB: [], WR: [], TE: [] },
    pool: { QB: ["ALPHA", "Bravo", "Bravo"], RB: [], WR: [], TE: [] },
    slots: [
      { id: "same", pos: "QB" },
      { id: "same", pos: "RB" },
    ],
    settings: { teams: 12, flexRbShare: 50 },
  });

  assert.deepEqual(state.rankings.QB, ["Alpha"]);
  assert.deepEqual(state.pool.QB, ["Bravo"]);
  assert.notEqual(state.slots[0].id, state.slots[1].id);
});

test("normalization prunes excluded names from the pool but preserves existing rankings and lineup slots", () => {
  const position = POSITIONS.find((candidate) => EXCLUDED_PLAYER_NAMES[candidate].length);
  const excludedName = EXCLUDED_PLAYER_NAMES[position][0];
  const state = normalizeState({
    rankings: { [position]: [excludedName, "Custom Prospect"] },
    pool: { [position]: [excludedName, "Another Custom Prospect"] },
    slots: [{
      id: "stale-player",
      pos: position,
      player: { name: excludedName, position },
    }],
    settings: { teams: 12, flexRbShare: 50, scoringFormat: "ppr" },
  });

  // A player dropping off the bundled pool (e.g. hitting free agency) shouldn't silently erase
  // a user's own saved ranking or lineup slot; only the default/backfilled pool prunes them.
  assert.deepEqual(state.rankings[position], [excludedName, "Custom Prospect"]);
  assert.deepEqual(state.pool[position], ["Another Custom Prospect"]);
  assert.deepEqual(state.slots[0].player, { name: excludedName, position });
});

test("legacy browser keys migrate player strings and backfill the default pool", () => {
  const storage = new MemoryStorage({
    lineupPpgCalc_rankings_v1: JSON.stringify({ QB: ["Alpha"], RB: [], WR: [], TE: [] }),
    lineupPpgCalc_pool_v1: JSON.stringify({ QB: [], RB: [], WR: [], TE: [] }),
    lineupPpgCalc_slots_v1: JSON.stringify([
      { pos: "QB", player: "Alpha", rank: null, flexPos: null },
      { pos: "FLEX", player: null, rank: "3", flexPos: "WR" },
    ]),
    lineupPpgCalc_mode_v1: JSON.stringify("player"),
  });

  const migrated = readLegacyState(storage);
  assert.deepEqual(migrated.slots[0].player, { name: "Alpha", position: "QB" });
  assert.equal(migrated.slots[1].flexPos, "WR");
  assert.equal(migrated.slots[1].rank, 3);
  assert.ok(migrated.pool.QB.includes("Josh Allen"));
});

test("version 2 state migrates to version 3 with the default scoring format", () => {
  const previous = createDefaultState();
  previous.version = 2;
  delete previous.settings.scoringFormat;
  const storage = new MemoryStorage({
    lineupPpgCalc_state_v2: JSON.stringify(previous),
  });

  const migrated = loadState(storage);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.settings.scoringFormat, "ppr");
});

test("corrupt current storage falls back safely to defaults", () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: "{not json" });
  const state = loadState(storage);

  assert.equal(state.version, 3);
  assert.equal(state.slots.length, 7);
});

test("saved state can be loaded from the single versioned storage key", () => {
  const storage = new MemoryStorage();
  const state = createDefaultState();
  state.lineupMode = "rank";
  saveState(storage, state);

  assert.ok(storage.getItem(STORAGE_KEY));
  assert.equal(loadState(storage).lineupMode, "rank");
});
