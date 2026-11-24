import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFplClient } from '../lib/fpl.mjs';
import { createApiHandler } from '../lib/http.mjs';
import { seasonSnapshot } from '../lib/node-storage.mjs';
import { predictionService } from '../lib/predictions.mjs';
import { isGameweekComplete } from '../public/model.mjs';

const firstDeadline = Date.parse('2026-08-15T10:00:00Z');
const day = 86_400_000;
const deadline = id => firstDeadline + (id - 1) * 7 * day;
const iso = time => new Date(time).toISOString();
const teams = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: `Club ${index + 1}`, short_name: `C${index + 1}` }));
const positions = ['GKP', 'DEF', 'MID', 'FWD'].map((position, index) => ({ id: index + 1,
  singular_name: position, singular_name_short: position, element_count: teams.length }));
const counts = { minutes: 90, starts: 1, total_points: 4, goals_scored: 0, assists: 0, clean_sheets: 0, saves: 0,
  bonus: 0, own_goals: 0, penalties_saved: 0, penalties_missed: 0, yellow_cards: 0, red_cards: 0, defensive_contribution: 0 };
const points = { long_play: 2, short_play: 1, goals_conceded: 0, saves: 0, goals_scored: 4, assists: 3,
  clean_sheets: 1, penalties_saved: 0, penalties_missed: -2, yellow_cards: -1, red_cards: -3, own_goals: -2,
  bonus: 1, defensive_contribution: 0 };
const players = teams.flatMap(team => positions.map(position => ({ ...counts, id: (team.id - 1) * 4 + position.id,
  team: team.id, element_type: position.id, web_name: `${team.short_name} ${position.singular_name}`,
  now_cost: 50, status: 'a', form: '4', expected_goals: '0.1', expected_assists: '0.2' })));
const rotation = teams.map(team => team.id);
const firstHalf = Array.from({ length: 19 }, () => {
  const pairings = Array.from({ length: 10 }, (_, index) => [rotation[index], rotation[19 - index]]);
  rotation.splice(1, 0, rotation.pop());
  return pairings;
});
const schedule = [...firstHalf, ...firstHalf.map(round => round.map(([home, away]) => [away, home]))];

function season(finalWeek, { finishedWeek = finalWeek, currentWeek = finalWeek + 1, unfinishedFixture } = {}) {
  const events = schedule.map((_, index) => {
    const id = index + 1;
    return { id, name: `Gameweek ${id}`, deadline_time: iso(deadline(id)), finished: id <= finishedWeek,
      data_checked: id <= finalWeek, is_current: id === currentWeek, is_next: id === currentWeek + 1 };
  });
  const fixtures = schedule.flatMap((pairs, index) => pairs.map(([team_h, team_a], match) => ({
    id: index * 10 + match + 1, event: index + 1, team_h, team_a, kickoff_time: iso(deadline(index + 1) + day / 4),
    started: index < finishedWeek, finished: index < finishedWeek && index * 10 + match + 1 !== unfinishedFixture,
    finished_provisional: index < finishedWeek,
    team_h_score: index < finishedWeek ? 1 : null, team_a_score: index < finishedWeek ? 1 : null,
    team_h_difficulty: 3, team_a_difficulty: 3
  })));
  return { bootstrap: { elements: players, teams, events, element_types: positions, game_config: { scoring: points } }, fixtures };
}

function feed() {
  const state = { now: deadline(3) - day, finalWeek: 1, offline: false, fixturesPartial: false,
    rosterPartial: false, liveFailure: null, livePartial: false, playerPartial: false, calls: [] };
  const fetchData = async url => {
    const path = new URL(url).pathname;
    state.calls.push(path);
    if (state.offline) throw new DOMException('Timed out', 'TimeoutError');
    const { bootstrap, fixtures } = season(state.finalWeek, state);
    if (path === '/api/bootstrap-static/') {
      return Response.json(state.rosterPartial ? { ...bootstrap, elements: players.slice(0, -1) } : bootstrap);
    }
    if (path === '/api/fixtures/') return Response.json(state.fixturesPartial ? fixtures.slice(0, -1) : fixtures);
    const event = Number(path.match(/^\/api\/event\/(\d+)\/live\/$/)?.[1]);
    if (event) {
      if (event === state.liveFailure) return new Response(null, { status: 503 });
      const matches = fixtures.filter(fixture => fixture.event === event);
      const stats = { ...counts, total_points: event <= state.finalWeek ? 4 : 1,
        expected_goals: '0.1', expected_assists: '0.2', expected_goal_involvements: '0.3' };
      const elements = players.map(player => ({ id: player.id, stats,
        explain: [{ fixture: matches.find(fixture => fixture.team_h === player.team || fixture.team_a === player.team).id,
          stats: [{ identifier: 'minutes', value: 90 }] }] }));
      return Response.json({ elements: state.livePartial ? elements.slice(0, -1) : elements });
    }
    const id = Number(path.match(/^\/api\/element-summary\/(\d+)\/$/)?.[1]);
    if (id) {
      const { team } = players.find(player => player.id === id);
      const fixture = fixtures.find(fixture => fixture.event === 1 && (fixture.team_h === team || fixture.team_a === team));
      const match = { ...counts, fixture: fixture.id, round: 1, kickoff_time: fixture.kickoff_time,
        opponent_team: fixture.team_h === team ? fixture.team_a : fixture.team_h, was_home: fixture.team_h === team };
      return Response.json({ history: state.playerPartial ? [] : [match], fixtures: [] });
    }
    return new Response(null, { status: 404 });
  };
  const clock = () => state.now;
  return { state, clock, client: store => createFplClient(store, { fetchData, now: clock }) };
}

async function cache(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fpl-cache-test-'));
  t.after(async () => {
    await Promise.all((await readdir(directory)).map(name => unlink(join(directory, name))));
    await rmdir(directory);
  });
  return { directory, store: () => seasonSnapshot(directory) };
}

test('keeps the last valid league data through partial API results and a restart', async t => {
  const { store } = await cache(t);
  const upstream = feed();
  const { state } = upstream;
  const client = upstream.client(store());
  const fresh = await client.getDashboard(true);
  assert.deepEqual(fresh.dataStatus, { source: 'Latest API Data', lastSuccessfulFetch: iso(state.now), gameweek: 2, complete: true });
  const saved = await store().read();
  state.now += day / 4;
  state.fixturesPartial = true;
  const partial = await client.getDashboard(true);
  assert.equal(partial.dataStatus.source, 'Cached Historical Data');
  assert.deepEqual(partial.fixtures, fresh.fixtures);
  assert.match(partial.refreshError, /incomplete/);
  state.fixturesPartial = false;
  state.rosterPartial = true;
  assert.equal((await client.getDashboard(true)).dataStatus.source, 'Cached Historical Data');
  assert.deepEqual(await store().read(), saved);

  state.offline = true;
  const restarted = await upstream.client(store()).getDashboard(true);
  assert.deepEqual(restarted.dataStatus, { ...fresh.dataStatus, source: 'Cached Historical Data' });
  assert.deepEqual(state.calls.slice(-2), ['/api/bootstrap-static/', '/api/fixtures/']);
  assert.deepEqual(restarted.events, fresh.events);
  assert.deepEqual(await store().read(), saved);
});

test('recovers the newest valid Gameweek archive if the latest snapshot is unreadable', async t => {
  const { directory, store } = await cache(t);
  const upstream = feed();
  const client = upstream.client(store());
  await client.getDashboard(true);
  upstream.state.finalWeek = 2;
  upstream.state.now += day;
  const newest = await client.getDashboard(true);
  assert.deepEqual((await store().readHistory(2026)).map(snapshot => snapshot.gameweek).sort(), [2, 3]);
  await writeFile(join(directory, 'season.json'), '{');
  upstream.state.offline = true;
  const recovered = await upstream.client(store()).getDashboard(true);
  assert.deepEqual(recovered.dataStatus, { ...newest.dataStatus, source: 'Cached Historical Data' });
  assert.deepEqual(recovered.events, newest.events);
});

test('waits for official checks and every final fixture before reporting completion after a rollover', async t => {
  const { store } = await cache(t);
  const upstream = feed();
  const client = upstream.client(store());
  const { state } = upstream;
  state.now = deadline(3) + day;
  state.currentWeek = 3;
  state.finishedWeek = 2;

  const pending = await client.getDashboard(true);
  assert.equal(pending.dataStatus.gameweek, 3);
  assert.deepEqual(pending.events.filter(isGameweekComplete).map(event => event.id), [1]);
  assert.equal((await client.getLive(2)).confirmedFinal, false);

  state.finalWeek = 2;
  state.unfinishedFixture = 20;
  const inconsistent = await client.getDashboard(true);
  assert.match(inconsistent.refreshError, /inconsistent/);
  assert.deepEqual(inconsistent.events, pending.events);

  state.unfinishedFixture = undefined;
  const confirmed = await client.getDashboard(true);
  assert.deepEqual(confirmed.events.filter(isGameweekComplete).map(event => event.id), [1, 2]);
  assert.equal((await client.getLive(2)).confirmedFinal, true);

  state.offline = true;
  const recovered = await upstream.client(store()).getDashboard(true);
  assert.deepEqual(recovered.events, confirmed.events);
});

test('recovers validated Gameweek scoring and player history during an outage after restart', async t => {
  const { store } = await cache(t);
  const upstream = feed();
  const client = upstream.client(store());
  await client.getDashboard(true);
  const history = { read: async () => [], update: async () => {} };
  const online = predictionService(client, { history, now: upstream.clock });
  const onlineRefresh = await online.refresh(3);
  const onlineRanking = await online.analyse(3, 'ranking', onlineRefresh.token);
  const prior = await client.getLive(1, true, undefined, true);
  const detail = await client.getPlayer(1);
  await client.getDashboard(true);
  upstream.state.livePartial = true;
  upstream.state.playerPartial = true;
  assert.equal((await client.getLive(1, true)).sources[0].origin, 'Cached Historical Data');
  assert.equal((await client.getPlayer(1)).sources[0].origin, 'Cached Historical Data');

  upstream.state.offline = true;
  const restarted = upstream.client(store());
  const service = predictionService(restarted, { history, now: upstream.clock });
  const refresh = await service.refresh(3);
  assert.equal(refresh.dashboard.dataStatus.source, 'Cached Historical Data');
  assert.equal(refresh.previousSource, 'Cached Historical Data');
  assert.deepEqual((await restarted.getLive(1, true, undefined, true)).players, prior.players);
  assert.deepEqual((await restarted.getPlayer(1)).history, detail.history);
  const forecast = await service.analyse(3, 'previous', refresh.token);
  assert.equal(forecast.previousWeek, 1);
  assert.equal(forecast.players.length, 15);
  assert.ok(forecast.players.every(player => Number.isFinite(player.predicted) && player.previousActualPoints === null));
  const ranking = await service.analyse(3, 'ranking', refresh.token);
  assert.deepEqual(ranking.players, onlineRanking.players);
  assert.ok(ranking.sources.some(source => source.url.includes('/element-summary/') && source.origin === 'Cached Historical Data'));
});

test('keeps provisional scores out of saved actuals and enforces deadlines during an outage', async t => {
  const { store } = await cache(t);
  const upstream = feed();
  const live = upstream.client(store());
  await live.getDashboard(true);
  assert.equal((await live.getLive(2, true)).confirmedFinal, false);
  await live.getLive(1, true);

  const reports = [
    { strategy: 'news', seasonYear: 2026, gameweek: 2, recommendations: [{ playerId: 1 }] },
    { strategy: 'season-index', seasonYear: 2026, gameweek: 2, squad: [{ required: 15, players: [{ id: 2, performanceScore: 3 }] }] },
    { strategy: 'special-rules', seasonYear: 2026, gameweek: 2, weeks: [1], players: [{ id: 3 }] }
  ];
  let records = [{ gameweek: 2, seasonYear: 2026, players: [{ id: 1, predicted: 3 }], sources: [], accuracy: null }, ...reports];
  const history = { read: async () => records, update: async transform => { records = transform(records); } };
  const service = predictionService(upstream.client(store()), { history, now: upstream.clock });
  const { state } = upstream;
  state.offline = true;
  const cached = await service.refresh(3);
  assert.equal(cached.previousWeek, 1);
  assert.equal(cached.dashboard.events[1].finished, false);
  assert.equal(cached.dashboard.events[1].data_checked, false);
  assert.equal(records[0].accuracy, null);

  state.offline = false;
  state.finalWeek = 2;
  state.liveFailure = 2;
  const provisionalOnly = await service.refresh(3);
  assert.equal(provisionalOnly.previousWeek, null);
  assert.equal(records[0].accuracy, null);
  assert.match(provisionalOnly.previousError, /Gameweek 2 scoring is unavailable/);
  assert.equal((await service.analyse(3, 'ranking', provisionalOnly.token)).players.length, 15);

  state.liveFailure = null;
  const final = await service.refresh(3);
  assert.equal(final.previousWeek, 2);
  assert.equal(records.find(record => record.gameweek === 2).accuracy.actual[0].points, 4);
  assert.deepEqual((await service.history()).slice(-reports.length), reports);

  state.offline = true;
  state.now = deadline(3) + 1;
  const recovery = await service.refresh(3);
  assert.equal(recovery.week.finished, false);
  await assert.rejects(service.analyse(3, 'ranking', recovery.token), { status: 409, message: /deadline has passed/ });
  const beforePreview = records.length;
  const preview = await service.preview(3, 'ranking', recovery.token);
  assert.equal(preview.preview.fixtureCount, 10);
  assert.equal(preview.players.length, 15);
  assert.equal(records.length, beforePreview);
});

test('warns when there is no validated data to recover', async t => {
  const { store } = await cache(t);
  const upstream = feed();
  upstream.state.offline = true;
  const client = upstream.client(store());
  const service = predictionService(client, { history: { read: async () => [] }, now: upstream.clock });
  const handle = createApiHandler(client, service);
  const startup = await handle('GET', new URL('http://localhost/api/dashboard'));
  assert.equal(startup.status, 502);
  assert.deepEqual(upstream.state.calls, ['/api/bootstrap-static/', '/api/fixtures/']);
  const result = await handle('POST', new URL('http://localhost/api/prediction-data?gameweek=3'));
  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /No validated cached data is available/);
  await assert.rejects(service.analyse(3, 'ranking', null), { status: 409 });
  assert.deepEqual(await store().readHistory(2026), []);
});
