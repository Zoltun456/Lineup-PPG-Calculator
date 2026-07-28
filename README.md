# Lineup PPG Calculator

A fantasy football tool for creating personal player rankings, building custom lineups, and comparing historical scoring value.

No account, installation, or setup is required.

## [Open the Calculator](https://zoltun456.github.io/Lineup-PPG-Calculator/)

## Features

### Create Player Rankings

Rank quarterbacks, running backs, wide receivers, and tight ends based on your own preferences.

* Click a player to add them to the bottom of your rankings.
* Drag players directly into the position you want.
* Reorder ranked players at any time.
* Remove players to return them to the available pool.
* Add missing players using the quick-add field.

### Build Custom Lineups

Create a lineup using any combination of:

* `QB`
* `RB`
* `WR`
* `TE`
* `FLEX`

Slots can be added, removed, and reordered.

You can build lineups in two different ways:

* **Player Mode:** Select players from your rankings.
* **Rank Mode:** Enter a position and rank, such as `RB, Rank 4`.

Switch between modes at any time from the Lineup tab.

## PPG and VOR

Each lineup slot displays two values:

* **PPG:** The average points per game scored by players who finished at that positional rank over the last five years.
* **VOR:** Value over replacement, which estimates how much better a player is than a replacement-level option at the same position.

Replacement level adjusts automatically based on your lineup:

* Each `QB`, `RB`, `WR`, or `TE` slot moves that position's replacement baseline down by 12 ranks.
* Each `FLEX` slot moves both the `RB` and `WR` baselines down by 6 ranks.

Total PPG and VOR are shown at the bottom of the lineup.

## Automatic Saving

Your rankings, player pool, lineup, and selected mode are saved automatically in your browser.

Your data stays on your device and is not connected to an account or sent to a server.

You can also:

* **Export Data:** Download your setup as a `.json` backup file.
* **Import Data:** Restore a previously exported file.

## Getting Started

1. [Open the calculator](https://zoltun456.github.io/Lineup-PPG-Calculator/).
2. Rank players from the Rankings tab.
3. Open the Lineup tab and add your roster slots.
4. Select players or enter positional ranks.
5. Compare the updated PPG and VOR totals.

## Important Note

The calculator uses historical scoring averages, not season projections.

It does not account for injuries, matchups, coaching changes, roster moves, or changes in player roles. Use the results as a reference when evaluating your own rankings, not as a final decision.
