import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createH2HIndexAnalysis } from '../lib/h2h-index.mjs';
import { createApiHandler } from '../lib/http.mjs';
import { predictionService } from '../lib/predictions.mjs';

const gameweek = 12;
const kickoff = '2026-11-28T15:00:00Z';
const deadline = '2026-11-28T13:30:00Z';
const asOf = Date.parse('2026-11-27T09:00:00Z');
const teams = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, name: `Club ${index + 1}` }));
const positions = ['GKP', 'DEF', 'MID', 'FWD'].map((singular_name_short, index) =>
  ({ id: index + 1, singular_name: singular_name_short, singular_name_short }));
const players = teams.flatMap(team => positions.flatMap(position => [1, 2].map(copy => ({
  id: team.id * 100 + position.id * 10 + copy, team: team.id, element_type: position.id, web_name: `${team.name} player ${position.id}/${copy}`
}))));
const fixtures = [[1, 2], [3, 4], [5, 6], [1, 7]].map(([team_h, team_a], index) =>
  ({ id: 51 + index, event: gameweek, team_h, team_a, kickoff_time: kickoff }));
const dashboard = { teams, positions, players, sources: [], events: [
  { id: 1, finished: true, data_checked: true, deadline_time: '2026-08-01T12:00:00Z' }, { id: gameweek, deadline_time: deadline }
], fixtures: [...fixtures, { ...fixtures[0], id: 1, event: 1, kickoff_time: '2026-08-01T15:00:00Z',
  team_h_score: 0, team_a_score: 1, finished: true }] };

function sides(home, away, homeGoals, awayGoals) {
  return [
    { homeAway: 'home', team: { id: String(100 + home), displayName: `Club ${home}` }, score: homeGoals },
    { homeAway: 'away', team: { id: String(100 + away), displayName: `Club ${away}` }, score: awayGoals }
  ];
}

function pastMeetings(fixture, scores) {
  return scores.map(([homeGoals, awayGoals], index) => ({
    id: String(fixture.id * 100 + index), date: `${2026 - index}-08-15T15:00:00Z`,
    statusType: { completed: true }, competitionName: 'League',
    competitors: index % 2 ? sides(fixture.team_a, fixture.team_h, String(awayGoals), String(homeGoals))
      : sides(fixture.team_h, fixture.team_a, String(homeGoals), String(awayGoals))
  }));
}

function provider(fixtures, records, requests) {
  return async input => {
    const url = new URL(input);
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/scoreboard')) {
      return Response.json({ events: fixtures.map(fixture => ({ id: String(fixture.id + 900), date: fixture.kickoff_time,
        competitions: [{ competitors: sides(fixture.team_h, fixture.team_a) }] })) });
    }
    const events = records.get(Number(url.searchParams.get('event')) - 900);
    return events ? Response.json({ seasonseries: [{ type: 'head-to-head', events }] }) : new Response(null, { status: 503 });
  };
}

test('compares the latest three verified meetings and runs the shared squad selection in analysis and preview', async () => {
  const [first, second, third, partial] = fixtures;
  const [latest, reverse, next, fourth, older] = pastMeetings(first, [[1, 0], [1, 4], [1, 3], [0, 1], [0, 2]]);
  const partialMeetings = pastMeetings(partial, [[1, 0], [0, 0]]);
  const records = new Map([
    [first.id, [older, next, latest, reverse, latest, fourth,
      { ...latest, id: '601', date: '2026-11-27T12:00:00Z' },
      { ...latest, id: '602', date: '2026-09-15T15:00:00Z', statusType: { completed: false } },
      { ...latest, id: '603', date: '2026-10-15T15:00:00Z', competitors: sides(1, 3, 4, 0) },
      { ...latest, id: '604', date: '2026-10-16T15:00:00Z', competitors: sides(1, 2, null, 0) },
      { ...latest, id: String(first.id + 900) }]],
    [second.id, pastMeetings(second, [[0, 1], [0, 1], [1, 1], [0, 2]])],
    [third.id, pastMeetings(third, [[1, 1], [2, 0], [0, 1], [1, 1]])],
    [partial.id, partialMeetings]
  ]);
  const requests = [];
  let now = asOf;
  const fpl = { getDashboard: async () => dashboard, getLive: async () => null };
  const history = { read: async () => [], update: async () => assert.fail('H2H Index wrote prediction history') };
  const h2hIndex = createH2HIndexAnalysis(fpl, provider(fixtures, records, requests));
  const api = createApiHandler(fpl, predictionService(fpl, { h2hIndex, history, now: () => now }));
  const url = (path, parameters) => new URL(`http://localhost/api/${path}?${new URLSearchParams(parameters)}`);
  const { token } = await (await api('POST', url('prediction-data', { gameweek }))).json();
  const query = { gameweek, token, strategy: 'h2h-index' };
  const response = await api('POST', url('predictions', query));
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.strategy, 'h2h-index');
  assert.equal(report.requiredMeetings, 3);
  const [homeWin, awayWin, draw, noPrediction] = report.matches;
  assert.deepEqual(homeWin.meetings.map(meeting => meeting.id), [latest.id, reverse.id, next.id]);
  const rates = team => [team.goalProbability, team.cleanSheetProbability, team.teamIndex];
  assert.deepEqual(report.matches.map(match => [rates(match.home), rates(match.away), match.outcome, match.eligibleTeamIds]), [
    [[1, 1 / 3, 400 / 3], [2 / 3, 0, 200 / 3], 'home', [1]],
    [[1 / 3, 0, 100 / 3], [1, 2 / 3, 500 / 3], 'away', [4]],
    [[2 / 3, 1 / 3, 100], [2 / 3, 1 / 3, 100], 'draw', [5, 6]],
    [[null, null, null], [null, null, null], null, []]
  ]);
  assert.equal(noPrediction.meetings.length, 2);
  for (const match of [homeWin, awayWin, draw, noPrediction]) {
    assert.deepEqual(new Set(match.attacking.map(player => player.teamId)), new Set(match.eligibleTeamIds));
    assert.deepEqual(new Set(match.defensive.map(player => player.teamId)), new Set(match.eligibleTeamIds));
    assert.ok(match.attacking.every(player => player.priority === match[player.teamId === match.home.id ? 'home' : 'away'].goalProbability));
    assert.ok(match.defensive.every(player => player.priority === match[player.teamId === match.home.id ? 'home' : 'away'].cleanSheetProbability));
  }
  assert.deepEqual(report.squad.map(({ positionCode, players }) => [positionCode, players.length]),
    [['GKP', 2], ['DEF', 5], ['MID', 5], ['FWD', 3]]);
  assert.equal(new Set(report.squad.flatMap(group => group.players.map(player => player.id))).size, 15);
  assert.equal(report.sources.length, 5);
  assert.equal(requests.filter(path => path.includes('/scoreboard')).length, 1);

  now = Date.parse('2026-11-28T14:00:00Z');
  const preview = await api('POST', url('prediction-preview', query));
  assert.equal(preview.status, 200);
  const previewReport = await preview.json();
  assert.deepEqual(previewReport.preview, { fixtureCount: 4 });
  assert.deepEqual(previewReport.matches.map(match => match.id), fixtures.map(fixture => fixture.id));
  assert.deepEqual(previewReport.matches[0].meetings.map(meeting => meeting.id), ['601', latest.id, reverse.id]);
  assert.equal(requests.length, 5);
});

test('leaves a fixture unpredicted when its head-to-head feed fails', async () => {
  const [fixture] = fixtures;
  const fpl = { getLive: () => assert.fail('There were no eligible clubs to score') };
  const analyse = createH2HIndexAnalysis(fpl, provider([fixture], new Map(), []));
  const { matches: [match], squad } = await analyse(dashboard, [fixture], gameweek, null, asOf);
  assert.deepEqual([match.meetings, match.outcome, match.home.teamIndex, match.away.teamIndex], [[], null, null, null]);
  assert.deepEqual(squad.flatMap(group => group.players), []);
});
