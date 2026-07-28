import { computeBaselines, scoreRosterPlayers } from "./calculator.js";
import { PLAYER_DIRECTORY, POSITIONS, historicalPpgFor } from "./data.js";
import { normalizeLeagueId } from "./state.js";

const API_BASE = "https://api.sleeper.app/v1";
const LINEUP_SLOT_TYPES = new Set(["QB", "RB", "WR", "TE", "FLEX"]);
const OUT_OF_SCOPE_SLOT_TYPES = new Set(["BN", "K", "DEF"]);

const PLAYER_INDEX = new Map(
  POSITIONS.flatMap((position) => (
    PLAYER_DIRECTORY[position]
      .filter((player) => player.sleeperId)
      .map((player) => [player.sleeperId, { name: player.name, position }])
  )),
);

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch {
    throw new Error("Could not reach Sleeper. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "That League ID was not found on Sleeper."
        : `Sleeper returned an error (${response.status}).`,
    );
  }
  return response.json();
}

export async function fetchLeagueRosterData(leagueId) {
  const id = normalizeLeagueId(leagueId);
  if (!id) throw new Error("Enter a Sleeper League ID.");

  const [league, rosters, users] = await Promise.all([
    fetchJson(`${API_BASE}/league/${id}`),
    fetchJson(`${API_BASE}/league/${id}/rosters`),
    fetchJson(`${API_BASE}/league/${id}/users`),
  ]);

  if (!league || typeof league !== "object" || !Array.isArray(rosters) || !Array.isArray(users)) {
    throw new Error("Sleeper returned an unexpected response for that League ID.");
  }
  if (!rosters.length) throw new Error("That league has no rosters yet.");

  const rosterPositions = Array.isArray(league.roster_positions) ? league.roster_positions : [];
  const unsupportedSlots = [...new Set(
    rosterPositions.filter((slot) => !LINEUP_SLOT_TYPES.has(slot) && !OUT_OF_SCOPE_SLOT_TYPES.has(slot)),
  )];

  const usersById = new Map(users.map((user) => [user.user_id, user]));
  const teams = rosters.map((roster) => {
    const user = roster.owner_id ? usersById.get(roster.owner_id) : null;
    const teamName = user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`;
    const players = (roster.players ?? [])
      .map((sleeperId) => PLAYER_INDEX.get(sleeperId))
      .filter(Boolean);
    return { rosterId: roster.roster_id, teamName, players };
  });

  return {
    leagueId: id,
    leagueName: league.name || "Sleeper League",
    season: league.season ?? null,
    rosterPositions,
    unsupportedSlots,
    teams,
  };
}

export function computeLeaguePowerRankings(leagueData, { rankings, settings }) {
  const ppgData = historicalPpgFor(settings.scoringFormat);
  const syntheticSlots = leagueData.rosterPositions
    .filter((slot) => LINEUP_SLOT_TYPES.has(slot))
    .map((slot) => ({ pos: slot, flexPos: "RB" }));
  const baselines = computeBaselines(
    syntheticSlots,
    { teams: leagueData.teams.length, flexRbShare: settings.flexRbShare },
    ppgData,
  );

  const teams = leagueData.teams.map((team) => ({
    rosterId: team.rosterId,
    teamName: team.teamName,
    ...scoreRosterPlayers(team.players, rankings, ppgData, baselines),
  }));

  return {
    leagueName: leagueData.leagueName,
    season: leagueData.season,
    unsupportedSlots: leagueData.unsupportedSlots,
    teams,
  };
}
