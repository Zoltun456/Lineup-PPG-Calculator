import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateLineup,
  clampRank,
  computeBaselines,
  ppgFor,
  rankOf,
  resolveSlot,
} from "../src/calculator.js";
import { consensusRankingsFor, HISTORICAL_PPG } from "../src/data.js";
import { createDefaultState } from "../src/state.js";

test("PPG lookup rejects invalid ranks and caps ranks beyond the dataset", () => {
  assert.equal(ppgFor("QB", 1), HISTORICAL_PPG.QB[0]);
  assert.equal(ppgFor("QB", 999), HISTORICAL_PPG.QB.at(-1));
  assert.equal(clampRank("TE", 999), 30);
  assert.equal(ppgFor("QB", 0), null);
  assert.equal(ppgFor("K", 1), null);
});

test("default lineup produces the documented 12-team replacement baselines", () => {
  const state = createDefaultState();
  const baselines = computeBaselines(state.slots, state.settings);

  assert.equal(baselines.QB.effectiveRank, 12);
  assert.equal(baselines.RB.effectiveRank, 30);
  assert.equal(baselines.WR.effectiveRank, 30);
  assert.equal(baselines.TE.effectiveRank, 12);
});

test("FLEX allocation and league size alter replacement ranks", () => {
  const slots = [{ pos: "FLEX" }, { pos: "RB" }];
  const baselines = computeBaselines(slots, { teams: 10, flexRbShare: 70 });

  assert.equal(baselines.RB.requestedRank, 17);
  assert.equal(baselines.WR.requestedRank, 3);
  assert.equal(baselines.QB.effectiveRank, null);
  assert.equal(baselines.TE.effectiveRank, null);
});

test("replacement baselines are capped and report that fact", () => {
  const slots = [{ pos: "TE" }, { pos: "TE" }, { pos: "TE" }];
  const baselines = computeBaselines(slots, { teams: 12, flexRbShare: 50 });

  assert.equal(baselines.TE.requestedRank, 36);
  assert.equal(baselines.TE.effectiveRank, 30);
  assert.equal(baselines.TE.wasCapped, true);
});

test("player slots resolve to a stable identity", () => {
  const rankings = { QB: ["Alpha"], RB: [], WR: ["Bravo"], TE: [] };
  assert.deepEqual(
    resolveSlot({ pos: "QB", player: { name: "Alpha", position: "QB" } }, rankings),
    { position: "QB", rank: 1, identity: "player:QB:Alpha" },
  );
  assert.equal(resolveSlot({ pos: "QB", player: null }, rankings), null);
  assert.equal(rankOf(rankings, "QB", "Missing"), null);
});

test("duplicate player selections do not inflate totals", () => {
  const state = createDefaultState();
  state.rankings.QB = ["Alpha"];
  state.slots = [
    { id: "one", pos: "QB", player: { name: "Alpha", position: "QB" }, flexPos: "RB" },
    { id: "two", pos: "QB", player: { name: "Alpha", position: "QB" }, flexPos: "RB" },
  ];

  const result = calculateLineup(state);
  assert.equal(result.rows[0].status, "valid");
  assert.equal(result.rows[1].status, "duplicate");
  assert.equal(result.totalPpg, HISTORICAL_PPG.QB[0]);
});

test("player rank beyond the dataset depth is capped and computes VOR", () => {
  const state = createDefaultState();
  state.rankings.TE = Array.from({ length: 31 }, (_, index) => `TE Player ${index + 1}`);
  state.slots = [
    { id: "one", pos: "TE", player: { name: "TE Player 31", position: "TE" }, flexPos: "RB" },
  ];

  const result = calculateLineup(state);
  assert.equal(result.rows[0].effectiveRank, 30);
  assert.equal(result.rows[0].rankWasCapped, true);
  assert.equal(result.rows[0].ppg, HISTORICAL_PPG.TE.at(-1));
  assert.ok(
    Math.abs(result.rows[0].vor - (HISTORICAL_PPG.TE.at(-1) - HISTORICAL_PPG.TE[11]))
      < Number.EPSILON * 8,
  );
});

test("selected scoring format changes lineup PPG", () => {
  const state = createDefaultState();
  state.rankings.WR = ["Solo"];
  state.slots = [
    { id: "one", pos: "WR", player: { name: "Solo", position: "WR" }, flexPos: "RB" },
  ];

  state.settings.scoringFormat = "standard";
  const standard = calculateLineup(state);
  state.settings.scoringFormat = "ppr";
  const ppr = calculateLineup(state);

  assert.ok(ppr.totalPpg > standard.totalPpg);
});

test("an explicit rankings override resolves independently of state.rankings", () => {
  const state = createDefaultState();
  state.slots = [
    { id: "one", pos: "QB", player: { name: "Josh Allen", position: "QB" }, flexPos: "RB" },
  ];

  const withOwnRankings = calculateLineup(state);
  assert.equal(withOwnRankings.rows[0].status, "empty");

  const consensusRankings = consensusRankingsFor(state.settings.scoringFormat);
  const withConsensus = calculateLineup(state, undefined, consensusRankings);
  assert.equal(withConsensus.rows[0].status, "valid");
  assert.equal(withConsensus.rows[0].rank, 1);
});
