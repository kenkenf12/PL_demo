import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roundRuleBasedPoints, ruleBasedMatchUnits, ruleBasedRateSample, withRuleBasedPredictions } from '../lib/fpl-rule-scoring.mjs';

const scoring = {
  long_play: 2, short_play: 1, goals_scored: { DEF: 6, GKP: 10 }, assists: 3,
  clean_sheets: { DEF: 4, GKP: 4 }, bonus: 1, yellow_cards: -1,
  saves: 1, goals_conceded: { DEF: -1, GKP: -1 }, defensive_contribution: { DEF: 2, GKP: 0 }
};
const fixture = { team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 };
const player = { id: 1, team: 1, element_type: 2, status: 'a', minutes: 540, starts: 6,
  goals_scored: 9, expected_goals: '2.0', assists: 8, expected_assists: '1.0', clean_sheets: 3,
  bonus: 2, yellow_cards: 1, total_points: 900, saves: 999 };
const selected = { id: 1, teamId: 1, predicted: 3.7, previousActualPoints: 999 };
const match = { minutes: 90, clean_sheets: 0, saves: 2, goals_conceded: 0, defensive_contribution: 0, yellow_cards: 0, red_cards: 0 };
const histories = new Map([[player.id, Array.from({ length: 6 }, (_, index) =>
  ({ ...match, clean_sheets: Number(index < 3), yellow_cards: Number(index === 0) }))]]);
const dashboard = {
  players: [player], scoring, positions: [{ id: 2, singular_name_short: 'DEF' }, { id: 1, singular_name_short: 'GKP' }],
  fixtures: Array.from({ length: 6 }, () => ({ ...fixture, finished: true }))
};

function projection(data, fixtures = [fixture]) {
  return withRuleBasedPredictions([selected], data, fixtures, { histories })[0].predictedFplRuleBasedPoints;
}

test('applies position scoring weights to season stats for the selected fixture', () => {
  const [result] = withRuleBasedPredictions([selected], dashboard, [fixture], { histories });
  const appearanceAndOther = 6 * 2 + 2 * 1 - 1;
  const attackAndCleanSheets = 2 * 6 + 1 * 3 + 3 * 4;
  const expected = (appearanceAndOther + attackAndCleanSheets * 1.04) / 6;
  assert.equal(result.predictedFplRuleBasedPoints, Math.round(expected));
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
  assert.equal(projection(halfChance), 3);
  assert.equal(projection(halfChance, [fixture, fixture]), 7);
  const revised = { ...dashboard, players: [{ ...player, total_points: -1000, saves: 0 }] };
  const [result] = withRuleBasedPredictions([{ ...selected, previousActualPoints: -999 }], revised, [fixture], { histories });
  assert.equal(result.predictedFplRuleBasedPoints, normal);
});

test('rounds final forecast totals to whole points and preserves missing data', () => {
  assert.deepEqual([4.49, 4.5, -1.5, -0.4, 0, null].map(roundRuleBasedPoints), [4, 5, -2, 0, 0, null]);
});

test('marks missing rules or playing-time evidence as unavailable', () => {
  assert.equal(projection({ ...dashboard, scoring: null }), null);
  assert.equal(projection({ ...dashboard, players: [{ ...player, minutes: 0 }] }), null);
  assert.equal(withRuleBasedPredictions([selected], dashboard, [fixture])[0].predictedFplRuleBasedPoints, null);
  assert.ok(projection({ ...dashboard, players: [{ ...player, expected_goals: null, expected_assists: null }] }) > projection(dashboard));
});

test('applies the official match thresholds at the boundaries', () => {
  const short = ruleBasedMatchUnits({ ...match, minutes: 59, clean_sheets: 1, defensive_contribution: 9 }, 'DEF');
  assert.equal(short.short_play, 1);
  assert.equal(short.long_play, 0);
  assert.equal(short.clean_sheets, 0);
  assert.equal(short.defensive_contribution, 0);
  const eligible = { ...match, minutes: 60, clean_sheets: 1, saves: 6, goals_conceded: 5, defensive_contribution: 10,
    yellow_cards: 1, red_cards: 1 };
  const defender = ruleBasedMatchUnits(eligible, 'DEF');
  assert.deepEqual(defender, { long_play: 1, short_play: 0, clean_sheets: 1, saves: 2, goals_conceded: 2,
    defensive_contribution: 1, yellow_cards: 0 });
  const absent = ruleBasedMatchUnits({ ...match, minutes: 0 }, 'GKP');
  assert.equal(absent.short_play + absent.long_play, 0);
  assert.equal(ruleBasedMatchUnits(eligible, 'MID').defensive_contribution, 0);
  assert.equal(ruleBasedMatchUnits({ ...eligible, defensive_contribution: 12 }, 'MID').defensive_contribution, 1);
  assert.equal(ruleBasedMatchUnits({ ...eligible, defensive_contribution: 24 }, 'FWD').defensive_contribution, 1);
  assert.equal(ruleBasedMatchUnits({ ...eligible, defensive_contribution: 24 }, 'GKP').defensive_contribution, 0);
});

test('evaluates each fixture before averaging Double Gameweek statistics', () => {
  const matches = [
    { ...match, minutes: 45, saves: 2, goals_conceded: 1, defensive_contribution: 6 },
    { ...match, minutes: 59, saves: 2, goals_conceded: 1, defensive_contribution: 6 }
  ];
  const { rates } = ruleBasedRateSample({ ...player, minutes: 104, starts: 2 }, 2, 'DEF', matches);
  assert.equal(rates.long_play, 0);
  assert.equal(rates.short_play, 1);
  assert.equal(rates.saves, 0);
  assert.equal(rates.goals_conceded, 0);
  assert.equal(rates.defensive_contribution, 0);
});
