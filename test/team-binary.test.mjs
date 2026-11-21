import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiHandler } from '../lib/http.mjs';
import { createFixturePlayerScorer } from '../lib/match-winner-strategy.mjs';
import { predictionService } from '../lib/predictions.mjs';
import { createTeamBinaryAnalysis } from '../lib/team-binary.mjs';

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

function dashboardFor(homeGoals, awayGoals) {
  const completed = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, finished: true, data_checked: true }));
  const history = completed.flatMap(({ id }) => {
    const past = { event: id, kickoff_time: `2026-10-${10 + id}T15:00:00Z`, finished: true };
    return [
      { ...past, team_h: 1, team_a: 2, team_h_score: homeGoals, team_a_score: awayGoals },
      { ...past, team_h: 3, team_a: 4, team_h_score: 1, team_a_score: 1 }
    ];
  });
  return { seasonYear: 2026, teams, positions, players, scoring, sources: [], fixtures: [...history, upcoming],
    events: [...completed, { id: gameweek, deadline_time: '2026-10-23T13:30:00Z' }] };
}

function seasonDashboard() {
  const dashboard = dashboardFor(2, 0);
  dashboard.events[0].deadline_time = '2026-10-11T12:00:00Z';
  const results = [
    [1, 1, 3, 1, 0], [1, 2, 4, 1, 0], [2, 4, 1, 2, 0], [2, 3, 2, 2, 1],
    [3, 1, 4, 2, 1], [3, 2, 3, 0, 0], [4, 3, 1, 0, 3], [4, 2, 4, 0, 0],
    [5, 1, 2, 2, 0], [6, 4, 1, 1, 1]
  ].map(([event, team_h, team_a, team_h_score, team_a_score], index) => ({
    id: index + 1, event, team_h, team_a, team_h_score, team_a_score, finished: true,
    kickoff_time: `2026-10-${10 + event}T15:00:00Z`
  }));
  dashboard.fixtures = [...results, upcoming,
    { ...results[0], id: 40, finished: false },
    { ...results[0], id: 41, kickoff_time: '2025-10-11T15:00:00Z' },
    { ...results[0], id: 42, kickoff_time: '2026-10-24T15:00:00Z' },
    { ...results[0], id: 43, event: gameweek },
    { ...results[0], id: 44, team_h_score: null }];
  return dashboard;
}

function playerEvidence(event) {
  return { event, sources: [{ url: `https://fpl.example/${event}` }], players: players.map(player => ({ id: player.id,
    minutes: 90, starts: 1, expected_goals: Number(player.expected_goals) / 6, expected_assists: 1 / 6, red_cards: 0,
    scoringMatches: [{ minutes: 90, saves: 0, yellow_cards: 0, red_cards: 0 }] })) };
}

const fpl = { getLive: async event => playerEvidence(event) };

for (const [description, homeGoals, awayGoals] of [
  ['both teams score', 2, 1], ['only the home team scores', 2, 0],
  ['only the away team scores', 0, 1], ['neither team scores', 0, 0]
]) {
  test(`predicts consistent goals and clean sheets when ${description}`, async () => {
    const report = await createTeamBinaryAnalysis(fpl)(dashboardFor(homeGoals, awayGoals), [upcoming], gameweek);
    const { home, away, attacking, defensive } = report.matches[0];
    assert.deepEqual([home.goal, away.goal], [homeGoals > 0, awayGoals > 0]);
    assert.deepEqual([home.cleanSheet, away.cleanSheet], [!away.goal, !home.goal]);
    assert.equal(home.cleanSheetProbability + away.goalProbability, 1);
    assert.equal(away.cleanSheetProbability + home.goalProbability, 1);
    assert.equal(report.completedMatches, 12);
    assert.deepEqual(attacking.map(player => player.id).sort((a, b) => a - b), [13, 14, 23, 24]);
    assert.deepEqual(defensive.map(player => player.id).sort((a, b) => a - b), [11, 12, 21, 22]);
    const teamsById = new Map([[home.id, home], [away.id, away]]);
    assert.ok(attacking.every(player => player.priority === teamsById.get(player.teamId).goal));
    assert.ok(defensive.every(player => player.priority === teamsById.get(player.teamId).cleanSheet));
  });
}

test('prioritises the relevant team prediction and uses the existing position-specific FPL scores', async () => {
  const dashboard = dashboardFor(2, 0);
  const reports = [6, 5, 4].map(playerEvidence);
  const scorePlayer = createFixturePlayerScorer(dashboard, [upcoming], gameweek, reports);
  const { matches: [match] } = await createTeamBinaryAnalysis(fpl)(dashboard, [upcoming], gameweek, reports[0]);
  for (const group of [match.attacking, match.defensive]) {
    assert.deepEqual(group.map(player => player.teamId), [1, 1, 2, 2]);
    assert.ok(group[0].performanceScore >= group[1].performanceScore);
    assert.ok(group[2].performanceScore >= group[3].performanceScore);
    for (const row of group) {
      const player = players.find(item => item.id === row.id);
      assert.ok(Number.isFinite(row.performanceScore));
      assert.equal(row.performanceScore, scorePlayer(player, upcoming.id));
    }
  }
  assert.ok(match.attacking[2].performanceScore > match.attacking[0].performanceScore);
});

test('uses consistent binary predictions and unavailable scores before any league results exist', async () => {
  const fixture = { ...upcoming, event: 1 };
  const dashboard = { ...dashboardFor(0, 0), fixtures: [fixture], events: [{ id: 1 }] };
  const { matches: [match], completedMatches } = await createTeamBinaryAnalysis({ getLive: () => assert.fail('No completed Gameweeks') })(
    dashboard, [fixture], 1);
  assert.equal(completedMatches, 0);
  for (const team of [match.home, match.away]) {
    assert.equal(team.goalProbability, 0.5);
    assert.equal(team.goal, true);
    assert.equal(team.cleanSheet, false);
  }
  assert.ok([...match.attacking, ...match.defensive].every(player => player.performanceScore === null));
});

test('serves only upcoming fixtures through the independent binary prediction option', async () => {
  const dashboard = dashboardFor(0, 1);
  dashboard.fixtures.push({ ...upcoming, id: 100, started: true });
  const client = { ...fpl, getDashboard: async () => dashboard };
  const history = { read: async () => [], update: async () => assert.fail('The binary analysis wrote prediction history') };
  const api = createApiHandler(client, predictionService(client, { history, now: () => cutoff }));
  const base = 'http://localhost/api/';
  const refresh = await api('POST', new URL(`${base}prediction-data?gameweek=${gameweek}`));
  const { token } = await refresh.json();
  const response = await api('POST', new URL(`${base}predictions?gameweek=${gameweek}&strategy=team-binary&token=${token}`));
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.strategy, 'team-binary');
  assert.deepEqual(report.matches.map(match => match.id), [99]);
  assert.ok(report.matches.every(match => !Object.hasOwn(match, 'outcome') && !Object.hasOwn(match, 'outcomeAnalysis')));
  assert.equal(report.sources.length, 3);
});

test('uses every earlier completed season match across venues and keeps both binary dimensions independent', async () => {
  const dashboard = seasonDashboard();
  const reports = [6, 5, 4].map(playerEvidence);
  const report = await createTeamBinaryAnalysis(fpl, { seasonBased: true })(dashboard, [upcoming], gameweek, reports[0], cutoff);
  const { home, away, attacking, defensive } = report.matches[0];
  assert.deepEqual(home, { id: 1, name: 'Home club', completedMatches: 6,
    goalMatches: 5, noGoalMatches: 1, cleanSheetMatches: 3, noCleanSheetMatches: 3,
    goalProbability: 5 / 6, noGoalProbability: 1 / 6, cleanSheetProbability: 3 / 6, noCleanSheetProbability: 3 / 6 });
  assert.deepEqual(away, { id: 2, name: 'Away club', completedMatches: 5,
    goalMatches: 2, noGoalMatches: 3, cleanSheetMatches: 3, noCleanSheetMatches: 2,
    goalProbability: 2 / 5, noGoalProbability: 3 / 5, cleanSheetProbability: 3 / 5, noCleanSheetProbability: 2 / 5 });
  assert.deepEqual(report.matches[0].outcomeAnalysis,
    { percentages: { home: 43.2, draw: 30.3, away: 26.5 }, mostLikely: ['home'], uncertain: true });
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

test('uses the fixture cutoff and excludes matches from an unchecked Gameweek', async () => {
  const dashboard = seasonDashboard();
  dashboard.events[1].data_checked = false;
  const earlier = { ...upcoming, id: 100, kickoff_time: '2026-10-15T14:00:00Z' };
  const report = await createTeamBinaryAnalysis(fpl, { seasonBased: true })(dashboard, [earlier, upcoming], gameweek, null, cutoff);
  const [first, second] = report.matches;
  assert.deepEqual([first.home.completedMatches, first.away.completedMatches], [3, 3]);
  assert.deepEqual([second.home.completedMatches, second.away.completedMatches], [5, 4]);
});

test('leaves season rates unavailable before the first completed match', async () => {
  const fixture = { ...upcoming, event: 1 };
  const dashboard = { ...dashboardFor(0, 0), fixtures: [fixture], events: [{ id: 1 }] };
  const { matches: [match] } = await createTeamBinaryAnalysis({ getLive: () => assert.fail('No completed Gameweeks') }, { seasonBased: true })(
    dashboard, [fixture], 1, null, cutoff);
  for (const team of [match.home, match.away]) {
    assert.equal(team.completedMatches, 0);
    assert.deepEqual([team.goalProbability, team.noGoalProbability, team.cleanSheetProbability, team.noCleanSheetProbability],
      [null, null, null, null]);
  }
  assert.ok([...match.attacking, ...match.defensive].every(player => player.priority === null));
});

test('serves the season-based strategy through analysis and post-deadline preview', async () => {
  const dashboard = seasonDashboard();
  let time = cutoff;
  const client = { ...fpl, getDashboard: async () => dashboard };
  const history = { read: async () => [], update: async () => assert.fail('The season analysis wrote prediction history') };
  const api = createApiHandler(client, predictionService(client, { history, now: () => time }));
  const base = 'http://localhost/api/';
  const refresh = await api('POST', new URL(`${base}prediction-data?gameweek=${gameweek}`));
  const { token } = await refresh.json();
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
});
