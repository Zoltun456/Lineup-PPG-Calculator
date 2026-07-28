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

The player directory only retains Sleeper records that match the current nflverse roster and do not carry a retired roster status. This prevents retired and stale teamless records from entering the generated pool. The runtime file also includes the previously relevant Sleeper names it excluded so saved browser state can remove stale bundled entries without removing unrelated custom players. The exact source URLs and SHA-256 hashes for a generated snapshot are embedded in both JSON files.

## Refresh and validation

```bash
npm run data:refresh
npm run data:validate
```

The refresh command downloads every input before replacing either generated file. It rejects incomplete positional depths, malformed source schemas, inconsistent PPR arithmetic, player records without current-roster evidence, invalid player directories, and bad integrity hashes.
