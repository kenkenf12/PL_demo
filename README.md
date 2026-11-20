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
2. Select a strategy, then click **Analyse FPL Players**. **Current FPL Ranking**, **Previous Gameweek Performance**, and **Recent Performance Form** project player points. **News & Expert Opinion Analysis** and **UK Betting Odds Comparison & Player Selection** each return their own ranked list. Analysis is available before the Gameweek deadline.
3. The squad fits the standard £100m budget and three-player club limit, with two goalkeepers, five defenders, five midfielders and three forwards. The total adds all 15 player forecasts before captaincy. A dash indicates insufficient scoring evidence.
4. In **Prediction history**, compare saved results across strategies and Gameweeks. Click **Refresh FPL Data** after scoring is final to record actuals. Results report mean absolute error per player with both a forecast and an official result. The comparison uses the latest saved prediction per strategy and Gameweek. The local Node server saves predictions in `.fpl-data/predictions.json`.

Current ranking uses season points, playing time, and FPL form. Previous Gameweek Performance uses points, minutes, and individual stats from the latest completed Gameweek before the selected one. Both use the selected Gameweek's official fixtures and current availability.

Each player row shows the previous Gameweek's official actual points next to the selected Gameweek's predicted points. The actual field shows a dash until the previous Gameweek's score is final and available. Refreshing FPL fills in missing prior scores for saved predictions in the current season.

**FPL Rule-Based Predicted Points** uses `game_config.scoring` from the official FPL bootstrap API and the per-fixture scoring breakdowns from the last completed Gameweek before the selected one. The average per match is scaled by the number of scheduled fixtures. A dash indicates missing official scoring data. This extra forecast leaves the original projections, captain selection, totals, and accuracy calculations unchanged. [Official FPL scoring configuration](https://fantasy.premierleague.com/api/bootstrap-static/)

**Recent Performance Form** only selects players with a verified appearance in the past 14 days in an English domestic cup, UEFA club competition, or senior international match covered by ESPN. It weighs points from up to three completed FPL Gameweeks and adjusts for the next fixture and recent non-EPL contributions. If the eligible players cannot form a legal squad, it shows a ranked shortlist of up to 15 players. The app reuses the last completed Gameweek from the refresh, caches match reports, and displays the sources and their coverage. [ESPN soccer scores](https://www.espn.com/soccer/scoreboard)

**News & Expert Opinion Analysis** searches the last seven days of coverage in The Guardian, BBC Sport, Sky Sports, The Independent and Fantasy Football Scout feeds. It matches current FPL players to positive coverage, counts at most one mention per publisher per player, and deduplicates repeated bylines and copied passages. Rankings use the independent mention count followed by the strength of the positive language. Each recommendation links to the dated article. This list is separate from squad points and prediction history.

**UK Betting Odds Comparison & Player Selection** matches upcoming FPL fixtures to pre-match anytime goalscorer prices from The Odds API. It ranks eligible FPL players by the median implied chance from at least two UK sportsbooks per fixture. Each result shows decimal prices, bookmakers and update times where supplied. The odds list is separate from squad points and prediction history. [The Odds API EPL coverage](https://the-odds-api.com/sports/epl-odds.html)

To enable live odds, set `ODDS_API_KEY` in the environment that runs the app. For local Wrangler development, put the key in the git-ignored `.dev.vars` file. For a deployed Worker, add `ODDS_API_KEY` as a Cloudflare secret or use `npx wrangler secret put ODDS_API_KEY`. The strategy requests the `uk` region, filters to UK sportsbooks and caches event prices for five minutes. Bookmaker coverage varies by fixture. [The Odds API event odds documentation](https://the-odds-api.com/liveapi/guides/v4/#get-event-odds) · [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

The app pauses odds requests when The Odds API reports fewer than 10 credits remaining, or when it cannot verify the balance. It displays the last saved prices for that fixture with their retrieval time. A quota-free events request checks for a replenished balance. Cloudflare shares the saved quotes and quota guard across browser sessions in a Durable Object. The local server saves them in `.fpl-cache/odds/`.

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
