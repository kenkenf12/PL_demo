import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixturePlayerScorer } from '../lib/fixture-player-scoring.mjs';

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

test('preserves shared fixture projections across both clubs and all positions', () => {
  const score = createFixturePlayerScorer(dashboard, upcoming, gameweek, reports);
  const expected = [5.60840944979024, 3.990966649243365, 3.6198209606129224, 3.2305249009570303, 10.474116054985549,
    2.811503746136032, 1.4300369658778047, 2.934643771060124, 2.817566865451898, 5.435438158589194];
  for (const [index, value] of expected.entries()) {
    const projection = score(players[index], upcoming[0].id);
    assert.ok(Number.isFinite(projection) && Math.abs(projection - value) < 1e-12);
  }
  assert.equal(score(players[10], upcoming[0].id), null);
});

test('returns unavailable projections when fixture or player evidence is missing', () => {
  const noResults = createFixturePlayerScorer({ ...dashboard, fixtures: [] }, upcoming, gameweek, reports);
  const noPlayerData = createFixturePlayerScorer(dashboard, upcoming, gameweek, []);
  const noKickoff = createFixturePlayerScorer(dashboard, [{ ...upcoming[0], kickoff_time: null }], gameweek, reports);
  for (const score of [noResults, noPlayerData, noKickoff]) assert.equal(score(players[0], upcoming[0].id), null);
});
