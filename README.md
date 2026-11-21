# Personal FPL Assistant

The dashboard ranks players, shows upcoming fixtures and recent match history, and suggests captains and single transfers from your published squad. The statistical model runs locally and uses the official Fantasy Premier League feeds.

## Run

Install Node.js 22 or later, run `npm ci`, then run `npm start` and open [the local assistant](http://127.0.0.1:3000/). The process needs HTTPS access to `fantasy.premierleague.com`. The port can be changed with `FPL_PORT`.

## Run on Cloudflare Workers

Run `npm ci` to install Wrangler. Use `npm run cloudflare:dev` to test the dashboard and API together locally, or `npm run cloudflare:check` to check the deployable bundle.

For a public deployment on your Cloudflare account, run `npx wrangler login`, then `npm run cloudflare:deploy`. Wrangler prints the Worker URL. To deploy from GitHub, connect the repository's `main` branch in Workers Builds and use `npm run cloudflare:deploy` as the deploy command. [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)

The Worker serves the dashboard and its `/api` routes from the same URL. An anonymous browser cookie identifies a SQLite-backed Durable Object that stores that browser's official FPL snapshot, refresh state, and prediction history. The Cloudflare deployment starts with its own history. [Durable Objects storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Predict a Gameweek squad

1. Select a Gameweek, then click **Refresh FPL Data**. The page shows the time of the last successful refresh. Opening the dashboard reads the saved league snapshot locally.
2. Select a strategy, then click **Analyse FPL Players**. **Current FPL Ranking**, **Previous Gameweek Performance**, and **Recent Performance Form** project squad points. **Match & Player** gives a fixture report and its own top 15. **News & Expert Opinion Analysis** returns its own ranked list. These strategies are available before the Gameweek deadline.
3. The squad fits the standard £100m budget and three-player club limit, with two goalkeepers, five defenders, five midfielders and three forwards. The total adds all 15 player forecasts before captaincy. A dash indicates insufficient scoring evidence.
4. In **Prediction history**, compare saved results across strategies and Gameweeks. Click **Refresh FPL Data** after scoring is final to record actuals. Results report mean absolute error per player with both a forecast and an official result. The comparison uses the latest saved prediction per strategy and Gameweek. The local Node server saves predictions in `.fpl-data/predictions.json`.

Current ranking uses season points, playing time, and FPL form. Previous Gameweek Performance uses points, minutes, and individual stats from the latest completed Gameweek before the selected one. Both use the selected Gameweek's official fixtures and current availability.

Each player row shows the previous Gameweek's official actual points next to the selected Gameweek's predicted points. The actual field shows a dash until the previous Gameweek's score is final and available. Refreshing FPL fills in missing prior scores for saved predictions in the current season.

**Predicted FPL Rule-Based Points** combines the official scoring rules, the point weights in `game_config.scoring` and the selected strategy's stats. Each historical match is evaluated separately for playing time, clean sheets, saves, goals conceded, defensive contributions and card deductions before rates are averaged. The forecast estimates attacking returns for upcoming fixtures and uses the API's published bonus awards to estimate bonus points. Each player's final Gameweek forecast is rounded once to the nearest whole point before captain or chip multipliers. [Official FPL scoring rules](https://fantasy.premierleague.com/en/help/rules) · [Official FPL scoring configuration](https://fantasy.premierleague.com/api/bootstrap-static/)

**Current FPL Ranking** uses season rates and the selected players' official match histories. **Previous Gameweek Performance** uses the last completed Gameweek. **Recent Performance Form** uses recent official matches for per-match thresholds, blends other recent rates with season rates where available, and includes verified non-EPL contributions. A dash indicates insufficient match data. The original strategy forecasts still drive squad selection, totals, captaincy and accuracy. History also displays older rule-based forecasts as whole points.

**Recent Performance Form** only selects players with a verified appearance in the past 14 days in an English domestic cup, UEFA club competition, or senior international match covered by ESPN. It weighs points from up to three completed FPL Gameweeks and adjusts for the next fixture and recent non-EPL contributions. If the eligible players cannot form a legal squad, it shows a ranked shortlist of up to 15 players. The app reuses the last completed Gameweek from the refresh, caches match reports, and displays the sources and their coverage. [ESPN soccer scores](https://www.espn.com/soccer/scoreboard)

**Match & Player** estimates goals from completed official Premier League scores using separate home and away attack and defence rates. Recent results receive more weight, and small venue samples are pulled toward the league average. The model calculates home win, draw, away win and both clean-sheet probabilities. The displayed score is the most probable score for the predicted outcome. Draws produce no picks.

For each predicted winning team, the strategy takes the highest projected player at each position. It applies official FPL scoring weights to estimated playing time, attacking returns, clean sheets, bonus and other scoring events. Playing time uses up to three completed official Gameweeks. Attacking and bonus rates blend recent and season data where available. The final ranking takes up to 15 unique players by unrounded Gameweek projection, including both fixtures in a Double Gameweek, and displays whole points. The top two are captain and vice-captain. The ranking can use any position mix, cost or club count. Fixtures, positions and players with insufficient evidence are identified in the report. [Official FPL scoring rules](https://fantasy.premierleague.com/en/help/rules)

**Head-to-Head (H2H) Analysis** is a separate fixture report. It uses the latest four completed meetings available in ESPN's match summaries, including previous seasons and other competitions where covered. It calculates win, draw and loss percentages from the upcoming home team's perspective, counting tied scores as draws. A full four-match sample contributes 25% of the outcome forecast alongside the season model. Smaller samples contribute proportionally less. The report uses the season model alone when no meetings are available, or the four-match H2H sample alone when the season model lacks results. For each fixture it lists players from the predicted winner's club, or from both clubs for a predicted draw. [ESPN Premier League scoreboard](https://www.espn.com/soccer/scoreboard/_/league/eng.1)

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

The Node server joins the league feeds and verifies the season from the Gameweek 1 deadline. It keeps a timestamped snapshot in `.fpl-cache/season.json` and labels snapshots older than ten minutes. Player details and public squad data are fetched when opened. Data sources expose the endpoint URL, retrieval time, HTTP `Date`, and `Last-Modified` when the provider supplies it.

The multi-Gameweek player rankings use 70% playing-time-adjusted season scoring and 30% official FPL form, with small samples pulled towards the observed scoring rate for the player's position. They adjust each upcoming match for home advantage, official fixture difficulty, and current FPL availability. Blank weeks contribute zero and doubles contribute both matches. Captain options use next-Gameweek points before the captain multiplier.

## Test

Run `npm test` with HTTPS access to the official FPL API and the supplementary data providers. The suite starts a temporary local server, exercises the prediction strategies, checks the squad constraints, and replays completed official results to verify accuracy. Set `FPL_TEST_ENTRY_ID` to a public Team ID with published picks to include the personal squad and transfer checks. In PowerShell, use `$env:FPL_TEST_ENTRY_ID = '1'` for the public example entry.
