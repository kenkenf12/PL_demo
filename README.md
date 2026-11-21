# Personal FPL Assistant

The dashboard ranks players, shows upcoming fixtures and recent match history, and suggests captains and single transfers from your published squad. The statistical model runs locally and uses the official Fantasy Premier League feeds.

## Run

Install Node.js 22 or later, run `npm ci`, then run `npm start` and open [the local assistant](http://127.0.0.1:3000/). The process needs HTTPS access to `fantasy.premierleague.com`. The port can be changed with `FPL_PORT`.

## Run on Cloudflare Workers

Run `npm ci` to install Wrangler. Use `npm run cloudflare:dev` to test the dashboard and API together locally, or `npm run cloudflare:check` to check the deployable bundle.

For a public deployment on your Cloudflare account, run `npx wrangler login`, then `npm run cloudflare:deploy`. Wrangler prints the Worker URL. To deploy from GitHub, connect the repository's `main` branch in Workers Builds and use `npm run cloudflare:deploy` as the deploy command. [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)

The Worker serves the dashboard and its `/api` routes from the same URL. An anonymous browser cookie identifies a SQLite-backed Durable Object that stores that browser's validated FPL cache, refresh state, and prediction history. The Cloudflare deployment starts with its own history. [Durable Objects storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Predict a Gameweek squad

1. Select a Gameweek, then click **Refresh FPL Data**. Opening the dashboard and refreshing both try the official API first. The page shows the dataset source, last successful fetch time, Gameweek coverage, and completeness.
2. Select a strategy, then click **Analyse FPL Players** before the Gameweek deadline. **Current FPL Ranking**, **Previous Gameweek Performance**, and **Recent Performance Form** project squad points. **News & Expert Opinion Analysis** returns its own ranked list.
3. The squad fits the standard £100m budget and three-player club limit, with two goalkeepers, five defenders, five midfielders and three forwards. The total adds all 15 player forecasts before captaincy. A dash indicates insufficient scoring evidence.
4. In **Prediction history**, compare saved results across strategies and Gameweeks. Click **Refresh FPL Data** after scoring is final to record actuals. Results report mean absolute error per player with both a forecast and an official result. The comparison uses the latest saved prediction per strategy and Gameweek. The local Node server saves predictions in `.fpl-data/predictions.json`.

After the FPL deadline, select a strategy and click **Post-Deadline Preview** to analyse fixtures with a published kick-off still ahead. The preview uses players from clubs with remaining fixtures and stays separate from Prediction history and accuracy comparisons. Squad strategies show a ranked shortlist if the remaining clubs cannot form a legal squad.

Current ranking uses season points, playing time, and FPL form. Previous Gameweek Performance uses points, minutes, and individual stats from the latest completed Gameweek before the selected one. Both use the selected Gameweek's official fixtures and current availability.

Each player row shows the previous Gameweek's official actual points next to the selected Gameweek's predicted points. The actual field shows a dash until the previous Gameweek's score is final and available. Refreshing FPL fills in missing prior scores for saved predictions in the current season.

**Predicted FPL Rule-Based Points** combines the official scoring rules, the point weights in `game_config.scoring` and the selected strategy's stats. Each historical match is evaluated separately for playing time, clean sheets, saves, goals conceded, defensive contributions and card deductions before rates are averaged. The forecast estimates attacking returns for upcoming fixtures and uses the API's published bonus awards to estimate bonus points. Each player's final Gameweek forecast is rounded once to the nearest whole point before captain or chip multipliers. [Official FPL scoring rules](https://fantasy.premierleague.com/en/help/rules) · [Official FPL scoring configuration](https://fantasy.premierleague.com/api/bootstrap-static/)

**Current FPL Ranking** uses season rates and the selected players' official match histories. **Previous Gameweek Performance** uses the last completed Gameweek. **Recent Performance Form** uses recent official matches for per-match thresholds, blends other recent rates with season rates where available, and includes verified non-EPL contributions. A dash indicates insufficient match data. The original strategy forecasts still drive squad selection, totals, captaincy and accuracy. History also displays older rule-based forecasts as whole points.

**Recent Performance Form** only selects players with a verified appearance in the past 14 days in an English domestic cup, UEFA club competition, or senior international match covered by ESPN. It weighs points from up to three completed FPL Gameweeks and adjusts for the next fixture and recent non-EPL contributions. If the eligible players cannot form a legal squad, it shows a ranked shortlist of up to 15 players. The app reuses the last completed Gameweek from the refresh, caches match reports, and displays the sources and their coverage. [ESPN soccer scores](https://www.espn.com/soccer/scoreboard)

**Season Index Match Predictor** adds each club’s goal, clean-sheet, and win-or-draw percentages from Gameweek 1 through the latest completed Gameweek of the current season. The win-or-draw percentage is 100 × (wins + draws) ÷ matches played. The higher index predicts the winner, and equal indices predict a draw. The winner’s players, or both clubs’ players in a draw, qualify for the attacking and defensive rankings and Final Top 15 selection. Both clubs need completed season data for a prediction.

**H2H Index Match Predictor** applies the same index to the three most recent completed meetings ESPN verifies for each fixture, across both venues and the competitions it covers. The report shows the meetings used. A fixture with fewer than three verified meetings has no prediction or eligible players. Eligible players use the same FPL projections and squad selection. [ESPN Premier League scoreboard](https://www.espn.com/soccer/scoreboard/_/league/eng.1)

The **Final Top 15 player selection** takes the highest-ranked unique players across the analysed fixtures, with two goalkeepers, five defenders, five midfielders and three forwards. The rankings prioritise scored players by their club’s goal rate for attackers or clean-sheet rate for defenders, then by projected FPL points. For players with multiple eligible fixtures, the list uses the average club rate and sums the fixture projections when all are available. Players with unavailable projections rank after scored players. The report shows any unfilled slots by position.

**News & Expert Opinion Analysis** searches the last seven days of coverage in The Guardian, BBC Sport, Sky Sports, The Independent and Fantasy Football Scout feeds. It matches current FPL players to positive coverage, counts at most one mention per publisher per player, and deduplicates repeated bylines and copied passages. Rankings use the independent mention count followed by the strength of the positive language. Each recommendation links to the dated article. This list is separate from squad points and prediction history.

Select **Special Rules** and click **Analyse FPL Players** after refreshing the selected Gameweek. The report uses completed Gameweeks before the selected Gameweek and counts goals and assists across all matches in each Gameweek. It is also available after the prediction deadline.

- **Special Rule** lists players who started at least one match in each of the latest three completed Gameweeks, regardless of minutes played. They must have scored or assisted in the oldest of the three and recorded zero goals and zero assists in both more recent Gameweeks.
- **Special Rule2** lists all players with a goal or assist in each of the first two of four consecutive completed Gameweeks and zero goals and zero assists in each of the last two. Returns from substitute appearances also count.
- **Special Rule3** lists all players who started at least one match in each of the latest three consecutive completed Gameweeks, regardless of minutes played. They must have scored or assisted in each of the first two and recorded zero goals and zero assists in the latest.
- **Special Rule4** lists all players who started at least one match and recorded at least one goal or assist in each of the latest three consecutive completed Gameweeks, regardless of minutes played.
- **Special Rule5** lists all players who started at least one match and recorded at least one goal or assist in each of the latest two consecutive completed Gameweeks, regardless of minutes played.

## Browse players and your public squad

Choose a projection horizon or filter the player rankings. Select a player to inspect official stats, fixtures, history, and Gameweek scoring. **My squad** loads the latest public deadline picks from the numeric Team ID in the URL of your FPL points page, after `/entry/`. For transfer advice, enter your actual FPL selling price and bank balance. The shortlist applies the position, club, and budget rules before any points hit. Public picks reflect the deadline snapshot and omit subsequent transfers, current selling prices, and available free transfers. [Official FPL FAQs](https://fantasy.premierleague.com/help/faqs)

## Data and projections

| Official feed | Use |
| --- | --- |
| [`/api/bootstrap-static/`](https://fantasy.premierleague.com/api/bootstrap-static/) | Current-season players, prices, statistics, clubs, positions and Gameweek deadlines |
| [`/api/fixtures/`](https://fantasy.premierleague.com/api/fixtures/) | Kick-offs, scores, and home and away fixture difficulty |
| `/api/element-summary/{playerId}/` | Historical match stats and future fixtures for the selected player |
| `/api/event/{gameweek}/live/` | Scoring for the active or latest locked Gameweek |
| `/api/entry/{teamId}/` and `/api/entry/{teamId}/event/{gameweek}/picks/` | Public squad, bank and results at the deadline |

The app validates league snapshots before using or saving them. It keeps the newest validated snapshot and an archive of the latest successful snapshot per covered Gameweek. A failed, timed-out, or incomplete refresh recovers the latest validated data for the current season. A missing cache produces a warning. Node stores the cache in `.fpl-cache/` and the Worker uses its SQLite-backed session storage.

Previously fetched Gameweek scoring and player histories are also recoverable. Final scoring is cached separately from provisional scoring. Saved predictions are reconciled only with official completion flags and final scoring, and prediction locks still use the published deadlines. Player details and public squad data are fetched when opened. Source details show retrieval time, cache provenance where applicable, HTTP `Date`, and `Last-Modified` when available.

The multi-Gameweek player rankings use 70% playing-time-adjusted season scoring and 30% official FPL form, with small samples pulled towards the observed scoring rate for the player's position. They adjust each upcoming match for home advantage, official fixture difficulty, and current FPL availability. Blank weeks contribute zero and doubles contribute both matches. Captain options use next-Gameweek points before the captain multiplier.

## Test

Run `npm test` with HTTPS access to the official FPL API and the supplementary data providers. The suite starts a temporary local server, exercises the prediction strategies, checks the squad constraints, and replays completed official results to verify accuracy. Set `FPL_TEST_ENTRY_ID` to a public Team ID with published picks to include the personal squad and transfer checks. In PowerShell, use `$env:FPL_TEST_ENTRY_ID = '1'` for the public example entry.
