import { captainOptions, forecast, makeModel, number, price, transferOptions } from './model.mjs';

import { setupPredictions } from './predictions.mjs';

const $ = selector => document.querySelector(selector);
const pageSize = 20;
const state = { page: 0, view: 'players', entry: null, detail: 0, week: null };
const ukTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
});
const sourceTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
});
const integer = new Intl.NumberFormat('en-GB');
const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const date = value => value && Number.isFinite(Date.parse(value)) ? ukTime.format(new Date(value)) : 'Date TBC';
const formattedNumber = value => value == null ? '—' : integer.format(value);
const displayName = player => player.web_name || [player.first_name, player.second_name].filter(Boolean).join(' ');
const normalizeName = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

async function get(url, method = 'GET') {
  const response = await fetch(url, { method });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load FPL data.');
  return data;
}

function playerButton(player, label = displayName(player)) {
  return `<button type="button" class="text-button" data-player="${player.id}">${html(label)}</button>`;
}

function sourceList(sources) {
  return `<dl class="sources">${sources.map(source => {
    const update = source.lastModified
      ? `FPL last modified ${sourceTime.format(new Date(source.lastModified))}`
      : 'FPL did not provide a last-modified time';
    const upstreamDate = source.upstreamDate ? ` · HTTP date ${sourceTime.format(new Date(source.upstreamDate))}` : '';
    const origin = source.origin ? `${html(source.origin)}${source.gameweek == null ? '' : ` · Gameweek ${source.gameweek}`}<br>` : '';
    return `<div><dt><a href="${html(source.url)}" target="_blank" rel="noopener">${html(source.label)}</a></dt>
      <dd>${origin}Retrieved ${sourceTime.format(new Date(source.retrievedAt))}<br>${update}${upstreamDate}</dd></div>`;
  }).join('')}</dl>`;
}

function openDialog(title, content) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = content;
  if (!$('#dialog').open) $('#dialog').showModal();
}

function fixtureChips(player, weeks = state.model.weeks) {
  return weeks.map(week => {
    const matches = player.schedule.filter(fixture => fixture.event === week.id);
    const chips = matches.map(fixture => {
      const label = `GW${fixture.event} · ${fixture.opponent.name} ${fixture.home ? 'home' : 'away'} · Difficulty ${fixture.difficulty ?? 'unrated'}`;
      return `<span class="fixture-chip fdr-${number(fixture.difficulty)}" title="${html(label)}" aria-label="${html(label)}">${html(fixture.opponent.short_name)} <small>${fixture.home ? 'H' : 'A'}</small></span>`;
    }).join('');
    return `<span class="fixture-week" aria-label="Gameweek ${week.id}">${chips || '<span class="fixture-chip fdr-0" title="Blank Gameweek" aria-label="Blank Gameweek">—</span>'}</span>`;
  }).join('');
}

function playerLabel(player) {
  return `<div class="player-label"><span class="club-key" aria-hidden="true">${html(player.teamInfo.short_name)}</span><div>${playerButton(player)}
    <span class="player-meta">${html(player.teamInfo.name)} · ${html(player.positionInfo.singular_name_short)}${player.chance < 1 ? ` · ${player.chance ? Math.round(player.chance * 100) + '% available' : 'Unavailable'}` : ''}</span></div></div>`;
}

function renderRecommendations() {
  const { players, weeks } = state.model;
  const [captain] = captainOptions(players);
  const pick = players.find(player => player.projected > 0);
  const value = players.filter(player => player.projected > 0 && player.expectedMinutes >= 45)
    .sort((a, b) => b.value - a.value)[0];
  const cards = [
    ['Next Gameweek captain', captain, captain ? `GW${weeks[0].id}` : '', captain?.next],
    ['Overall projection leader', pick, `${weeks.length} GW`, pick?.projected],
    ['Best value', value, 'pts per £m', value?.value]
  ];
  $('#insights').innerHTML = cards.map(([label, player, context, score], index) =>
    `<article class="insight ${index === 0 ? 'insight-featured' : ''}"><h2>${label}</h2>${player ? `
      <div class="insight-main"><div>${playerButton(player)}<p>${html(player.teamInfo.name)} · ${price(player.now_cost)}</p></div>
      <div class="insight-score"><strong>${forecast(score)}</strong><span>${context}</span></div></div>
      ${index === 0 ? `<div class="chip-list">${fixtureChips(player, weeks.slice(0, 1))}</div>` : ''}
    ` : '<p class="empty-insight">Awaiting projected points</p>'}</article>`).join('');
}

function renderPlayers() {
  const { players, weeks } = state.model;
  const query = normalizeName($('#search').value.trim());
  const position = number($('#position').value);
  const club = number($('#club').value);
  const maxPrice = $('#max-price').valueAsNumber;
  const sort = $('#sort').value;
  const filtered = players.filter(player =>
    (!position || player.element_type === position) && (!club || player.team === club)
    && (!Number.isFinite(maxPrice) || player.now_cost <= Math.round(maxPrice * 10))
    && (!query || normalizeName(`${displayName(player)} ${player.first_name} ${player.second_name}`).includes(query)));
  if (sort !== 'projected') {
    filtered.sort((a, b) => sort === 'now_cost' ? a.now_cost - b.now_cost
      : (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity) || b.total_points - a.total_points);
  }

  $('#ranking-caption').textContent = weeks.length
    ? `GW${weeks[0].id}${weeks.length > 1 ? '–' + weeks.at(-1).id : ''} projections · season totals from official FPL`
    : 'Season totals from official FPL. No future Gameweek is scheduled.';
  state.page = Math.min(state.page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const start = state.page * pageSize;
  const page = filtered.slice(start, start + pageSize);
  $('#player-rows').innerHTML = page.map(player => `<tr><td>${playerLabel(player)}</td>
    <td>${price(player.now_cost)}</td><td>${formattedNumber(player.total_points)}</td>
    <td>${formattedNumber(player.minutes)}</td><td>${html(player.form ?? '—')}</td>
    <td><div class="chip-list">${fixtureChips(player) || '—'}</div></td>
    <td><span class="score-pill">${forecast(player.projected)}</span></td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">No players match these filters.</td></tr>';
  $('#page-summary').textContent = filtered.length ? `${start + 1}–${start + page.length} of ${filtered.length} players` : '0 players';
  $('#prev').disabled = !state.page;
  $('#next').disabled = start + pageSize >= filtered.length;
}

function renderFixtures() {
  const week = state.data.events.find(event => event.id === number($('#fixture-week').value));
  const fixtures = state.data.fixtures.filter(fixture => fixture.event === week?.id)
    .sort((first, second) => (Date.parse(first.kickoff_time) || Infinity) - (Date.parse(second.kickoff_time) || Infinity));
  $('#fixture-list').innerHTML = fixtures.map(fixture => {
    const home = state.model.teams.get(fixture.team_h);
    const away = state.model.teams.get(fixture.team_a);
    const status = fixture.finished ? 'Full time' : fixture.finished_provisional ? 'Provisional result' : fixture.started ? 'In play' : date(fixture.kickoff_time);
    return `<article class="fixture-row"><div class="fixture-status">${html(status)}
      ${fixture.started || fixture.finished ? `<small>${html(date(fixture.kickoff_time))}</small>` : ''}</div>
      <div class="fixture-teams"><span>${html(home.name)}</span><strong>${fixture.team_h_score == null || fixture.team_a_score == null
        ? 'vs' : `${fixture.team_h_score}–${fixture.team_a_score}`}</strong><span>${html(away.name)}</span></div>
      <div class="fixture-difficulty">FDR <span class="fixture-chip fdr-${number(fixture.team_h_difficulty)}" aria-label="Home difficulty">${fixture.team_h_difficulty ?? '—'}</span>
        <span class="fixture-chip fdr-${number(fixture.team_a_difficulty)}" aria-label="Away difficulty">${fixture.team_a_difficulty ?? '—'}</span></div></article>`;
  }).join('') || '<p class="empty">No fixtures are scheduled for this Gameweek.</p>';
}

function tab(view) {
  state.view = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.setAttribute('aria-pressed', active);
    $(`#${button.dataset.view}-view`).hidden = !active;
  }
}

function inputPrice(field) {
  const value = field.valueAsNumber;
  return Number.isFinite(value) && field.validity.valid && Number.isSafeInteger(Math.round(value * 10))
    ? Math.round(value * 10) : null;
}

function renderTransfers() {
  if (!$('#outgoing')) return;
  const shortlist = $('#transfers');
  const outgoing = state.model.byId.get(number($('#outgoing').value));
  const selling = inputPrice($('#sell-price'));
  const bank = inputPrice($('#bank'));
  if (!outgoing || selling == null || bank == null) {
    shortlist.innerHTML = '<p class="empty">Enter a selling price and bank balance to see upgrades.</p>';
    return;
  }
  if (selling > outgoing.now_cost) {
    shortlist.innerHTML = '<p class="empty">Selling price must be at or below the player’s current market price.</p>';
    return;
  }
  if (outgoing.projected == null) {
    shortlist.innerHTML = '<p class="empty">The model needs an outgoing player projection to compare upgrades.</p>';
    return;
  }
  const squad = state.entry.picks.map(pick => state.model.byId.get(pick.element)).filter(Boolean);
  const options = transferOptions(state.model.players, squad, outgoing, selling + bank).slice(0, 5);
  shortlist.innerHTML = options.length ? `<ul class="transfer-list">${options.map(({ player, gain, remaining }) => `
    <li>${playerLabel(player)}<span>${price(player.now_cost)} · ${price(remaining)} left</span>
      <strong>+${forecast(gain)} pts</strong></li>`).join('')}</ul>` : '<p class="empty">No projected upgrades fit this budget and the club limit.</p>';
}

function renderSquad() {
  const target = $('#entry-content');
  if (!state.entry) {
    target.innerHTML = '';
    return;
  }
  const { entry, event, picks, bank, squadValue, activeChip, sources } = state.entry;
  const squad = picks.map(pick => ({ ...pick, player: state.model.byId.get(pick.element) }));
  const captains = activeChip === 'freehit' ? [] : captainOptions(squad.map(pick => pick.player).filter(Boolean)).slice(0, 3);
  const canPlan = state.model.weeks.length && activeChip !== 'freehit' && squad.length === 15 && squad.every(pick => pick.player);
  const plan = state.plan ?? {};
  target.innerHTML = `
    <div class="panel squad-header"><div><p class="eyebrow">Team ${entry.id}${event ? ` · Gameweek ${event} locked picks` : ''}</p>
      <h3>${html(entry.name)}</h3><p>${formattedNumber(entry.summary_overall_points)} points · Rank ${formattedNumber(entry.summary_overall_rank)}</p></div>
      <div class="team-figures"><span>Squad value <strong>${price(squadValue)}</strong></span><span>Bank at deadline <strong>${price(bank)}</strong></span></div>
    </div>
    ${picks.length ? `
      <div class="squad-grid">
        <div class="panel squad-card"><h3>Next Gameweek captain</h3>
          ${captains.length ? `<ol class="captain-list">${captains.map(player => `<li>${playerLabel(player)}<strong>${forecast(player.next)} pts</strong></li>`).join('')}</ol>` : `<p>${activeChip === 'freehit' ? 'The published picks were for Free Hit. Captain advice needs your permanent squad.' : 'No captain projection for this squad.'}</p>`}
        </div>
        <div class="panel squad-card">
          <h3>Plan a transfer</h3>
          ${canPlan ? `<p>Check your current squad, bank, and selling price on FPL before using these options. Gains exclude transfer hits.</p>
            <div class="planner">
              <label>Outgoing player<select id="outgoing">${squad.map(({ player }) => `<option value="${player.id}" ${plan.outgoing === player.id ? 'selected' : ''}>${html(displayName(player))}</option>`).join('')}</select></label>
              <label>Selling price (£m)<input id="sell-price" type="number" min="0" step="0.1" value="${html(plan.selling ?? '')}" placeholder="Enter price"></label>
              <label>Bank (£m)<input id="bank" type="number" min="0" step="0.1" value="${html(plan.bank ?? (bank == null ? '' : (bank / 10).toFixed(1)))}"></label>
            </div><div id="transfers" aria-live="polite"></div>` : `<p>${activeChip === 'freehit' ? 'Transfer planning needs your permanent squad after Free Hit.' : 'Transfer planning needs a complete squad and an upcoming Gameweek.'}</p>`}
        </div>
      </div>
      <div class="panel squad-table"><div class="panel-title"><h3>Published squad</h3><span>Order and captaincy as published by FPL</span></div>
        <div class="scroll-table" tabindex="0" aria-label="Published squad table"><table>
          <thead><tr><th scope="col">Player</th><th scope="col">Role</th><th scope="col">Price</th><th scope="col">Next GW</th><th scope="col">Projected</th></tr></thead>
          <tbody>${squad.map(({ player, element, position, is_captain, is_vice_captain }) => `<tr><td>${player ? playerLabel(player) : `Unavailable player ${element}`}</td>
            <td>${is_captain ? 'Captain' : is_vice_captain ? 'Vice-captain' : position > 11 ? 'Bench' : 'Starting XI'}</td>
            <td>${price(player?.now_cost)}</td><td>${forecast(player?.next)}</td><td>${forecast(player?.projected)}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : '<p class="empty">FPL has yet to publish picks for this entry.</p>'}
    <details class="panel provenance"><summary>Squad data sources</summary>${sourceList(sources)}</details>`;
  if (!canPlan) return;
  $('#outgoing').addEventListener('change', () => {
    $('#sell-price').value = '';
    savePlan();
  });
  $('#sell-price').addEventListener('input', savePlan);
  $('#bank').addEventListener('input', savePlan);
  renderTransfers();
}

function savePlan() {
  state.plan = { outgoing: number($('#outgoing').value), selling: $('#sell-price').value, bank: $('#bank').value };
  renderTransfers();
}

async function loadEntry(id) {
  const sequence = (state.entryRequest ?? 0) + 1;
  state.entryRequest = sequence;
  const status = $('#entry-status');
  status.hidden = false;
  status.textContent = 'Loading published FPL picks…';
  try {
    const entry = await get(`/api/entries/${id}`);
    if (sequence !== state.entryRequest) return;
    if (state.entry?.entry.id !== entry.entry.id || state.entry?.event !== entry.event) state.plan = null;
    state.entry = entry;
    status.hidden = true;
    renderSquad();
  } catch (error) {
    if (sequence !== state.entryRequest) return;
    status.textContent = error.message;
  }
}

function renderModel() {
  state.model = makeModel(state.data, number($('#horizon').value));
  const { weeks } = state.model;
  $('#hero-season').textContent = `${state.data.seasonYear}/${String(state.data.seasonYear + 1).slice(-2)} PREMIER LEAGUE`;
  $('#hero-deadline').textContent = weeks.length ? `Gameweek ${weeks[0].id} deadline · ${date(weeks[0].deadline_time)}` : 'No upcoming Gameweek deadline has been published.';
  renderRecommendations();
  renderPlayers();
  renderSquad();
}

function showDashboard(data) {
  const notice = $('#notice');
  state.data = data;
  const position = $('#position').value;
  const club = $('#club').value;
  $('#position').innerHTML = '<option value="">All positions</option>' + state.data.positions.map(item =>
    `<option value="${item.id}">${html(item.singular_name)}</option>`).join('');
  $('#club').innerHTML = '<option value="">All clubs</option>' + state.data.teams.map(item =>
    `<option value="${item.id}">${html(item.name)}</option>`).join('');
  $('#position').value = state.data.positions.some(item => item.id === number(position)) ? position : '';
  $('#club').value = state.data.teams.some(item => item.id === number(club)) ? club : '';
  renderModel();
  $('#fixture-week').innerHTML = state.data.events.map(week => `<option value="${week.id}">${html(week.name)}</option>`).join('');
  $('#fixture-week').value = state.week ?? state.model.weeks[0]?.id ?? state.data.events.find(week => week.is_current)?.id ?? state.data.events.at(-1).id;
  renderFixtures();
  $('#dashboard').hidden = false;
  notice.hidden = !state.data.refreshError;
  if (state.data.refreshError) notice.textContent = 'Using the last validated FPL snapshot. Use Refresh FPL Data to try the live feeds again.';
}

async function playerDetail(id) {
  const player = state.model.byId.get(id);
  if (!player) return;
  const sequence = ++state.detail;
  const current = state.data.events.find(week => week.is_current);
  const fullName = [player.first_name, player.second_name].filter(Boolean).join(' ') || displayName(player);
  const stats = [
    ['Price', price(player.now_cost)], ['Season points', formattedNumber(player.total_points)],
    ['Minutes', formattedNumber(player.minutes)], ['Starts', formattedNumber(player.starts)],
    ['Goals', formattedNumber(player.goals_scored)], ['Assists', formattedNumber(player.assists)],
    ['Clean sheets', formattedNumber(player.clean_sheets)], ['FPL form', html(player.form ?? '—')],
    ['Expected goals', html(player.expected_goals ?? '—')], ['Expected assists', html(player.expected_assists ?? '—')],
    ['Next GW projection', forecast(player.next)], ['Horizon projection', forecast(player.projected)]
  ];
  openDialog(fullName, `
    <p class="dialog-subtitle">${html(player.teamInfo.name)} · ${html(player.positionInfo.singular_name)} · ${player.chance === 1 ? 'Available' : `${Math.round(player.chance * 100)}% model availability`}</p>
    <dl class="stat-grid">${stats.map(([title, value]) => `<div><dt>${title}</dt><dd>${value}</dd></div>`).join('')}</dl>
    ${player.news ? `<div class="player-news"><strong>Official availability news</strong><p>${html(player.news)}</p>${player.news_added ? `<small>Added ${html(date(player.news_added))}</small>` : ''}</div>` : ''}
    <div id="detail-live" aria-live="polite"></div>
    <div id="detail-history" aria-live="polite"><p>Loading official match history…</p></div>
    <details class="provenance"><summary>Season data sources</summary>${sourceList(state.data.sources)}</details>`);
  const isOpen = () => sequence === state.detail && $('#dialog').open;
  if (current) {
    get(`/api/gameweeks/${current.id}/live`).then(live => {
      if (!isOpen()) return;
      const record = live.players.find(item => item.id === id);
      $('#detail-live').innerHTML = `<h3>${html(current.name)} scoring</h3><p>${record ? `${record.total_points} points · ${record.minutes} minutes · ${record.bonus} bonus` : 'No scoring record published for this player.'}</p>
        <details class="provenance"><summary>Gameweek scoring source</summary>${sourceList(live.sources)}</details>`;
    }).catch(error => {
      if (isOpen()) $('#detail-live').textContent = error.message;
    });
  }
  try {
    const detail = await get(`/api/players/${id}`);
    if (!isOpen()) return;
    const matches = detail.history.slice().sort((a, b) => Date.parse(b.kickoff_time) - Date.parse(a.kickoff_time)).slice(0, 8);
    const fixtures = detail.fixtures.filter(fixture => state.model.weeks.some(week => week.id === fixture.event))
      .sort((a, b) => a.event - b.event || Date.parse(a.kickoff_time) - Date.parse(b.kickoff_time));
    $('#detail-history').innerHTML = `<h3>Upcoming fixtures</h3>
      ${fixtures.length ? `<ul class="details-fixtures">${fixtures.map(fixture => {
        const opponent = state.model.teams.get(fixture.is_home ? fixture.team_a : fixture.team_h);
        return `<li><span>GW${fixture.event} · ${html(opponent?.name ?? 'Opponent TBC')} ${fixture.is_home ? '(H)' : '(A)'}</span><span>${html(date(fixture.kickoff_time))}</span></li>`;
      }).join('')}</ul>` : '<p>No fixtures for this projection horizon.</p>'}
      <h3>Recent match history</h3>
      ${matches.length ? `<div class="scroll-table" tabindex="0" aria-label="Recent match history"><table>
        <thead><tr><th scope="col">GW</th><th scope="col">Opponent</th><th scope="col">Minutes</th><th scope="col">Points</th><th scope="col">Price</th></tr></thead>
        <tbody>${matches.map(match => `<tr><td>${match.round}</td>
          <td>${html(state.model.teams.get(match.opponent_team)?.name ?? 'Unknown')} ${match.was_home ? '(H)' : '(A)'}</td>
          <td>${match.minutes}</td><td>${match.total_points}</td><td>${price(match.value)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p>No current-season match history published.</p>'}
      <details class="provenance"><summary>Player history and fixtures source</summary>${sourceList(detail.sources)}</details>`;
  } catch (error) {
    if (isOpen()) $('#detail-history').textContent = error.message;
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-player], [data-view]');
  if (button?.dataset.player) playerDetail(number(button.dataset.player));
  if (button?.dataset.view) tab(button.dataset.view);
});
$('#filters').addEventListener('submit', event => event.preventDefault());
$('#filters').addEventListener('input', () => { state.page = 0; renderPlayers(); });
$('#prev').addEventListener('click', () => { state.page -= 1; renderPlayers(); });
$('#next').addEventListener('click', () => { state.page += 1; renderPlayers(); });
$('#fixture-week').addEventListener('change', () => { state.week = number($('#fixture-week').value); renderFixtures(); });
$('#horizon').addEventListener('change', () => { state.page = 0; renderModel(); });
$('#entry-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = Number($('#entry-id').value.trim());
  if (Number.isSafeInteger(id) && id > 0) loadEntry(id);
  else {
    $('#entry-status').textContent = 'Enter a positive numeric Team ID.';
    $('#entry-status').hidden = false;
  }
});
$('#dialog').addEventListener('close', () => { state.detail += 1; });
$('#source-button').addEventListener('click', () => openDialog('Official FPL data', state.data ? `
  <p>${html(state.data.dataStatus.source)}</p>
  ${sourceList(state.data.sources)}<p>Player, Gameweek scoring, and squad views show the timestamps of their own requests.</p>`
  : '<p>Waiting for a verified response from official Fantasy Premier League.</p>'));
$('#method-button').addEventListener('click', () => openDialog('How projections work', `
  <p>Projected points use a weighted blend of season scoring (70%) and the official FPL form number (30%). The season estimate adjusts for playing time and leans towards the average for the player’s position when their sample is small.</p>
  <p>The model applies the current FPL availability flag and each fixture’s home or away status and difficulty. A blank Gameweek contributes zero and a double Gameweek includes both fixtures. Players without minutes this season have no projection.</p>
  <p>Captain picks use the next Gameweek’s projection before the captain multiplier. Best value uses projected points per £m among players averaging at least 45 minutes. Transfer gains compare the two players over the selected horizon.</p>
  <p>Availability is held constant across the projection horizon, so return dates and rotation can materially change the estimates.</p>`));

const predictions = setupPredictions({ request: get, html, sourceList, openDialog, sourceTime,
  onRefresh(data) {
    showDashboard(data);
    if (state.entry) loadEntry(state.entry.entry.id);
  }
});
get('/api/dashboard').then(data => {
  if (predictions.useSnapshot(data)) showDashboard(data);
}).catch(error => predictions.showSnapshotWarning(error.message));
