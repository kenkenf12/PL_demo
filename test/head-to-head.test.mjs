import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeadToHeadAnalysis } from '../lib/head-to-head.mjs';
import { createApiHandler } from '../lib/http.mjs';
import { predictMatchWinners } from '../lib/match-winner-strategy.mjs';
import { predictionService } from '../lib/predictions.mjs';

const gameweek = 5;
const cutoff = Date.parse('2026-08-19T09:00:00Z');
const kickoff = '2026-08-19T15:00:00Z';
const teams = [
  { id: 1, name: 'Man Utd', short_name: 'MUN' }, { id: 2, name: 'Hull City', short_name: 'HUL' },
  { id: 3, name: 'Arsenal', short_name: 'ARS' }, { id: 4, name: 'Everton', short_name: 'EVE' },
  { id: 5, name: 'Bournemouth', short_name: 'BOU' }, { id: 6, name: "Nott'm Forest", short_name: 'NFO' }
];
const espnTeams = new Map(teams.map(team => [team.id, { id: String(team.id + 1000),
  displayName: team.id === 1 ? 'Manchester United' : team.name, abbreviation: team.id === 1 ? 'MAN' : team.short_name }]));
const fixtures = [1, 3, 5].map(team => ({ id: 100 + team, event: gameweek, team_h: team, team_a: team + 1, kickoff_time: kickoff }));
const events = [1, 2, 3, 4].map(id => ({ id, finished: true, data_checked: true }));
const dashboard = { seasonYear: 2026, teams, sources: [], positions: [{ id: 1, singular_name: 'Goalkeeper' }],
  players: teams.flatMap(team => [1, 2].map(number => ({ id: team.id * 10 + number, team: team.id,
    web_name: `Player ${team.id}.${number}`, element_type: 1 }))),
  events: [...events, { id: gameweek, deadline_time: '2026-08-19T13:30:00Z' }],
  fixtures: [...fixtures, ...events.flatMap(({ id }) => fixtures.map(fixture => ({
    event: id, finished: true, kickoff_time: `2026-08-${10 + id}T15:00:00Z`, team_h_score: 1, team_a_score: 1,
    team_h: id % 2 ? fixture.team_h : fixture.team_a, team_a: id % 2 ? fixture.team_a : fixture.team_h
  })))] };

const sides = (home, away, homeScore, awayScore) => [
  { homeAway: 'home', team: espnTeams.get(home), score: homeScore },
  { homeAway: 'away', team: espnTeams.get(away), score: awayScore }
];
const meeting = (id, home, away, homeScore, awayScore, date = `2025-05-0${id}T15:00:00Z`) => ({
  id: String(id), date, competitors: sides(home, away, homeScore, awayScore),
  competitionName: 'Test Cup', statusType: { completed: true }
});
const histories = new Map([
  [101, [meeting(1, 2, 1, '2', '0'), meeting(4, 1, 2, 1, 0), meeting(3, 1, 2, 1, 0),
    meeting(5, 2, 1, 1, 0), meeting(2, 1, 2, 2, 1), meeting(3, 1, 2, 1, 0),
    meeting(6, 2, 3, 4, 0), meeting(7, 2, 1, 4, 0, '2026-08-19T12:00:00Z'),
    meeting(101, 1, 2, 0, 4, '2026-08-18T15:00:00Z'),
    { ...meeting(8, 1, 2, 0, 4), statusType: { completed: false } }, meeting(9, 1, 2, null, 4)]],
  [103, [1, 2, 3, 4].map(id => meeting(id, 4, 3, 1, 0))],
  [105, [1, 2, 3, 4].map(id => meeting(id, 5, 6, 1, 1))]
]);

function analysis(history = histories, requests = []) {
  return createHeadToHeadAnalysis(async input => {
    const url = new URL(input);
    requests.push(url.pathname.split('/').at(-1));
    if (url.pathname.endsWith('/scoreboard')) {
      assert.equal(url.searchParams.get('dates'), '20260819');
      return Response.json({ events: fixtures.map(fixture => ({ id: String(fixture.id), date: kickoff,
        competitions: [{ competitors: sides(fixture.team_h, fixture.team_a) }] })) });
    }
    const results = history.get(Number(url.searchParams.get('event')));
    return results ? Response.json({ seasonseries: [{ type: 'head-to-head', events: results }] })
      : new Response(null, { status: 503 });
  });
}

test('uses the latest four verified meetings and filters each outcome by its clubs', async () => {
  const requests = [];
  const report = await analysis(histories, requests)(dashboard, fixtures, gameweek, cutoff);
  const [home, away, draw] = report.matches;
  assert.deepEqual(home.meetings.map(match => match.id), ['5', '4', '3', '2']);
  assert.deepEqual(home.h2h, { home: 0.75, draw: 0, away: 0.25 });
  const baseline = predictMatchWinners(dashboard, fixtures, gameweek, []).matches;
  assert.equal(draw.h2hWeight, 0.25);
  assert.equal(draw.probabilities.draw, baseline[2].probabilities.draw * 0.75 + 0.25);
  assert.ok(draw.probabilities.draw > draw.probabilities.home);
  assert.deepEqual(report.matches.map(match => match.outcome), ['home', 'away', 'draw']);
  assert.deepEqual(home.players.map(player => player.id), [11, 12]);
  assert.deepEqual(away.players.map(player => player.id), [41, 42]);
  assert.deepEqual(draw.players.map(player => player.id), [51, 52, 61, 62]);
  assert.deepEqual(requests, ['scoreboard', 'summary', 'summary', 'summary']);
  assert.equal(report.sources.length, 4);
});

test('reduces the weight for partial H2H coverage and uses the baseline when the history is unavailable', async () => {
  const report = await analysis(new Map([[101, [meeting(1, 1, 2, 1, 0)]]]))(dashboard, fixtures, gameweek, cutoff);
  const [partial, unavailable] = report.matches;
  assert.equal(partial.h2hWeight, 0.0625);
  assert.deepEqual(partial.h2h, { home: 1, draw: 0, away: 0 });
  assert.equal(unavailable.h2hWeight, 0);
  assert.equal(unavailable.h2h, null);
  assert.deepEqual(unavailable.probabilities, predictMatchWinners(dashboard, fixtures, gameweek, []).matches[1].probabilities);
  assert.equal(unavailable.outcome, 'draw');
});

test('uses a full H2H sample when season results are unavailable', async () => {
  const report = await analysis(new Map([[105, histories.get(105)]]))({ ...dashboard, fixtures }, fixtures, gameweek, cutoff);
  assert.equal(report.matches[0].probabilities, null);
  assert.deepEqual(report.matches[0].players, []);
  assert.equal(report.matches[2].outcome, 'draw');
  assert.equal(report.matches[2].h2hWeight, 1);
});

test('offers H2H through the prediction API as an independent analysis', async () => {
  const fpl = { getDashboard: async () => dashboard, getLive: async () => { throw new Error('No player scoring'); } };
  let saved = [];
  const requests = [];
  const history = { read: async () => saved, update: async transform => { saved = transform(saved); } };
  const api = createApiHandler(fpl, predictionService(fpl, { history, headToHead: analysis(histories, requests), now: () => cutoff }));
  const url = path => new URL(`http://localhost/api/${path}`);
  const refresh = await api('POST', url(`prediction-data?gameweek=${gameweek}`));
  const { token } = await refresh.json();
  const post = strategy => api('POST', url(`predictions?gameweek=${gameweek}&token=${token}&strategy=${strategy}`));
  const original = await (await post('match-winners')).json();
  assert.equal(original.strategy, 'match-winners');
  assert.equal(requests.length, 0);
  assert.ok(original.matches.every(match => match.winner === null && match.picks.length === 0));

  const response = await post('head-to-head');
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.strategy, 'head-to-head');
  assert.equal(report.matches[2].outcome, 'draw');
  assert.ok(report.matches[2].players.length > 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, original.id);
  const repeated = await (await post('match-winners')).json();
  assert.deepEqual(repeated.matches, original.matches);
});
