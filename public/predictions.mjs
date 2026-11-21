import { forecast, price, remainingFixtures } from './model.mjs';

const strategyName = {
  ranking: 'Current FPL Ranking', previous: 'Previous Gameweek Performance',
  recent: 'Recent Performance Form', 'match-winners': 'Match & Player'
};
const strategyLabel = strategy => strategyName[strategy] ?? (strategy === 'weather' ? 'Archived weather prediction' : strategy);
const $ = selector => document.querySelector(selector);

export function setupPredictions({ request, html, sourceList, openDialog, sourceTime, onRefresh }) {
  const week = $('#prediction-week');
  const strategy = $('#prediction-strategy');
  const refresh = $('#refresh');
  const analyse = $('#analyse');
  const preview = $('#prediction-preview');
  const refreshStatus = $('#refresh-status');
  const dataStatus = $('#data-status');
  const analysisStatus = $('#analysis-status');
  const result = $('#prediction-result');
  const newsResult = $('#news-result');
  const history = $('#history-content');
  let ready;
  let hasSnapshot = false;
  let busy = false;
  let records = [];
  let historyRequest = 0;
  const shortDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/London' });
  const percent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 }).format;

  function hideResults() {
    result.hidden = true;
    newsResult.hidden = true;
  }

  function gameweeks(events) {
    const selected = week.value;
    week.innerHTML = '<option value="">Choose a Gameweek</option>' + events.map(event =>
      `<option value="${event.id}">${html(event.name)}${event.finished ? ' · Completed' : ''}</option>`).join('');
    week.value = events.some(event => event.id === Number(selected)) ? selected : '';
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

  function useSnapshot(data) {
    if (ready || busy) return false;
    showSnapshot(data);
    if (data.refreshError) refreshStatus.textContent = `${data.refreshError} Using the last validated league dataset.`;
    return true;
  }

  function showSnapshotWarning(message) {
    if (ready || busy) return;
    refreshStatus.textContent = message;
    if (!hasSnapshot) dataStatus.textContent = 'Data source unavailable · Gameweek unavailable · Dataset incomplete';
  }

  function showSnapshot(data) {
    hasSnapshot = true;
    gameweeks(data.events);
    const { source, lastSuccessfulFetch, gameweek, complete } = data.dataStatus;
    dataStatus.textContent = `${source} · ${gameweek == null ? 'Gameweek unavailable' : `Covers Gameweek ${gameweek}`} · League dataset ${complete ? 'complete' : 'incomplete'}`;
    $('#last-refresh').textContent = `Last successful fetch ${sourceTime.format(new Date(lastSuccessfulFetch))}`;
    updateControls();
  }

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
    return `<div class="prediction-result-head"><div><h3>Gameweek ${record.gameweek} · ${html(strategyLabel(record.strategy))}</h3>
      <p>${players.length} ${shortlist && players.length ? 'shortlisted ' : ''}${players.length === 1 ? 'player' : 'players'}${shortlist ? '' : ` · ${price(record.cost)}`}${record.previousWeek ? ` · Uses final GW${record.previousWeek} results` : ''}</p></div>
      ${players.length ? `<div class="prediction-total"><strong>${forecast(record.total)}</strong><span>Projected ${shortlist ? 'shortlist' : 'squad'} pts</span></div>` : ''}</div>
      ${record.projectedCount < players.length ? `<p>${record.projectedCount} of ${players.length} players have a point estimate.</p>` : ''}
      ${shortlist ? `<p>${players.length
        ? 'Too few eligible players to form a legal squad. Ranked shortlist shown.'
        : emptyShortlist}</p>`
        : `<p>Captain <strong>${html(players.find(player => player.id === record.captain)?.name)}</strong> · Vice-captain <strong>${html(players.find(player => player.id === record.viceCaptain)?.name)}</strong></p>
          <p class="prediction-caption">Squad totals add all 15 players before captaincy.</p>`}
      ${coverage ? `<p class="prediction-caption">${html(coverage)}</p>` : ''}
      ${comparison}
      ${players.length ? `<div class="scroll-table" tabindex="0" aria-label="${shortlist ? 'Player shortlist' : 'Predicted 15-player squad'}">
        <table><thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th><th scope="col">Price</th>
        ${previousWeek > 0 ? `<th scope="col" title="Official FPL points once the Gameweek is final">GW${previousWeek} actual points</th>` : ''}
        <th scope="col">GW${record.gameweek} predicted points</th>
        <th scope="col" title="Uses the selected strategy and official match scoring rules, then rounds to whole points before captaincy">Predicted FPL Rule-Based Points</th>
        ${accuracy ? `<th scope="col">GW${record.gameweek} actual points</th>` : ''}</tr></thead>
        <tbody>${players.map(player => `<tr><td><strong>${html(player.name)}</strong>
          ${player.id === record.captain ? '<span class="prediction-role">C</span>' : player.id === record.viceCaptain ? '<span class="prediction-role">VC</span>' : ''}
          ${player.evidence ? `<span class="player-meta">${player.evidence.domesticWeeks} PL weeks · ${player.evidence.cupMatches} domestic cup · ${player.evidence.europeanMatches ?? 0} UEFA club · ${player.evidence.internationalMatches} international</span>` : ''}</td>
          <td>${html(player.team)}</td><td>${html(player.position)}</td><td>${price(player.cost)}</td>
          ${previousWeek > 0 ? `<td>${player.previousActualPoints ?? '—'}</td>` : ''}
          <td>${forecast(player.predicted)}</td>
          <td>${player.predictedFplRuleBasedPoints ?? '—'}</td>
          ${accuracy ? `<td>${actual.get(player.id) ?? '—'}</td>` : ''}</tr>`).join('')}</tbody></table>
      </div>` : ''}
      <details class="provenance"><summary>Prediction data sources</summary>${sourceList(record.sources)}
        <p><a href="https://fantasy.premierleague.com/en/help/rules" target="_blank" rel="noopener">Official FPL scoring rules</a></p>
      </details>
      ${accuracy ? `<details class="provenance"><summary>Actual scoring source</summary>${sourceList(accuracy.sources)}</details>` : ''}`;
  }

  function matchWinnerView(record) {
    const { matches, players, accuracy, sampleWeeks } = record;
    const matchup = match => `${html(match.home.name)} v ${html(match.away.name)}`;
    const actual = new Map(accuracy?.actual.map(player => [player.id, player.points]));
    const coverage = sampleWeeks.length ? `Player form uses ${sampleWeeks.map(week => 'GW' + week).join(', ')}.`
      : 'Recent official player match data is unavailable.';
    return `<div class="prediction-result-head"><div><h3>Gameweek ${record.gameweek} · ${html(strategyLabel(record.strategy))}</h3>
      <p>${matches.filter(match => match.score).length}/${matches.length} fixtures forecast · ${record.completedMatches} completed matches in the team model</p></div>
      </div>
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
      </table></div>` : '<p>No upcoming fixtures are scheduled for this Gameweek.</p>'}
      <h4>Picks by predicted winner</h4>
      <p class="prediction-caption">${html(coverage)}${record.requestedWeeks > sampleWeeks.length ? ' Coverage is partial.' : ''}</p>
      ${matches.some(match => match.winner) ? matches.filter(match => match.winner).map(match =>
        `<details class="provenance"><summary>${matchup(match)} · ${match.picks.length}/4 picks for ${html(match.winner.name)}</summary>
        ${match.missingPositions.length ? `<p>Insufficient player data for ${html(match.missingPositions.join(', '))}.</p>` : ''}
        ${match.picks.length ? `<div class="scroll-table" tabindex="0" aria-label="Predicted winning team picks"><table>
          <thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th>
          <th scope="col">Start chance</th><th scope="col">Expected minutes</th><th scope="col">Projected FPL points</th></tr></thead>
          <tbody>${match.picks.map(player => `<tr><td>${html(player.name)}</td><td>${html(player.team)}</td><td>${html(player.position)}</td>
          <td>${percent(player.startProbability)}</td><td>${player.expectedMinutes}</td><td>${player.predicted}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}</details>`).join('') : '<p>No fixture has a predicted winner.</p>'}
      <h4>Top 15 player ranking</h4>
      <p class="prediction-caption">${players.length} ranked · ${record.candidateCount} unique candidates${record.total != null ? ` · ${record.total} projected points before captaincy` : ''}. Rankings use unrounded projections across the Gameweek.</p>
      ${record.incompleteCandidates ? `<p>${record.incompleteCandidates} candidates lacked forecasts for all of their fixtures.</p>` : ''}
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
      <details class="provenance"><summary>Prediction data sources</summary>${sourceList(record.sources)}
        <p><a href="https://fantasy.premierleague.com/en/help/rules" target="_blank" rel="noopener">Official FPL scoring rules</a></p>
      </details>
      ${accuracy ? `<details class="provenance"><summary>Actual scoring source</summary>${sourceList(accuracy.sources)}</details>` : ''}`;
  }

  const predictionView = record => record.strategy === 'match-winners' ? matchWinnerView(record) : squadView(record);

  function headToHeadView({ gameweek, matches, players, sources }) {
    const split = rates => rates ? [rates.home, rates.draw, rates.away].map(percent).join(' / ') : '—';
    const matchup = match => `${html(match.home.name)} v ${html(match.away.name)}`;
    const teamRatesRow = (name, rates) => `<tr><th scope="row">${html(name)}</th>
      <td>${percent(rates.win)}</td><td>${percent(rates.draw)}</td><td>${percent(rates.loss)}</td></tr>`;
    const prediction = match => {
      if (!match.outcome) return html(match.reason);
      if (match.outcome === 'draw') return 'Draw';
      const side = match.outcome === 'home' ? 'Home' : 'Away';
      return `${side} win · ${html(match[match.outcome].name)}`;
    };
    return `<div class="prediction-result-head"><h3>Gameweek ${gameweek} · Head-to-Head (H2H) Analysis</h3></div>
      ${matches.length ? `<p class="prediction-caption">Open a fixture to see the latest meetings, both clubs’ win, draw and loss rates, and the 50/50 average.</p>
        <div class="scroll-table" tabindex="0" aria-label="Head-to-head match forecasts"><table>
        <thead><tr><th scope="col">Fixture</th><th scope="col">Verified meetings</th>
          <th scope="col">H2H home / draw / away</th><th scope="col">Predicted outcome</th></tr></thead>
        <tbody>${matches.map(match => `<tr><td><strong>${matchup(match)}</strong></td><td>${match.meetings.length}/4</td>
          <td>${split(match.probabilities)}</td><td>${prediction(match)}</td></tr>`).join('')}</tbody></table></div>
        ${matches.map(match => `<details class="provenance"><summary>${matchup(match)}</summary>
          ${match.meetings.length ? `<div class="scroll-table" tabindex="0" aria-label="Recent head-to-head meetings"><table>
            <thead><tr><th scope="col">Date</th><th scope="col">Competition</th><th scope="col">Result</th></tr></thead>
            <tbody>${match.meetings.map(meeting => `<tr><td>${shortDate.format(new Date(meeting.kickoff))}</td><td>${html(meeting.competition)}</td>
              <td>${html(meeting.home)} ${meeting.homeScore}–${meeting.awayScore} ${html(meeting.away)}</td></tr>`).join('')}</tbody></table></div>`
            : '<p>No head-to-head results were available for this fixture.</p>'}
          ${match.teamRates ? `<div class="scroll-table" tabindex="0" aria-label="Head-to-head win, draw and loss percentages"><table>
            <thead><tr><th scope="col">Club</th><th scope="col">Win</th><th scope="col">Draw</th><th scope="col">Loss</th></tr></thead>
            <tbody>${teamRatesRow(match.home.name, match.teamRates.home)}${teamRatesRow(match.away.name, match.teamRates.away)}
              ${teamRatesRow('Combined (50/50)', match.combined)}</tbody></table></div>
            <p>Eligible clubs for the Top 15 · ${[match.home, match.away].filter(club => match.eligibleTeamIds.includes(club.id))
              .map(club => html(club.name)).join(', ')}</p>` : `<p>${html(match.reason)}</p>`}</details>`).join('')}`
        : '<p>No upcoming fixtures are scheduled for this Gameweek.</p>'}
      <h4>H2H Top 15 player ranking</h4>
      ${players.length ? `<p class="prediction-caption">Projected FPL points are summed across eligible fixtures. A dash indicates an unavailable score.</p>
        <div class="scroll-table" tabindex="0" aria-label="H2H Top 15 player ranking"><table>
        <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th>
          <th scope="col">Performance score (proj. FPL pts)</th></tr></thead>
        <tbody>${players.map((player, index) => `<tr><td>${index + 1}</td><td>${html(player.name)}</td><td>${html(player.team)}</td>
          <td>${html(player.position)}</td><td>${forecast(player.performanceScore)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p>No players are eligible for this Gameweek’s H2H ranking.</p>'}
      ${sources.length ? `<details class="provenance"><summary>Analysis data sources</summary><ul class="news-evidence">
        ${sources.map(source => `<li><a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.label)}</a>
        <span>${source.origin ? `${html(source.origin)} · ` : ''}Retrieved ${sourceTime.format(new Date(source.retrievedAt))}</span></li>`).join('')}</ul></details>` : ''}`;
  }

  function teamBinaryView({ gameweek, matches, completedMatches, sources }) {
    const matchup = match => `${html(match.home.name)} v ${html(match.away.name)}`;
    const goal = predicted => predicted ? 'Goal' : 'No Goal';
    const cleanSheet = predicted => predicted ? 'Clean Sheet' : 'No Clean Sheet';
    const predictionCell = (label, likelihood, description) => `<td><strong>${label}</strong>
      <span class="player-meta">${percent(likelihood)} ${description}</span></td>`;
    const teamCells = team => `<th scope="row">${html(team.name)}</th>
      ${predictionCell(goal(team.goal), team.goalProbability, 'to score')}
      ${predictionCell(cleanSheet(team.cleanSheet), team.cleanSheetProbability, 'clean sheet chance')}`;
    const playerTable = (label, players, predictionLabel, formatPrediction) => `<h4>${label}</h4>
      ${players.length ? `<div class="scroll-table" tabindex="0" aria-label="${label}"><table>
        <thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th>
          <th scope="col">${predictionLabel}</th><th scope="col">Projected FPL points</th></tr></thead>
        <tbody>${players.map(player => `<tr><td>${html(player.name)}</td><td>${html(player.team)}</td>
          <td>${html(player.position)}</td><td>${formatPrediction(player.priority)}</td>
          <td>${forecast(player.performanceScore)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No players listed for these positions.</p>'}`;

    return `<div class="prediction-result-head"><h3>Gameweek ${gameweek} · Team Goals &amp; Clean Sheets</h3></div>
      ${matches.length ? `<p class="prediction-caption">${completedMatches ? `Based on ${completedMatches} completed league matches.`
        : 'Team scoring chances start at 50% before league results are available.'} Goal is predicted at 50% or higher.</p>
        <div class="scroll-table" tabindex="0" aria-label="Team goal and clean-sheet predictions"><table>
        <thead><tr><th scope="col">Fixture</th><th scope="col">Team</th><th scope="col">Goal prediction</th>
          <th scope="col">Clean sheet prediction</th></tr></thead>
        ${matches.map(match => `<tbody><tr><th scope="rowgroup" rowspan="2">${matchup(match)}</th>${teamCells(match.home)}</tr>
          <tr>${teamCells(match.away)}</tr></tbody>`).join('')}</table></div>
        <p class="prediction-caption">Open a fixture to see both player groups. Players with scores appear first, with priority given to the relevant team prediction.</p>
        ${matches.map(match => `<details class="provenance"><summary>${matchup(match)} · Player analysis</summary>
          ${playerTable('Attacking players', match.attacking, 'Team goal prediction', goal)}
          ${playerTable('Defensive players', match.defensive, 'Team clean sheet prediction', cleanSheet)}
        </details>`).join('')}` : '<p>No upcoming fixtures are scheduled for this Gameweek.</p>'}
      ${sources.length ? `<details class="provenance"><summary>Analysis data sources</summary>${sourceList(sources)}</details>` : ''}`;
  }

  function specialRuleTable({ weeks, players }, label, showStarts) {
    if (!players.length) return `<p>No players matched across ${weeks.map(week => `GW${week}`).join(', ')}.</p>`;
    return `<div class="scroll-table" tabindex="0" aria-label="${label}"><table>
      <thead><tr><th scope="col">Player</th><th scope="col">Club</th>
      ${weeks.map(week => `<th scope="col">GW${week}<span class="player-meta">${showStarts ? 'Starts / ' : ''}Goals / Assists</span></th>`).join('')}</tr></thead>
      <tbody>${players.map(player => `<tr><td><strong>${html(player.name)}</strong></td><td>${html(player.team)}</td>
      ${player.gameweeks.map(({ starts, goals, assists }) => `<td>${showStarts ? `${starts} / ` : ''}${goals ?? '—'} / ${assists ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
  }

  function specialRulesView({ gameweek, weeks, players, sources, error, rule2, rule3, rule4, rule5 }) {
    return `<div class="prediction-result-head"><h3>Gameweek ${gameweek} · Special Rules</h3></div>
      <h4>Special Rule</h4>
      <p class="prediction-caption">Players started in all three Gameweeks and had a goal or assist followed by two Gameweeks with neither.</p>
      ${error ? `<p>${html(error)}</p>` : weeks.length < 3 ? '<p>Three completed Gameweeks are needed to check this rule.</p>'
        : specialRuleTable({ weeks, players }, 'Players matching Special Rule', true)}
      <h4>Special Rule2</h4>
      <p class="prediction-caption">Players had a goal or assist in each of two consecutive Gameweeks, followed by two Gameweeks with neither.</p>
      ${rule2.error ? `<p>${html(rule2.error)}</p>` : specialRuleTable(rule2, 'Players matching Special Rule2', false)}
      <h4>Special Rule3</h4>
      <p class="prediction-caption">Players started in all three Gameweeks, had a goal or assist in each of the first two, then recorded zero goals and zero assists in the latest.</p>
      ${rule3.error ? `<p>${html(rule3.error)}</p>` : specialRuleTable(rule3, 'Players matching Special Rule3', true)}
      <h4>Special Rule4</h4>
      <p class="prediction-caption">Players started and recorded a goal or assist in each of the last three consecutive completed Gameweeks.</p>
      ${rule4.error ? `<p>${html(rule4.error)}</p>` : specialRuleTable(rule4, 'Players matching Special Rule4', true)}
      <h4>Special Rule5</h4>
      <p class="prediction-caption">Players started and recorded a goal or assist in each of the last two consecutive completed Gameweeks.</p>
      ${rule5.error ? `<p>${html(rule5.error)}</p>` : specialRuleTable(rule5, 'Players matching Special Rule5', true)}
      ${sources.length ? `<details class="provenance"><summary>Gameweek scoring sources</summary>${sourceList(sources)}</details>` : ''}`;
  }

  function newsView(report) {
    const { recommendations, coverage } = report;
    const listing = recommendations.length ? `<ol class="news-picks">${recommendations.map(pick => `<li>
      <div class="news-pick-heading"><strong>${html(pick.name)}</strong>
        <span>${pick.count} independent positive ${pick.count === 1 ? 'mention' : 'mentions'} · ${html(pick.sentiment)}</span></div>
      <p>${html(pick.explanation)}</p>
      <ul class="news-evidence">${pick.sources.map(source => `<li>
        <strong>${html(source.publisher)}</strong> · <time datetime="${html(source.publishedAt)}">${shortDate.format(new Date(source.publishedAt))}</time>
        <a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.title)}</a>
      </li>`).join('')}</ul></li>`).join('')}</ol>`
      : `<p>${coverage.publishers ? 'No verified positive player mentions in the last seven days.' : 'Publisher feeds are unavailable. Try analysing again.'}</p>`;
    return `<h3 id="news-title">News &amp; Expert Opinion Analysis</h3>
      <p class="prediction-caption">${shortDate.format(new Date(report.since))} to ${shortDate.format(new Date(report.searchedAt))} · ${coverage.articles} articles from ${coverage.publishers} of ${coverage.expectedPublishers} publishers</p>
      ${listing}
      ${report.sources.length ? `<details class="provenance"><summary>Publisher feeds searched</summary><ul class="news-evidence">
        ${report.sources.map(source => `<li><a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.publisher)}</a>
        <span>Retrieved ${sourceTime.format(new Date(source.retrievedAt))}</span></li>`).join('')}</ul></details>` : ''}`;
  }

  function renderHistory() {
    if (!records.length) {
      history.innerHTML = '<p class="empty">Saved predictions will appear here. Refresh FPL after a Gameweek is final to record actual points.</p>';
      return;
    }
    const latest = new Map();
    for (const record of records) {
      const key = `${record.seasonYear}:${record.gameweek}:${record.strategy}`;
      if (!latest.has(key)) latest.set(key, record);
    }
    const comparison = Object.entries(strategyName).filter(([key]) => key !== 'match-winners' || records.some(record => record.strategy === key))
      .map(([key, label]) => {
      const scored = [...latest.values()].filter(record => record.strategy === key && record.accuracy?.meanAbsoluteError != null);
      const samples = scored.reduce((sum, record) => sum + record.accuracy.comparedCount, 0);
      const error = samples ? scored.reduce((sum, record) => sum + record.accuracy.meanAbsoluteError * record.accuracy.comparedCount, 0) / samples : null;
      return `<div class="prediction-comparison"><strong>${label}</strong><span>${forecast(error)} pts/player · ${scored.length} scored GW</span></div>`;
    }).join('');
    history.innerHTML = `<div class="prediction-comparisons">${comparison}</div>
      <p class="prediction-caption">Mean absolute error uses the latest prediction per strategy and Gameweek. Lower is better.</p>
      <div class="scroll-table" tabindex="0" aria-label="Prediction history table"><table><thead><tr>
        <th scope="col">Season / GW</th><th scope="col">Strategy</th><th scope="col">Saved</th><th scope="col">Projected</th>
        <th scope="col">Actual</th><th scope="col">Error per player</th><th scope="col">Players</th></tr></thead>
        <tbody>${records.map(record => {
          const { accuracy } = record;
          return `<tr><td>${record.seasonYear}/${String(record.seasonYear + 1).slice(-2)} · GW${record.gameweek}</td>
            <td>${html(strategyLabel(record.strategy))}${record.shortlist ? `<span class="player-meta">${record.players.length}-player shortlist</span>` : ''}</td>
            <td>${sourceTime.format(new Date(record.createdAt))}</td><td>${record.strategy === 'match-winners' ? record.total ?? '—' : forecast(record.total)}${record.projectedCount < record.players.length ? ` (${record.projectedCount}/${record.players.length})` : ''}</td>
            <td>${accuracy ? `${accuracy.actualTotal}${accuracy.actualCount < record.players.length ? ` (${accuracy.actualCount}/${record.players.length})` : ''}` : record.players.length ? 'Pending' : '—'}</td>
            <td>${forecast(accuracy?.meanAbsoluteError)}${accuracy && accuracy.comparedCount < record.players.length ? ` (${accuracy.comparedCount}/${record.players.length})` : ''}</td>
            <td><button type="button" class="text-button" data-saved-prediction="${html(record.id)}">View</button></td></tr>`;
        }).join('')}</tbody></table></div>`;
  }

  async function loadHistory() {
    const sequence = ++historyRequest;
    try {
      const saved = await request('/api/predictions');
      if (sequence !== historyRequest) return;
      records = saved.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      renderHistory();
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
  });
  strategy.addEventListener('change', () => {
    hideResults();
    showAnalysis(strategy.value === 'previous' && !ready.previousWeek
      ? ready.previousError ?? 'There is no previous completed Gameweek to analyse.' : '');
    updateControls();
  });
  refresh.addEventListener('click', async () => {
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
      const availability = !closed ? '' : canPreview(time) ? 'The FPL deadline has passed. Preview remaining fixtures.'
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
  const analysisViews = { 'head-to-head': headToHeadView, 'special-rules': specialRulesView, 'team-binary': teamBinaryView };
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
      if (record.strategy === 'news') {
        newsResult.innerHTML = previewNotice + newsView(record);
        newsResult.hidden = false;
        showAnalysis('');
        return;
      }
      result.innerHTML = previewNotice + (analysisViews[record.strategy] ?? predictionView)(record);
      result.hidden = false;
      showAnalysis(record.id ? (record.strategy === 'match-winners' ? `${strategyLabel(record.strategy)} prediction saved.`
        : record.shortlist ? 'Shortlist saved.' : 'Squad prediction saved.') : '');
      if (record.id) await loadHistory();
    } catch (error) {
      showAnalysis(error.message);
    } finally {
      busy = false;
      updateControls();
    }
  }
  analyse.addEventListener('click', () => runAnalysis(false));
  preview.addEventListener('click', () => runAnalysis(true));
  history.addEventListener('click', event => {
    const button = event.target.closest('[data-saved-prediction]');
    const record = records.find(item => item.id === button?.dataset.savedPrediction);
    if (record) openDialog('Saved prediction', predictionView(record));
  });

  gameweeks(Array.from({ length: 38 }, (_, index) => ({ id: index + 1, name: `Gameweek ${index + 1}` })));
  loadHistory();
  return { useSnapshot, showSnapshotWarning };
}
