import { forecast, price } from './model.mjs';

const strategyName = {
  ranking: 'Current FPL Ranking', previous: 'Previous Gameweek Performance',
  recent: 'Recent Performance Form'
};
const strategyLabel = strategy => strategyName[strategy] ?? (strategy === 'weather' ? 'Archived weather prediction' : strategy);
const $ = selector => document.querySelector(selector);

export function setupPredictions({ request, html, sourceList, openDialog, sourceTime, onRefresh }) {
  const week = $('#prediction-week');
  const strategy = $('#prediction-strategy');
  const refresh = $('#refresh');
  const analyse = $('#analyse');
  const refreshStatus = $('#refresh-status');
  const analysisStatus = $('#analysis-status');
  const result = $('#prediction-result');
  const newsResult = $('#news-result');
  const oddsResult = $('#odds-result');
  const history = $('#history-content');
  let ready;
  let busy = false;
  let records = [];
  let historyRequest = 0;
  const newsDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/London' });
  const oddsPercent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 });

  function hideResults() {
    result.hidden = true;
    newsResult.hidden = true;
    oddsResult.hidden = true;
  }

  function gameweeks(events) {
    const selected = week.value;
    week.innerHTML = '<option value="">Choose a Gameweek</option>' + events.map(event =>
      `<option value="${event.id}">${html(event.name)}${event.finished ? ' · Completed' : ''}</option>`).join('');
    week.value = events.some(event => event.id === Number(selected)) ? selected : '';
  }

  function updateControls() {
    const locked = ready && (ready.week.finished || Date.parse(ready.week.deadline_time) <= Date.now());
    week.disabled = busy;
    refresh.disabled = busy || !week.value;
    strategy.disabled = busy || !ready || locked;
    analyse.disabled = strategy.disabled || !strategy.value || (strategy.value === 'previous' && !ready.previousWeek);
  }

  function showAnalysis(message) {
    analysisStatus.textContent = message;
    analysisStatus.hidden = !message;
  }

  function useSnapshot(data) {
    if (ready || busy) return false;
    showSnapshot(data);
    return true;
  }

  function showSnapshot(data) {
    gameweeks(data.events);
    const latest = Math.max(...data.sources.map(source => Date.parse(source.retrievedAt)));
    $('#last-refresh').textContent = `Last successful refresh ${sourceTime.format(latest)}`;
    updateControls();
  }

  function squadView(record) {
    const { players, accuracy, shortlist } = record;
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
        : 'No eligible players had a verified non-EPL appearance in the 14-day window.'}</p>`
        : `<p>Captain <strong>${html(players.find(player => player.id === record.captain)?.name)}</strong> · Vice-captain <strong>${html(players.find(player => player.id === record.viceCaptain)?.name)}</strong></p>
          <p class="prediction-caption">Squad totals add all 15 players before captaincy.</p>`}
      ${coverage ? `<p class="prediction-caption">${html(coverage)}</p>` : ''}
      ${comparison}
      ${players.length ? `<div class="scroll-table" tabindex="0" aria-label="${shortlist ? 'Recent form shortlist' : 'Predicted 15-player squad'}">
        <table><thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th><th scope="col">Price</th>
        ${previousWeek > 0 ? `<th scope="col" title="Official FPL points once the Gameweek is final">GW${previousWeek} actual points</th>` : ''}
        <th scope="col">GW${record.gameweek} predicted points</th>
        <th scope="col" title="Recalculates past match points using official FPL scoring and scales them by the selected Gameweek’s fixture count">FPL Rule-Based Historical Benchmark</th>
        ${accuracy ? `<th scope="col">GW${record.gameweek} actual points</th>` : ''}</tr></thead>
        <tbody>${players.map(player => `<tr><td><strong>${html(player.name)}</strong>
          ${player.id === record.captain ? '<span class="prediction-role">C</span>' : player.id === record.viceCaptain ? '<span class="prediction-role">VC</span>' : ''}
          ${player.evidence ? `<span class="player-meta">${player.evidence.domesticWeeks} PL weeks · ${player.evidence.cupMatches} domestic cup · ${player.evidence.europeanMatches ?? 0} UEFA club · ${player.evidence.internationalMatches} international</span>` : ''}</td>
          <td>${html(player.team)}</td><td>${html(player.position)}</td><td>${price(player.cost)}</td>
          ${previousWeek > 0 ? `<td>${player.previousActualPoints ?? '—'}</td>` : ''}
          <td>${forecast(player.predicted)}</td>
          <td>${forecast(player.fplRuleBasedHistoricalBenchmark)}</td>
          ${accuracy ? `<td>${actual.get(player.id) ?? '—'}</td>` : ''}</tr>`).join('')}</tbody></table>
      </div>` : ''}
      <details class="provenance"><summary>Prediction data sources</summary>${sourceList(record.sources)}</details>
      ${accuracy ? `<details class="provenance"><summary>Actual scoring source</summary>${sourceList(accuracy.sources)}</details>` : ''}`;
  }

  function newsView(report) {
    const { recommendations, coverage } = report;
    const listing = recommendations.length ? `<ol class="news-picks">${recommendations.map(pick => `<li>
      <div class="news-pick-heading"><strong>${html(pick.name)}</strong>
        <span>${pick.count} independent positive ${pick.count === 1 ? 'mention' : 'mentions'} · ${html(pick.sentiment)}</span></div>
      <p>${html(pick.explanation)}</p>
      <ul class="news-evidence">${pick.sources.map(source => `<li>
        <strong>${html(source.publisher)}</strong> · <time datetime="${html(source.publishedAt)}">${newsDate.format(new Date(source.publishedAt))}</time>
        <a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.title)}</a>
      </li>`).join('')}</ul></li>`).join('')}</ol>`
      : `<p>${coverage.publishers ? 'No verified positive player mentions in the last seven days.' : 'Publisher feeds are unavailable. Try analysing again.'}</p>`;
    return `<h3 id="news-title">News &amp; Expert Opinion Analysis</h3>
      <p class="prediction-caption">${newsDate.format(new Date(report.since))} to ${newsDate.format(new Date(report.searchedAt))} · ${coverage.articles} articles from ${coverage.publishers} of ${coverage.expectedPublishers} publishers</p>
      ${listing}
      ${report.sources.length ? `<details class="provenance"><summary>Publisher feeds searched</summary><ul class="news-evidence">
        ${report.sources.map(source => `<li><a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.publisher)}</a>
        <span>Retrieved ${sourceTime.format(new Date(source.retrievedAt))}</span></li>`).join('')}</ul></details>` : ''}`;
  }

  function oddsView(report) {
    const { recommendations, coverage, provider } = report;
    const messages = {
      'missing-key': 'Set the server’s ODDS_API_KEY to see live bookmaker prices.',
      'access-denied': 'The provider did not authorize this request. Check ODDS_API_KEY and the account’s market access.',
      'rate-limited': 'The Odds API request limit was reached. Try again later.',
      unavailable: 'The Odds API is temporarily unavailable. Try again later.',
      'quota-paused': 'No saved comparable odds are available for this Gameweek.',
      'no-fixtures': 'This Gameweek has no scheduled upcoming fixtures to compare.',
      insufficient: 'There are no matching player prices from two UK bookmakers for the selected Gameweek.'
    };
    const paused = report.paused === 'low-credits' ? 'Live odds updates are paused because fewer than 10 credits remain.'
      : report.paused === 'unverified' ? 'Live odds updates are paused until the provider confirms the remaining credits.' : '';
    const savedMessage = recommendations.some(player => player.matches.some(fixture => fixture.saved))
      ? ' Saved prices are shown where available.' : '';
    const matched = (coverage.matched || report.status === 'ready')
      ? `<p class="prediction-caption">${coverage.compared} of ${coverage.fixtures} fixtures with comparable quotes${coverage.singleBookPlayers ? ` · ${coverage.singleBookPlayers} players had only one bookmaker quote` : ''}</p>` : '';
    const listing = recommendations.length ? `<p class="prediction-caption">Ranked by the median bookmaker-implied chance of scoring in a fixture, including bookmaker margin.</p>
      <div class="scroll-table" tabindex="0" aria-label="UK bookmaker player comparisons"><table>
      <thead><tr><th scope="col">Player</th><th scope="col">Fixture</th><th scope="col">Implied chance</th><th scope="col">UK bookmaker prices</th></tr></thead>
      <tbody>${recommendations.map(player => {
        const [primary] = player.matches;
        return `<tr><td><strong>${html(player.name)}</strong><span class="player-meta">${html(player.team)}</span></td>
          <td>${html(primary.home)} v ${html(primary.away)}<span class="player-meta">${sourceTime.format(new Date(primary.kickoff))}</span></td>
          <td>${oddsPercent.format(primary.implied)}</td>
          <td><details><summary>${primary.quotes.length} bookmakers · ${primary.quotes.at(-1).price.toFixed(2)}–${primary.quotes[0].price.toFixed(2)}</summary>
          ${player.matches.map(fixture => `<div class="odds-quotes"><strong>${html(fixture.home)} v ${html(fixture.away)}</strong>
            ${fixture.retrievedAt ? `<span class="player-meta">${fixture.saved ? 'Saved prices retrieved' : 'Prices retrieved'} ${sourceTime.format(new Date(fixture.retrievedAt))}</span>` : ''}
            <ul class="news-evidence">${fixture.quotes.map(quote => `<li><span>${html(quote.bookmaker)}</span> <strong>${quote.price.toFixed(2)}</strong>
              ${quote.updatedAt ? `<span>Updated ${sourceTime.format(new Date(quote.updatedAt))}</span>` : ''}</li>`).join('')}</ul>
          </div>`).join('')}</details></td></tr>`;
      }).join('')}</tbody></table></div>` : `<p>${html(messages[report.status])}</p>`;
    return `<h3 id="odds-title">UK Betting Odds Comparison &amp; Player Selection</h3>
      <p class="prediction-caption">Gameweek ${report.gameweek} · ${html(report.market)} · Decimal prices</p>
      ${paused ? `<p role="status">${paused}${savedMessage}</p>` : ''}${matched}${listing}
      ${report.sources.length ? `<details class="provenance"><summary>Odds data sources</summary>${sourceList(report.sources)}</details>` : ''}
      <p class="prediction-caption">Odds data from <a href="${html(provider.url)}" target="_blank" rel="noopener">${html(provider.name)}</a></p>`;
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
    const comparison = Object.entries(strategyName).map(([key, label]) => {
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
            <td>${sourceTime.format(new Date(record.createdAt))}</td><td>${forecast(record.total)}${record.projectedCount < record.players.length ? ` (${record.projectedCount}/${record.players.length})` : ''}</td>
            <td>${accuracy ? `${accuracy.actualTotal}${accuracy.actualCount < record.players.length ? ` (${accuracy.actualCount}/${record.players.length})` : ''}` : 'Pending'}</td>
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
      const closed = ready.week.finished || Date.parse(ready.week.deadline_time) <= Date.now();
      refreshStatus.textContent = `Gameweek ${ready.week.id} data refreshed.${closed ? ' The prediction deadline has passed.' : ''}${ready.historyError ? ` ${ready.historyError}` : ''}`;
      await loadHistory();
    } catch (error) {
      refreshStatus.textContent = `Refresh failed. ${error.message}${ready ? ' You can still use the previous successful refresh for this Gameweek.' : ''}`;
    } finally {
      busy = false;
      updateControls();
    }
  });
  analyse.addEventListener('click', async () => {
    busy = true;
    hideResults();
    showAnalysis(`Analysing Gameweek ${week.value}…`);
    updateControls();
    try {
      const query = new URLSearchParams({ gameweek: week.value, strategy: strategy.value, token: ready.token });
      const record = await request(`/api/predictions?${query}`, 'POST');
      if (record.strategy === 'news' || record.strategy === 'odds') {
        const section = record.strategy === 'news' ? newsResult : oddsResult;
        section.innerHTML = record.strategy === 'news' ? newsView(record) : oddsView(record);
        section.hidden = false;
        showAnalysis('');
        return;
      }
      result.innerHTML = squadView(record);
      result.hidden = false;
      showAnalysis(record.id ? (record.shortlist ? 'Shortlist saved.' : 'Squad prediction saved.') : '');
      if (record.id) await loadHistory();
    } catch (error) {
      showAnalysis(error.message);
    } finally {
      busy = false;
      updateControls();
    }
  });
  history.addEventListener('click', event => {
    const button = event.target.closest('[data-saved-prediction]');
    const record = records.find(item => item.id === button?.dataset.savedPrediction);
    if (record) openDialog('Saved prediction', squadView(record));
  });

  gameweeks(Array.from({ length: 38 }, (_, index) => ({ id: index + 1, name: `Gameweek ${index + 1}` })));
  loadHistory();
  return { useSnapshot };
}
