import assert from 'node:assert/strict';
import { test } from 'node:test';
import { predictionService } from '../lib/predictions.mjs';

const gameweek = 8;
const now = Date.parse('2026-10-10T09:00:00Z');
const teams = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `Club ${index + 1}` }));
const positionIds = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
const players = positionIds.map((element_type, index) => ({
  id: 100 + index * 7, web_name: `Player ${index + 1}`, team: Math.floor(index / 3) + 1, element_type,
  status: 'a', now_cost: 50, minutes: 90, starts: 1, form: '3', total_points: 10 + index,
  expected_goals: '1', expected_assists: '0.5', clean_sheets: 1
}));
const match = { minutes: 90, clean_sheets: 1, saves: 0, goals_conceded: 0, defensive_contribution: 0, yellow_cards: 0, red_cards: 0 };
const priorPlayers = players.map((player, index) => ({
  id: player.id, minutes: 90, starts: 1, expected_goals: '0.25', expected_assists: '0.25',
  expected_goal_involvements: '0.5', clean_sheets: 0, total_points: index, scoringMatches: [{ ...match, clean_sheets: 0 }]
})).reverse();
const prior = { event: gameweek - 1, players: priorPlayers, sources: [{ url: 'https://fpl.example/gameweek/7' }] };
const events = [
  { id: gameweek - 1, finished: true, data_checked: true },
  { id: gameweek, deadline_time: new Date(now + 60_000).toISOString() },
  { id: gameweek + 1, deadline_time: new Date(now + 86_400_000).toISOString() }
];
const form = async () => ({
  performances: Object.fromEntries(players.map(player => [player.id, {
    points: 5, minutes: 90, matchWeight: 1, domesticWeeks: 1, cupMatches: 1
  }])),
  ruleBased: Object.fromEntries(players.map(player => [player.id, {
    goals_scored: { total: 2, weight: 1 }, assists: { total: 1, weight: 1 }, clean_sheets: { total: 1, weight: 1 },
    long_play: { total: 1, weight: 1 }, short_play: { total: 0, weight: 1 }, saves: { total: 0, weight: 1 },
    goals_conceded: { total: 0, weight: 1 }, defensive_contribution: { total: 0, weight: 1 }, yellow_cards: { total: 0, weight: 1 }
  }])),
  usesMatchScoringRules: true,
  summary: { domesticWeeks: [7], requestedWeeks: 1, europeanReports: 0, days: 1, expectedDays: 1, reports: 1, requested: 1 },
  sources: []
});

function serviceFor(difficulty, report = prior, saved = []) {
  const fixtures = events.flatMap(({ id, finished }) => [1, 3, 5].map(team => ({
    id: id * 10 + team, event: id, finished, team_h: team, team_a: team + 1,
    team_h_difficulty: id === gameweek ? difficulty : 3, team_a_difficulty: id === gameweek ? difficulty : 3
  })));
  const dashboard = { seasonYear: 2026, fixtures, events, teams, players, sources: [],
    scoring: { long_play: 2, short_play: 1, goals_scored: 5, assists: 3, clean_sheets: 2,
      saves: 1, goals_conceded: -1, defensive_contribution: 2, yellow_cards: -1 },
    positions: [...new Set(positionIds)].map(id => ({ id, singular_name: `Position ${id}`, singular_name_short: String(id) })) };
  return predictionService({
    getDashboard: async () => dashboard,
    getPlayer: async id => {
      const club = players.find(player => player.id === id).team;
      return { history: [{ ...match, fixture: (gameweek - 1) * 10 + (club % 2 ? club : club - 1) }], sources: [] };
    },
    getLive: async id => {
      assert.equal(id, gameweek - 1);
      return report;
    }
  }, { now: () => now, form, history: { read: async () => saved, update: async transform => {
    saved = transform(saved);
  } } });
}

test('the original and rule-based forecasts respond to selected fixtures while actuals stay fixed', async () => {
  const easy = serviceFor(1);
  const hard = serviceFor(5);
  const [easyRefresh, hardRefresh] = await Promise.all([easy.refresh(gameweek), hard.refresh(gameweek)]);
  const totals = new Map(priorPlayers.map(({ id, total_points }) => [id, total_points]));
  for (const strategy of ['ranking', 'previous', 'recent']) {
    const before = await easy.analyse(gameweek, strategy, easyRefresh.token);
    const after = await hard.analyse(gameweek, strategy, hardRefresh.token);
    assert.equal(after.gameweek, gameweek);
    assert.equal(after.previousActualWeek, gameweek - 1);
    assert.equal(after.players.length, 15);
    const beforeById = new Map(before.players.map(player => [player.id, player]));
    for (const player of after.players) {
      const expectedActual = totals.get(player.id);
      assert.equal(player.previousActualPoints, expectedActual);
      const original = beforeById.get(player.id);
      assert.ok(Math.abs(player.predicted - original.predicted * 0.76 / 1.2) < 1e-9);
      assert.ok(player.predictedFplRuleBasedPoints <= original.predictedFplRuleBasedPoints);
      assert.ok(Number.isInteger(player.predictedFplRuleBasedPoints));
    }
    assert.ok(after.players.some(player => player.predictedFplRuleBasedPoints < beforeById.get(player.id).predictedFplRuleBasedPoints));
  }
  await assert.rejects(easy.analyse(gameweek + 1, 'ranking', easyRefresh.token), { status: 409 });
});

test('rule-based points use the selected strategy independently of historical totals', async () => {
  const original = serviceFor(3);
  const revised = serviceFor(3, { ...prior, players: priorPlayers.map(player => ({ ...player, total_points: 99 })) });
  const first = await original.refresh(gameweek);
  const second = await revised.refresh(gameweek);
  const targets = new Set(players.map(player => player.id));
  const byPlayer = new Map(players.map(player => [player.id, []]));
  for (const strategy of ['ranking', 'previous', 'recent']) {
    const a = await original.analyse(gameweek, strategy, first.token);
    const b = await revised.analyse(gameweek, strategy, second.token);
    const points = report => new Map(report.players.map(player => [player.id, player.predictedFplRuleBasedPoints]));
    assert.deepEqual(points(a), points(b));
    assert.deepEqual(new Set(points(a).keys()), targets);
    for (const [id, forecast] of points(a)) {
      assert.ok(Number.isInteger(forecast));
      byPlayer.get(id).push(forecast);
    }
    assert.ok(b.players.every(player => player.previousActualPoints === 99));
  }
  assert.ok([...byPlayer.values()].every(forecasts => new Set(forecasts).size === 3));
});

test('ranking forecasts stay independent from prior totals and reject reports for a different Gameweek', async () => {
  const original = serviceFor(3);
  const revised = serviceFor(3, { ...prior, players: priorPlayers.map(player => ({ ...player, total_points: 99 })) });
  const mismatch = serviceFor(3, { ...prior, event: gameweek - 2 });
  const results = await Promise.all([original, revised, mismatch].map(async service => {
    const ready = await service.refresh(gameweek);
    return { ready, forecast: await service.analyse(gameweek, 'ranking', ready.token) };
  }));
  const [before, after, wrongWeek] = results;
  const forecasts = report => report.players.map(player => [player.id, player.predicted, player.predictedFplRuleBasedPoints]);
  assert.deepEqual(forecasts(before.forecast), forecasts(after.forecast));
  assert.ok(after.forecast.players.every(player => player.previousActualPoints === 99));
  assert.equal(wrongWeek.ready.previousWeek, null);
  assert.ok(wrongWeek.forecast.players.every(player => player.previousActualPoints === null
    && Number.isInteger(player.predictedFplRuleBasedPoints)));
  assert.deepEqual(forecasts(before.forecast), forecasts(wrongWeek.forecast));
  await assert.rejects(mismatch.analyse(gameweek, 'previous', wrongWeek.ready.token), { status: 409 });
});

test('history displays whole rule-based points without changing the stored forecasts', async () => {
  const player = { id: 103, predicted: 4.6, previousActualPoints: 7, fplRuleBasedPredictedPoints: 7 };
  const saved = [{ id: 'saved', gameweek, players: [player] },
    { id: 'benchmark', gameweek, players: [{ id: 103, predicted: 4.6, previousActualPoints: 7, fplRuleBasedHistoricalBenchmark: 7 }] },
    { id: 'forecast', gameweek, players: [{ id: 103, predicted: 4.6, previousActualPoints: 7, predictedFplRuleBasedPoints: 4.5 }] }];
  const [record, benchmark, current] = await serviceFor(3, prior, saved).history();
  assert.deepEqual(record.players, [{ id: 103, predicted: 4.6, previousActualPoints: 7 }]);
  assert.deepEqual(benchmark.players, record.players);
  assert.equal(current.players[0].predictedFplRuleBasedPoints, 5);
  assert.equal(current.players[0].predicted, 4.6);
  assert.equal(saved[2].players[0].predictedFplRuleBasedPoints, 4.5);
  assert.equal(saved[0].players[0].fplRuleBasedPredictedPoints, 7);
});
