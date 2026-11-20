import { forecast, price } from './model.mjs';

const strategyName = {
  ranking: 'Current FPL Ranking', previous: 'Previous Gameweek Performance', weather: 'Weather Impact Prediction',
  recent: 'Recent Performance Form'
};
const $ = selector => document.querySelector(selector);
const availableForecasts = report => report.fixtures.filter(fixture => !fixture.unavailable).length;

export function setupPredictions({ request, html, sourceList, openDialog, sourceTime, onRefresh }) {
  const week = $('#prediction-week');
  const strategy = $('#prediction-strategy');
  const refresh = $('#refresh');
  const analyse = $('#analyse');
  const refreshStatus = $('#refresh-status');
  const analysisStatus = $('#analysis-status');
  const result = $('#prediction-result');
  const newsResult = $('#news-result');
  const history = $('#history-content');
  let ready;
  let busy = false;
  let records = [];
  let historyRequest = 0;
  const newsDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/London' });

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

  function weatherView(report) {
    const coverage = availableForecasts(report);
    const summary = report.fixtures.length
      ? `${coverage} of ${report.fixtures.length} fixtures covered${coverage ? '' : ' · FPL-only estimates'}`
      : 'No scheduled fixtures to forecast';
    return `<details class="provenance prediction-weather"><summary>Weather · ${summary}</summary>
      <p>Weather flags indicate possible match impacts. Points use the FPL baseline.</p>
      <div class="scroll-table" tabindex="0" aria-label="Fixture weather"><table>
        <thead><tr><th scope="col">Match and venue</th><th scope="col">Kickoff conditions</th><th scope="col">Potential impact</th></tr></thead>
        <tbody>${report.fixtures.map(fixture => `<tr><td><strong>${html(fixture.home)} v ${html(fixture.away)}</strong>
          <span class="player-meta">${html(fixture.venue ?? 'Venue unavailable')}</span></td>
          <td>${fixture.unavailable ? '—' : `${html(fixture.temperature)}°C · ${html(fixture.rain)} mm/h rain · ${html(fixture.gust)} km/h gusts`}</td>
          <td>${html(fixture.unavailable || fixture.risks.join(' · ') || 'No weather flag')}</td></tr>`).join('')}</tbody>
      </table></div>
      <p>Forecasts by <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener">Open-Meteo</a> · <a href="${html(report.venueSource)}" target="_blank" rel="noopener">Premier League home grounds</a></p>
    </details>`;
  }

  function squadView(record) {
    const { players, accuracy } = record;
    const actual = new Map(accuracy?.actual.map(player => [player.id, player.points]));
    const comparison = accuracy && accuracy.meanAbsoluteError != null
      ? `<p>Mean absolute error <strong>${forecast(accuracy.meanAbsoluteError)} pts/player</strong> · ${accuracy.comparedCount} compared · ${forecast(accuracy.predictedComparableTotal)} predicted, ${accuracy.actualComparableTotal} actual for those players.</p>` : '';
    const form = record.recentForm;
    const coverage = form ? [
      form.domesticWeeks.length ? `PL results: ${form.domesticWeeks.map(week => 'GW' + week).join(', ')}` : 'Recent PL results unavailable',
      form.cupReports ? `${form.cupReports} domestic cup reports matched` : '',
      form.internationalReports ? `${form.internationalReports} international reports matched` : 'No verified international appearances in this window',
      form.days < form.expectedDays || form.reports < form.requested || form.domesticWeeks.length < form.requestedWeeks ? 'Partial data coverage' : ''
    ].filter(Boolean).join(' · ') : '';
    return `<div class="prediction-result-head"><div><h3>Gameweek ${record.gameweek} · ${strategyName[record.strategy]}</h3>
      <p>${players.length} players · ${price(record.cost)}${record.previousWeek ? ` · Uses final GW${record.previousWeek} results` : ''}</p></div>
      <div class="prediction-total"><strong>${forecast(record.total)}</strong><span>Projected squad pts</span></div></div>
      ${record.projectedCount < players.length ? `<p>${record.projectedCount} of ${players.length} players have a point estimate.</p>` : ''}
      <p>Captain <strong>${html(players.find(player => player.id === record.captain)?.name)}</strong> · Vice-captain <strong>${html(players.find(player => player.id === record.viceCaptain)?.name)}</strong></p>
      <p class="prediction-caption">Squad totals add all 15 players before captaincy.</p>
      ${coverage ? `<p class="prediction-caption">${html(coverage)}</p>` : ''}
      ${comparison}
      <div class="scroll-table" tabindex="0" aria-label="Predicted 15-player squad">
        <table><thead><tr><th scope="col">Player</th><th scope="col">Club</th><th scope="col">Position</th><th scope="col">Price</th><th scope="col">Projected</th>
        ${accuracy ? '<th scope="col">Actual</th>' : ''}</tr></thead>
        <tbody>${players.map(player => `<tr><td><strong>${html(player.name)}</strong>
          ${player.id === record.captain ? '<span class="prediction-role">C</span>' : player.id === record.viceCaptain ? '<span class="prediction-role">VC</span>' : ''}
          ${player.weatherWatch ? '<span class="player-meta">Weather watch</span>' : ''}
          ${player.evidence ? `<span class="player-meta">${player.evidence.domesticWeeks} PL weeks · ${player.evidence.cupMatches} cup · ${player.evidence.internationalMatches} international</span>` : ''}</td>
          <td>${html(player.team)}</td><td>${html(player.position)}</td><td>${price(player.cost)}</td><td>${forecast(player.predicted)}</td>
          ${accuracy ? `<td>${actual.get(player.id) ?? '—'}</td>` : ''}</tr>`).join('')}</tbody></table>
      </div>
      ${record.weather ? weatherView(record.weather) : ''}
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

  function renderHistory() {
    if (!records.length) {
      history.innerHTML = '<p class="empty">Saved squads will appear here. Refresh FPL after a Gameweek is final to record actual points.</p>';
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
        <th scope="col">Actual</th><th scope="col">Error per player</th><th scope="col">Squad</th></tr></thead>
        <tbody>${records.map(record => {
          const { accuracy } = record;
          return `<tr><td>${record.seasonYear}/${String(record.seasonYear + 1).slice(-2)} · GW${record.gameweek}</td>
            <td>${strategyName[record.strategy]}${record.weather ? `<span class="player-meta">${availableForecasts(record.weather)}/${record.weather.fixtures.length} fixtures with forecasts</span>` : ''}</td>
            <td>${sourceTime.format(new Date(record.createdAt))}</td><td>${forecast(record.total)}${record.projectedCount < record.players.length ? ` (${record.projectedCount}/15)` : ''}</td>
            <td>${accuracy ? `${accuracy.actualTotal}${accuracy.actualCount < record.players.length ? ` (${accuracy.actualCount}/15)` : ''}` : 'Pending'}</td>
            <td>${forecast(accuracy?.meanAbsoluteError)}${accuracy && accuracy.comparedCount < record.players.length ? ` (${accuracy.comparedCount}/15)` : ''}</td>
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
      if (record.strategy === 'news') {
        newsResult.innerHTML = newsView(record);
        newsResult.hidden = false;
        showAnalysis('');
        return;
      }
      result.innerHTML = squadView(record);
      result.hidden = false;
      showAnalysis('Squad prediction saved.');
      await loadHistory();
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
    if (record) openDialog('Saved squad prediction', squadView(record));
  });

  gameweeks(Array.from({ length: 38 }, (_, index) => ({ id: index + 1, name: `Gameweek ${index + 1}` })));
  loadHistory();
  return { useSnapshot };
}
