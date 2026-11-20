import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleBasedMatchAverage, withRuleBasedHistoricalBenchmark } from '../lib/fpl-rule-scoring.mjs';

const config = {
  long_play: 2, short_play: 1, goals_scored: { GKP: 10, DEF: 6 }, saves: 1,
  goals_conceded: { GKP: -1, DEF: -1 }, defensive_contribution: { GKP: 0, DEF: 2 }
};
const stat = (identifier, value, points) => ({ identifier, value, points, points_modification: 0 });
const match = (fixture, ...stats) => ({ fixture, stats });
const completed = new Set([1, 2]);

test('uses configured position weights and official threshold outcomes for each completed fixture', () => {
  const explain = [
    match(1, stat('minutes', 90, 2), stat('goals_scored', 1, 6), stat('defensive_contribution', 12, 2),
      stat('goals_conceded', 3, -1)),
    match(2, stat('minutes', 27, 1)),
    match(3, stat('minutes', 90, 2), stat('goals_scored', 4, 24))
  ];
  assert.equal(ruleBasedMatchAverage(explain, completed, 'DEF', config), 5);
  assert.equal(ruleBasedMatchAverage(explain, completed, 'DEF', { ...config, goals_scored: { DEF: 8 } }), 6);
  const goalkeeper = [match(1, stat('minutes', 90, 2), stat('saves', 4, 1), stat('goals_conceded', 2, -1))];
  assert.equal(ruleBasedMatchAverage(goalkeeper, completed, 'GKP', config), 2);
});

test('distinguishes missing scoring data from a confirmed zero', () => {
  const zero = [match(1, stat('minutes', 0, 0))];
  assert.equal(ruleBasedMatchAverage(zero, completed, 'DEF', config), 0);
  assert.equal(ruleBasedMatchAverage(zero, completed, 'DEF', null), null);
  assert.equal(ruleBasedMatchAverage([], completed, 'DEF', config), null);
  const unsupported = [match(1, stat('minutes', 90, 2), stat('unpublished_rule', 1, 5))];
  assert.equal(ruleBasedMatchAverage(unsupported, completed, 'DEF', config), null);
});

test('adds the historical benchmark without changing forecasts and handles doubles and blanks', () => {
  const players = [{ id: 1, teamId: 1, predicted: 3.7 }, { id: 2, teamId: 5, predicted: 0 },
    { id: 3, teamId: 2, predicted: null }, { id: 4, teamId: 2, predicted: 2.1 }];
  const fixtures = [{ team_h: 1, team_a: 2 }, { team_h: 3, team_a: 1 }];
  const previous = { players: [{ id: 1, fplRuleBasedMatchAverage: 5 }, { id: 2, fplRuleBasedMatchAverage: 4 },
    { id: 4, fplRuleBasedMatchAverage: -1 }] };
  const results = withRuleBasedHistoricalBenchmark(players, fixtures, previous);
  assert.deepEqual(results.map(player => player.fplRuleBasedHistoricalBenchmark), [10, 0, null, -1]);
  assert.deepEqual(results.map(({ fplRuleBasedHistoricalBenchmark, ...player }) => player), players);
  const legacy = withRuleBasedHistoricalBenchmark(players, fixtures, { players: [{ id: 1, total_points: 5 }] });
  assert.ok(legacy.every(player => player.fplRuleBasedHistoricalBenchmark === null));
});
