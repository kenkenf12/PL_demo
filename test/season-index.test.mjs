import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiHandler } from '../lib/http.mjs';
import { createFixturePlayerScorer } from '../lib/fixture-player-scoring.mjs';
import { predictionService } from '../lib/predictions.mjs';
import { createSeasonIndexAnalysis } from '../lib/season-index.mjs';

const gameweek = 7;
const kickoff = '2026-10-23T15:00:00Z';
const cutoff = Date.parse('2026-10-23T09:00:00Z');
const upcoming = { id: 99, event: gameweek, team_h: 1, team_a: 2, kickoff_time: kickoff };
const teams = ['Home club', 'Away club', 'Third club', 'Fourth club'].map((name, index) => ({ id: index + 1, name }));
const positions = [['GKP', 'Goalkeeper'], ['DEF', 'Defender'], ['MID', 'Midfielder'], ['FWD', 'Forward']]
  .map(([singular_name_short, singular_name], index) => ({ id: index + 1, singular_name_short, singular_name }));
const scoring = { long_play: 2, short_play: 1, goals_scored: { GKP: 10, DEF: 6, MID: 5, FWD: 4 }, assists: 3,
  clean_sheets: { GKP: 4, DEF: 4, MID: 1, FWD: 0 }, saves: 1,
  goals_conceded: { GKP: -1, DEF: -1, MID: 0, FWD: 0 }, defensive_contribution: 0,
  yellow_cards: -1, own_goals: 0, penalties_saved: 0, penalties_missed: 0, red_cards: -3, bonus: 0 };
const players = teams.flatMap(team => positions.map(position => ({ id: team.id * 10 + position.id, team: team.id,
  web_name: `${team.name} ${position.singular_name}`, element_type: position.id, status: 'a', minutes: 540,
  expected_goals: team.id === 2 ? '24' : '1.2', expected_assists: '1' })));

function seasonDashboard() {
  const completed = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, finished: true, data_checked: true,
    deadline_time: `2026-10-${11 + index}T12:00:00Z` }));
  const results = [
    [1, 1, 3, 1, 0], [1, 2, 4, 1, 0], [2, 4, 1, 2, 0], [2, 3, 2, 2, 1],
    [3, 1, 4, 2, 1], [3, 2, 3, 0, 0], [4, 3, 1, 0, 3], [4, 2, 4, 0, 0],
    [5, 1, 2, 2, 0], [6, 4, 1, 1, 1]
  ].map(([event, team_h, team_a, team_h_score, team_a_score], index) => ({
    id: index + 1, event, team_h, team_a, team_h_score, team_a_score, finished: true,
    kickoff_time: `2026-10-${10 + event}T15:00:00Z`
  }));
  const fixtures = [...results, upcoming,
    { ...results[0], id: 40, finished: false },
    { ...results[0], id: 41, kickoff_time: '2025-10-11T15:00:00Z' },
    { ...results[0], id: 42, kickoff_time: '2026-10-24T15:00:00Z' },
    { ...results[0], id: 43, event: gameweek },
    { ...results[0], id: 44, team_h_score: null }];
  return { seasonYear: 2026, teams, positions, players, scoring, sources: [], fixtures,
    events: [...completed, { id: gameweek, deadline_time: '2026-10-23T13:30:00Z' }] };
}

function playerEvidence(event, roster = players) {
  return { event, sources: [{ url: `https://fpl.example/${event}` }], players: roster.map(player => ({ id: player.id,
    minutes: 90, starts: 1, expected_goals: Number(player.expected_goals) / 6, expected_assists: 1 / 6, red_cards: 0,
    scoringMatches: [{ minutes: 90, saves: 0, yellow_cards: 0, red_cards: 0 }] })) };
}

const fpl = { getLive: async event => playerEvidence(event) };

test('season index excludes matches from an unchecked Gameweek', async () => {
  const dashboard = seasonDashboard();
  dashboard.events[1].data_checked = false;
  const { matches: [match] } = await createSeasonIndexAnalysis(fpl)(dashboard, [upcoming], gameweek, null, cutoff);
  assert.deepEqual([match.home.completedMatches, match.away.completedMatches], [5, 4]);
});

test('season index leaves the squad empty before the first completed match', async () => {
  const fixture = { ...upcoming, event: 1 };
  const dashboard = { ...seasonDashboard(), fixtures: [fixture], events: [{ id: 1 }] };
  const { matches: [match], squad, latestCompletedGameweek } = await createSeasonIndexAnalysis({ getLive: () => assert.fail('No completed Gameweeks') })(
    dashboard, [fixture], 1, null, cutoff);
  assert.equal(latestCompletedGameweek, null);
  for (const team of [match.home, match.away]) {
    assert.equal(team.completedMatches, 0);
    assert.deepEqual([team.goalProbability, team.cleanSheetProbability, team.winOrDrawProbability, team.teamIndex], [null, null, null, null]);
  }
  assert.deepEqual([match.outcome, match.eligibleTeamIds], [null, []]);
  assert.deepEqual(squad.flatMap(group => group.players), []);
});

test('season index applies fixture eligibility to the shared player rankings and squad in analysis and preview', async () => {
  const dashboard = seasonDashboard();
  const awayWin = { ...upcoming, id: 100, team_h: 2, team_a: 1 };
  const draw = { ...upcoming, id: 101, team_h: 2, team_a: 4 };
  dashboard.fixtures.push(awayWin, draw, { ...upcoming, id: 102, started: true });
  dashboard.players = players.flatMap(player => [player, { ...player, id: player.id + 100 }]);
  const client = { getDashboard: async () => dashboard, getLive: async event => playerEvidence(event, dashboard.players) };
  const history = { read: async () => [], update: async () => assert.fail('The season index wrote prediction history') };
  let time = cutoff;
  const api = createApiHandler(client, predictionService(client, { history, now: () => time }));
  const url = (path, parameters) => new URL(`http://localhost/api/${path}?${new URLSearchParams(parameters)}`);
  const refresh = await api('POST', url('prediction-data', { gameweek }));
  const { token } = await refresh.json();
  const query = { token, gameweek, strategy: 'season-index' };
  const response = await api('POST', url('predictions', query));
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.strategy, 'season-index');
  assert.equal(report.latestCompletedGameweek, 6);
  assert.deepEqual(report.teams.map(team => [team.completedMatches, team.goalProbability, team.cleanSheetProbability,
    team.winOrDrawProbability, team.teamIndex]), [
    [6, 5 / 6, 3 / 6, 5 / 6, 1300 / 6], [5, 2 / 5, 3 / 5, 3 / 5, 160],
    [4, 1 / 4, 1 / 4, 2 / 4, 100], [5, 3 / 5, 2 / 5, 3 / 5, 160]
  ]);
  assert.deepEqual(report.matches.map(match => [match.id, match.outcome, match.eligibleTeamIds]), [
    [99, 'home', [1]], [100, 'away', [1]], [101, 'draw', [2, 4]]
  ]);

  const reports = [6, 5, 4].map(event => playerEvidence(event, dashboard.players));
  const scorePlayer = createFixturePlayerScorer(dashboard, [upcoming, awayWin, draw], gameweek, reports);
  const roster = new Map(dashboard.players.map(player => [player.id, player]));
  for (const { id, attacking, defensive, eligibleTeamIds } of report.matches) {
    assert.equal(attacking.length, 4 * eligibleTeamIds.length);
    assert.equal(defensive.length, 4 * eligibleTeamIds.length);
    assert.ok(attacking.every(player => ['MID', 'FWD'].includes(player.positionCode)));
    assert.ok(defensive.every(player => ['GKP', 'DEF'].includes(player.positionCode)));
    for (const player of [...attacking, ...defensive]) {
      assert.ok(eligibleTeamIds.includes(player.teamId));
      assert.equal(player.performanceScore, scorePlayer(roster.get(player.id), id));
    }
  }
  assert.deepEqual(report.matches[2].attacking.map(player => player.teamId), [4, 4, 4, 4, 2, 2, 2, 2]);
  assert.deepEqual(report.matches[2].defensive.map(player => player.teamId), [2, 2, 2, 2, 4, 4, 4, 4]);
  assert.deepEqual(report.squad.map(group => [group.positionCode, group.required, group.players.length]), [
    ['GKP', 2, 2], ['DEF', 5, 5], ['MID', 5, 5], ['FWD', 3, 3]
  ]);
  const selected = report.squad.flatMap(group => group.players);
  assert.equal(new Set(selected.map(player => player.id)).size, 15);
  for (const player of selected) {
    const rows = report.matches.flatMap(match => [...match.attacking, ...match.defensive]).filter(row => row.id === player.id);
    assert.equal(rows.length, player.teamId === 1 ? 2 : 1);
    assert.ok(rows.every(row => Number.isFinite(row.performanceScore)));
    assert.equal(player.performanceScore, rows.reduce((sum, row) => sum + row.performanceScore, 0));
  }

  time = Date.parse('2026-10-23T14:00:00Z');
  const previewResponse = await api('POST', url('prediction-preview', query));
  assert.equal(previewResponse.status, 200);
  assert.deepEqual(await previewResponse.json(), { ...report, preview: { fixtureCount: 3 } });
});

test('season index treats equal fractions as a draw and leaves matches with missing data unpredicted', async () => {
  const events = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, finished: true, data_checked: true }));
  const results = [[1, [[1, 1], [0, 0], [0, 0], [0, 1], [0, 1]]],
    [2, [[1, 1], [1, 1], [1, 1], [0, 0], [0, 0], [0, 0], [0, 1], [0, 1], [0, 1], [0, 1]]]]
    .flatMap(([team, scores]) => scores.map(([team_h_score, team_a_score], index) => ({
      id: 10 * team + index, event: index + 1, team_h: team, team_a: 3, team_h_score, team_a_score, finished: true,
      kickoff_time: `2026-10-${11 + index}T15:00:00Z`
    })));
  const fixtures = [{ ...upcoming, event: 11 }, { ...upcoming, id: 100, event: 11, team_a: 4 }];
  const dashboard = { ...seasonDashboard(), events, fixtures: [...results, ...fixtures] };
  const { teams: [home, away, , noData], matches } = await createSeasonIndexAnalysis(fpl)(dashboard, fixtures, 11, null, cutoff);
  const sumRates = team => team.goalProbability + team.cleanSheetProbability + team.winOrDrawProbability;
  assert.notEqual(sumRates(home), sumRates(away));
  assert.deepEqual([home.teamIndex, away.teamIndex], [120, 120]);
  assert.equal(matches[0].outcome, 'draw');
  assert.deepEqual(matches[0].eligibleTeamIds, [1, 2]);
  assert.deepEqual([noData.goalProbability, noData.cleanSheetProbability, noData.winOrDrawProbability, noData.teamIndex],
    [null, null, null, null]);
  assert.deepEqual([matches[1].outcome, matches[1].eligibleTeamIds, matches[1].attacking, matches[1].defensive], [null, [], [], []]);
});
