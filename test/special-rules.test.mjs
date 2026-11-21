import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiHandler } from '../lib/http.mjs';
import { predictionService } from '../lib/predictions.mjs';

const gameweek = 7;
const appearance = { starts: 1, goals_scored: 0, assists: 0 };
const players = Array.from({ length: 11 }, (_, index) => ({
  id: index + 1, team: 1, web_name: `Player ${String(index + 1).padStart(2, '0')}`
}));
const stats = {
  2: { 2: { goals_scored: 1 }, 3: { assists: 1 }, 4: { goals_scored: 1 }, 6: { assists: 1 }, 7: { assists: 1 },
    8: { goals_scored: 2 }, 9: { goals_scored: 1 }, 10: { goals_scored: 1, starts: 0 }, 11: { goals_scored: 1 } },
  3: { 1: { goals_scored: 1 }, 2: { assists: 2 }, 4: { goals_scored: 1 }, 6: { goals_scored: 1 },
    7: { goals_scored: 1 }, 8: { goals_scored: 1 }, 9: { goals_scored: 1 }, 10: { goals_scored: 1, starts: 0 }, 11: { assists: 1 } },
  4: { 2: { starts: 2 }, 4: { assists: 1 }, 5: { goals_scored: 1 }, 8: { starts: undefined }, 9: { assists: undefined } },
  5: { 1: { minutes: 0 }, 2: { minutes: 1 }, 6: { starts: 0, minutes: 80 }, 7: null, 11: { goals_scored: 1 } }
};

function setup({ missingWeek, uncheckedWeeks = [6] } = {}) {
  const dashboard = { seasonYear: 2026, players, teams: [{ id: 1, name: 'Club 1' }],
    events: [6, 1, 5, 3, 7, 4, 2].map(id => ({ id, finished: true, data_checked: !uncheckedWeeks.includes(id) })) };
  const liveCalls = [];
  const fpl = {
    getDashboard: async () => dashboard,
    getLive: async event => {
      liveCalls.push(event);
      if (event === missingWeek) throw new Error('Feed unavailable');
      return { event, sources: [{ url: `https://fpl.example/gameweek/${event}` }], players: players.flatMap(({ id }) => {
        const overrides = stats[event]?.[id];
        return overrides === null ? [] : [{ id, ...appearance, ...overrides }];
      }) };
    }
  };
  const service = predictionService(fpl, { history: {
    read: async () => [],
    update: async () => assert.fail('Special Rules must not write prediction history')
  } });
  return { service, handle: createApiHandler(fpl, service), liveCalls };
}

test('finds goals and assists followed by two blanks using recorded starts and final Gameweeks', async () => {
  const { handle, liveCalls } = setup();
  const refresh = await handle('POST', new URL(`https://app.example/api/prediction-data?gameweek=${gameweek}`));
  assert.equal(refresh.status, 200);
  const { token } = await refresh.json();
  const response = await handle('POST', new URL(`https://app.example/api/predictions?gameweek=${gameweek}&strategy=special-rules&token=${token}`));
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.strategy, 'special-rules');
  assert.equal(report.gameweek, gameweek);
  assert.deepEqual(report.weeks, [3, 4, 5]);
  assert.deepEqual(liveCalls, [5, 2, 3, 4]);
  assert.equal(report.sources.length, 4);
  assert.deepEqual(report.players, [
    { id: 1, name: 'Player 01', team: 'Club 1', gameweeks: [
      { starts: 1, goals: 1, assists: 0 }, { starts: 1, goals: 0, assists: 0 }, { starts: 1, goals: 0, assists: 0 }
    ] },
    { id: 2, name: 'Player 02', team: 'Club 1', gameweeks: [
      { starts: 1, goals: 0, assists: 2 }, { starts: 2, goals: 0, assists: 0 }, { starts: 1, goals: 0, assists: 0 }
    ] }
  ]);
});

test('lists all players with returns in both older Gameweeks and blanks in both recent Gameweeks', async () => {
  const { service } = setup();
  const { token } = await service.refresh(gameweek);
  const { rule2 } = await service.analyse(gameweek, 'special-rules', token);
  assert.equal(rule2.error, null);
  assert.deepEqual(rule2.weeks, [2, 3, 4, 5]);
  assert.deepEqual(rule2.players.map(player => player.id), [2, 6, 8, 10]);
  assert.deepEqual(rule2.players[1], { id: 6, name: 'Player 06', team: 'Club 1', gameweeks: [
    { starts: 1, goals: 0, assists: 1 }, { starts: 1, goals: 1, assists: 0 },
    { starts: 1, goals: 0, assists: 0 }, { starts: 0, goals: 0, assists: 0 }
  ] });
});

test('reports insufficient completed history without fetching extra Gameweeks', async () => {
  const { service, liveCalls } = setup();
  const { token } = await service.refresh(3);
  assert.deepEqual(await service.analyse(3, 'special-rules', token), {
    strategy: 'special-rules', gameweek: 3, weeks: [1, 2], players: [], sources: [],
    rule2: { weeks: [1, 2], players: [], error: 'Four consecutive completed Gameweeks are needed to check this rule.' }
  });
  assert.deepEqual(liveCalls, [2]);
});

test('reports an unavailable scoring feed instead of returning an empty shortlist', async () => {
  const { service } = setup({ missingWeek: 4 });
  const { token } = await service.refresh(gameweek);
  await assert.rejects(service.analyse(gameweek, 'special-rules', token), /Gameweek 4 scoring is unavailable/);
});

test('keeps the three-Gameweek rule available when the fourth scoring feed is unavailable', async () => {
  const { service } = setup({ missingWeek: 2 });
  const { token } = await service.refresh(gameweek);
  const report = await service.analyse(gameweek, 'special-rules', token);
  assert.deepEqual(report.players.map(player => player.id), [1, 2]);
  assert.deepEqual(report.rule2.players, []);
  assert.match(report.rule2.error, /Gameweek 2 scoring is unavailable/);
});

test('does not treat Gameweeks separated by an unchecked Gameweek as consecutive', async () => {
  const { service, liveCalls } = setup({ uncheckedWeeks: [2, 6] });
  const { token } = await service.refresh(gameweek);
  const report = await service.analyse(gameweek, 'special-rules', token);
  assert.deepEqual(report.players.map(player => player.id), [1, 2]);
  assert.deepEqual(report.rule2.players, []);
  assert.match(report.rule2.error, /Four consecutive completed Gameweeks/);
  assert.deepEqual(liveCalls, [5, 3, 4]);
});
