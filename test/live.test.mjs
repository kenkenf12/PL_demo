import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { captainOptions, makeModel, transferOptions } from '../public/model.mjs';
import { predictionService } from '../lib/predictions.mjs';
import { rankNews } from '../lib/news-ranking.mjs';
import { predictSquad } from '../lib/squad-prediction.mjs';

let child;
let base;
let season;
let historyDir;
const testEntry = process.env.FPL_TEST_ENTRY_ID;

async function request(path, expectedStatus = 200, method = 'GET') {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, expectedStatus, `Unexpected HTTP status for ${path}`);
  return response;
}

function assertSource(source, path) {
  assert.equal(source.url, `https://fantasy.premierleague.com${path}`);
  assert.ok(Number.isFinite(Date.parse(source.retrievedAt)));
  assert.ok(source.lastModified === null || Number.isFinite(Date.parse(source.lastModified)));
}

before(async () => {
  historyDir = await mkdtemp(join(tmpdir(), 'fpl-test-history-'));
  child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, FPL_PORT: '0', FPL_HISTORY_DIR: historyDir },
    stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(10_000) });
    base = line.replace('FPL Assistant: ', '').replace(/\/$/, '');
  } finally {
    lines.close();
  }
  season = await (await request('/api/dashboard?refresh=1')).json();
});

after(async () => {
  child?.kill();
  if (historyDir) {
    await unlink(join(historyDir, 'predictions.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(historyDir);
  }
});

test('serves the dashboard and freshly retrieves a consistent current-season snapshot', async () => {
  const page = await (await request('/')).text();
  assert.match(page, /Personal FPL Assistant/);
  assert.doesNotMatch(page, /Weather Impact Prediction/);
  assert.doesNotMatch(page, /UK Betting Odds|value="odds"/);
  await request('/app.mjs');
  const now = new Date();
  assert.equal(season.seasonYear, now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0));
  assert.equal(season.stale, false);
  assert.equal(season.teams.length, 20);
  assert.equal(season.events.length, 38);
  assert.equal(season.fixtures.length, 380);
  assert.ok(season.players.length > 0);
  assert.ok(Number.isInteger(season.scoring?.long_play));
  assert.ok(season.players.every(player => Number.isInteger(player.now_cost) && Number.isInteger(player.minutes)
    && Number.isInteger(player.total_points) && season.teams.some(team => team.id === player.team)));
  assertSource(season.sources[0], '/api/bootstrap-static/');
  assertSource(season.sources[1], '/api/fixtures/');
  assert.ok(season.sources.every(source => Math.abs(Date.now() - Date.parse(source.retrievedAt)) < 60_000));
});

test('retrieves real player history and official Gameweek scoring', async () => {
  const player = season.players.reduce((a, b) => a.minutes >= b.minutes ? a : b);
  const detail = await (await request(`/api/players/${player.id}`)).json();
  assertSource(detail.sources[0], `/api/element-summary/${player.id}/`);
  if (player.minutes > 0) assert.ok(detail.history.some(match => match.minutes > 0));
  assert.ok(Array.isArray(detail.fixtures));
  const event = season.events.find(week => week.is_current);
  if (!event) return;
  const live = await (await request(`/api/gameweeks/${event.id}/live`)).json();
  assertSource(live.sources[0], `/api/event/${event.id}/live/`);
  assert.equal(live.event, event.id);
  assert.ok(live.players.some(record => record.id === player.id && Number.isInteger(record.total_points)));
});

test('ranks genuine players, using the next Gameweek for captaincy', () => {
  const model = makeModel(season, 4);
  assert.equal(model.players.length, season.players.length);
  assert.ok(model.weeks.every(week => Date.parse(week.deadline_time) > Date.now()));
  assert.ok(model.players.every(player => player.projected == null || Number.isFinite(player.projected) && player.projected >= 0));
  if (!model.weeks.length || !season.events.some(event => event.finished)) return;
  assert.ok(model.players[0].projected > 0);
  const captains = captainOptions(model.players);
  if (captains.length) {
    assert.ok(captains[0].schedule.some(fixture => fixture.event === model.weeks[0].id));
    assert.ok(captains.every(player => captains[0].next >= player.next));
  }
});

test('loads a public entry and checks transfer constraints against real players', { skip: !testEntry }, async () => {
  const entry = await (await request(`/api/entries/${testEntry}`)).json();
  assertSource(entry.sources[0], `/api/entry/${testEntry}/`);
  assert.equal(entry.entry.id, Number(testEntry));
  if (!entry.event) return;
  assert.equal(entry.picks.length, 15);
  assertSource(entry.sources[1], `/api/entry/${testEntry}/event/${entry.event}/picks/`);
  const model = makeModel(season, 4);
  const squad = entry.picks.map(pick => model.byId.get(pick.element));
  assert.ok(squad.every(Boolean));
  if (!model.weeks.length) return;

  let upgrades = 0;
  for (const outgoing of squad) {
    const simulatedFunds = outgoing.now_cost + entry.bank;
    const options = transferOptions(model.players, squad, outgoing, simulatedFunds);
    upgrades += options.length;
    assert.ok(options.every(({ player, gain, remaining }) =>
      !squad.some(owned => owned.id === player.id) && player.element_type === outgoing.element_type
      && squad.filter(owned => owned.id !== outgoing.id && owned.team === player.team).length < 3
      && gain > 0 && remaining === simulatedFunds - player.now_cost && remaining >= 0));
  }
  assert.ok(upgrades > 0, 'The selected test entry should have an affordable eligible upgrade.');
});

test('rejects invalid local API IDs', async () => {
  await request('/api/entries/0', 400);
  await request('/api/players/999999999', 404);
  await request('/api/gameweeks/999/live', 404);
});

function assertSquad(record) {
  assert.equal(record.players.length, 15);
  const ids = new Set(record.players.map(player => player.id));
  assert.equal(ids.size, 15);
  assert.notEqual(record.captain, record.viceCaptain);
  assert.ok(ids.has(record.captain) && ids.has(record.viceCaptain));
  assert.deepEqual([1, 2, 3, 4].map(id => record.players.filter(player => player.positionId === id).length), [2, 5, 5, 3]);
  assert.ok(record.players.every(player => record.players.filter(member => member.teamId === player.teamId).length <= 3));
  assert.equal(record.cost, record.players.reduce((sum, player) => sum + player.cost, 0));
  assert.ok(record.cost <= 1000);
  const comparable = record.players.filter(player => player.predicted !== null);
  assert.equal(record.projectedCount, comparable.length);
  assert.equal(record.total, comparable.length ? comparable.reduce((sum, player) => sum + player.predicted, 0) : null);
}

test('requires a manual Gameweek refresh and runs only the selected prediction strategy', async t => {
  const target = season.events.find(event => !event.finished && Date.parse(event.deadline_time) > Date.now());
  if (!target) return t.skip('The season has no upcoming Gameweek.');
  const endpoint = `/api/predictions?gameweek=${target.id}`;
  await request(`${endpoint}&strategy=ranking`, 409, 'POST');
  const refresh = await (await request(`/api/prediction-data?gameweek=${target.id}`, 200, 'POST')).json();
  assert.equal(refresh.week.id, target.id);
  assert.equal(refresh.dashboard.stale, false);
  const scope = `${endpoint}&token=${refresh.token}`;
  await request(`${scope}&strategy=all`, 400, 'POST');
  await request(`${scope}&strategy=weather`, 400, 'POST');

  const selected = refresh.previousWeek ? ['ranking', 'previous', 'recent'] : ['ranking', 'recent'];
  const fixtures = refresh.dashboard.fixtures.filter(fixture => fixture.event === target.id && !fixture.started && !fixture.finished);
  const previous = refresh.previousWeek ? await (await request(`/api/gameweeks/${refresh.previousWeek}/live`)).json() : null;
  const exactPrevious = previous?.event === target.id - 1 ? previous : null;
  const previousTotals = new Map(exactPrevious?.players.map(player => [player.id, player.total_points]));
  const results = [];
  let previousSource;
  for (const strategy of selected) {
    const record = await (await request(`${scope}&strategy=${strategy}`, 201, 'POST')).json();
    assert.equal(record.strategy, strategy);
    assert.equal(record.gameweek, target.id);
    assert.equal(record.weather, undefined);
    assert.equal(record.previousActualWeek, exactPrevious?.event ?? null);
    for (const player of record.players) assert.equal(player.previousActualPoints, previousTotals.get(player.id) ?? null);
    assert.ok(record.players.every(player => player.predictedFplRuleBasedPoints === null
      || Number.isInteger(player.predictedFplRuleBasedPoints)));
    assert.ok(record.players.every(player => !Object.hasOwn(player, 'fplRuleBasedHistoricalBenchmark')));
    assert.ok(record.players.every(player => !Object.hasOwn(player, 'fplRuleBasedPredictedPoints')));
    if (strategy === 'ranking' || strategy === 'previous') {
      const original = predictSquad(refresh.dashboard, fixtures, strategy, strategy === 'previous' ? previous : null, null);
      assert.deepEqual(record.players.map(({ predictedFplRuleBasedPoints, previousActualPoints, ...player }) => player), original.players);
      for (const key of ['total', 'captain', 'viceCaptain', 'cost', 'projectedCount']) assert.equal(record[key], original[key]);
      if (fixtures.length && record.players.some(player => refresh.dashboard.players.find(stats => stats.id === player.id)?.minutes > 0)) {
        assert.ok(record.players.some(player => Number.isFinite(player.predictedFplRuleBasedPoints)));
      }
      if (exactPrevious) {
        assert.ok(record.sources.some(source => source.url.endsWith(`/event/${refresh.previousWeek}/live/`)));
      }
    }
    if (!record.shortlist) assertSquad(record);
    else {
      assert.equal(strategy, 'recent');
      assert.ok(record.players.length <= 15);
      assert.equal(record.captain, null);
      assert.equal(record.viceCaptain, null);
      assert.equal(Boolean(record.id), record.players.length > 0);
    }
    assert.equal(record.accuracy, null);
    if (strategy === 'previous') {
      previousSource = record.sources[2];
      assertSource(previousSource, `/api/event/${refresh.previousWeek}/live/`);
    }
    else assert.equal(record.previousWeek, null);
    if (strategy === 'recent') {
      assert.ok(record.recentForm.domesticWeeks.length <= 3);
      assert.ok(record.players.every(player => Number.isInteger(player.evidence.domesticWeeks)
        && player.evidence.internationalMatches + player.evidence.cupMatches + player.evidence.europeanMatches > 0));
      if (previousSource) assert.deepEqual(record.sources.find(source => source.url === previousSource.url), previousSource);
      if (record.recentForm.internationalReports) {
        assert.ok(record.sources.some(source => source.url.startsWith('https://site.api.espn.com/') && source.url.includes('/summary?event=')));
      }
      t.diagnostic(`Recent form selected ${record.players.length} players with verified non-EPL appearances. Matched reports: ${record.recentForm.internationalReports} international, ${record.recentForm.cupReports} domestic cup, ${record.recentForm.europeanReports} UEFA club.`);
      const repeat = await (await request(`${scope}&strategy=recent`, 201, 'POST')).json();
      assert.deepEqual(repeat.sources, record.sources);
      assert.deepEqual(repeat.players, record.players);
      if (repeat.id) results.push(repeat.id);
    } else {
      assert.equal(record.recentForm, undefined);
      assert.ok(record.players.every(player => player.evidence === undefined));
    }
    if (record.id) results.push(record.id);
  }
  const history = await (await request('/api/predictions')).json();
  assert.ok(results.every(id => history.some(record => record.id === id)));
  const news = await (await request(`${scope}&strategy=news`, 201, 'POST')).json();
  assert.equal(news.strategy, 'news');
  assert.equal(news.gameweek, target.id);
  assert.equal(news.players, undefined);
  assert.equal(Date.parse(news.searchedAt) - Date.parse(news.since), 7 * 86_400_000);
  for (const recommendation of news.recommendations) {
    assert.ok(season.players.some(player => player.id === recommendation.playerId));
    assert.equal(recommendation.count, new Set(recommendation.sources.map(source => source.publisher)).size);
    assert.ok(recommendation.sources.every(source => Date.parse(source.publishedAt) >= Date.parse(news.since)
      && Date.parse(source.publishedAt) <= Date.parse(news.searchedAt) && source.url.startsWith('https://')));
  }
  assert.deepEqual(await (await request('/api/predictions')).json(), history);
  await request(`${scope}&strategy=odds`, 400, 'POST');
  assert.deepEqual(await (await request('/api/predictions')).json(), history);
  const winners = await (await request(`${scope}&strategy=match-winners`, 201, 'POST')).json();
  assert.equal(winners.strategy, 'match-winners');
  assert.equal(winners.gameweek, target.id);
  assert.deepEqual(winners.matches.map(match => match.id), fixtures.map(fixture => fixture.id));
  for (const match of winners.matches) {
    if (!match.score) {
      assert.ok(match.reason);
      continue;
    }
    const { home, draw, away } = match.probabilities;
    assert.ok(Math.abs(home + draw + away - 1) < 1e-12);
    if (match.score.home === match.score.away) {
      assert.equal(match.winner, null);
      assert.deepEqual(match.picks, []);
    } else {
      assert.equal(match.winner.id, match.score.home > match.score.away ? match.home.id : match.away.id);
      assert.equal(match.picks.length + match.missingPositions.length, 4);
      assert.equal(new Set(match.picks.map(player => player.positionCode)).size, match.picks.length);
      assert.ok(match.picks.every(player => player.teamId === match.winner.id && Number.isInteger(player.predicted)));
    }
  }
  assert.ok(winners.players.length <= 15 && winners.players.every(player => Number.isInteger(player.predicted)));
  assert.equal(winners.captain, winners.players[0]?.id ?? null);
  assert.equal(winners.viceCaptain, winners.players[1]?.id ?? null);
  if (winners.id) {
    const saved = await (await request('/api/predictions')).json();
    assert.deepEqual(saved.find(record => record.id === winners.id), winners);
  }
  t.diagnostic(`News coverage: ${news.coverage.publishers} publishers, ${news.coverage.articles} recent articles, ${news.recommendations.length} recommended players`);
  const past = season.events.find(event => event.finished && event.data_checked);
  if (past) {
    const closed = await (await request(`/api/prediction-data?gameweek=${past.id}`, 200, 'POST')).json();
    await request(`${scope}&strategy=ranking`, 409, 'POST');
    await request(`/api/predictions?gameweek=${past.id}&strategy=ranking&token=${closed.token}`, 409, 'POST');
  }
  if (target.id < 38) {
    const future = await (await request(`/api/prediction-data?gameweek=${target.id + 1}`, 200, 'POST')).json();
    assert.equal(future.previousWeek, refresh.previousWeek);
    const record = await (await request(`/api/predictions?gameweek=${future.week.id}&strategy=ranking&token=${future.token}`, 201, 'POST')).json();
    assert.equal(record.previousActualWeek, null);
    assert.ok(record.players.every(player => player.previousActualPoints === null));
  }
});

test('ranks independent positive news without counting repeated, stale or misattributed coverage', () => {
  const [target, other, uncovered] = season.players.filter(player => player.first_name && player.second_name
    && player.first_name !== player.second_name).slice(0, 3);
  const fullName = player => `${player.first_name} ${player.second_name}`;
  const name = fullName(target);
  const otherName = fullName(other);
  const now = Date.now();
  const week = 7 * 86_400_000;
  const makeArticle = (publisher, text, author, published = now - 10_000) => ({
    publisher, publisherName: publisher, url: `https://${publisher}.example/football`, title: 'Match analysis', description: '',
    sections: [{ text }], authors: [author], published, retrievedAt: new Date(now).toISOString()
  });
  const shared = `${name} is in excellent form and has consistently created chances for teammates.`;
  const stories = [
    makeArticle('paper-a', shared, 'Writer One'),
    makeArticle('paper-a', `${name} was outstanding at the weekend.`, 'Writer Two', now - 11_000),
    makeArticle('syndicate', shared, 'Different Byline', now - 20_000),
    makeArticle('guest-column', `${name} made an impressive return to action.`, 'Writer One', now - 25_000),
    makeArticle('pundit', `${name} is a strong captaincy pick.`, 'Writer Three'),
    makeArticle('archive', `${otherName} is a must-have.`, 'Writer Four', now - week - 1),
    makeArticle('future', `${otherName} was outstanding.`, 'Writer Five', now + 1),
    makeArticle('negative', `${otherName} is not an outstanding option.`, 'Writer Six'),
    makeArticle('quote', `${otherName} said the manager is brilliant.`, 'Writer Seven')
  ];
  const result = rankNews(stories, [target, other, uncovered], now - week, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].playerId, target.id);
  assert.equal(result[0].count, 2);
  assert.equal(result[0].sentiment, 'Strong positive');
  assert.deepEqual(result[0].sources.map(source => source.publisher), ['pundit', 'paper-a']);
});

test('replays an official completed Gameweek to verify accuracy and independent strategy execution', async t => {
  const finished = season.events.filter(event => event.finished && event.data_checked);
  const finalByWeek = new Map(finished.map(event => [event.id, event]));
  const week = finished.findLast(event => finalByWeek.has(event.id - 1));
  if (!week) return t.skip('The test needs two consecutive completed Gameweeks.');
  const prior = finalByWeek.get(week.id - 1);
  const events = season.events.map(event => event.id === week.id ? { ...event, finished: false, data_checked: false } : event);
  const fixtures = season.fixtures.map(fixture => fixture.event === week.id
    ? { ...fixture, started: false, finished: false, finished_provisional: false } : fixture);
  const points = new Map(await Promise.all([week, prior].map(async event => [event.id,
    await (await request(`/api/gameweeks/${event.id}/live`)).json()])));
  const tracked = [];
  let clock = Date.parse(week.deadline_time) - 1;
  let snapshot = { ...season, events, fixtures };
  let liveCalls = 0;
  let refreshCalls = 0;
  let formCalls = 0;
  const service = predictionService({
    getDashboard: async () => { refreshCalls += 1; return snapshot; },
    getPlayer: async id => (await request(`/api/players/${id}`)).json(),
    getLive: async id => { liveCalls += 1; return points.get(id); }
  }, {
    now: () => clock,
    history: { read: async () => tracked, update: async transform => tracked.splice(0, tracked.length, ...transform(tracked)) },
    form: async () => { formCalls += 1; throw new Error('Recent form must only run for its own strategy'); }
  });
  const input = await service.refresh(week.id);
  assert.equal(input.previousWeek, prior.id);
  const ranking = await service.analyse(week.id, 'ranking', input.token);
  await service.analyse(week.id, 'previous', input.token);
  await assert.rejects(service.analyse(week.id, 'weather', input.token), { status: 400 });
  assert.equal(formCalls, 0);
  assert.equal(liveCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.ok((await service.history()).every(record => record.accuracy === null));

  snapshot = { ...snapshot, stale: true, refreshError: 'Connection failed' };
  const recovered = await service.refresh(week.id);
  assert.equal(recovered.dashboard.refreshError, 'Connection failed');
  assert.equal(recovered.week.finished, false);
  assertSquad(await service.analyse(week.id, 'ranking', recovered.token));

  snapshot = season;
  clock = Date.parse(week.deadline_time) + 10 * 86_400_000;
  const { previousActualWeek, ...legacy } = ranking;
  const legacyPlayers = legacy.players.map(({ previousActualPoints, ...player }) => player);
  tracked[tracked.findIndex(record => record.id === ranking.id)] = { ...legacy, players: legacyPlayers };
  await service.refresh(week.id);
  const scored = (await service.history()).find(record => record.id === ranking.id);
  const previousTotals = new Map(points.get(prior.id).players.map(record => [record.id, record.total_points]));
  assert.equal(scored.previousActualWeek, prior.id);
  assert.equal(previousActualWeek, prior.id);
  assert.deepEqual(scored.players, ranking.players);
  assert.ok(scored.players.every(player => player.previousActualPoints === (previousTotals.get(player.id) ?? null)));
  const results = new Map(points.get(week.id).players.map(record => [record.id, record.total_points]));
  assert.equal(scored.accuracy.actualCount, 15);
  assert.equal(scored.accuracy.actualTotal, scored.players.reduce((sum, player) => sum + results.get(player.id), 0));
  const comparable = scored.players.filter(player => player.predicted !== null);
  assert.equal(scored.accuracy.meanAbsoluteError, comparable.reduce((sum, player) => sum + Math.abs(player.predicted - results.get(player.id)), 0) / comparable.length);
  assertSource(scored.accuracy.sources[0], `/api/event/${week.id}/live/`);
});
