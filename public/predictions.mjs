import { forecast, isGameweekComplete, price, remainingFixtures } from './model.mjs';

const statusCheckInterval = 5 * 60_000;

const archivedStrategyNames = new Map([['match-winners', 'Match & Player'], ['weather', 'Archived weather prediction']]);
const historyPeriod = (seasonYear, gameweek) => `${seasonYear}:${gameweek}`;
const $ = selector => document.querySelector(selector);

export function setupPredictions({ request, html, sourceList, openDialog, sourceTime, onRefresh }) {
  const week = $('#prediction-week');
  const strategy = $('#prediction-strategy');
  const strategyNames = new Map(Array.from(strategy.options).filter(option => option.value)
    .map(option => [option.value, option.textContent.trim()]));
  const strategyLabel = id => strategyNames.get(id) ?? archivedStrategyNames.get(id) ?? id;
  const refresh = $('#refresh');
  const analyse = $('#analyse');
  const preview = $('#prediction-preview');
  const refreshStatus = $('#refresh-status');
  const gameweekStatus = $('#gameweek-status');
  const dataStatus = $('#data-status');
  const analysisStatus = $('#analysis-status');
  const result = $('#prediction-result');
  const newsResult = $('#news-result');
  const historyWeek = $('#history-week');
  const history = $('#history-content');
  let ready;
  let hasSnapshot = false;
  let busy = false;
  let records;
  let seasonYear;
  let seasonWeeks = [];
  let historyRequest = 0;
  let reportRequest = 0;
  let gameweekOptions;
  let statusRequest;
  let refreshSequence = 0;
  const shortDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/London' });
  const percent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 }).format;

  function hideResults() {
    result.hidden = true;
    newsResult.hidden = true;
  }

  function gameweeks(events) {
    const options = '<option value="">Choose a Gameweek</option>' + events.map(event =>
      `<option value="${event.id}">${html(event.name)}${isGameweekComplete(event) ? ' · COMPLETE' : ''}</option>`).join('');
    if (gameweekOptions !== options) {
      const selected = week.value;
      week.innerHTML = options;
      week.value = events.some(event => event.id === Number(selected)) ? selected : '';
      gameweekOptions = options;
    }
  }

  function showGameweekStatus({ events, seasonYear: year }) {
    gameweeks(events);
    if (year !== seasonYear) {
      seasonYear = year;
      seasonWeeks = events.map(event => event.id);
      renderHistory(true);
    }
    const latestComplete = events.reduce((latest, event) => isGameweekComplete(event) && event.id > latest ? event.id : latest, 0);
    const message = latestComplete ? `Gameweek ${latestComplete} · COMPLETE`
      : 'No Gameweek has been confirmed complete.';
    if (gameweekStatus.textContent !== message) gameweekStatus.textContent = message;
    gameweekStatus.hidden = false;
  }

  function canPreview(time) {
    return Boolean(ready && !ready.week.finished && Date.parse(ready.week.deadline_time) <= time
      && remainingFixtures(ready.dashboard.fixtures, ready.week.id, time).length);
  }

  function updateControls() {
    const time = Date.now();
    const locked = ready && (ready.week.finished || Date.parse(ready.week.deadline_time) <= time);
    const previewAvailable = canPreview(time);
    const specialRules = strategy.value === 'special-rules';
    week.disabled = busy;
    refresh.disabled = busy || !week.value;
    strategy.disabled = busy || !ready;
    for (const option of strategy.options) {
      option.disabled = Boolean(locked && !previewAvailable && option.value && option.value !== 'special-rules');
    }
    const unavailable = strategy.disabled || !strategy.value || strategy.selectedOptions[0]?.disabled
      || (strategy.value === 'previous' && !ready.previousWeek);
    analyse.hidden = previewAvailable && !specialRules;
    analyse.disabled = unavailable || Boolean(locked && !specialRules);
    preview.hidden = !analyse.hidden;
    preview.disabled = unavailable || preview.hidden;
  }

  function showAnalysis(message) {
    analysisStatus.textContent = message;
    analysisStatus.hidden = !message;
  }

  function checkGameweekStatus() {
    if (busy || statusRequest || document.hidden) return;
    const sequence = refreshSequence;
    statusRequest = request('/api/dashboard').then(data => {
      if (sequence !== refreshSequence) return;
      if (hasSnapshot) {
        showGameweekStatus(data);
        return;
      }
      showSnapshot(data);
      onRefresh(data);
      if (data.refreshError) refreshStatus.textContent = `${data.refreshError} Using the last validated league dataset.`;
    }).catch(error => {
      if (sequence !== refreshSequence || hasSnapshot) return;
      refreshStatus.textContent = error.message;
      dataStatus.textContent = 'Data source unavailable · Gameweek unavailable · Dataset incomplete';
    }).finally(() => { statusRequest = undefined; });
  }

  function showSnapshot(data) {
    hasSnapshot = true;
    showGameweekStatus(data);
    const { source, lastSuccessfulFetch, gameweek, complete } = data.dataStatus;
    dataStatus.textContent = `${source} · ${gameweek == null ? 'Gameweek unavailable' : `Covers Gameweek ${gameweek}`} · League dataset ${complete ? 'complete' : 'incomplete'}`;
    $('#last-refresh').textContent = `Last successful fetch ${sourceTime.format(new Date(lastSuccessfulFetch))}`;
    updateControls();
  }

  function reportSections(results, phases, heading = 'Final results') {
    return `<section class="analysis-results"><h4>${heading}</h4>${results}</section>
      <section class="analysis-breakdown"><h4>Analysis breakdown</h4>
        ${phases.map(([title, content], index) => `<section class="analysis-phase">
          <h5>Phase ${index + 1} · ${title}</h5>${content}</section>`).join('')}
      </section>`;
  }

  function scoringSources(sources) {
    return `<details class="provenance"><summary>Prediction data sources</summary>${sourceList(sources)}
      <p><a href="https://fantasy.premierleague.com/en/help/rules" target="_blank" rel="noopener">Official FPL scoring rules</a></p>
    </details>`;
  }

  function matchResultSummary(matches, fixture, outcome) {
    if (!matches.length) return '';
    return `<h5>Predicted match outcomes</h5><dl class="analysis-summary">
      ${matches.map(match => `<div><dt>${fixture(match)}</dt><dd>${outcome(match)}</dd></div>`).join('')}
    </dl>`;
  }

  const squadInputs = {
    ranking: 'Season points, playing time and official FPL form establish the baseline for each player.',
    previous: 'The baseline uses points, minutes and expected goal involvement from the latest completed Gameweek before the selected one.',
    recent: 'Recent performances establish the baseline. Selection requires a verified appearance in an English domestic cup, UEFA club competition or senior international match in the past 14 days.'
  };

  function squadView(record) {
    const { players, accuracy, shortlist } = record;
    const emptyShortlist = record.strategy === 'recent' ? 'No eligible players had a verified non-EPL appearance in the 14-day window.'
      : 'No eligible players are available for the remaining fixtures.';
    const previousWeek = record.gameweek - 1;
    const actual = new Map(accuracy?.actual.map(player => [player.id, player.points]));
    const comparison = accuracy && accuracy.meanAbsoluteError != null
      ? `<p>Mean absolute error <strong>${forecast(accuracy.meanAbsoluteError)} pts/player</strong> · ${accuracy.comparedCount} compared · ${forecast(accuracy.predictedComparableTotal)} predicted, ${accuracy.actualComparableTotal} actual for those players.</p>` : '';
    const form = record.recentForm;
    const coverage = form ? [
      form.domesticWeeks.length ? `PL results: ${form.domesticWeeks.map(week => 'GW' + week).join(', ')}` : 'Recent PL results unavailable',
      form.cupReports ? `${form.cupReports} domestic cup reports matched` : '',
      form.europeanReports ? `${form.europeanReports} UEFA club reports matched` : '',
      form.internationalReports ? `${form.internationalReports} international reports matched` : '',
      form.days < form.expectedDays || form.reports < (form.available ?? form.requested) || form.domesticWeeks.length < form.requestedWeeks ? 'Partial data coverage' : ''
    ].filter(Boolean).join(' · ') : '';
    const evidence = players.filter(player => player.evidence);
    const results = `<div class="prediction-result-head">
      <p>${players.length} ${shortlist && players.length ? 'shortlisted ' : ''}${players.length === 1 ? 'player' : 'players'}${shortlist ? '' : ` · ${price(record.cost)}`}</p>
      ${players.length ? `<div class="prediction-total"><strong>${forecast(record.total)}</strong><span>Projected ${shortlist ? 'shortlist' : 'squad'} pts</span></div>` : ''}</div>
      ${shortlist ? `<p>${players.length
        ? 'Too few eligible players to form a legal squad. Ranked shortlist shown.'
        : emptyShortlist}</p>`
        : `<p>Captain <strong>${html(players.find(player => player.id === record.captain)?.name)}</strong> · Vice-captain <strong>${html(players.find(player => player.id === record.viceCaptain)?.name)}</strong></p>`}
      ${players.length ? `<div class="scroll-table" tabindex="0" aria-label="${shortlist ? 'Player shortlist' : 'Predicted 15-player squad'}">
        <table><thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th><th scope="col">Price</th>
        ${previousWeek > 0 ? `<th scope="col" title="Official FPL points once the Gameweek is final">GW${previousWeek} actual points</th>` : ''}
        <th scope="col">GW${record.gameweek} predicted points</th>
        <th scope="col" title="Uses the selected strategy and official match scoring rules, then rounds to whole points before captaincy">Predicted FPL Rule-Based Points</th>
        ${accuracy ? `<th scope="col">GW${record.gameweek} actual points</th>` : ''}</tr></thead>
        <tbody>${players.map(player => `<tr><td><strong>${html(player.name)}</strong>
          ${player.id === record.captain ? '<span class="prediction-role">C</span>' : player.id === record.viceCaptain ? '<span class="prediction-role">VC</span>' : ''}</td>
          <td>${html(player.team)}</td><td>${html(player.position)}</td><td>${price(player.cost)}</td>
          ${previousWeek > 0 ? `<td>${player.previousActualPoints ?? '—'}</td>` : ''}
          <td>${forecast(player.predicted)}</td>
          <td>${player.predictedFplRuleBasedPoints ?? '—'}</td>
          ${accuracy ? `<td>${actual.get(player.id) ?? '—'}</td>` : ''}</tr>`).join('')}</tbody></table>
      </div>` : ''}`;
    const phases = [
      ['Player evidence and eligibility', `${squadInputs[record.strategy] ? `<p>${squadInputs[record.strategy]}</p>` : ''}
        ${record.previousWeek ? `<p>Uses final GW${record.previousWeek} results.</p>` : ''}
        ${coverage ? `<p class="prediction-caption">${html(coverage)}</p>` : ''}
        ${evidence.length ? `<details class="provenance" open><summary>Recent appearances by selected player</summary><ul>
          ${evidence.map(({ name, evidence: player }) => `<li><strong>${html(name)}</strong> · ${player.domesticWeeks} PL weeks · ${player.cupMatches} domestic cup · ${player.europeanMatches ?? 0} UEFA club · ${player.internationalMatches} international</li>`).join('')}
        </ul></details>` : ''}
        ${scoringSources(record.sources)}`],
      ['Point projections', `<p>Availability, venue and fixture difficulty adjust the strategy forecast. The separate rule-based forecast applies official FPL scoring weights.</p>
        ${record.projectedCount < players.length ? `<p>${record.projectedCount} of ${players.length} players have a point estimate.</p>` : ''}`],
      ['Squad selection', `<p>Squad selection applies the £100m budget, position requirements and three-player club limit.</p>
        ${shortlist ? '' : '<p>Squad totals add all 15 players before captaincy.</p>'}`]
    ];
    if (accuracy) phases.push(['Actual scoring', `${comparison}
      <details class="provenance"><summary>Actual scoring source</summary>${sourceList(accuracy.sources)}</details>`]);
    return `<div class="prediction-result-head"><h3>Gameweek ${record.gameweek} · ${html(strategyLabel(record.strategy))}</h3></div>
      ${reportSections(results, phases)}`;
  }

  function archivedMatchWinnerView(record) {
    const { matches, players, accuracy, sampleWeeks } = record;
    const matchup = match => `${html(match.home.name)} v ${html(match.away.name)}`;
    const actual = new Map(accuracy?.actual.map(player => [player.id, player.points]));
    const coverage = sampleWeeks.length ? `Player form uses ${sampleWeeks.map(week => 'GW' + week).join(', ')}.`
      : 'Recent official player match data is unavailable.';
    const forecasts = `<p>${matches.filter(match => match.score).length}/${matches.length} fixtures forecast · ${record.completedMatches} completed matches in the team model</p>
      ${matches.length ? `<div class="scroll-table" tabindex="0" aria-label="Match forecasts"><table>
        <thead><tr><th scope="col">Fixture</th><th scope="col">Predicted score</th><th scope="col">Predicted outcome</th>
          <th scope="col">Expected goals (H/A)</th><th scope="col">Home win</th><th scope="col">Draw</th><th scope="col">Away win</th>
          <th scope="col">Home clean sheet</th><th scope="col">Away clean sheet</th></tr></thead>
        <tbody>${matches.map(match => `<tr><td><strong>${matchup(match)}</strong>
          ${match.kickoff ? `<span class="player-meta">${sourceTime.format(new Date(match.kickoff))}</span>` : ''}</td>
          ${match.score ? `<td><strong>${match.score.home}–${match.score.away}</strong>
          <span class="player-meta">${percent(match.score.probability)} exact-score chance</span></td>
          <td>${match.winner ? html(match.winner.name) : 'Draw'}${match.uncertain ? '<span class="player-meta">Low confidence</span>' : ''}</td>
          <td>${forecast(match.home.expectedGoals)} / ${forecast(match.away.expectedGoals)}</td>
          <td>${percent(match.probabilities.home)}</td><td>${percent(match.probabilities.draw)}</td><td>${percent(match.probabilities.away)}</td>
          ${[match.home, match.away].map(team => `<td>${percent(team.cleanSheetProbability)}${team.cleanSheet ? '<span class="player-meta">Predicted clean sheet</span>' : ''}</td>`).join('')}`
          : `<td colspan="8">${html(match.reason)}</td>`}</tr>`).join('')}</tbody>
      </table></div>` : '<p>No upcoming fixtures are scheduled for this Gameweek.</p>'}`;
    const winnerPicks = `<p class="prediction-caption">${html(coverage)}${record.requestedWeeks > sampleWeeks.length ? ' Coverage is partial.' : ''}</p>
      ${matches.some(match => match.winner) ? matches.filter(match => match.winner).map(match =>
        `<details class="provenance"><summary>${matchup(match)} · ${match.picks.length}/4 picks for ${html(match.winner.name)}</summary>
        ${match.missingPositions.length ? `<p>Insufficient player data for ${html(match.missingPositions.join(', '))}.</p>` : ''}
        ${match.picks.length ? `<div class="scroll-table" tabindex="0" aria-label="Predicted winning team picks"><table>
          <thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th>
          <th scope="col">Start chance</th><th scope="col">Expected minutes</th><th scope="col">Projected FPL points</th></tr></thead>
          <tbody>${match.picks.map(player => `<tr><td>${html(player.name)}</td><td>${html(player.team)}</td><td>${html(player.position)}</td>
          <td>${percent(player.startProbability)}</td><td>${player.expectedMinutes}</td><td>${player.predicted}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}</details>`).join('') : '<p>No fixture has a predicted winner.</p>'}`;
    const results = `<h5>Top 15 player ranking</h5>
      <p class="prediction-caption">${players.length} ranked${record.total != null ? ` · ${record.total} projected points before captaincy` : ''}</p>
      ${players.length < 15 ? '<p>Fewer than 15 players had sufficient data from predicted winning teams.</p>' : ''}
      ${players.length ? `<div class="scroll-table" tabindex="0" aria-label="Top ranked players"><table>
        <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th>
          ${record.gameweek > 1 ? `<th scope="col">GW${record.gameweek - 1} actual points</th>` : ''}
          <th scope="col">Projected FPL points</th>${accuracy ? `<th scope="col">GW${record.gameweek} actual points</th>` : ''}</tr></thead>
        <tbody>${players.map((player, index) => `<tr><td>${index + 1}</td><td><strong>${html(player.name)}</strong>
          ${player.id === record.captain ? '<span class="prediction-role">Captain</span>'
            : player.id === record.viceCaptain ? '<span class="prediction-role">Vice-captain</span>' : ''}</td>
          <td>${html(player.team)}</td><td>${html(player.position)}</td>
          ${record.gameweek > 1 ? `<td>${player.previousActualPoints ?? '—'}</td>` : ''}
          <td>${player.predicted}</td>${accuracy ? `<td>${actual.get(player.id) ?? '—'}</td>` : ''}</tr>`).join('')}</tbody>
      </table></div>` : ''}
      ${matchResultSummary(matches, matchup, match => match.score ? `${match.score.home}–${match.score.away} · ${match.winner ? html(match.winner.name) : 'Draw'}` : 'No prediction')}`;
    return `<div class="prediction-result-head"><h3>Gameweek ${record.gameweek} · ${html(strategyLabel(record.strategy))}</h3></div>
      ${reportSections(results, [
        ['Match forecasts', forecasts + scoringSources(record.sources)],
        ['Picks by predicted winner', winnerPicks],
        ['Gameweek player ranking', `<p>${record.candidateCount} unique candidates. Rankings use unrounded projections across the Gameweek.</p>
          ${record.incompleteCandidates ? `<p>${record.incompleteCandidates} candidates lacked forecasts for all of their fixtures.</p>` : ''}
          ${accuracy ? `<details class="provenance"><summary>Actual scoring source</summary>${sourceList(accuracy.sources)}</details>` : ''}`]
      ])}`;
  }

  function seasonSquadView(squad) {
    const positionLabels = { GKP: 'Goalkeepers (GK)', DEF: 'Defenders (DEF)', MID: 'Midfielders (MID)', FWD: 'Forwards (FWD)' };
    const selected = squad.reduce((sum, group) => sum + group.players.length, 0);
    const required = squad.reduce((sum, group) => sum + group.required, 0);
    const shortages = squad.filter(group => group.players.length < group.required)
      .map(({ positionCode, required, players }) => `${required - players.length} ${positionCode === 'GKP' ? 'GK' : positionCode}`);
    return `<h5>Final Top 15 player selection</h5>
      <p>${selected} of ${required} players selected.</p>
      ${shortages.length ? `<p>Too few eligible players fit the position and three-player club limits. Missing ${shortages.join(', ')}.</p>` : ''}
      <div class="scroll-table" tabindex="0" aria-label="Final Top 15 player selection"><table>
        <thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th>
          <th scope="col">Performance score (projected FPL points)</th></tr></thead>
        ${squad.map(({ positionCode, required, players }) => `<tbody>
          <tr><th scope="rowgroup" colspan="4">${positionLabels[positionCode]} · ${players.length}/${required} selected</th></tr>
          ${players.map(player => `<tr><td>${html(player.name)}</td><td>${html(player.team)}</td>
            <td>${html(player.position)}</td><td>${forecast(player.performanceScore)}</td></tr>`).join('')}</tbody>`).join('')}
      </table></div>`;
  }

  const seasonMatchup = match => `${html(match.home.name)} v ${html(match.away.name)}`;
  const seasonPercent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 3 }).format;
  const seasonRate = value => value == null ? '—' : seasonPercent(value);
  const seasonIndexNumber = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format;
  const seasonIndexValue = value => value == null ? '—' : seasonIndexNumber(value);
  const indexOutcomeLabels = { home: 'Home Win', draw: 'Draw', away: 'Away Win' };
  const indexTeamCells = team => `<th scope="row">${html(team.name)}</th><td>${team.completedMatches}</td>
    <td>${seasonRate(team.goalProbability)}</td><td>${seasonRate(team.cleanSheetProbability)}</td>
    <td>${seasonRate(team.winOrDrawProbability)}</td>
    <td><strong>${seasonIndexValue(team.teamIndex)}</strong></td>`;

  function seasonPlayerTable(label, players, rateLabel) {
    return `<h6>${label}</h6>
      ${players.length ? `<div class="scroll-table" tabindex="0" aria-label="${label}"><table>
        <thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th>
          <th scope="col">${rateLabel}</th><th scope="col">Projected FPL points</th></tr></thead>
        <tbody>${players.map(player => `<tr><td>${html(player.name)}</td><td>${html(player.team)}</td>
          <td>${html(player.position)}</td><td>${seasonRate(player.priority)}</td>
          <td>${forecast(player.performanceScore)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No players listed for these positions.</p>'}`;
  }

  function seasonPlayerAnalysis(match) {
    return `<details class="provenance"><summary>${seasonMatchup(match)} · Player analysis</summary>
          ${seasonPlayerTable('Attacking players', match.attacking, 'Club goal rate')}
          ${seasonPlayerTable('Defensive players', match.defensive, 'Club clean-sheet rate')}
        </details>`;
  }

  function relativeIndexCells(match) {
    if (match.homePercentage == null || match.awayPercentage == null) return '<td>—</td><td>—</td>';
    // Round the displayed shares together so they still add up to 100%.
    const home = Math.round(match.homePercentage * 1000) / 1000;
    return `<td>${seasonIndexValue(home)}%</td><td>${seasonIndexValue(100 - home)}%</td>`;
  }

  function indexMatchOutcomes(matches, label, missingData, showPercentages = false) {
    return `<div class="scroll-table" tabindex="0" aria-label="${label}"><table>
        <thead><tr><th scope="col">Fixture</th><th scope="col">Home Index</th><th scope="col">Away Index</th>
          ${showPercentages ? '<th scope="col">Home Percentage</th><th scope="col">Away Percentage</th>' : ''}
          <th scope="col">Predicted outcome</th></tr></thead>
        <tbody>${matches.map(match => `<tr><th scope="row">${seasonMatchup(match)}</th>
          <td>${seasonIndexValue(match.home.teamIndex)}</td><td>${seasonIndexValue(match.away.teamIndex)}</td>
          ${showPercentages ? relativeIndexCells(match) : ''}
          <td>${match.outcome ? `<strong>${indexOutcomeLabels[match.outcome]}</strong>` : missingData}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  function indexReport({ gameweek, matches, squad, sources }, title, teamIndex, matchOutcomes) {
    const eligibleMatches = matches.filter(match => match.outcome);
    const results = seasonSquadView(squad) + matchResultSummary(matches, seasonMatchup, match => indexOutcomeLabels[match.outcome] ?? 'No prediction');
    return `<div class="prediction-result-head"><h3>Gameweek ${gameweek} · ${title}</h3></div>
      ${reportSections(results, [
        ['Team indices', `${teamIndex}
          ${sources.length ? `<details class="provenance"><summary>Analysis data sources</summary>${sourceList(sources)}</details>` : ''}`],
        ['Match outcome analysis', matches.length ? matchOutcomes : '<p>No upcoming fixtures are scheduled for this Gameweek.</p>'],
        ['Attacking and defensive player rankings', eligibleMatches.length ? eligibleMatches.map(seasonPlayerAnalysis).join('')
          : '<p>No players qualified for the fixture-level rankings.</p>']
      ])}`;
  }

  function seasonIndexView(report) {
    const { teams, matches, latestCompletedGameweek } = report;
    const scope = latestCompletedGameweek
      ? `Rates use completed Premier League matches from Gameweek 1${latestCompletedGameweek > 1 ? ` through Gameweek ${latestCompletedGameweek}` : ''}.`
      : 'No completed Gameweeks are available yet.';
    const teamIndex = `<p class="prediction-caption">${scope} The index adds the goal, clean-sheet, and win-or-draw percentages. Draws count for half a point.</p>
      <div class="scroll-table" tabindex="0" aria-label="Season team indices"><table>
        <thead><tr><th scope="col">Club</th><th scope="col">Matches</th><th scope="col">Goal Probability (%)</th>
          <th scope="col">Clean Sheet Probability (%)</th><th scope="col">Win or Draw Percentage (%)</th><th scope="col">Team Index</th></tr></thead>
        <tbody>${teams.map(team => `<tr>${indexTeamCells(team)}</tr>`).join('')}</tbody></table></div>`;
    return indexReport(report, 'Season Index Match Predictor', teamIndex,
      indexMatchOutcomes(matches, 'Season Index match predictions', 'Insufficient season data'));
  }

  function h2hMeetingsView(match, requiredMeetings) {
    const teamName = id => html((id === match.home.id ? match.home : match.away).name);
    return `<details class="provenance"><summary>${seasonMatchup(match)} · ${match.meetings.length}/${requiredMeetings} verified meetings</summary>
      ${match.meetings.length ? `<div class="scroll-table" tabindex="0" aria-label="Verified head-to-head meetings"><table>
        <thead><tr><th scope="col">Date</th><th scope="col">Competition</th><th scope="col">Result</th></tr></thead>
        <tbody>${match.meetings.map(meeting => `<tr><td>${shortDate.format(new Date(meeting.kickoff))}</td>
          <td>${html(meeting.competition)}</td><td>${teamName(meeting.team_h)} ${meeting.team_h_score}–${meeting.team_a_score} ${teamName(meeting.team_a)}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p>No verified meetings are available for this fixture.</p>'}</details>`;
  }

  function h2hIndexView(report) {
    const { matches, requiredMeetings } = report;
    const teamIndex = matches.length ? `<p class="prediction-caption">The index adds the goal, clean-sheet, and win-or-draw percentages from the ${requiredMeetings} most recent completed head-to-head meetings. Draws count for half a point.</p>
        <div class="scroll-table" tabindex="0" aria-label="Head-to-head team indices"><table>
          <thead><tr><th scope="col">Fixture</th><th scope="col">Club</th><th scope="col">Verified meetings</th>
            <th scope="col">Goal Probability (%)</th><th scope="col">Clean Sheet Probability (%)</th>
            <th scope="col">Win or Draw Percentage (%)</th><th scope="col">Team Index</th></tr></thead>
          ${matches.map(match => `<tbody><tr><th scope="rowgroup" rowspan="2">${seasonMatchup(match)}</th>${indexTeamCells(match.home)}</tr>
            <tr>${indexTeamCells(match.away)}</tr></tbody>`).join('')}</table></div>
        ${matches.map(match => h2hMeetingsView(match, requiredMeetings)).join('')}` : '<p>No head-to-head indices are available for this Gameweek.</p>';
    return indexReport(report, 'H2H Index Match Predictor', teamIndex,
      indexMatchOutcomes(matches, 'H2H Index match predictions', 'Insufficient head-to-head data'));
  }

  function combinedIndexView(report) {
    const { matches, latestCompletedGameweek, requiredMeetings } = report;
    const teamCells = team => `<th scope="row">${html(team.name)}</th><td>${seasonIndexValue(team.seasonTeamIndex)}</td>
      <td>${seasonIndexValue(team.h2hTeamIndex)}</td><td><strong>${seasonIndexValue(team.teamIndex)}</strong></td>`;
    const seasonScope = latestCompletedGameweek ? `Season data covers Gameweek 1 through Gameweek ${latestCompletedGameweek}.`
      : 'No completed season Gameweeks are available yet.';
    const teamIndex = matches.length ? `<p class="prediction-caption">The Combined Index gives equal weight to the Season and H2H indices. ${seasonScope}</p>
        <div class="scroll-table" tabindex="0" aria-label="Combined team indices"><table>
          <thead><tr><th scope="col">Fixture</th><th scope="col">Club</th><th scope="col">Season Team Index</th>
            <th scope="col">H2H Team Index</th><th scope="col">Combined Team Index</th></tr></thead>
          ${matches.map(match => `<tbody><tr><th scope="rowgroup" rowspan="2">${seasonMatchup(match)}</th>${teamCells(match.home)}</tr>
            <tr>${teamCells(match.away)}</tr></tbody>`).join('')}</table></div>
        ${matches.map(match => h2hMeetingsView(match, requiredMeetings)).join('')}` : '<p>No combined indices are available for this Gameweek.</p>';
    const matchOutcomes = `<p class="prediction-caption">The percentages show each club’s share of the total index. A gap below 10 percentage points with both shares above 45% predicts a draw.</p>
      ${indexMatchOutcomes(matches, 'Combined Index match predictions', 'Both indices are required', true)}`;
    return indexReport(report, 'Combined Index Match Predictor', teamIndex, matchOutcomes);
  }

  function specialRuleTable({ weeks, players }, label, showStarts) {
    return `<div class="scroll-table" tabindex="0" aria-label="${label}"><table>
      <thead><tr><th scope="col">Player</th><th scope="col">Club</th>
      ${weeks.map(week => `<th scope="col">GW${week}<span class="player-meta">${showStarts ? 'Starts / ' : ''}Goals / Assists</span></th>`).join('')}</tr></thead>
      <tbody>${players.map(player => `<tr><td><strong>${html(player.name)}</strong></td><td>${html(player.team)}</td>
      ${player.gameweeks.map(({ starts, goals, assists }) => `<td>${showStarts ? `${starts} / ` : ''}${goals ?? '—'} / ${assists ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
  }

  function specialRulesView({ gameweek, weeks, players, sources, error, rule2, rule3, rule4, rule5 }) {
    const rules = [
      ['Special Rule', { weeks, players, error: error ?? (weeks.length < 3 ? 'Three completed Gameweeks are needed to check this rule.' : null) },
        'Players started in all three Gameweeks and had a goal or assist followed by two Gameweeks with neither.', true],
      ['Special Rule2', rule2,
        'Players had a goal or assist in each of two consecutive Gameweeks, followed by two Gameweeks with neither.', false],
      ['Special Rule3', rule3,
        'Players started in all three Gameweeks, had a goal or assist in each of the first two, then recorded zero goals and zero assists in the latest.', true],
      ['Special Rule4', rule4,
        'Players started and recorded a goal or assist in each of the last three consecutive completed Gameweeks.', true],
      ['Special Rule5', rule5,
        'Players started and recorded a goal or assist in each of the last two consecutive completed Gameweeks.', true]
    ];
    const results = `<dl class="analysis-summary">${rules.map(([label, rule]) => `<div><dt>${label}</dt>
      <dd>${rule.error ? html(rule.error) : rule.players.length ? rule.players.map(player => html(player.name)).join(', ')
        : `No players matched across ${rule.weeks.map(week => `GW${week}`).join(', ')}.`}</dd></div>`).join('')}</dl>`;
    return `<div class="prediction-result-head"><h3>Gameweek ${gameweek} · Special Rules</h3></div>
      ${reportSections(results, [
        ['Gameweek scoring', `<p>The checks use completed Gameweeks before the selected one and count goals and assists across all matches in each Gameweek.</p>
          ${sources.length ? `<details class="provenance"><summary>Gameweek scoring sources</summary>${sourceList(sources)}</details>` : ''}`],
        ...rules.map(([label, rule, criteria, showStarts]) => [label, `<p>${criteria}</p>
          ${!rule.error && rule.players.length ? specialRuleTable(rule, `Players matching ${label}`, showStarts) : ''}`])
      ])}`;
  }

  function newsView(report) {
    const { recommendations, coverage } = report;
    const listing = recommendations.length ? `<ol class="news-picks">${recommendations.map(pick => `<li>
      <div class="news-pick-heading"><strong>${html(pick.name)}</strong>
        <span>${pick.count} independent positive ${pick.count === 1 ? 'mention' : 'mentions'} · ${html(pick.sentiment)}</span></div></li>`).join('')}</ol>`
      : `<p>${coverage.publishers ? 'No verified positive player mentions in the last seven days.' : 'Publisher feeds are unavailable. Try analysing again.'}</p>`;
    const evidence = recommendations.map(pick => `<details class="provenance" open><summary>${html(pick.name)}</summary>
      <p>${html(pick.explanation)}</p>
      <ul class="news-evidence">${pick.sources.map(source => `<li>
        <strong>${html(source.publisher)}</strong> · <time datetime="${html(source.publishedAt)}">${shortDate.format(new Date(source.publishedAt))}</time>
        <a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.title)}</a>
      </li>`).join('')}</ul></details>`).join('');
    const search = `<p class="prediction-caption">${shortDate.format(new Date(report.since))} to ${shortDate.format(new Date(report.searchedAt))} · ${coverage.articles} articles from ${coverage.publishers} of ${coverage.expectedPublishers} publishers</p>
      ${report.sources.length ? `<details class="provenance"><summary>Publisher feeds searched</summary><ul class="news-evidence">
        ${report.sources.map(source => `<li><a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.publisher)}</a>
        <span>Retrieved ${sourceTime.format(new Date(source.retrievedAt))}</span></li>`).join('')}</ul></details>` : ''}`;
    return `<div class="prediction-result-head"><h3>News &amp; Expert Opinion Analysis</h3></div>
      ${reportSections(listing, [
        ['Publisher coverage', search],
        ['Verified positive mentions', `<p>Coverage is matched to FPL players. Each publisher counts once per player, and repeated bylines and copied passages are deduplicated.</p>${evidence}`],
        ['Recommendation ranking', '<p>Players are ranked by independent mention count, then by the strength of the positive coverage.</p>']
      ], 'Final recommendations')}`;
  }

  function historyComparison() {
    const latest = new Set();
    const comparison = new Map();
    for (const record of records) {
      const key = `${historyPeriod(record.seasonYear, record.gameweek)}:${record.strategy}`;
      if (latest.has(key)) continue;
      latest.add(key);
      const { accuracy } = record;
      if (accuracy?.meanAbsoluteError == null) continue;
      const scores = comparison.get(record.strategy) ?? { error: 0, players: 0, weeks: 0 };
      scores.error += accuracy.meanAbsoluteError * accuracy.comparedCount;
      scores.players += accuracy.comparedCount;
      scores.weeks += 1;
      comparison.set(record.strategy, scores);
    }
    if (!comparison.size) return '';
    return `<div class="prediction-comparisons">${[...comparison].map(([id, { error, players, weeks }]) =>
      `<div class="prediction-comparison"><strong>${html(strategyLabel(id))}</strong><span>${forecast(players ? error / players : null)} pts/player · ${weeks} scored GW</span></div>`).join('')}</div>
      <p class="prediction-caption">Mean absolute error across saved Gameweeks uses the latest prediction per strategy and Gameweek. Lower is better.</p>`;
  }

  function selectionLabel(selection) {
    switch (selection?.type) {
      case 'squad': return `${selection.count} of ${selection.required} selected`;
      case 'recommendations': return `${selection.count} ${selection.count === 1 ? 'recommendation' : 'recommendations'}`;
      case 'rules': return 'Rule matches';
      case 'shortlist': return `${selection.count}-player shortlist`;
      case 'players': return `${selection.count} selected`;
      default: return 'Saved report';
    }
  }

  function historyRow(id, record) {
    const label = html(strategyLabel(id));
    if (!record) return `<tr><th scope="row">${label}</th><td colspan="6">No saved analysis</td></tr>`;
    const { accuracy, selection } = record;
    const date = Number.isFinite(Date.parse(record.createdAt)) ? sourceTime.format(new Date(record.createdAt)) : '—';
    const count = selection?.count;
    const projected = id === 'match-winners' ? record.total ?? '—' : forecast(record.total);
    const incomplete = value => value < count ? ` (${value}/${count})` : '';
    const actual = accuracy ? `${accuracy.actualTotal}${incomplete(accuracy.actualCount)}` : record.hasPlayerForecasts ? 'Pending' : '—';
    return `<tr><th scope="row">${label}</th><td>${date}</td><td>${selectionLabel(selection)}</td>
      <td>${projected}${incomplete(record.projectedCount)}</td><td>${actual}</td>
      <td>${forecast(accuracy?.meanAbsoluteError)}${incomplete(accuracy?.comparedCount)}</td>
      <td><button type="button" class="text-button" aria-label="View ${label} report" data-saved-prediction="${html(record.id)}">View</button></td></tr>`;
  }

  function historyTable(rows, label) {
    return `<div class="scroll-table" tabindex="0" aria-label="${label}"><table><thead><tr>
      <th scope="col">Strategy</th><th scope="col">Saved</th><th scope="col">Result</th><th scope="col">Projected</th>
      <th scope="col">Actual</th><th scope="col">Error per player</th><th scope="col">Report</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderHistory(followPredictionWeek = false) {
    if (!records) return;
    const periods = new Map(seasonWeeks.map(gameweek => [historyPeriod(seasonYear, gameweek), { seasonYear, gameweek }]));
    for (const { seasonYear, gameweek } of records) periods.set(historyPeriod(seasonYear, gameweek), { seasonYear, gameweek });
    const predictionWeek = historyPeriod(seasonYear, week.value);
    const wanted = followPredictionWeek && periods.has(predictionWeek) ? predictionWeek : historyWeek.value;
    const latest = records[0];
    const selected = periods.has(wanted) ? wanted : periods.has(predictionWeek) ? predictionWeek
      : latest ? historyPeriod(latest.seasonYear, latest.gameweek) : '';
    const choices = [...periods].sort(([, a], [, b]) => b.seasonYear - a.seasonYear || b.gameweek - a.gameweek);
    historyWeek.innerHTML = '<option value="">Choose a Gameweek</option>' + choices.map(([key, { seasonYear, gameweek }]) =>
      `<option value="${key}">${seasonYear}/${String(seasonYear + 1).slice(-2)} · Gameweek ${gameweek}</option>`).join('');
    historyWeek.value = selected;
    historyWeek.disabled = !choices.length;
    if (!selected) {
      history.innerHTML = '<p class="empty">Choose a Gameweek to see its strategy reports.</p>';
      return;
    }

    const strategies = new Map([...strategyNames.keys()].map(id => [id, []]));
    for (const record of records) {
      if (historyPeriod(record.seasonYear, record.gameweek) !== selected) continue;
      if (!strategies.has(record.strategy)) strategies.set(record.strategy, []);
      strategies.get(record.strategy).push(record);
    }
    const rows = [];
    const earlier = [];
    for (const [id, [record, ...previous]] of strategies) {
      rows.push(historyRow(id, record));
      earlier.push(...previous.map(item => historyRow(id, item)));
    }
    history.innerHTML = `${historyTable(rows, 'Latest strategy reports for the selected Gameweek')}
      ${earlier.length ? `<details class="provenance"><summary>Earlier runs for this Gameweek</summary>${historyTable(earlier, 'Earlier strategy reports')}</details>` : ''}
      ${historyComparison()}`;
  }

  async function loadHistory(followPredictionWeek = false) {
    const sequence = ++historyRequest;
    try {
      const saved = await request('/api/predictions?summary=1');
      if (sequence !== historyRequest) return;
      records = saved.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      renderHistory(followPredictionWeek);
    } catch (error) {
      if (sequence === historyRequest) history.textContent = error.message;
    }
  }

  week.addEventListener('change', () => {
    ready = null;
    strategy.value = '';
    hideResults();
    showAnalysis('');
    refreshStatus.textContent = week.value ? `Refresh official FPL data for Gameweek ${week.value}.` : 'Select a Gameweek to start.';
    updateControls();
    reportRequest += 1;
    renderHistory(true);
    checkGameweekStatus();
  });
  strategy.addEventListener('change', () => {
    hideResults();
    showAnalysis(strategy.value === 'previous' && !ready.previousWeek
      ? ready.previousError ?? 'There is no previous completed Gameweek to analyse.' : '');
    updateControls();
  });
  refresh.addEventListener('click', async () => {
    refreshSequence += 1;
    busy = true;
    showAnalysis('');
    refreshStatus.textContent = `Refreshing official FPL data for Gameweek ${week.value}…`;
    updateControls();
    try {
      ready = await request(`/api/prediction-data?gameweek=${week.value}`, 'POST');
      strategy.value = '';
      hideResults();
      showSnapshot(ready.dashboard);
      onRefresh(ready.dashboard);
      const time = Date.now();
      const closed = ready.week.finished || Date.parse(ready.week.deadline_time) <= time;
      const loaded = ready.dashboard.refreshError ? `Using cached historical data for Gameweek ${ready.week.id}. ${ready.dashboard.refreshError}`
        : `Gameweek ${ready.week.id} data refreshed.`;
      const availability = !closed || isGameweekComplete(ready.week) ? '' : canPreview(time) ? 'The FPL deadline has passed. Preview remaining fixtures.'
        : 'The FPL deadline has passed. A preview requires a remaining fixture with a published kick-off.';
      refreshStatus.textContent = [loaded, availability,
        ready.previousError ?? (ready.previousSource === 'Cached Historical Data' ? `Using cached Gameweek ${ready.previousWeek} scoring.` : ''),
        ready.historyError].filter(Boolean).join(' ');
      await loadHistory();
    } catch (error) {
      refreshStatus.textContent = `Refresh failed. ${error.message}${ready ? ' You can still use the previous successful refresh for this Gameweek.' : ''}`;
      if (!hasSnapshot) dataStatus.textContent = 'Data source unavailable · Gameweek unavailable · Dataset incomplete';
    } finally {
      busy = false;
      updateControls();
    }
  });
  const analysisViews = new Map([['special-rules', specialRulesView], ['season-index', seasonIndexView], ['h2h-index', h2hIndexView],
    ['combined-index', combinedIndexView], ['news', newsView], ['match-winners', archivedMatchWinnerView]]);
  const reportView = record => (analysisViews.get(record.strategy) ?? squadView)(record);
  async function runAnalysis(usePreview) {
    busy = true;
    hideResults();
    showAnalysis(`${usePreview ? 'Preparing a preview for' : 'Analysing'} Gameweek ${week.value}…`);
    updateControls();
    try {
      const query = new URLSearchParams({ gameweek: week.value, strategy: strategy.value, token: ready.token });
      const endpoint = usePreview ? '/api/prediction-preview' : '/api/predictions';
      const record = await request(`${endpoint}?${query}`, 'POST');
      const previewNotice = record.preview ? `<p class="notice"><strong>Post-deadline preview</strong> · ${record.preview.fixtureCount}
        remaining ${record.preview.fixtureCount === 1 ? 'fixture' : 'fixtures'} · Separate from Prediction history</p>` : '';
      const panel = record.strategy === 'news' ? newsResult : result;
      panel.innerHTML = previewNotice + reportView(record);
      panel.hidden = false;
      showAnalysis(record.id ? 'Saved to Prediction history.' : '');
      if (record.id) await loadHistory(true);
    } catch (error) {
      showAnalysis(error.message);
    } finally {
      busy = false;
      updateControls();
    }
  }
  analyse.addEventListener('click', () => runAnalysis(false));
  preview.addEventListener('click', () => runAnalysis(true));
  historyWeek.addEventListener('change', () => {
    reportRequest += 1;
    renderHistory();
  });
  history.addEventListener('click', async event => {
    const button = event.target.closest('[data-saved-prediction]');
    if (!button) return;
    const sequence = ++reportRequest;
    try {
      const query = new URLSearchParams({ id: button.dataset.savedPrediction });
      const record = await request(`/api/predictions?${query}`);
      if (sequence === reportRequest) openDialog('Saved prediction', reportView(record));
    } catch (error) {
      if (sequence === reportRequest) openDialog('Saved prediction', `<p>${html(error.message)}</p>`);
    }
  });

  gameweeks(Array.from({ length: 38 }, (_, index) => ({ id: index + 1, name: `Gameweek ${index + 1}` })));
  document.addEventListener('visibilitychange', checkGameweekStatus);
  setInterval(checkGameweekStatus, statusCheckInterval);
  checkGameweekStatus();
  loadHistory();
}
