import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiHandler } from '../lib/http.mjs';
import { predictionService } from '../lib/predictions.mjs';

const gameweek = 11;
const hour = 3_600_000;
const deadline = Date.parse('2026-11-21T11:00:00Z');
const iso = time => new Date(time).toISOString();
const teams = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `Club ${index + 1}` }));
const positions = ['GKP', 'DEF', 'MID', 'FWD'].map((singular_name_short, index) => ({ id: index + 1,
  singular_name: singular_name_short, singular_name_short }));
const players = teams.flatMap(team => positions.map(position => ({ id: team.id * 10 + position.id, team: team.id,
  element_type: position.id, now_cost: 50, status: 'a', minutes: 90, total_points: 4 + team.id, form: '4',
  web_name: `Player ${team.id}/${position.id}` })));
const fixtures = [1, 3, 5].map((team, index) => ({ id: team, event: gameweek, kickoff_time: iso(deadline + hour * (index + 1)),
  team_h: team, team_a: team + 1, team_h_difficulty: 3, team_a_difficulty: 3, started: false, finished: false }));
const prior = { event: gameweek - 1, players: players.map(player => ({ id: player.id, minutes: 90, total_points: 4 })), sources: [] };

function setup({ matches = fixtures, finished = false, ...strategies } = {}) {
  const state = { time: deadline - 1, saved: [] };
  const dashboard = { seasonYear: 2026, teams, positions, players, sources: [],
    events: [{ id: gameweek - 1, finished: true, data_checked: true }, { id: gameweek, deadline_time: iso(deadline), finished }],
    fixtures: [...matches, ...fixtures.map(fixture => ({ ...fixture, id: fixture.id + 10, event: gameweek - 1, finished: true }))] };
  const fpl = { getDashboard: async () => dashboard, getLive: async () => prior, getPlayer: async () => ({ history: [], sources: [] }) };
  const service = predictionService(fpl, { now: () => state.time, ...strategies,
    history: { read: async () => state.saved, update: async transform => { state.saved = transform(state.saved); } } });
  const api = createApiHandler(fpl, service);
  const url = path => new URL(`http://localhost/api/${path}`);
  async function ready() {
    const refresh = await api('POST', url(`prediction-data?gameweek=${gameweek}`));
    assert.equal(refresh.status, 200);
    const { token } = await refresh.json();
    return (kind, strategy) => api('POST', url(`${kind}?gameweek=${gameweek}&strategy=${strategy}&token=${token}`));
  }
  return { state, ready, getHistory: () => api('GET', url('predictions')) };
}

test('rejects new Match & Player requests and retains the saved report', async () => {
  const { state, ready, getHistory } = setup();
  const archived = { id: 'archived-prediction', strategy: 'match-winners', seasonYear: 2025, gameweek,
    matches: [{ id: 1 }], players: [{ id: 11, predicted: 5 }] };
  state.saved.push(archived);
  const run = await ready();
  assert.equal((await run('predictions', 'match-winners')).status, 400);
  state.time = deadline;
  assert.equal((await run('prediction-preview', 'match-winners')).status, 400);
  assert.deepEqual(await (await getHistory()).json(), [archived]);
});

test('runs the same strategy as an unsaved preview after the Gameweek deadline', async () => {
  const { state, ready } = setup();
  const run = await ready();
  assert.equal((await run('prediction-preview', 'ranking')).status, 409);
  const prediction = await run('predictions', 'ranking');
  assert.equal(prediction.status, 201);
  const before = await prediction.json();
  assert.equal(state.saved.length, 1);

  state.time = deadline;
  assert.equal((await run('predictions', 'ranking')).status, 409);
  const preview = await run('prediction-preview', 'ranking');
  assert.equal(preview.status, 200);
  const after = await preview.json();
  assert.deepEqual(after.preview, { fixtureCount: 3 });
  assert.equal(after.id, null);
  assert.equal(after.players.length, 15);
  assert.deepEqual(after.players, before.players);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].id, before.id);
});

test('previews only future kick-offs and lists remaining players when a legal squad is unavailable', async () => {
  const matches = [...fixtures, { ...fixtures[0], id: 21, kickoff_time: null },
    { ...fixtures[1], id: 22, kickoff_time: fixtures[2].kickoff_time, started: true },
    { ...fixtures[1], id: 23, kickoff_time: fixtures[2].kickoff_time, finished_provisional: true }];
  const seen = [];
  const { state, ready } = setup({ matches,
    seasonBinary: async (dashboard, scheduled) => ({ matches: scheduled, sources: [] }),
    news: async eligible => { seen.push(...eligible.map(player => player.team)); return { recommendations: [] }; }
  });
  state.time = deadline + 2 * hour;
  const run = await ready();
  const matchup = await (await run('prediction-preview', 'season-binary')).json();
  assert.deepEqual(matchup.matches.map(match => match.id), [5]);
  assert.equal(matchup.id, undefined);
  const squad = await (await run('prediction-preview', 'previous')).json();
  assert.equal(squad.shortlist, true);
  assert.equal(squad.players.length, 8);
  assert.ok(squad.players.every(player => player.teamId >= 5 && player.predicted > 0));
  assert.equal((await run('prediction-preview', 'news')).status, 200);
  assert.deepEqual([...new Set(seen)], [5, 6]);
  assert.deepEqual(state.saved, []);

  state.time = deadline + 3 * hour;
  const none = await run('prediction-preview', 'ranking');
  assert.equal(none.status, 409);
  assert.match((await none.json()).error, /no remaining fixtures/);
});

test('rejects a preview for a finished Gameweek and keeps Special Rules on its original path', async () => {
  const { state, ready } = setup({ finished: true });
  state.time = deadline + 1;
  const run = await ready();
  assert.equal((await run('prediction-preview', 'ranking')).status, 409);
  assert.equal((await run('prediction-preview', 'special-rules')).status, 400);
  assert.equal((await run('predictions', 'special-rules')).status, 201);
});

test('rejects a preview if an included fixture kicks off during analysis', async () => {
  const { state, ready } = setup({ seasonBinary: async () => {
    state.time = deadline + hour;
    return { matches: [], sources: [] };
  } });
  state.time = deadline + 1;
  const run = await ready();
  const result = await run('prediction-preview', 'season-binary');
  assert.equal(result.status, 409);
  assert.match((await result.json()).error, /kicked off during the preview/);
  assert.deepEqual(state.saved, []);
});
