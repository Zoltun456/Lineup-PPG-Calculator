import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoricalDataset,
  currentRosterSeason,
  defaultSeasons,
  excludedSleeperPlayerNames,
  parseCsv,
  selectSleeperPlayers,
} from "../scripts/collect-data.mjs";

test("CSV parser handles quoted commas, escaped quotes, and newlines", () => {
  const rows = parseCsv('name,note,value\r\n"Smith, Jr.","said ""hi""",3\r\nAlpha,"two\nlines",4\r\n');
  assert.deepEqual(rows, [
    { name: "Smith, Jr.", note: 'said "hi"', value: "3" },
    { name: "Alpha", note: "two\nlines", value: "4" },
  ]);
});

test("default seasons select the five completed seasons conservatively", () => {
  assert.deepEqual(defaultSeasons(new Date("2026-07-27T12:00:00Z")), [2021, 2022, 2023, 2024, 2025]);
  assert.deepEqual(defaultSeasons(new Date("2026-01-15T12:00:00Z")), [2020, 2021, 2022, 2023, 2024]);
});

test("current roster season follows the NFL offseason boundary", () => {
  assert.equal(currentRosterSeason(new Date("2026-07-27T12:00:00Z")), 2026);
  assert.equal(currentRosterSeason(new Date("2026-01-15T12:00:00Z")), 2025);
});

test("Sleeper selection requires a current roster match or free-agent relevance, and excludes retired records", () => {
  const player = {
    player_id: "1",
    gsis_id: "00-1",
    full_name: "Example Player",
    first_name: "Example",
    last_name: "Player",
    position: "QB",
    active: true,
    search_rank: 12,
    depth_chart_order: 1,
  };
  const inactive = { ...player, player_id: "2", full_name: "Inactive", active: false };
  const irrelevant = {
    ...player,
    player_id: "3",
    full_name: "Deep Reserve",
    search_rank: 999,
    depth_chart_order: 8,
  };
  const rosterRetired = {
    ...player,
    player_id: "5",
    gsis_id: "00-5",
    full_name: "Ceremonial Retiree",
    search_rank: 1,
  };
  const freeAgent = {
    ...player,
    player_id: "6",
    gsis_id: "00-6",
    full_name: "Available Veteran",
    search_rank: 50,
    depth_chart_order: null,
  };
  const obscureFreeAgent = {
    ...player,
    player_id: "7",
    gsis_id: "00-7",
    full_name: "Long Shot",
    search_rank: 400,
    depth_chart_order: null,
  };
  // Mirrors a real case: Sleeper's `active` flag stayed true for a legendary veteran years
  // after their actual final game, with a search rank still well inside the free-agent bar.
  const staleLegend = {
    ...player,
    player_id: "8",
    gsis_id: "00-8",
    full_name: "Old Legend",
    search_rank: 187,
    depth_chart_order: null,
    age: 38,
    years_exp: 17,
  };
  const currentRoster = [
    {
      season: 2026,
      team: "BUF",
      position: "QB",
      status: "ACT",
      name: player.full_name,
      sleeperId: player.player_id,
      gsisId: player.gsis_id,
      yearsExperience: 3,
      jerseyNumber: 7,
    },
    {
      season: 2026,
      team: "BUF",
      position: "QB",
      status: "ACT",
      name: inactive.full_name,
      sleeperId: inactive.player_id,
      gsisId: inactive.gsis_id,
    },
    {
      season: 2026,
      team: "BUF",
      position: "QB",
      status: "ACT",
      name: irrelevant.full_name,
      sleeperId: irrelevant.player_id,
      gsisId: irrelevant.gsis_id,
    },
    {
      season: 2026,
      team: "BUF",
      position: "QB",
      status: "RET",
      name: rosterRetired.full_name,
      sleeperId: rosterRetired.player_id,
      gsisId: rosterRetired.gsis_id,
    },
  ];
  const rawByPosition = {
    QB: {
      1: player,
      2: inactive,
      3: irrelevant,
      5: rosterRetired,
      6: freeAgent,
      7: obscureFreeAgent,
      8: staleLegend,
    },
  };
  const selected = selectSleeperPlayers(rawByPosition, currentRoster);
  const excluded = excludedSleeperPlayerNames(rawByPosition, selected);
  const selectedNames = selected.QB.map((entry) => entry.name).sort();

  assert.deepEqual(selectedNames, ["Available Veteran", "Example Player"]);
  const rostered = selected.QB.find((entry) => entry.name === "Example Player");
  assert.equal(rostered.gsisId, "00-1");
  assert.equal(rostered.team, "BUF");
  assert.equal(rostered.rosterStatus, "ACT");
  assert.equal(rostered.rosterSeason, 2026);
  const agent = selected.QB.find((entry) => entry.name === "Available Veteran");
  assert.equal(agent.team, null);
  assert.equal(agent.rosterSeason, null);
  assert.equal(agent.rosterStatus, null);
  assert.deepEqual(excluded.QB, ["Ceremonial Retiree", "Long Shot", "Old Legend"]);
  assert.deepEqual(selected.RB, []);
});

test("historical builder ranks by total points and averages rank PPG", () => {
  const seasons = [2024, 2025];
  const seasonRows = {};
  for (const season of seasons) {
    seasonRows[season] = [];
    for (const [position, depth] of Object.entries({ QB: 32, RB: 50, WR: 50, TE: 24 })) {
      for (let index = 0; index < depth; index += 1) {
        const points = 300 - index + (season - 2024) * 10;
        seasonRows[season].push({
          playerId: `${season}-${position}-${index}`,
          name: `${position} ${index}`,
          position,
          team: "TST",
          games: 10,
          receptions: position === "QB" ? 0 : 20,
          points: {
            standard: points,
            halfPpr: points + 10,
            ppr: points + 20,
          },
        });
      }
    }
  }

  const output = buildHistoricalDataset(seasonRows, seasons);
  assert.equal(output.details.standard.QB["2024"][0].name, "QB 0");
  assert.equal(output.averages.standard.QB[0], 30.5);
  assert.equal(output.averages.ppr.WR[0], 32.5);
  assert.equal(output.averages.halfPpr.TE.length, 24);
});
