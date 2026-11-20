import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRuleBasedPredictions } from '../lib/fpl-rule-scoring.mjs';

const scoring = {
  long_play: 2, short_play: 1, goals_scored: { DEF: 6, GKP: 10 }, assists: 3,
  clean_sheets: { DEF: 4, GKP: 4 }, bonus: 1, yellow_cards: -1
};
const fixture = { team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 };
const player = { id: 1, team: 1, element_type: 2, status: 'a', minutes: 540, starts: 6,
  goals_scored: 9, expected_goals: '2.0', assists: 8, expected_assists: '1.0', clean_sheets: 3,
  bonus: 2, yellow_cards: 1, total_points: 900, saves: 999 };
const selected = { id: 1, teamId: 1, predicted: 3.7, previousActualPoints: 999 };
const dashboard = {
  players: [player], scoring, positions: [{ id: 2, singular_name_short: 'DEF' }, { id: 1, singular_name_short: 'GKP' }],
  fixtures: Array.from({ length: 6 }, () => ({ ...fixture, finished: true }))
};

function projection(data, fixtures = [fixture]) {
  return withRuleBasedPredictions([selected], data, fixtures)[0].predictedFplRuleBasedPoints;
}

test('applies position scoring weights to season stats for the selected fixture', () => {
  const [result] = withRuleBasedPredictions([selected], dashboard, [fixture]);
  const appearanceAndOther = 6 * 2 + 2 * 1 - 1;
  const attackAndCleanSheets = 2 * 6 + 1 * 3 + 3 * 4;
  const expected = (appearanceAndOther + attackAndCleanSheets * 1.04) / 6;
  assert.ok(Math.abs(result.predictedFplRuleBasedPoints - expected) < 1e-12);
  const goalkeeper = { ...dashboard, players: [{ ...player, element_type: 1 }] };
  assert.ok(projection(goalkeeper) > projection(dashboard));
  const { predictedFplRuleBasedPoints, ...original } = result;
  assert.deepEqual(original, selected);
});

test('responds to fixtures and availability independently of past score totals', () => {
  const normal = projection(dashboard);
  const hard = { ...fixture, team_h_difficulty: 5 };
  assert.ok(projection(dashboard, [hard]) < normal);
  assert.equal(projection(dashboard, [fixture, fixture]), normal * 2);
  assert.equal(projection(dashboard, []), 0);
  const halfChance = { ...dashboard, players: [{ ...player, chance_of_playing_next_round: 50 }] };
  assert.equal(projection(halfChance), normal / 2);
  const revised = { ...dashboard, players: [{ ...player, total_points: -1000, saves: 0 }] };
  const [result] = withRuleBasedPredictions([{ ...selected, previousActualPoints: -999 }], revised, [fixture]);
  assert.equal(result.predictedFplRuleBasedPoints, normal);
});

test('marks missing rules or playing-time evidence as unavailable', () => {
  assert.equal(projection({ ...dashboard, scoring: null }), null);
  assert.equal(projection({ ...dashboard, players: [{ ...player, minutes: 0 }] }), null);
  assert.ok(projection({ ...dashboard, players: [{ ...player, expected_goals: null, expected_assists: null }] }) > projection(dashboard));
});
