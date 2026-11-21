import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateSeasonMatchOutcome } from '../lib/season-match-outcome.mjs';

function seasonRates(goalProbability, cleanSheetProbability) {
  return Object.freeze({ goalProbability, noGoalProbability: 1 - goalProbability,
    cleanSheetProbability, noCleanSheetProbability: 1 - cleanSheetProbability });
}

function tenthsTotal(report) {
  return Object.values(report.percentages).reduce((sum, percentage) => sum + Math.round(percentage * 10), 0);
}

test('considers both defences instead of picking the club with the higher goal rate', () => {
  const report = estimateSeasonMatchOutcome(seasonRates(0.8, 0), seasonRates(0.7, 0.9));
  assert.deepEqual(report, { percentages: { home: 19.5, draw: 21, away: 59.5 }, mostLikely: ['away'],
    predictedOutcome: 'away', uncertain: false });
});

test('finds a leading draw when both clubs are unlikely to score', () => {
  const report = estimateSeasonMatchOutcome(seasonRates(0.2, 0.8), seasonRates(0.2, 0.8));
  assert.deepEqual(report.mostLikely, ['draw']);
  assert.equal(report.predictedOutcome, 'draw');
  assert.equal(report.uncertain, false);
  assert.ok(report.percentages.draw > report.percentages.home && report.percentages.draw > report.percentages.away);
  assert.equal(tenthsTotal(report), 1000);
});

test('flags uncertainty when the both-score scenario could change the leading result', () => {
  const report = estimateSeasonMatchOutcome(seasonRates(0.9, 0.45), seasonRates(0.65, 0.55));
  assert.deepEqual(report.mostLikely, ['home']);
  assert.equal(report.predictedOutcome, 'home');
  assert.ok(report.percentages.home > report.percentages.draw);
  assert.equal(report.uncertain, true);
  assert.equal(tenthsTotal(report), 1000);
});

test('predicts a draw when home and away wins tie for the lead and keeps their estimated percentages', () => {
  const report = estimateSeasonMatchOutcome(seasonRates(0.8, 0.2), seasonRates(0.8, 0.2));
  assert.deepEqual(report.mostLikely, ['home', 'away']);
  assert.equal(report.predictedOutcome, 'draw');
  assert.ok(report.percentages.home > report.percentages.draw && report.percentages.away > report.percentages.draw);
  assert.equal(report.uncertain, true);
  assert.equal(tenthsTotal(report), 1000);
});

test('reports a three-way tie even if rounding allocates an extra tenth of a percent', () => {
  const report = estimateSeasonMatchOutcome(seasonRates(1, 0), seasonRates(1, 0));
  assert.deepEqual(report.percentages, { home: 33.4, draw: 33.3, away: 33.3 });
  assert.deepEqual(report.mostLikely, ['home', 'draw', 'away']);
  assert.equal(report.predictedOutcome, null);
  assert.equal(report.uncertain, true);
  assert.equal(tenthsTotal(report), 1000);
});

test('marks an estimate unavailable when one club has missing or inconsistent rates', () => {
  const opponent = seasonRates(0.7, 0.3);
  const missing = { goalProbability: null, noGoalProbability: null, cleanSheetProbability: null, noCleanSheetProbability: null };
  const invalid = { ...opponent, noGoalProbability: 0 };
  for (const team of [missing, invalid]) {
    assert.deepEqual(estimateSeasonMatchOutcome(team, opponent),
      { percentages: null, mostLikely: [], predictedOutcome: null, uncertain: true });
  }
});
