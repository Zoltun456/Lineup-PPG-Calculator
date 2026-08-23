Fantasy Gut Check

A fantasy football tool for ranking your own players and instantly seeing the historical scoring pace and value of any lineup you build — no login, no backend, nothing to install. Open the page and go.

[Open The App](https://zoltun456.github.io/Lineup-PPG-Calculator/)

**What it does**

This is a three-part tool: a place to rank players your way, a lineup builder that turns those rankings into live scoring, and a power-rankings view for your whole Sleeper league.

1. Rank your players

Every position (QB, RB, WR, TE) comes preloaded with a full pool of current players. Build your personal ranking by:

Clicking a player in the pool to send them to the bottom of your ranked list, or
Dragging them directly into the exact spot you want

Ranked players can be dragged to reorder at any time, and removing someone from your rankings sends them back to the pool instead of deleting them — nothing is ever lost. Don't see a player you're looking for? Add them by name with the quick-add box.

2. Build a lineup and see it score

Add slots for QB, RB, WR, TE, or FLEX, then fill each one in by typing a name — it autocompletes from whichever rankings are active.

By default that's your own rankings, but a toggle at the top of the Lineup tab switches the whole pool to a bundled consensus ranking, for anyone who'd rather not rank every player themselves. Slots can be dragged into any order, and you can add or remove as many as you want.

Every slot shows:

PPG — points per game, based on 5-year historical scoring averages for whatever finish rank a player occupies (e.g. the RB1 number reflects how RB1 finishes have actually scored, on average, over the last 5 years — not a projection of what any specific player will do this season)
VOR (value over replacement) — how much better that player is than a "replacement level" player at the same position, given your current roster construction

VOR isn't a fixed number — it recalculates live. Every QB/RB/WR/TE slot in your lineup raises that position's replacement baseline by 12 ranks; every FLEX slot raises the RB and WR baselines according to the FLEX RB/WR split configured in Settings. Add a second FLEX spot, and the "replacement level" bar for RB/WR moves accordingly, and every VOR number updates instantly.

Totals for both PPG and VOR are summed at the bottom, so you can compare full lineups at a glance.

3. League Power Rankings

Enter a Sleeper League ID on the League Power Rankings tab to pull every roster in that league and score each team using your own rankings or the bundled consensus rankings — same toggle pattern as the Lineup tab. Each team shows two numbers: PPG scores that team's best possible starting lineup, while VOR scores the full roster, so it also credits bench depth. Sort the list by either metric. If the league uses slot types this app doesn't model, they're called out and left out of the replacement-rank baseline.

**Settings**

The gear icon in the header opens Settings, where you can tune the model behind the numbers:

Number of teams — how many teams are in your league (2–32), which sets the replacement-rank baseline
Scoring format — Standard, Half-PPR, or PPR; historical ranks and PPG are recalculated separately for each
FLEX demand assigned to RB — a slider controlling how a FLEX slot splits its replacement-rank pressure between RB and WR (defaults to a 50/50 split)
Dataset information — a transparency panel showing exactly what data the bundled historical averages are built from and how to regenerate it locally
Reset calculator — clears all rankings, custom players, lineup changes, and settings saved on this device

**Your data, saved automatically**

Everything you do — your rankings, your pool, your current lineup, your settings, even which rankings source you last used — saves automatically to your browser as you go. Close the tab, come back next week, and it's exactly how you left it.

This data lives only in your own browser. It's never sent anywhere, isn't tied to an account, and isn't shared with anyone else who opens this same page — every visitor gets their own private, independent copy.

Two buttons at the bottom of the Rankings tab give you extra control over that data:

Export backup — downloads everything (rankings, pool, lineup) as a .json file, useful as a backup or for moving your setup to a different browser or device
Import backup — loads a previously exported file back in

**How to actually use this**

This tool is meant to help you visualize your own preferences and opinions about players — not replace them.

Say you're stuck deciding between your RB8 and your WR11 for a flex spot. Plug both into a lineup and see how they stack up historically. That's the use case this is built for: turning a gut-level "I like this guy more" into a quick, concrete comparison based on how players at that rank have actually scored over time.

What it isn't is a decision-maker. PPG and VOR here reflect historical scoring by finish rank, not a forecast of what your specific players will do this season — matchups, injuries, coaching changes, and a dozen other things this tool has no idea about will all matter more than a 5-year average. Treat the numbers as a sanity check on your own rankings, not a verdict. You already know things about these players that a spreadsheet doesn't.

**Getting started**

Open the app.
Go to the Rankings tab and start ranking players at each position — click or drag them out of the pool.
Switch to the Lineup tab, set your slots, and start typing in players — or flip on consensus rankings if you'd rather skip ranking altogether.
Watch PPG and VOR update as you build.
Want a full-league view instead? Head to League Power Rankings and drop in your Sleeper League ID.

No sign-up, no setup — just open it and start ranking.

**A separate tool: Duel Ranker**

Dragging a full position into order gets tedious past the top 20 or so. [Duel Ranker](https://zoltun456.github.io/Lineup-PPG-Calculator/duel-ranker/) is a standalone companion app for that — it pulls from the same player pool as the calculator, but instead of dragging players into place, you settle your board through head-to-head matchups: pick who you'd rather have, one pair at a time, until the whole group is ordered.

Your board saves automatically per position. Add more players later and only the new ones get compared — against the board you've already settled, never from scratch — so a big board never means redoing pairs you've already decided. Export your finished rankings to an Excel file whenever you want a copy.

It's a fully separate tool with its own page and its own saved data — nothing you do there touches your rankings in the calculator above, or vice versa.
