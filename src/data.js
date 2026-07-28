async function readGeneratedDataset() {
  const datasetUrl = new URL("../data/generated/app-data.json", import.meta.url);
  let text;
  if (datasetUrl.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    text = await readFile(datasetUrl, "utf8");
  } else {
    const response = await fetch(datasetUrl, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Could not load generated calculator data (${response.status}).`);
    }
    text = await response.text();
  }

  const parsed = JSON.parse(text);
  if (
    parsed?.schemaVersion !== 1
    || !parsed.historicalPpg?.ppr
    || !parsed.players?.QB
    || !parsed.sources?.nflverse
    || !parsed.sources?.sleeper
  ) {
    throw new Error("The generated calculator dataset has an unsupported schema.");
  }
  return parsed;
}

export const GENERATED_DATA = await readGeneratedDataset();
export const POSITIONS = ["QB", "RB", "WR", "TE"];
export const SLOT_POSITIONS = [...POSITIONS, "FLEX"];
export const SCORING_FORMATS = Object.freeze(GENERATED_DATA.scoringFormats);
export const DEFAULT_SCORING_FORMAT = GENERATED_DATA.defaultScoringFormat;
export const HISTORICAL_PPG_BY_FORMAT = Object.freeze(GENERATED_DATA.historicalPpg);
export const HISTORICAL_PPG = Object.freeze(HISTORICAL_PPG_BY_FORMAT[DEFAULT_SCORING_FORMAT]);
export const PLAYER_DIRECTORY = Object.freeze(GENERATED_DATA.players);

export function historicalPpgFor(scoringFormat = DEFAULT_SCORING_FORMAT) {
  return HISTORICAL_PPG_BY_FORMAT[scoringFormat] ?? HISTORICAL_PPG;
}

export const DATASET_META = Object.freeze({
  id: GENERATED_DATA.datasetId,
  title: "Generated nflverse historical PPG and Sleeper player snapshot",
  seasons: `${GENERATED_DATA.seasons[0]}–${GENERATED_DATA.seasons.at(-1)}`,
  scoringFormat: Object.values(SCORING_FORMATS).map((format) => format.label).join(", "),
  source: "nflverse player statistics; Sleeper NFL player directory",
  aggregation: GENERATED_DATA.methodology.average,
  finishRank: GENERATED_DATA.methodology.finishRank,
  generatedAt: GENERATED_DATA.generatedAt,
  integrity: GENERATED_DATA.integrity,
  sourceLinks: [
    {
      label: "nflverse player-stat documentation",
      url: GENERATED_DATA.sources.nflverse.documentationUrl,
    },
    {
      label: "nflverse update schedule",
      url: GENERATED_DATA.sources.nflverse.updateScheduleUrl,
    },
    {
      label: "Sleeper API documentation",
      url: GENERATED_DATA.sources.sleeper.documentationUrl,
    },
    {
      label: "Local per-season audit dataset",
      url: "./data/generated/historical-detail.json",
    },
  ],
});

export const DEFAULT_PLAYER_POOL = Object.freeze(Object.fromEntries(
  POSITIONS.map((position) => [
    position,
    PLAYER_DIRECTORY[position].map((player) => player.name),
  ]),
));
