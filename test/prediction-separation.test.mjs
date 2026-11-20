import assert from 'node:assert/strict';
import { test } from 'node:test';
import { predictionService } from '../lib/predictions.mjs';

const gameweek = 8;
const now = Date.parse('2026-10-10T09:00:00Z');
const teams = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `Club ${index + 1}` }));
const positionIds = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
const players = positionIds.map((element_type, index) => ({
  id: 100 + index * 7, web_name: `Player ${index + 1}`, team: Math.floor(index / 3) + 1, element_type,
  status: 'a', now_cost: 50, minutes: 90, form: '3', total_points: 10 + index
}));
const priorPlayers = players.map((player, index) => ({
  id: player.id, minutes: 90, expected_goal_involvements: '1', total_points: index, fplRuleBasedMatchAverage: index
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
  summary: { domesticWeeks: [7], requestedWeeks: 1, europeanReports: 0, days: 1, expectedDays: 1, reports: 1, requested: 1 },
  sources: []
});

function serviceFor(difficulty, report = prior, saved = []) {
  const fixtures = events.flatMap(({ id, finished }) => [1, 3, 5].map(team => ({
    id: id * 10 + team, event: id, finished, team_h: team, team_a: team + 1,
    team_h_difficulty: id === gameweek ? difficulty : 3, team_a_difficulty: id === gameweek ? difficulty : 3
  })));
  const dashboard = { seasonYear: 2026, fixtures, events, teams, players, sources: [],
    positions: [...new Set(positionIds)].map(id => ({ id, singular_name: `Position ${id}` })) };
  return predictionService({
    getDashboard: async () => dashboard,
    getLive: async id => {
      assert.equal(id, gameweek - 1);
      return report;
    }
  }, { now: () => now, form, history: { read: async () => saved, update: async transform => {
    saved = transform(saved);
  } } });
}

test('all three forecasts respond to selected fixtures while actuals and the benchmark stay fixed', async () => {
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
      assert.equal(player.fplRuleBasedHistoricalBenchmark, expectedActual);
      assert.ok(Math.abs(player.predicted - beforeById.get(player.id).predicted * 0.76 / 1.2) < 1e-9);
      assert.ok(player.predicted < beforeById.get(player.id).predicted);
    }
  }
  await assert.rejects(easy.analyse(gameweek + 1, 'ranking', easyRefresh.token), { status: 409 });
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
  const forecasts = report => report.players.map(player => [player.id, player.predicted]);
  assert.deepEqual(forecasts(before.forecast), forecasts(after.forecast));
  assert.ok(after.forecast.players.every(player => player.previousActualPoints === 99));
  assert.equal(wrongWeek.ready.previousWeek, null);
  assert.ok(wrongWeek.forecast.players.every(player => player.previousActualPoints === null && player.fplRuleBasedHistoricalBenchmark === null));
  assert.deepEqual(forecasts(before.forecast), forecasts(wrongWeek.forecast));
  await assert.rejects(mismatch.analyse(gameweek, 'previous', wrongWeek.ready.token), { status: 409 });
});

test('saved results display the legacy rule-based value as a benchmark without rewriting history', async () => {
  const player = { id: 103, predicted: 4.6, previousActualPoints: 7, fplRuleBasedPredictedPoints: 7 };
  const saved = [{ id: 'saved', gameweek, players: [player] }];
  const [record] = await serviceFor(3, prior, saved).history();
  assert.deepEqual(record.players, [{ id: 103, predicted: 4.6, previousActualPoints: 7, fplRuleBasedHistoricalBenchmark: 7 }]);
  assert.equal(saved[0].players[0].fplRuleBasedPredictedPoints, 7);
});
