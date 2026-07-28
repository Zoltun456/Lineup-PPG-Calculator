import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const POSITION_DEPTHS = { QB: 32, RB: 50, WR: 50, TE: 24 };
const SCORING_FORMATS = {
  standard: {
    label: "Standard",
    formula: "nflverse fantasy_points",
    receptionPoints: 0,
  },
  halfPpr: {
    label: "Half-PPR",
    formula: "nflverse fantasy_points + 0.5 x receptions",
    receptionPoints: 0.5,
  },
  ppr: {
    label: "PPR",
    formula: "nflverse fantasy_points_ppr",
    receptionPoints: 1,
  },
};
const DEFAULT_OUTPUT_DIRECTORY = resolve("data", "generated");
const DEFAULT_SEASON_COUNT = 5;
const SLEEPER_RELEVANCE_RANK = 500;
const SLEEPER_DEPTH_LIMIT = 3;
const MAX_PLAYERS_PER_POSITION = 500;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 3;

const NFLVERSE_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download/stats_player";
const NFLVERSE_ROSTER_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download/rosters";
const NFLVERSE_DOCS = "https://nflreadr.nflverse.com/reference/load_player_stats.html";
const NFLVERSE_ROSTER_DOCS = "https://nflreadr.nflverse.com/reference/dictionary_rosters.html";
const NFLVERSE_SCHEDULE = "https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html";
const NFLVERSE_LICENSE = "https://github.com/nflverse/nflverse-data/blob/master/LICENSE.md";
const SLEEPER_ENDPOINT = "https://api.sleeper.app/v1/players/nfl";
const SLEEPER_DOCS = "https://docs.sleeper.com/";

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compactHash(value) {
  const payload = structuredClone(value);
  delete payload.integrity;
  return `sha256-${sha256(JSON.stringify(payload))}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseCsv(text) {
  if (typeof text !== "string" || !text.length) return [];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (quoted) throw new Error("CSV input ended inside a quoted field.");
  if (rows.length < 2) return [];

  const headers = rows[0];
  return rows.slice(1)
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function validateRequiredColumns(rows, requiredColumns, label) {
  if (!rows.length) throw new Error(`${label} returned no records.`);
  const available = new Set(Object.keys(rows[0]));
  const missing = requiredColumns.filter((column) => !available.has(column));
  if (missing.length) throw new Error(`${label} is missing required columns: ${missing.join(", ")}.`);
}

async function fetchWithRetry(url, { responseType = "text" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: responseType === "json" ? "application/json" : "text/csv,*/*;q=0.8",
          "User-Agent": "Lineup-PPG-Calculator data collector",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const text = await response.text();
      return responseType === "json"
        ? { data: JSON.parse(text), rawText: text }
        : text;
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message ?? "unknown error"}`);
}

function latestCompletedSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  // Use March as a conservative boundary so an in-progress postseason is never
  // treated as a completed regular-season dataset.
  return now.getUTCMonth() >= 2 ? year - 1 : year - 2;
}

export function defaultSeasons(now = new Date(), count = DEFAULT_SEASON_COUNT) {
  const latest = latestCompletedSeason(now);
  return Array.from({ length: count }, (_, index) => latest - count + index + 1);
}

export function currentRosterSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 2 ? year : year - 1;
}

function parseSeasonArgument(value) {
  if (!value) return defaultSeasons();
  const seasons = [...new Set(value.split(",").map(Number))].sort((a, b) => a - b);
  if (
    seasons.length < 2
    || seasons.some((season) => !Number.isInteger(season) || season < 1999 || season > latestCompletedSeason())
  ) {
    throw new Error("Use at least two completed NFL seasons, such as --seasons=2021,2022,2023,2024,2025.");
  }
  return seasons;
}

function nflverseSeasonUrl(season) {
  return `${NFLVERSE_RELEASE_BASE}/stats_player_reg_${season}.csv`;
}

function nflverseRosterUrl(season) {
  return `${NFLVERSE_ROSTER_RELEASE_BASE}/roster_${season}.csv`;
}

function normalizeNflverseRows(csvText, season) {
  const rows = parseCsv(csvText);
  validateRequiredColumns(rows, [
    "player_id",
    "player_display_name",
    "position",
    "season",
    "season_type",
    "recent_team",
    "games",
    "receptions",
    "fantasy_points",
    "fantasy_points_ppr",
  ], `nflverse ${season}`);

  const normalized = rows.flatMap((row) => {
    if (
      !POSITIONS.includes(row.position)
      || row.season_type !== "REG"
      || Number(row.season) !== season
    ) return [];
    const games = numberOrNull(row.games);
    const standardPoints = numberOrNull(row.fantasy_points);
    const pprPoints = numberOrNull(row.fantasy_points_ppr);
    const receptions = numberOrNull(row.receptions) ?? 0;
    const name = row.player_display_name || row.player_name;
    if (!games || games < 1 || standardPoints === null || pprPoints === null || !name) return [];
    if (Math.abs((standardPoints + receptions) - pprPoints) > 0.05) {
      throw new Error(
        `nflverse ${season} PPR validation failed for ${row.player_display_name || row.player_id}.`,
      );
    }
    return [{
      playerId: row.player_id,
      name,
      position: row.position,
      team: row.recent_team || null,
      season,
      games,
      receptions,
      points: {
        standard: standardPoints,
        halfPpr: standardPoints + receptions * 0.5,
        ppr: pprPoints,
      },
    }];
  });

  for (const position of POSITIONS) {
    if (normalized.filter((player) => player.position === position).length < POSITION_DEPTHS[position]) {
      throw new Error(`nflverse ${season} does not contain enough ${position} records.`);
    }
  }
  return normalized;
}

function normalizedPlayerName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isRetiredStatus(value) {
  const status = String(value ?? "").trim().toLocaleUpperCase();
  return status === "RET" || status === "RETIRED";
}

export function normalizeCurrentRoster(csvText, season) {
  const rows = parseCsv(csvText);
  validateRequiredColumns(rows, [
    "season",
    "team",
    "position",
    "status",
    "full_name",
    "gsis_id",
    "sleeper_id",
  ], `nflverse roster ${season}`);

  const unique = new Map();
  for (const row of rows) {
    if (
      Number(row.season) !== season
      || !POSITIONS.includes(row.position)
      || !row.team
      || !row.full_name
      || isRetiredStatus(row.status)
    ) continue;
    const player = {
      season,
      team: row.team,
      position: row.position,
      status: row.status || null,
      name: row.full_name,
      sleeperId: row.sleeper_id || null,
      gsisId: row.gsis_id || null,
      yearsExperience: numberOrNull(row.years_exp),
      jerseyNumber: numberOrNull(row.jersey_number),
    };
    const key = player.sleeperId
      ? `sleeper:${player.sleeperId}`
      : (player.gsisId
        ? `gsis:${player.gsisId}`
        : `name:${player.position}:${normalizedPlayerName(player.name)}`);
    unique.set(key, player);
  }
  const roster = [...unique.values()];
  for (const position of POSITIONS) {
    if (roster.filter((player) => player.position === position).length < POSITION_DEPTHS[position]) {
      throw new Error(`nflverse roster ${season} does not contain enough ${position} players.`);
    }
  }
  return roster;
}

export function buildHistoricalDataset(seasonRows, seasons) {
  const details = Object.fromEntries(Object.keys(SCORING_FORMATS).map((format) => [
    format,
    Object.fromEntries(POSITIONS.map((position) => [position, {}])),
  ]));
  const averages = Object.fromEntries(Object.keys(SCORING_FORMATS).map((format) => [
    format,
    Object.fromEntries(POSITIONS.map((position) => [position, []])),
  ]));

  for (const format of Object.keys(SCORING_FORMATS)) {
    for (const position of POSITIONS) {
      const depth = POSITION_DEPTHS[position];
      for (const season of seasons) {
        const ranked = seasonRows[season]
          .filter((player) => player.position === position)
          .sort((left, right) => (
            right.points[format] - left.points[format]
            || (right.points[format] / right.games) - (left.points[format] / left.games)
            || left.playerId.localeCompare(right.playerId)
          ))
          .slice(0, depth)
          .map((player, index) => ({
            rank: index + 1,
            playerId: player.playerId,
            name: player.name,
            team: player.team,
            games: player.games,
            totalPoints: round(player.points[format]),
            ppg: round(player.points[format] / player.games),
          }));
        if (ranked.length !== depth) {
          throw new Error(`${season} ${format} ${position} produced ${ranked.length} of ${depth} ranks.`);
        }
        details[format][position][String(season)] = ranked;
      }

      averages[format][position] = Array.from({ length: depth }, (_, index) => {
        const ppgValues = seasons.map((season) => details[format][position][String(season)][index].ppg);
        return round(ppgValues.reduce((sum, value) => sum + value, 0) / ppgValues.length);
      });
    }
  }

  return { averages, details };
}

function sleeperName(player) {
  const fullName = typeof player.full_name === "string" ? player.full_name.trim() : "";
  if (fullName) return fullName;
  return [player.first_name, player.last_name].filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .trim();
}

export function selectSleeperPlayers(rawByPosition, currentRoster) {
  const bySleeperId = new Map();
  const byGsisId = new Map();
  const byName = new Map();
  for (const player of currentRoster ?? []) {
    if (player.sleeperId) bySleeperId.set(player.sleeperId, player);
    if (player.gsisId) byGsisId.set(player.gsisId, player);
    byName.set(`${player.position}:${normalizedPlayerName(player.name)}`, player);
  }

  return Object.fromEntries(POSITIONS.map((position) => {
    const rawPlayers = Object.values(rawByPosition[position] ?? {});
    const selected = rawPlayers.flatMap((player) => {
      const name = sleeperName(player);
      const searchRank = numberOrNull(player.search_rank);
      const depthChartOrder = numberOrNull(player.depth_chart_order);
      const rosterPlayer = bySleeperId.get(player.player_id)
        ?? byGsisId.get(player.gsis_id)
        ?? byName.get(`${position}:${normalizedPlayerName(name)}`);
      const isRelevant = (
        (searchRank !== null && searchRank > 0 && searchRank <= SLEEPER_RELEVANCE_RANK)
        || (depthChartOrder !== null && depthChartOrder <= SLEEPER_DEPTH_LIMIT)
      );
      if (
        player.active !== true
        || player.position !== position
        || rosterPlayer?.position !== position
        || isRetiredStatus(rosterPlayer?.status)
        || !name
        || !isRelevant
        || typeof player.player_id !== "string"
      ) return [];

      return [{
        id: `sleeper:${player.player_id}`,
        sleeperId: player.player_id,
        gsisId: typeof player.gsis_id === "string" && player.gsis_id
          ? player.gsis_id
          : rosterPlayer.gsisId,
        name: rosterPlayer.name,
        firstName: typeof player.first_name === "string" ? player.first_name : null,
        lastName: typeof player.last_name === "string" ? player.last_name : null,
        position,
        team: rosterPlayer.team,
        status: typeof player.status === "string" ? player.status : null,
        rosterStatus: rosterPlayer.status,
        rosterSeason: rosterPlayer.season,
        injuryStatus: typeof player.injury_status === "string" ? player.injury_status : null,
        active: true,
        yearsExperience: numberOrNull(player.years_exp) ?? rosterPlayer.yearsExperience,
        age: numberOrNull(player.age),
        depthChartOrder,
        searchRank,
        jerseyNumber: numberOrNull(player.number) ?? rosterPlayer.jerseyNumber,
      }];
    });

    const unique = new Map();
    for (const player of selected) unique.set(player.id, player);
    const sorted = [...unique.values()]
      .sort((left, right) => (
        (left.searchRank ?? Number.MAX_SAFE_INTEGER) - (right.searchRank ?? Number.MAX_SAFE_INTEGER)
        || (left.depthChartOrder ?? Number.MAX_SAFE_INTEGER) - (right.depthChartOrder ?? Number.MAX_SAFE_INTEGER)
        || left.name.localeCompare(right.name)
      ));
    const names = new Set();
    const players = sorted.filter((player) => {
      const key = player.name.toLocaleLowerCase();
      if (names.has(key)) return false;
      names.add(key);
      return true;
    }).slice(0, MAX_PLAYERS_PER_POSITION);
    return [position, players];
  }));
}

export function excludedSleeperPlayerNames(rawByPosition, selectedPlayers) {
  return Object.fromEntries(POSITIONS.map((position) => {
    const selectedById = new Map(
      (selectedPlayers[position] ?? []).map((player) => [player.sleeperId, player]),
    );
    const excluded = new Map();
    for (const player of Object.values(rawByPosition[position] ?? {})) {
      const name = sleeperName(player);
      const searchRank = numberOrNull(player.search_rank);
      const depthChartOrder = numberOrNull(player.depth_chart_order);
      const wasPreviouslyRelevant = (
        searchRank !== null
        && searchRank > 0
        && searchRank <= SLEEPER_RELEVANCE_RANK
      ) || (
        player.team
        && depthChartOrder !== null
        && depthChartOrder <= SLEEPER_DEPTH_LIMIT
      );
      if (
        player.active !== true
        || player.position !== position
        || !name
        || !wasPreviouslyRelevant
        || typeof player.player_id !== "string"
      ) continue;
      const selected = selectedById.get(player.player_id);
      if (!selected || normalizedPlayerName(selected.name) !== normalizedPlayerName(name)) {
        excluded.set(name.toLocaleLowerCase(), name);
      }
    }
    return [position, [...excluded.values()].sort((left, right) => left.localeCompare(right))];
  }));
}

function datasetMetadata({
  seasons,
  generatedAt,
  sourceFiles,
  rosterFile,
  sleeperFiles,
  players,
}) {
  return {
    schemaVersion: 1,
    datasetId: `nflverse-sleeper-${seasons[0]}-${seasons.at(-1)}-v2`,
    generatedAt,
    seasons,
    defaultScoringFormat: "ppr",
    scoringFormats: SCORING_FORMATS,
    positionDepths: POSITION_DEPTHS,
    methodology: {
      seasonType: "Regular season only",
      finishRank: "Players are ranked within position and season by total fantasy points for the selected scoring format.",
      ppg: "A finisher's total fantasy points divided by nflverse games.",
      average: `The PPG values at each positional finish are averaged across ${seasons.length} completed seasons.`,
      ties: "Ties in total points are resolved by PPG, then nflverse player ID.",
      rankCapping: "Ranks beyond the generated positional depth use the last available rank.",
      sleeperPlayerFilter: `Players must appear on the nflverse ${rosterFile.season} NFL roster, be active in Sleeper, and have Sleeper search rank 1-${SLEEPER_RELEVANCE_RANK} or depth-chart order 1-${SLEEPER_DEPTH_LIMIT}. Teamless stale and retired Sleeper records are excluded.`,
    },
    sources: {
      nflverse: {
        name: "nflverse player summary statistics",
        documentationUrl: NFLVERSE_DOCS,
        updateScheduleUrl: NFLVERSE_SCHEDULE,
        licenseUrl: NFLVERSE_LICENSE,
        attribution: "Data provided by nflverse. Underlying NFL data may be governed by its respective owners' terms.",
        files: sourceFiles,
      },
      nflverseRoster: {
        name: "nflverse current-season roster",
        season: rosterFile.season,
        documentationUrl: NFLVERSE_ROSTER_DOCS,
        licenseUrl: NFLVERSE_LICENSE,
        usage: "Current roster eligibility, team, and roster status; used to exclude retired and stale Sleeper records.",
        file: rosterFile,
      },
      sleeper: {
        name: "Sleeper NFL player directory",
        documentationUrl: SLEEPER_DOCS,
        endpoint: SLEEPER_ENDPOINT,
        usage: "Position-filtered player metadata; collected by this script and never requested by the browser.",
        files: sleeperFiles,
      },
    },
    playerCounts: Object.fromEntries(POSITIONS.map((position) => [position, players[position].length])),
  };
}

function attachIntegrity(value) {
  return { ...value, integrity: compactHash(value) };
}

export function validateAppDataset(dataset) {
  const errors = [];
  if (dataset?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(dataset?.seasons) || dataset.seasons.length < 2) errors.push("seasons are missing");
  if (!Number.isFinite(Date.parse(dataset?.generatedAt))) errors.push("generatedAt is invalid");
  if (!dataset?.sources?.nflverse?.files?.length) errors.push("nflverse source files are missing");
  if (!dataset?.sources?.nflverseRoster?.file?.url) errors.push("nflverse current roster source is missing");
  if (!dataset?.sources?.sleeper?.files?.length) errors.push("Sleeper source files are missing");
  const rosterSeason = dataset?.sources?.nflverseRoster?.season;

  for (const format of Object.keys(SCORING_FORMATS)) {
    for (const position of POSITIONS) {
      const values = dataset?.historicalPpg?.[format]?.[position];
      if (!Array.isArray(values) || values.length !== POSITION_DEPTHS[position]) {
        errors.push(`${format}.${position} must contain ${POSITION_DEPTHS[position]} PPG values`);
      } else if (values.some((value) => !Number.isFinite(value) || value < -20 || value > 100)) {
        errors.push(`${format}.${position} contains invalid PPG values`);
      }
    }
  }

  for (const position of POSITIONS) {
    const players = dataset?.players?.[position];
    const excludedNames = dataset?.excludedPlayerNames?.[position];
    if (
      !Array.isArray(excludedNames)
      || excludedNames.some((name) => typeof name !== "string" || !name.trim())
      || new Set(excludedNames.map((name) => name.toLocaleLowerCase())).size !== excludedNames.length
    ) {
      errors.push(`${position} excluded player names are invalid`);
    }
    if (!Array.isArray(players) || players.length < POSITION_DEPTHS[position] || players.length > MAX_PLAYERS_PER_POSITION) {
      errors.push(`${position} player directory has an invalid size`);
      continue;
    }
    const ids = new Set();
    const names = new Set();
    for (const player of players) {
      const playerName = typeof player?.name === "string" ? player.name : "";
      if (
        typeof player?.id !== "string"
        || !playerName
        || player.position !== position
        || typeof player.team !== "string"
        || !player.team
        || player.rosterSeason !== rosterSeason
        || isRetiredStatus(player.rosterStatus)
        || player.active !== true
      ) errors.push(`${position} contains an invalid player`);
      if (ids.has(player.id)) errors.push(`${position} contains duplicate player ID ${player.id}`);
      const nameKey = playerName.toLocaleLowerCase();
      if (playerName && names.has(nameKey)) errors.push(`${position} contains duplicate player name ${playerName}`);
      if (excludedNames?.some((name) => name.toLocaleLowerCase() === nameKey)) {
        errors.push(`${position} includes excluded player ${playerName}`);
      }
      ids.add(player.id);
      if (playerName) names.add(nameKey);
    }
  }

  if (dataset?.integrity !== compactHash(dataset)) errors.push("app dataset integrity hash does not match");
  if (errors.length) throw new Error(`Generated app dataset is invalid:\n- ${errors.join("\n- ")}`);
  return true;
}

export function validateDetailDataset(dataset) {
  const errors = [];
  if (dataset?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const format of Object.keys(SCORING_FORMATS)) {
    for (const position of POSITIONS) {
      for (const season of dataset?.seasons ?? []) {
        const entries = dataset?.rankDetails?.[format]?.[position]?.[String(season)];
        if (!Array.isArray(entries) || entries.length !== POSITION_DEPTHS[position]) {
          errors.push(`${format}.${position}.${season} has an invalid rank detail count`);
        }
      }
    }
  }
  if (dataset?.integrity !== compactHash(dataset)) errors.push("detail dataset integrity hash does not match");
  if (errors.length) throw new Error(`Generated detail dataset is invalid:\n- ${errors.join("\n- ")}`);
  return true;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function validateExisting(outputDirectory = DEFAULT_OUTPUT_DIRECTORY) {
  const appPath = join(outputDirectory, "app-data.json");
  const detailPath = join(outputDirectory, "historical-detail.json");
  const [appData, detailData] = await Promise.all([
    readFile(appPath, "utf8").then(JSON.parse),
    readFile(detailPath, "utf8").then(JSON.parse),
  ]);
  validateAppDataset(appData);
  validateDetailDataset(detailData);
  if (appData.datasetId !== detailData.datasetId) throw new Error("Generated dataset IDs do not match.");
  return { appData, detailData };
}

async function collect({ seasons, outputDirectory }) {
  const generatedAt = new Date().toISOString();
  const seasonRows = {};
  const sourceFiles = [];

  process.stdout.write(`Collecting nflverse regular-season data for ${seasons.join(", ")}...\n`);
  for (const season of seasons) {
    const url = nflverseSeasonUrl(season);
    const csv = await fetchWithRetry(url);
    const rows = normalizeNflverseRows(csv, season);
    seasonRows[season] = rows;
    sourceFiles.push({
      season,
      url,
      sha256: sha256(csv),
      relevantPlayerRecords: rows.length,
    });
  }

  const rosterSeason = currentRosterSeason(new Date(generatedAt));
  const rosterUrl = nflverseRosterUrl(rosterSeason);
  process.stdout.write(`Collecting nflverse ${rosterSeason} current roster eligibility...\n`);
  const rosterCsv = await fetchWithRetry(rosterUrl);
  const currentRoster = normalizeCurrentRoster(rosterCsv, rosterSeason);
  const rosterFile = {
    season: rosterSeason,
    url: rosterUrl,
    sha256: sha256(rosterCsv),
    relevantPlayerRecords: currentRoster.length,
  };

  process.stdout.write("Collecting Sleeper QB/RB/WR/TE player metadata...\n");
  const rawSleeper = {};
  const sleeperFiles = [];
  for (const position of POSITIONS) {
    const url = `${SLEEPER_ENDPOINT}?position=${position}&active=true`;
    const { data: payload, rawText } = await fetchWithRetry(url, { responseType: "json" });
    rawSleeper[position] = payload;
    sleeperFiles.push({
      position,
      url,
      sha256: sha256(rawText),
      returnedRecords: Object.keys(payload).length,
    });
  }
  const players = selectSleeperPlayers(rawSleeper, currentRoster);
  const excludedPlayerNames = excludedSleeperPlayerNames(rawSleeper, players);
  const historical = buildHistoricalDataset(seasonRows, seasons);
  const metadata = datasetMetadata({
    seasons,
    generatedAt,
    sourceFiles,
    rosterFile,
    sleeperFiles,
    players,
  });

  const appData = attachIntegrity({
    ...metadata,
    historicalPpg: historical.averages,
    players,
    excludedPlayerNames,
  });
  const detailData = attachIntegrity({
    schemaVersion: metadata.schemaVersion,
    datasetId: metadata.datasetId,
    generatedAt,
    seasons,
    scoringFormats: SCORING_FORMATS,
    positionDepths: POSITION_DEPTHS,
    methodology: metadata.methodology,
    sources: metadata.sources,
    rankDetails: historical.details,
  });
  validateAppDataset(appData);
  validateDetailDataset(detailData);

  await Promise.all([
    writeJsonAtomically(join(outputDirectory, "app-data.json"), appData),
    writeJsonAtomically(join(outputDirectory, "historical-detail.json"), detailData),
  ]);
  process.stdout.write(
    `Generated ${join(outputDirectory, "app-data.json")} and historical-detail.json `
    + `(${Object.values(players).reduce((sum, values) => sum + values.length, 0)} current players).\n`,
  );
}

function cliOptions(argumentsList) {
  const seasonOption = argumentsList.find((argument) => argument.startsWith("--seasons="));
  const outputOption = argumentsList.find((argument) => argument.startsWith("--output="));
  return {
    validateOnly: argumentsList.includes("--validate"),
    seasons: parseSeasonArgument(seasonOption?.slice("--seasons=".length)),
    outputDirectory: outputOption
      ? resolve(outputOption.slice("--output=".length))
      : DEFAULT_OUTPUT_DIRECTORY,
  };
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  if (options.validateOnly) {
    const { appData } = await validateExisting(options.outputDirectory);
    process.stdout.write(
      `Validated ${appData.datasetId}, generated ${appData.generatedAt}, `
      + `${appData.seasons.join(", ")}.\n`,
    );
    return;
  }
  await collect(options);
  await validateExisting(options.outputDirectory);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
