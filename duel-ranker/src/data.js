// Standalone data loader — deliberately independent of the calculator's own
// src/data.js. This app only needs the player pool (name + team) per
// position, so it reads the same generated dataset directly rather than
// sharing loader code with the calculator.

export const POSITIONS = ["QB", "RB", "WR", "TE"];

async function fetchGeneratedDataset() {
  const response = await fetch(new URL("../../data/generated/app-data.json", import.meta.url), {
    cache: "no-cache",
  });
  if (!response.ok) {
    throw new Error(`Could not load player data (${response.status}).`);
  }
  const parsed = await response.json();
  if (parsed?.schemaVersion !== 1 || POSITIONS.some((position) => !Array.isArray(parsed.players?.[position]))) {
    throw new Error("The generated player dataset has an unsupported schema.");
  }
  return parsed;
}

const GENERATED_DATA = await fetchGeneratedDataset();

/** @type {Record<string, {name: string, team: string}[]>} */
export const PLAYER_POOL = Object.freeze(Object.fromEntries(POSITIONS.map((position) => [
  position,
  GENERATED_DATA.players[position].map((player) => ({ name: player.name, team: player.team ?? "" })),
])));
