import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiHandler } from '../lib/http.mjs';
import { predictionService } from '../lib/predictions.mjs';

const gameweek = 7;
const appearance = { starts: 1, goals_scored: 0, assists: 0 };
const players = Array.from({ length: 18 }, (_, index) => ({
  id: index + 1, team: 1, web_name: `Player ${String(index + 1).padStart(2, '0')}`
}));
const stats = {
  1: { 3: { goals_scored: 1 } },
  2: { 2: { goals_scored: 1 }, 3: { assists: 1 }, 4: { goals_scored: 1 }, 6: { assists: 1 }, 7: { assists: 1 },
    8: { goals_scored: 2 }, 9: { goals_scored: 1 }, 10: { goals_scored: 1, starts: 0 }, 11: { goals_scored: 1 } },
  3: { 1: { goals_scored: 1 }, 2: { assists: 2 }, 4: { goals_scored: 1 }, 6: { goals_scored: 1 },
    7: { goals_scored: 1 }, 8: { goals_scored: 1 }, 9: { goals_scored: 1 }, 10: { goals_scored: 1, starts: 0 }, 11: { assists: 1 },
    12: { assists: 1 }, 13: { assists: 1 }, 14: { assists: 1 }, 15: { assists: 1, starts: 0 }, 16: { assists: 1 },
    17: { assists: 1 }, 18: { goals_scored: 1 } },
  4: { 2: { starts: 2 }, 4: { assists: 1 }, 5: { goals_scored: 1 }, 7: { goals_scored: 1 }, 8: { starts: undefined }, 9: { assists: undefined },
    12: { goals_scored: 2, starts: 2 }, 13: { goals_scored: 1 }, 14: { goals_scored: 1 }, 15: { goals_scored: 1 },
    16: { goals_scored: 1, starts: undefined }, 17: { goals_scored: 1 }, 18: { assists: 2, starts: 2 } },
  5: { 1: { minutes: 0 }, 2: { minutes: 1 }, 5: { goals_scored: 1 }, 6: { starts: 0, minutes: 80 }, 7: null, 11: { goals_scored: 1 },
    12: { minutes: 0 }, 13: { assists: 1, minutes: 0 }, 14: { goals_scored: 1, starts: 0, minutes: 80 },
    15: { assists: 1 }, 16: { goals_scored: 1 }, 17: { assists: undefined }, 18: { goals_scored: 1 } }
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
  let saved = [];
  const service = predictionService(fpl, { history: { read: async () => saved, update: async transform => { saved = transform(saved); } } });
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
  assert.ok(report.id);
  assert.deepEqual(await (await handle('GET', new URL('https://app.example/api/predictions'))).json(), [report]);
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

test('lists every starter with two consecutive returns followed by one blank, regardless of minutes', async () => {
  const { service, liveCalls } = setup();
  const { token } = await service.refresh(gameweek);
  const { rule3 } = await service.analyse(gameweek, 'special-rules', token);
  assert.equal(rule3.error, null);
  assert.deepEqual(rule3.weeks, [3, 4, 5]);
  assert.deepEqual(rule3.players.map(player => player.id), [4, 12]);
  assert.deepEqual(rule3.players[1], { id: 12, name: 'Player 12', team: 'Club 1', gameweeks: [
    { starts: 1, goals: 0, assists: 1 }, { starts: 2, goals: 2, assists: 0 }, { starts: 1, goals: 0, assists: 0 }
  ] });
  assert.deepEqual(liveCalls, [5, 2, 3, 4]);
});

test('lists players who started and scored or assisted in each of the latest three Gameweeks', async () => {
  const { service, liveCalls } = setup();
  const { token } = await service.refresh(gameweek);
  const { rule4 } = await service.analyse(gameweek, 'special-rules', token);
  assert.equal(rule4.error, null);
  assert.deepEqual(rule4.weeks, [3, 4, 5]);
  assert.deepEqual(rule4.players, [
    { id: 13, name: 'Player 13', team: 'Club 1', gameweeks: [
      { starts: 1, goals: 0, assists: 1 }, { starts: 1, goals: 1, assists: 0 }, { starts: 1, goals: 0, assists: 1 }
    ] },
    { id: 18, name: 'Player 18', team: 'Club 1', gameweeks: [
      { starts: 1, goals: 1, assists: 0 }, { starts: 2, goals: 0, assists: 2 }, { starts: 1, goals: 1, assists: 0 }
    ] }
  ]);
  assert.deepEqual(liveCalls, [5, 2, 3, 4]);
});

test('lists all players who started and recorded a return in both recent Gameweeks', async () => {
  const { service, liveCalls } = setup();
  const { token } = await service.refresh(gameweek);
  const { rule5 } = await service.analyse(gameweek, 'special-rules', token);
  assert.equal(rule5.error, null);
  assert.deepEqual(rule5.weeks, [4, 5]);
  assert.deepEqual(rule5.players.map(player => player.id), [5, 13, 15, 18]);
  assert.deepEqual(rule5.players[1], { id: 13, name: 'Player 13', team: 'Club 1', gameweeks: [
    { starts: 1, goals: 1, assists: 0 }, { starts: 1, goals: 0, assists: 1 }
  ] });
  assert.deepEqual(liveCalls, [5, 2, 3, 4]);
});

test('evaluates Special Rule5 after the first two completed Gameweeks', async () => {
  const { service, liveCalls } = setup();
  const { token } = await service.refresh(3);
  const report = await service.analyse(3, 'special-rules', token);
  assert.deepEqual(report.players, []);
  assert.ok([report.rule2, report.rule3, report.rule4].every(rule => rule.error));
  assert.equal(report.sources.length, 2);
  assert.equal(report.rule5.error, null);
  assert.deepEqual(report.rule5.weeks, [1, 2]);
  assert.deepEqual(report.rule5.players.map(player => player.id), [3]);
  assert.deepEqual(liveCalls, [2, 1]);
});

test('reports insufficient completed history without fetching extra Gameweeks', async () => {
  const { service, liveCalls } = setup();
  const { token } = await service.refresh(2);
  const report = await service.analyse(2, 'special-rules', token);
  assert.deepEqual(report.players, []);
  assert.deepEqual(report.sources, []);
  assert.deepEqual(report.rule5, {
    weeks: [1], players: [], error: 'Two consecutive completed Gameweeks are needed to check this rule.'
  });
  assert.deepEqual(liveCalls, [1]);
});

test('reports an unavailable scoring feed instead of returning an empty shortlist', async () => {
  const { service } = setup({ missingWeek: 4 });
  const { token } = await service.refresh(gameweek);
  await assert.rejects(service.analyse(gameweek, 'special-rules', token), /Gameweek 4 scoring is unavailable/);
});

test('keeps the three-Gameweek rules available when the fourth scoring feed is unavailable', async () => {
  const { service } = setup({ missingWeek: 2 });
  const { token } = await service.refresh(gameweek);
  const report = await service.analyse(gameweek, 'special-rules', token);
  assert.deepEqual(report.players.map(player => player.id), [1, 2]);
  assert.deepEqual(report.rule3.players.map(player => player.id), [4, 12]);
  assert.deepEqual(report.rule4.players.map(player => player.id), [13, 18]);
  assert.deepEqual(report.rule2.players, []);
  assert.match(report.rule2.error, /Gameweek 2 scoring is unavailable/);
});

test('keeps Special Rule5 available when the scoring feed for an older Gameweek is unavailable', async () => {
  const { service } = setup({ missingWeek: 3 });
  const { token } = await service.refresh(gameweek);
  const report = await service.analyse(gameweek, 'special-rules', token);
  for (const rule of [report, report.rule2, report.rule3, report.rule4]) {
    assert.deepEqual(rule.players, []);
    assert.match(rule.error, /Gameweek 3 scoring is unavailable/);
  }
  assert.equal(report.rule5.error, null);
  assert.deepEqual(report.rule5.weeks, [4, 5]);
  assert.deepEqual(report.rule5.players.map(player => player.id), [5, 13, 15, 18]);
});

test('does not treat Gameweeks separated by an unchecked Gameweek as consecutive', async () => {
  const { service, liveCalls } = setup({ uncheckedWeeks: [2, 6] });
  const { token } = await service.refresh(gameweek);
  const report = await service.analyse(gameweek, 'special-rules', token);
  assert.deepEqual(report.players.map(player => player.id), [1, 2]);
  assert.deepEqual(report.rule2.players, []);
  assert.match(report.rule2.error, /Four consecutive completed Gameweeks/);
  assert.deepEqual(report.rule3.players.map(player => player.id), [4, 12]);
  assert.deepEqual(liveCalls, [5, 3, 4]);
});

test('requires consecutive completed Gameweeks for Special Rule3, Special Rule4 and Special Rule5', async () => {
  const { service } = setup({ uncheckedWeeks: [4, 6] });
  const { token } = await service.refresh(gameweek);
  const { rule3, rule4, rule5 } = await service.analyse(gameweek, 'special-rules', token);
  for (const rule of [rule3, rule4]) {
    assert.deepEqual(rule.weeks, [2, 3, 5]);
    assert.deepEqual(rule.players, []);
    assert.match(rule.error, /Three consecutive completed Gameweeks/);
  }
  assert.deepEqual(rule5.weeks, [3, 5]);
  assert.deepEqual(rule5.players, []);
  assert.match(rule5.error, /Two consecutive completed Gameweeks/);
});
