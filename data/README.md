# Generated calculator data

Files in [`generated/`](generated/) are produced by [`scripts/collect-data.mjs`](../scripts/collect-data.mjs). Do not edit them by hand.

## Files

- `app-data.json` is the compact runtime snapshot loaded by the browser. It contains dataset metadata, scoring profiles, historical positional PPG averages, and the current Sleeper player directory.
- `historical-detail.json` is the audit dataset. It contains every season/format/position finisher used to create the averages, including player ID, name, team, games, total fantasy points, and PPG.

## Upstream sources

- nflverse regular-season player summaries:
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_<SEASON>.csv`
- nflverse current-season roster eligibility:
  `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_<CURRENT_SEASON>.csv`
- Sleeper position-filtered NFL player directory:
  `https://api.sleeper.app/v1/players/nfl?position=<POSITION>&active=true`

The player directory retains active, non-retired Sleeper records: players on the current nflverse roster need a generous Sleeper search rank or depth-chart order, and free agents with no current team (matched by Sleeper's own relevance data alone, with no roster to corroborate them) need a tighter search rank. This keeps genuinely active free agents in the pool while filtering out stale and retired records. The runtime file also includes the previously relevant Sleeper names it excluded so saved browser state can remove stale bundled entries from the default pool without removing unrelated custom players; a player's own saved rankings are never auto-removed this way. The exact source URLs and SHA-256 hashes for a generated snapshot are embedded in both JSON files.

## Consensus rankings

[`sources/consensus-rankings/`](sources/consensus-rankings/) holds one CSV per position/scoring-format combination (`Name,Team,Rank`), plus a single format-agnostic `qb.csv`. Unlike the other sources, these are **not fetched over the network** — they're a manually maintained, personally-compiled consensus that `collect-data.mjs` reads from disk and joins to the Sleeper/nflverse player directory (matching on name, falling back to a Jr./Sr./II/III-stripped comparison, then a small hand-maintained alias list for known nickname mismatches). Rows that still don't match are kept under their own name — harmless, since no default-pool player will share that exact name — and logged during `data:refresh` so new mismatches stay visible.

To update: edit the CSVs directly (or replace them wholesale) and rerun `npm run data:refresh`. The resulting `consensusRankings` block in `app-data.json` is `{ standard | halfPpr | ppr } → { QB | RB | WR | TE } → ordered array of player names`, in the same shape the app already uses for `historicalPpg`.

## Refresh and validation

```bash
npm run data:refresh
npm run data:validate
```

The refresh command downloads every input before replacing either generated file. It rejects incomplete positional depths, malformed source schemas, inconsistent PPR arithmetic, player records without current-roster evidence, invalid player directories, and bad integrity hashes.
