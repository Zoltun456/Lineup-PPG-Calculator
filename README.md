# Lineup PPG Calculator

A private, browser-based fantasy football tool for turning personal player rankings into estimated lineup points per game (PPG) and value over replacement (VOR).

No account, installation, analytics, or server-side storage is required.

## [Open the calculator](https://zoltun456.github.io/Lineup-PPG-Calculator/)

## What it does

### Build personal rankings

- Add players from the QB, RB, WR, and TE pools.
- Search large player pools.
- Add missing players.
- Reorder rankings with drag-and-drop or keyboard-accessible arrow buttons.
- Return ranked players to their available pool.
- Undo recent changes or clear every ranking.

### Model a lineup

Create and reorder any combination of `QB`, `RB`, `WR`, `TE`, and `FLEX` slots.

- **By player:** Select players from your personal rankings.
- **By rank:** Enter a positional rank such as RB4.

The calculator prevents a duplicate player or positional rank from inflating lineup totals. FLEX selections retain their actual RB or WR position.

### Configure replacement value

Replacement ranks are calculated from:

- The selected Standard, Half-PPR, or PPR scoring profile.
- The number of teams in the league.
- The position slots in the lineup.
- The percentage of FLEX demand assigned to RB versus WR.

For example, the default 12-team lineup contains two RB slots and one FLEX. With an even FLEX split, the RB replacement rank is:

```text
(2 RB + 0.5 FLEX) x 12 teams = RB30
```

If a calculated or entered rank exceeds the bundled data, the final available rank is used and the interface identifies that cap.
Fractional replacement demand is rounded to the nearest whole positional rank.

## Calculation methodology

For a selected positional rank:

```text
PPG = historical PPG value at that positional rank
VOR = selected-rank PPG - replacement-rank PPG
```

Total PPG and VOR include only valid, non-duplicate selections.

## Data collection and provenance

The browser does not call a live sports API. A separate, reproducible collection script downloads upstream data, validates it, and builds versioned local JSON snapshots. This keeps the deployed calculator fast and usable when an upstream provider is unavailable.

The current generated dataset uses:

- **nflverse:** Regular-season player summary statistics for the five completed seasons from 2021 through 2025.
- **Sleeper:** The current active fantasy player directory, stable Sleeper and GSIS IDs, teams, positions, injury status, experience, depth-chart order, and search rank.

[nflverse player-stat documentation](https://nflreadr.nflverse.com/reference/load_player_stats.html) · [nflverse update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html) · [Sleeper API documentation](https://docs.sleeper.com/)

TheSportsDB is not queried because the calculator does not currently need general event, artwork, or per-player lookup data.

### Historical PPG generation

For every selected season, position, and scoring format:

1. Filter nflverse player summaries to regular-season QB, RB, WR, and TE records with at least one game.
2. Calculate Standard from nflverse `fantasy_points`, Half-PPR from `fantasy_points + 0.5 x receptions`, and PPR from `fantasy_points_ppr`.
3. Rank players by regular-season total fantasy points. Resolve ties by PPG, then nflverse player ID.
4. Divide each finisher's points by nflverse `games`.
5. Average the PPG found at each positional finish across the five seasons.

Generated depths are QB32, RB50, WR50, and TE24. The application caps higher requested ranks to the final generated rank and identifies the cap in the UI.

The runtime snapshot is [`data/generated/app-data.json`](data/generated/app-data.json). Full per-season finishers, totals, games, and PPG values are retained in [`data/generated/historical-detail.json`](data/generated/historical-detail.json) for auditing.

### Player-pool generation

The script uses Sleeper's position-filtered endpoints and retains active QB/RB/WR/TE players who have either:

- Sleeper search rank 1–500, or
- An assigned team and depth-chart order 1–3.

Existing browser rankings and custom players are preserved when a new generated player snapshot is released. The app currently stores player selections by name and position; generated stable IDs are retained for a future ID-based state migration.

## Saving, backups, and privacy

The app stores a versioned state object in browser `localStorage`. Data never leaves the device.

- **Export backup** downloads rankings, pool, lineup slots, FLEX positions, entry mode, and league settings as JSON.
- **Import backup** validates the entire file before replacing any state.
- Existing version 1 and version 2 browser data is migrated automatically.
- Malformed storage falls back safely instead of preventing the app from loading.
- **Reset** removes both current and legacy calculator keys after confirmation.

Import files are limited to 1 MB and bounded collection sizes. Imported values are validated and rendered through DOM properties rather than inserted as HTML.

## Keyboard and mobile support

- Use Left/Right, Home, and End on the main tabs.
- Use the visible Up/Down controls to reorder ranked players and lineup slots.
- All player-pool actions use native buttons and all fields have programmatic labels.
- The ranking columns and lineup rows switch to stacked mobile layouts.
- Drag-and-drop remains available as a pointer convenience.

## License

See [`LICENSE`](LICENSE).
