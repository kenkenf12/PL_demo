import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiHandler } from '../lib/http.mjs';
import { createFixturePlayerScorer } from '../lib/fixture-player-scoring.mjs';
import { predictionService } from '../lib/predictions.mjs';
import { createSeasonBinaryAnalysis } from '../lib/team-binary.mjs';

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

test('uses every earlier completed season match across venues and keeps both binary dimensions independent', async () => {
  const dashboard = seasonDashboard();
  const reports = [6, 5, 4].map(event => playerEvidence(event));
  const report = await createSeasonBinaryAnalysis(fpl)(dashboard, [upcoming], gameweek, reports[0], cutoff);
  const { home, away, attacking, defensive } = report.matches[0];
  assert.deepEqual(home, { id: 1, name: 'Home club', completedMatches: 6,
    goalMatches: 5, noGoalMatches: 1, cleanSheetMatches: 3, noCleanSheetMatches: 3,
    goalProbability: 5 / 6, noGoalProbability: 1 / 6, cleanSheetProbability: 3 / 6, noCleanSheetProbability: 3 / 6 });
  assert.deepEqual(away, { id: 2, name: 'Away club', completedMatches: 5,
    goalMatches: 2, noGoalMatches: 3, cleanSheetMatches: 3, noCleanSheetMatches: 2,
    goalProbability: 2 / 5, noGoalProbability: 3 / 5, cleanSheetProbability: 3 / 5, noCleanSheetProbability: 2 / 5 });
  assert.deepEqual(report.matches[0].outcomeAnalysis,
    { percentages: { home: 43.2, draw: 30.3, away: 26.5 }, mostLikely: ['home'], predictedOutcome: 'home', uncertain: true });
  for (const team of [home, away]) {
    assert.equal(team.goalProbability + team.noGoalProbability, 1);
    assert.equal(team.cleanSheetProbability + team.noCleanSheetProbability, 1);
  }
  assert.notEqual(away.cleanSheetProbability, home.noGoalProbability);
  assert.deepEqual(attacking.map(player => player.teamId), [1, 1, 2, 2]);
  assert.deepEqual(defensive.map(player => player.teamId), [2, 2, 1, 1]);
  assert.ok(attacking.every(player => ['MID', 'FWD'].includes(player.positionCode)));
  assert.ok(defensive.every(player => ['GKP', 'DEF'].includes(player.positionCode)));
  const scorePlayer = createFixturePlayerScorer(dashboard, [upcoming], gameweek, reports);
  for (const player of [...attacking, ...defensive]) {
    assert.ok(Number.isFinite(player.performanceScore));
    assert.equal(player.performanceScore, scorePlayer(players.find(item => item.id === player.id), upcoming.id));
  }
});

test('selects 15 unique players by position and uses all of a player’s upcoming fixtures', async () => {
  const dashboard = seasonDashboard();
  const fixtures = [upcoming, { ...upcoming, id: 100, team_h: 3, team_a: 1 }];
  dashboard.fixtures.push(fixtures[1]);
  dashboard.players = players.filter(player => player.team < 3).flatMap(player => Array.from({ length: 4 }, (_, index) => ({
    ...player, id: player.id * 10 + index, expected_goals: String(Number(player.expected_goals) * (index + 1))
  }))).concat(players.filter(player => player.team === 4));
  const evidence = dashboard.players.filter(player => player.id !== 223);
  const client = { getLive: async event => playerEvidence(event, evidence) };
  const { matches, squad } = await createSeasonBinaryAnalysis(client)(dashboard, fixtures, gameweek, null, cutoff);
  assert.deepEqual(squad.map(group => [group.positionCode, group.required, group.players.map(player => player.id)]), [
    ['GKP', 2, [213, 212]], ['DEF', 5, [222, 221, 220, 123, 122]],
    ['MID', 5, [133, 132, 131, 130, 233]], ['FWD', 3, [143, 142, 141]]
  ]);
  const selected = squad.flatMap(group => group.players);
  assert.equal(new Set(selected.map(player => player.id)).size, 15);
  const fixtureRows = matches.flatMap(match => [...match.attacking, ...match.defensive]);
  for (const player of selected) {
    const rows = fixtureRows.filter(row => row.id === player.id);
    assert.equal(rows.length, player.teamId === 1 ? 2 : 1);
    assert.equal(player.performanceScore, rows.reduce((sum, row) => sum + row.performanceScore, 0));
  }
});

test('uses the fixture cutoff and excludes matches from an unchecked Gameweek', async () => {
  const dashboard = seasonDashboard();
  dashboard.events[1].data_checked = false;
  const earlier = { ...upcoming, id: 100, kickoff_time: '2026-10-15T14:00:00Z' };
  const report = await createSeasonBinaryAnalysis(fpl)(dashboard, [earlier, upcoming], gameweek, null, cutoff);
  const [first, second] = report.matches;
  assert.deepEqual([first.home.completedMatches, first.away.completedMatches], [3, 3]);
  assert.deepEqual([second.home.completedMatches, second.away.completedMatches], [5, 4]);
});

test('leaves season rates unavailable before the first completed match', async () => {
  const fixture = { ...upcoming, event: 1 };
  const dashboard = { ...seasonDashboard(), fixtures: [fixture], events: [{ id: 1 }] };
  const { matches: [match], squad } = await createSeasonBinaryAnalysis({ getLive: () => assert.fail('No completed Gameweeks') })(
    dashboard, [fixture], 1, null, cutoff);
  for (const team of [match.home, match.away]) {
    assert.equal(team.completedMatches, 0);
    assert.deepEqual([team.goalProbability, team.noGoalProbability, team.cleanSheetProbability, team.noCleanSheetProbability],
      [null, null, null, null]);
  }
  assert.ok([...match.attacking, ...match.defensive].every(player => player.priority === null));
  assert.deepEqual(squad.map(group => group.required - group.players.length), [0, 3, 3, 1]);
  assert.ok(squad.flatMap(group => group.players).every(player => player.performanceScore === null));
});

test('serves the season-based strategy through analysis and post-deadline preview', async () => {
  const dashboard = seasonDashboard();
  dashboard.fixtures.push({ ...upcoming, id: 100, started: true });
  let time = cutoff;
  const client = { ...fpl, getDashboard: async () => dashboard };
  const history = { read: async () => [], update: async () => assert.fail('The season analysis wrote prediction history') };
  const api = createApiHandler(client, predictionService(client, { history, now: () => time }));
  const base = 'http://localhost/api/';
  const refresh = await api('POST', new URL(`${base}prediction-data?gameweek=${gameweek}`));
  const { token } = await refresh.json();
  const retired = await api('POST', new URL(`${base}predictions?gameweek=${gameweek}&token=${token}&strategy=team-binary`));
  assert.equal(retired.status, 400);
  const query = `?gameweek=${gameweek}&token=${token}&strategy=season-binary`;
  const response = await api('POST', new URL(`${base}predictions${query}`));
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.strategy, 'season-binary');
  assert.deepEqual(report.matches.map(match => match.id), [99]);
  time = Date.parse('2026-10-23T14:00:00Z');
  const previewResponse = await api('POST', new URL(`${base}prediction-preview${query}`));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(preview.preview, { fixtureCount: 1 });
  assert.deepEqual(preview.matches, report.matches);
  assert.deepEqual(preview.squad, report.squad);
});
