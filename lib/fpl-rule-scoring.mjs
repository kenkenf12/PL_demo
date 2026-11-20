const thresholdStats = new Set(['goals_conceded', 'saves', 'defensive_contribution']);
const countedStats = new Set(['goals_scored', 'assists', 'clean_sheets', 'penalties_saved', 'penalties_missed',
  'yellow_cards', 'red_cards', 'own_goals', 'bonus']);

function scoreMatch(stats, position, scoring) {
  if (!Array.isArray(stats) || !stats.some(stat => stat?.identifier === 'minutes')) return null;
  let total = 0;
  for (const stat of stats) {
    if (!stat) return null;
    const { identifier, value, points, points_modification } = stat;
    if (!Number.isInteger(points) || !Number.isInteger(value) || value < 0 || points_modification !== 0) return null;
    if (identifier === 'minutes') {
      if (value === 0 && points === 0) continue;
      // The API publishes the short/long appearance award, but no minutes threshold in the configuration.
      if (value > 0 && points === scoring.long_play) total += scoring.long_play;
      else if (value > 0 && points === scoring.short_play) total += scoring.short_play;
      else return null;
      continue;
    }
    const rule = scoring[identifier];
    const weight = typeof rule === 'object' ? rule?.[position] : rule;
    if (!Number.isInteger(weight)) return null;
    if (thresholdStats.has(identifier)) {
      // Use the qualifying units awarded by FPL instead of inferring a threshold from the raw stat.
      const units = weight === 0 && points === 0 ? 0 : points / weight;
      if (!Number.isInteger(units) || units < 0) return null;
      total += units * weight;
    } else {
      const contribution = value * weight;
      if (!countedStats.has(identifier) && contribution !== points) return null;
      total += contribution;
    }
  }
  return total;
}

export function ruleBasedMatchAverage(explain, finishedFixtures, position, scoring) {
  if (!Array.isArray(explain) || !position || !Number.isInteger(scoring?.short_play)
    || !Number.isInteger(scoring?.long_play)) return null;
  const scores = explain.filter(match => finishedFixtures.has(match?.fixture))
    .map(match => scoreMatch(match.stats, position, scoring)).filter(score => score !== null);
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}

export function withRuleBasedHistoricalBenchmark(players, fixtures, previous) {
  const past = new Map(previous?.players.map(player => [player.id, player.fplRuleBasedMatchAverage]));
  const scheduled = new Map();
  for (const { team_h, team_a } of fixtures) {
    for (const team of [team_h, team_a]) scheduled.set(team, (scheduled.get(team) ?? 0) + 1);
  }
  return players.map(player => {
    const average = past.get(player.id);
    const matches = scheduled.get(player.teamId) ?? 0;
    return { ...player, fplRuleBasedHistoricalBenchmark: Number.isFinite(average) ? average * matches : null };
  });
}
