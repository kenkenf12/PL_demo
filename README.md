# Personal FPL Assistant

The dashboard ranks players, shows upcoming fixtures and recent match history, and suggests captains and single transfers from your published squad. The statistical model runs locally and uses the official Fantasy Premier League feeds.

## Run

Install Node.js 22 or later, then run `npm start` and open [the local assistant](http://127.0.0.1:3000/). The process needs HTTPS access to `fantasy.premierleague.com`. The port can be changed with `FPL_PORT`.

## Predict a Gameweek squad

1. Select a Gameweek, then click **Refresh FPL Data**. The page shows the time of the last successful refresh. Opening the dashboard reads the saved league snapshot locally.
2. Select **Current FPL Ranking**, **Previous Gameweek Performance**, or **Weather Impact Prediction**, then click **Analyse FPL Players**. Predictions are available before the Gameweek deadline.
3. The squad fits the standard £100m budget and three-player club limit, with two goalkeepers, five defenders, five midfielders and three forwards. The total adds all 15 player forecasts before captaincy. A dash indicates insufficient scoring evidence.
4. In **Prediction history**, compare saved results across strategies and Gameweeks. Click **Refresh FPL Data** after scoring is final to record actuals. Results report mean absolute error per player with both a forecast and an official result. The comparison uses the latest saved prediction per strategy and Gameweek. Predictions are saved locally in `.fpl-data/predictions.json`.

Current ranking uses season points, playing time, and FPL form. Previous Gameweek Performance uses points, minutes, and individual stats from the latest completed Gameweek before the selected one. Both use the selected Gameweek's official fixtures and current availability. The weather strategy also retrieves Open-Meteo forecasts for the home grounds and flags heavy rain, wind gusts, and extreme temperatures. Weather flags add context to the FPL-based points estimate. Missing fixture forecasts and coverage are shown in the result. [Open-Meteo forecast data](https://open-meteo.com/en/docs) · [Premier League home grounds](https://www.premierleague.com/en/news/4725666/all-you-need-to-know-about-the-20-premier-league-stadiums)

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

The Node server joins the league feeds and verifies the season from the Gameweek 1 deadline. It keeps a timestamped snapshot in `.fpl-cache/season.json` and labels snapshots older than ten minutes. Player details and public squad data are fetched when opened. Data sources expose the endpoint URL, retrieval time, HTTP `Date`, and `Last-Modified` when the provider supplies it. Weather also requires HTTPS access to `api.open-meteo.com`.

The multi-Gameweek player rankings use 70% playing-time-adjusted season scoring and 30% official FPL form, with small samples pulled towards the observed scoring rate for the player's position. They adjust each upcoming match for home advantage, official fixture difficulty, and current FPL availability. Blank weeks contribute zero and doubles contribute both matches. Captain options use next-Gameweek points before the captain multiplier.

## Test

Run `npm test` with HTTPS access to the official FPL API and Open-Meteo. The suite starts a temporary local server, exercises each prediction strategy, checks the squad constraints, and replays completed official results to verify accuracy. Set `FPL_TEST_ENTRY_ID` to a public Team ID with published picks to include the personal squad and transfer checks. In PowerShell, use `$env:FPL_TEST_ENTRY_ID = '1'` for the public example entry.
