import { HISTORICAL_PPG, POSITIONS, historicalPpgFor } from "./data.js";

export function clampRank(position, rank, ppgData = HISTORICAL_PPG) {
  const values = ppgData[position];
  const numericRank = Number(rank);
  if (!values || !Number.isFinite(numericRank) || numericRank < 1) return null;
  return Math.min(Math.trunc(numericRank), values.length);
}

export function ppgFor(position, rank, ppgData = HISTORICAL_PPG) {
  const effectiveRank = clampRank(position, rank, ppgData);
  return effectiveRank === null ? null : ppgData[position][effectiveRank - 1];
}

export function rankOf(rankings, position, playerName) {
  if (!playerName || !Array.isArray(rankings[position])) return null;
  const index = rankings[position].indexOf(playerName);
  return index < 0 ? null : index + 1;
}

export function countLineupSlots(slots) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0 };
  for (const slot of slots) {
    if (Object.hasOwn(counts, slot.pos)) counts[slot.pos] += 1;
  }
  return counts;
}

export function computeBaselines(slots, settings, ppgData = HISTORICAL_PPG) {
  const counts = countLineupSlots(slots);
  const teams = Math.max(1, Math.trunc(Number(settings.teams) || 12));
  const rbShare = Math.min(100, Math.max(0, Number(settings.flexRbShare) || 0)) / 100;
  const raw = {
    QB: counts.QB * teams,
    RB: (counts.RB + counts.FLEX * rbShare) * teams,
    WR: (counts.WR + counts.FLEX * (1 - rbShare)) * teams,
    TE: counts.TE * teams,
  };

  return Object.fromEntries(POSITIONS.map((position) => {
    if (raw[position] <= 0) {
      return [position, {
        requestedRank: 0,
        effectiveRank: null,
        wasCapped: false,
      }];
    }
    const requestedRank = Math.max(1, Math.round(raw[position]));
    const effectiveRank = clampRank(position, requestedRank, ppgData);
    return [position, {
      requestedRank,
      effectiveRank,
      wasCapped: effectiveRank !== null && effectiveRank !== requestedRank,
    }];
  }));
}

export function resolveSlot(slot, mode, rankings) {
  if (mode === "player") {
    if (!slot.player?.name || !slot.player?.position) return null;
    const position = slot.pos === "FLEX" ? slot.player.position : slot.pos;
    const rank = rankOf(rankings, position, slot.player.name);
    return rank === null ? null : {
      position,
      rank,
      identity: `player:${position}:${slot.player.name}`,
    };
  }

  const position = slot.pos === "FLEX" ? slot.flexPos : slot.pos;
  const rank = Number(slot.rank);
  if (!POSITIONS.includes(position) || !Number.isInteger(rank) || rank < 1) return null;
  return {
    position,
    rank,
    identity: `rank:${position}:${rank}`,
  };
}

function evaluateRosterPlayers(players, rankings, ppgData, baselines) {
  return players.map((player) => {
    if (!POSITIONS.includes(player.position)) {
      return { position: player.position, name: player.name, rank: null, ppg: null, vor: null };
    }
    const rank = rankOf(rankings, player.position, player.name);
    const ppg = rank === null ? null : ppgFor(player.position, rank, ppgData);
    const baseline = baselines[player.position];
    const replacementPpg = baseline ? ppgFor(player.position, baseline.effectiveRank, ppgData) : null;
    const vor = ppg === null || replacementPpg === null ? null : ppg - replacementPpg;
    return { position: player.position, name: player.name, rank, ppg, vor };
  });
}

// PPG reflects only the best-scoring starting lineup; VOR sums the entire ranked roster so
// it also credits bench depth. FLEX is filled by PPG since the starting lineup is defined as
// whichever players would score the most, not which combination maximizes VOR.
export function pickStartingLineup(players, rankings, ppgData, baselines, slotCounts) {
  const evaluated = evaluateRosterPlayers(players, rankings, ppgData, baselines);
  const playerKey = (player) => `${player.position}:${player.name}`;
  const byPosition = Object.fromEntries(POSITIONS.map((position) => [
    position,
    evaluated.filter((player) => player.position === position && player.ppg !== null)
      .sort((left, right) => right.ppg - left.ppg),
  ]));

  const usedKeys = new Set();
  const starterSlots = [];

  for (const position of POSITIONS) {
    const count = slotCounts[position] ?? 0;
    for (let index = 0; index < count; index += 1) {
      const candidate = byPosition[position].find((player) => !usedKeys.has(playerKey(player)));
      if (candidate) usedKeys.add(playerKey(candidate));
      starterSlots.push({ slotType: position, player: candidate ?? null });
    }
  }

  const flexCount = slotCounts.FLEX ?? 0;
  const flexPool = [...byPosition.RB, ...byPosition.WR]
    .filter((player) => !usedKeys.has(playerKey(player)))
    .sort((left, right) => right.ppg - left.ppg);
  for (let index = 0; index < flexCount; index += 1) {
    const candidate = flexPool[index] ?? null;
    if (candidate) usedKeys.add(playerKey(candidate));
    starterSlots.push({ slotType: "FLEX", player: candidate ?? null });
  }

  const bench = evaluated.filter((player) => !usedKeys.has(playerKey(player)));
  const starters = starterSlots.map((slot) => slot.player).filter(Boolean);
  const totalPpg = starters.reduce((sum, player) => sum + player.ppg, 0);
  const totalVor = evaluated.reduce((sum, player) => sum + (player.vor ?? 0), 0);

  return {
    starterSlots,
    bench,
    totalPpg,
    totalVor,
    filledSlots: starters.length,
    totalSlots: starterSlots.length,
    rankedPlayers: evaluated.filter((player) => player.ppg !== null).length,
    totalPlayers: evaluated.length,
  };
}

export function calculateLineup(
  state,
  ppgData = historicalPpgFor(state.settings?.scoringFormat),
) {
  const baselines = computeBaselines(state.slots, state.settings, ppgData);
  const used = new Set();
  let totalPpg = 0;
  let totalVor = 0;

  const rows = state.slots.map((slot) => {
    const resolved = resolveSlot(slot, state.lineupMode, state.rankings);
    if (!resolved) {
      return { slotId: slot.id, status: "empty", ppg: null, vor: null };
    }

    if (used.has(resolved.identity)) {
      return {
        slotId: slot.id,
        status: "duplicate",
        position: resolved.position,
        rank: resolved.rank,
        ppg: null,
        vor: null,
      };
    }
    used.add(resolved.identity);

    const effectiveRank = clampRank(resolved.position, resolved.rank, ppgData);
    const ppg = ppgFor(resolved.position, resolved.rank, ppgData);
    const baseline = baselines[resolved.position];
    const replacementPpg = ppgFor(resolved.position, baseline.effectiveRank, ppgData);
    const vor = ppg === null || replacementPpg === null ? null : ppg - replacementPpg;

    if (ppg !== null) totalPpg += ppg;
    if (vor !== null) totalVor += vor;

    return {
      slotId: slot.id,
      status: "valid",
      position: resolved.position,
      rank: resolved.rank,
      effectiveRank,
      rankWasCapped: effectiveRank !== resolved.rank,
      ppg,
      vor,
    };
  });

  return { baselines, rows, totalPpg, totalVor };
}
