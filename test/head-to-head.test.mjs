import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeadToHeadAnalysis } from '../lib/head-to-head.mjs';
import { roundRuleBasedPoints } from '../lib/fpl-rule-scoring.mjs';
import { createApiHandler } from '../lib/http.mjs';
import { createFixturePlayerScorer, predictMatchWinners } from '../lib/match-winner-strategy.mjs';
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
const scoring = { long_play: 2, short_play: 1, goals_scored: 10, assists: 3, clean_sheets: 4, saves: 1,
  goals_conceded: -1, defensive_contribution: 0, yellow_cards: -1, own_goals: 0,
  penalties_saved: 0, penalties_missed: 0, red_cards: 0, bonus: 0 };
const dashboard = { seasonYear: 2026, teams, scoring, sources: [], positions: [{ id: 1, singular_name: 'Goalkeeper', singular_name_short: 'GKP' }],
  players: teams.flatMap(team => [1, 2].map(number => ({ id: team.id * 10 + number, team: team.id,
    web_name: `Player ${team.id}.${number}`, element_type: 1, status: 'a', minutes: 360,
    expected_goals: `${number}`, expected_assists: '0.5' }))),
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
    meeting(5, 2, 1, 1, 0), meeting(2, 1, 2, 2, 2), meeting(3, 1, 2, 1, 0),
    meeting(6, 2, 3, 4, 0), meeting(7, 2, 1, 4, 0, '2026-08-19T12:00:00Z'),
    meeting(101, 1, 2, 0, 4, '2026-08-18T15:00:00Z'),
    { ...meeting(8, 1, 2, 0, 4), statusType: { completed: false } }, meeting(9, 1, 2, null, 4)]],
  [103, [1, 2, 3, 4].map(id => meeting(id, 4, 3, 1, 0))],
  [105, [1, 2, 3, 4].map(id => meeting(id, 5, 6, 1, 1))]
]);

function playerEvidence(event, data = dashboard) {
  return { event, sources: [{ url: `https://fpl.example/${event}` }], players: data.players.map(player => ({ id: player.id,
    minutes: 90, starts: 1, expected_goals: Number(player.expected_goals) / 4, expected_assists: 0.125,
    scoringMatches: [{ minutes: 90, saves: 0, yellow_cards: 0, red_cards: 0 }] })) };
}

function analysis({ history = histories, requests = [], scheduled = fixtures,
  fpl = { getLive: async id => playerEvidence(id) } } = {}) {
  return createHeadToHeadAnalysis(fpl, async input => {
    const url = new URL(input);
    requests.push(url.pathname.split('/').at(-1));
    if (url.pathname.endsWith('/scoreboard')) {
      const day = url.searchParams.get('dates');
      return Response.json({ events: scheduled.filter(fixture => fixture.kickoff_time.slice(0, 10).replaceAll('-', '') === day)
        .map(fixture => ({ id: String(fixture.id), date: fixture.kickoff_time,
          competitions: [{ competitors: sides(fixture.team_h, fixture.team_a) }] })) });
    }
    const results = history.get(Number(url.searchParams.get('event')));
    return results ? Response.json({ seasonseries: [{ type: 'head-to-head', events: results }] })
      : new Response(null, { status: 503 });
  });
}

test('uses the latest four verified meetings and filters each outcome by its clubs', async () => {
  const requests = [];
  const report = await analysis({ requests })(dashboard, fixtures, gameweek, cutoff);
  const [home, away, draw] = report.matches;
  assert.deepEqual(home.meetings.map(match => match.id), ['5', '4', '3', '2']);
  assert.deepEqual(home.teamRates, { home: { win: 0.5, draw: 0.25, loss: 0.25 }, away: { win: 0.25, draw: 0.25, loss: 0.5 } });
  assert.deepEqual(home.combined, { win: 0.375, draw: 0.25, loss: 0.375 });
  assert.deepEqual(home.probabilities, { home: 0.5, draw: 0.25, away: 0.25 });
  assert.equal(Object.values(home.combined).reduce((sum, rate) => sum + rate, 0), 1);
  assert.deepEqual(away.probabilities, { home: 0, draw: 0, away: 1 });
  assert.deepEqual(draw.probabilities, { home: 0, draw: 1, away: 0 });
  assert.deepEqual(report.matches.map(match => match.outcome), ['home', 'away', 'draw']);
  assert.deepEqual(home.eligibleTeamIds, [1]);
  assert.deepEqual(away.eligibleTeamIds, [4]);
  assert.deepEqual(draw.eligibleTeamIds, [5, 6]);
  assert.deepEqual(report.players.map(player => player.id).sort((a, b) => a - b), [11, 12, 41, 42, 51, 52, 61, 62]);
  assert.ok(report.players.every(player => Number.isFinite(player.performanceScore)));
  assert.deepEqual(requests, ['scoreboard', 'summary', 'summary', 'summary']);
  assert.equal(report.sources.length, 7);
});

test('shows partial meeting history and requires four meetings before making a prediction', async () => {
  const report = await analysis({ history: new Map([[101, [meeting(1, 1, 2, 1, 0)]]]) })(dashboard, fixtures, gameweek, cutoff);
  assert.equal(report.matches[0].meetings.length, 1);
  assert.equal(report.matches[1].meetings.length, 0);
  for (const match of report.matches) {
    assert.equal(match.teamRates, null);
    assert.equal(match.combined, null);
    assert.equal(match.probabilities, null);
    assert.equal(match.outcome, null);
    assert.deepEqual(match.eligibleTeamIds, []);
  }
  assert.deepEqual(report.players, []);
});

test('predicts from H2H independently of the season projection, and shows unavailable scores', async () => {
  const report = await analysis({ history: new Map([[105, histories.get(105)]]) })({ ...dashboard, fixtures }, fixtures, gameweek, cutoff);
  assert.equal(report.matches[2].outcome, 'draw');
  assert.deepEqual(report.players.map(player => player.id), [51, 52, 61, 62]);
  assert.ok(report.players.every(player => player.performanceScore === null));
});

test('uses the most recent meeting among tied outcomes', async () => {
  const tied = [meeting(4, 2, 1, 1, 0), meeting(3, 1, 2, 1, 0), meeting(2, 1, 2, 1, 0), meeting(1, 1, 2, 0, 1)];
  const report = await analysis({ history: new Map([[101, tied]]) })(dashboard, fixtures, gameweek, cutoff);
  assert.deepEqual(report.matches[0].probabilities, { home: 0.5, draw: 0, away: 0.5 });
  assert.equal(report.matches[0].outcome, 'away');
  assert.ok(report.players.every(player => player.teamId === 2));
});

test('ranks the best 15 on the same scoring criteria as Match & Player', async () => {
  const extraPlayers = Array.from({ length: 17 }, (_, index) => ({ ...dashboard.players[0], id: 1000 + index,
    web_name: `Extra player ${index}`, expected_goals: String(index + 3) }));
  const data = { ...dashboard, players: [...dashboard.players, ...extraPlayers], fixtures: dashboard.fixtures.map(fixture =>
    !fixture.finished ? fixture : { ...fixture, team_h_score: fixture.team_h === 1 ? 4 : 1, team_a_score: fixture.team_a === 1 ? 4 : 1 }) };
  const selected = [fixtures[0]];
  const h2h = await analysis({ fpl: { getLive: async id => playerEvidence(id, data) } })(data, selected, gameweek, cutoff);
  assert.deepEqual(h2h.players.map(player => player.id), extraPlayers.slice(-15).reverse().map(player => player.id));
  const old = predictMatchWinners(data, selected, gameweek, [4, 3, 2].map(event => playerEvidence(event, data)));
  assert.equal(old.matches[0].picks[0].id, h2h.players[0].id);
  assert.equal(old.matches[0].picks[0].predicted, roundRuleBasedPoints(h2h.players[0].performanceScore));
});

test('sums eligible fixtures only and keeps each player unique in a Double Gameweek', async () => {
  const second = { ...fixtures[0], id: 107, team_h: 2, team_a: 1, kickoff_time: '2026-08-21T15:00:00Z' };
  const scheduled = [fixtures[0], second];
  const history = new Map([[101, histories.get(101)], [107, [1, 2, 3, 4].map(id => meeting(id, 2, 1, 1, 1))]]);
  const scorePlayer = createFixturePlayerScorer(dashboard, scheduled, gameweek, [4, 3, 2].map(event => playerEvidence(event)));
  const report = await analysis({ history, scheduled })(dashboard, scheduled, gameweek, cutoff);
  assert.deepEqual(report.matches.map(match => match.eligibleTeamIds), [[1], [2, 1]]);
  assert.equal(report.players.length, 4);
  for (const player of dashboard.players.slice(0, 4)) {
    const expected = scorePlayer(player, 107) + (player.team === 1 ? scorePlayer(player, 101) : 0);
    assert.equal(report.players.find(candidate => candidate.id === player.id).performanceScore, expected);
  }
});

test('offers H2H through the prediction API as an independent analysis', async () => {
  const fpl = { getDashboard: async () => dashboard, getLive: async () => { throw new Error('No player scoring'); } };
  let saved = [];
  const requests = [];
  const history = { read: async () => saved, update: async transform => { saved = transform(saved); } };
  const api = createApiHandler(fpl, predictionService(fpl, { history, headToHead: analysis({ requests, fpl }), now: () => cutoff }));
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
  assert.ok(report.players.some(player => player.teamId === 5) && report.players.some(player => player.teamId === 6));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, original.id);
  const repeated = await (await post('match-winners')).json();
  assert.deepEqual(repeated.matches, original.matches);
});
