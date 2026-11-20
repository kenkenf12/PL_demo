import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchProbabilities, predictMatchWinners } from '../lib/match-winner-strategy.mjs';

const gameweek = 5;
const positions = ['GKP', 'DEF', 'MID', 'FWD'].map((code, index) => ({
  id: index + 1, singular_name_short: code, singular_name: code
}));
const scoring = {
  long_play: 2, short_play: 1, goals_scored: { GKP: 10, DEF: 6, MID: 5, FWD: 4 }, assists: 3,
  clean_sheets: { GKP: 4, DEF: 4, MID: 1, FWD: 0 }, goals_conceded: { GKP: -1, DEF: -1, MID: 0, FWD: 0 },
  defensive_contribution: { GKP: 0, DEF: 2, MID: 2, FWD: 2 }, saves: 1, own_goals: -2,
  penalties_saved: 5, penalties_missed: -2, yellow_cards: -1, red_cards: -3, bonus: 1
};
const teams = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `Club ${index + 1}` }));
const baseStats = { starts: 4, minutes: 360, expected_goals: '0.5', expected_assists: '0.5', bonus: 1,
  own_goals: 0, penalties_saved: 0, penalties_missed: 0, red_cards: 0 };
const players = teams.flatMap(team => [...positions, positions[1]].map((position, index) => ({
  ...baseStats, id: team.id * 10 + index, team: team.id, web_name: `Player ${team.id}/${index}`,
  element_type: position.id, status: 'a', expected_goals: index === 4 ? '4.0' : baseStats.expected_goals
})));
const played = Array.from({ length: 4 }, (_, index) => index + 1);
const league = played.flatMap(event => [1, 3, 5, 7, 9].map(strongTeam => {
  const strongHome = event % 2 === 0;
  return { id: event * 100 + strongTeam, event, finished: true, kickoff_time: `2026-08-${10 + event}T15:00:00Z`,
    team_h: strongHome ? strongTeam : strongTeam + 1, team_a: strongHome ? strongTeam + 1 : strongTeam,
    team_h_score: strongHome ? 4 : 1, team_a_score: strongHome ? 1 : 4 };
}));
const upcoming = [1, 3, 5, 7].map(team => ({
  id: 500 + team, event: gameweek, team_h: team, team_a: team + 1, kickoff_time: '2026-08-19T15:00:00Z'
}));
const dashboard = { teams, players, positions, scoring, fixtures: [...league, ...upcoming],
  events: [...played.map(id => ({ id, finished: true, data_checked: true })), { id: gameweek }] };
const reports = [2, 3, 4].map(event => ({
  event, players: players.map(player => ({
    ...player, starts: 1, minutes: 90, expected_goals: player.expected_goals === '4.0' ? '1.0' : '0.125',
    expected_assists: '0.125', bonus: 0, scoringMatches: [{ minutes: 90, yellow_cards: 0, red_cards: 0,
      clean_sheets: 0, goals_conceded: 1, defensive_contribution: 0, saves: player.element_type === 1 ? 4 : 0 }]
  }))
}));

test('provides coherent score, win, draw and clean-sheet probabilities', () => {
  const home = matchProbabilities(2.6, 0.7);
  assert.equal(home.outcome, 'home');
  assert.ok(home.score.home > home.score.away);
  assert.ok(home.probabilities.home > home.probabilities.away);
  assert.equal(home.cleanSheets.home, Math.exp(-0.7));
  assert.equal(home.cleanSheets.away, Math.exp(-2.6));
  assert.ok(Math.abs(Object.values(home.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  const away = matchProbabilities(0.7, 2.6);
  assert.equal(away.outcome, 'away');
  assert.ok(away.score.home < away.score.away);
  const draw = matchProbabilities(0.35, 0.35);
  assert.equal(draw.outcome, 'draw');
  assert.equal(draw.score.home, draw.score.away);
});

test('takes one highest-projected player per position, ranks unique players and assigns captaincy', () => {
  const secondMatch = { ...upcoming[0], id: 510, team_a: 10 };
  const result = predictMatchWinners(dashboard, [...upcoming, secondMatch], gameweek, reports);
  assert.equal(result.matches.length, 5);
  for (const match of result.matches) {
    assert.equal(match.winner.id, match.home.id);
    assert.deepEqual(match.picks.map(player => player.positionCode), ['GKP', 'DEF', 'MID', 'FWD']);
    assert.ok(match.picks.every(player => player.teamId === match.winner.id && Number.isInteger(player.predicted)));
    assert.equal(match.picks[1].id, match.home.id * 10 + 4);
  }
  assert.equal(result.candidateCount, 16);
  assert.equal(result.players.length, 15);
  assert.equal(new Set(result.players.map(player => player.id)).size, 15);
  assert.ok(result.players.filter(player => player.teamId === 1).every(player => player.fixtures === 2));
  assert.equal(result.captain, result.players[0].id);
  assert.equal(result.viceCaptain, result.players[1].id);
  assert.ok(result.players.every((player, index) => index === 0 || player.predicted <= result.players[index - 1].predicted));
});

test('reports unavailable data and position gaps without adding players from other teams', () => {
  const incomplete = { ...dashboard, players: players.filter(player => !(player.team === 1 && player.element_type === 4)) };
  const report = predictMatchWinners(incomplete, upcoming.slice(0, 1), gameweek, reports);
  assert.deepEqual(report.matches[0].missingPositions, ['FWD']);
  assert.equal(report.players.length, 3);
  assert.ok(report.players.every(player => player.teamId === 1));
  const noResults = predictMatchWinners({ ...dashboard, fixtures: [] }, upcoming, gameweek, reports);
  assert.ok(noResults.matches.every(match => match.reason && match.picks.length === 0));
  assert.equal(noResults.players.length, 0);
  const noPlayerData = predictMatchWinners(dashboard, upcoming, gameweek, []);
  assert.ok(noPlayerData.matches.every(match => match.score && match.picks.length === 0));
  assert.equal(noPlayerData.captain, null);
  const tiedLeague = { ...dashboard, fixtures: league.map(fixture => ({ ...fixture, team_h_score: 1, team_a_score: 1 })) };
  const draw = predictMatchWinners(tiedLeague, upcoming, gameweek, reports);
  assert.ok(draw.matches.every(match => match.score.home === match.score.away && match.winner === null && !match.picks.length));
});
