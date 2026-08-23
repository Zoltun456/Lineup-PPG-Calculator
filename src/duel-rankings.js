import { POSITIONS } from "./data.js";

export const DUEL_RANKINGS_STORAGE_KEY = "fantasyGutCheck_duelRankings_v1";

export function loadDuelRankings() {
  try {
    const raw = localStorage.getItem(DUEL_RANKINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const output = {};
    for (const position of POSITIONS) {
      const list = parsed?.[position];
      if (Array.isArray(list) && list.every((name) => typeof name === "string")) {
        output[position] = list.slice(0, 500);
      }
    }
    return output;
  } catch {
    return {};
  }
}

export function saveDuelRankings(rankings) {
  try {
    localStorage.setItem(DUEL_RANKINGS_STORAGE_KEY, JSON.stringify(rankings));
  } catch {
    // Private browsing or full storage — export from the Duel Ranker still works from memory.
  }
}
