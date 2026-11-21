const outcomes = ['home', 'draw', 'away'];
const roundingUnits = 1000;
const tolerance = 1e-12;
const complementary = (yes, no) => Number.isFinite(yes) && Number.isFinite(no) && yes >= 0 && no >= 0
  && yes <= 1 && no <= 1 && Math.abs(yes + no - 1) <= tolerance;

function displayedPercentages(probabilities) {
  const parts = outcomes.map((outcome, index) => {
    const exact = probabilities[outcome] * roundingUnits;
    const units = Math.floor(exact);
    return { outcome, index, units, fraction: exact - units };
  });
  const remaining = roundingUnits - parts.reduce((sum, part) => sum + part.units, 0);
  const remainders = [...parts].sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const part of remainders.slice(0, remaining)) part.units += 1;
  return Object.fromEntries(parts.map(part => [part.outcome, part.units / 10]));
}

export function estimateSeasonMatchOutcome(home, away) {
  if (![home, away].every(team => complementary(team.goalProbability, team.noGoalProbability)
    && complementary(team.cleanSheetProbability, team.noCleanSheetProbability))) {
    return { percentages: null, mostLikely: [], uncertain: true };
  }

  const homeScores = (home.goalProbability + away.noCleanSheetProbability) / 2;
  const homeBlanks = (home.noGoalProbability + away.cleanSheetProbability) / 2;
  const awayScores = (away.goalProbability + home.noCleanSheetProbability) / 2;
  const awayBlanks = (away.noGoalProbability + home.cleanSheetProbability) / 2;
  const bothScore = homeScores * awayScores;
  const fixed = { home: homeScores * awayBlanks, draw: homeBlanks * awayBlanks, away: homeBlanks * awayScores };

  // The binary rates leave goal margins open when both sides score.
  const weights = outcomes.map(outcome => fixed[outcome] + bothScore / outcomes.length);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const probabilities = Object.fromEntries(outcomes.map((outcome, index) => [outcome, weights[index] / total]));
  const ranked = [...outcomes].sort((a, b) => fixed[b] - fixed[a]);
  const leader = fixed[ranked[0]];
  return {
    percentages: displayedPercentages(probabilities),
    mostLikely: outcomes.filter(outcome => leader - fixed[outcome] <= tolerance),
    uncertain: leader - fixed[ranked[1]] <= bothScore + tolerance
  };
}
