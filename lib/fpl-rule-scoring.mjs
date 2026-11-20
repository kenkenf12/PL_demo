import { availability, fixtureFactor } from '../public/model.mjs';

const otherScoredStats = ['own_goals', 'penalties_saved', 'penalties_missed', 'yellow_cards', 'red_cards', 'bonus'];
const fixtureAdjustedStats = ['goals_scored', 'assists', 'clean_sheets'];
const scoringStats = ['long_play', 'short_play', ...fixtureAdjustedStats, ...otherScoredStats];

function stat(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function applyWeight(scoring, position, name, amount) {
  const rule = scoring?.[name];
  const weight = typeof rule === 'number' ? rule : rule?.[position];
  if (!Number.isFinite(weight)) return null;
  return weight === 0 ? 0 : Number.isFinite(amount) ? amount * weight : null;
}

export function ruleBasedRateSample(player, played) {
  const minutes = stat(player?.minutes);
  const starts = stat(player?.starts);
  if (minutes === null || starts === null) return null;
  const matches = Math.max(played, starts, Math.ceil(minutes / 90));
  if (!matches) return null;
  // Starts approximate long appearances. Extra minutes contribute short-play exposure in match equivalents.
  const shortPlay = Math.min(matches - starts, Math.max(0, minutes / 90 - starts));
  const totals = {
    long_play: starts, short_play: shortPlay,
    goals_scored: stat(player.expected_goals) ?? stat(player.goals_scored),
    assists: stat(player.expected_assists) ?? stat(player.assists),
    clean_sheets: stat(player.clean_sheets),
    ...Object.fromEntries(otherScoredStats.map(name => [name, stat(player[name])]))
  };
  const rates = Object.fromEntries(Object.entries(totals)
    .filter(([, amount]) => amount !== null).map(([name, amount]) => [name, amount / matches]));
  return { rates, matches };
}

export function addRuleBasedRates(samples, id, rates, weight) {
  for (const [name, rate] of Object.entries(rates)) {
    if (!Number.isFinite(rate)) continue;
    const player = samples[id] ??= {};
    const component = player[name] ??= { total: 0, weight: 0 };
    component.total += rate * weight;
    component.weight += weight;
  }
}

function recentRates(season, samples) {
  if (!samples) return season;
  return Object.fromEntries(scoringStats.map(name => {
    const component = samples[name];
    const form = component?.weight > 0 ? component.total / component.weight : null;
    const baseline = season?.[name];
    return [name, form == null ? baseline : baseline == null ? form : 0.65 * form + 0.35 * baseline];
  }));
}

function projectPlayer(player, position, scoring, rates, scheduled) {
  if (!scheduled.length) return 0;
  if (!rates) return null;
  const points = name => applyWeight(scoring, position, name, rates[name]);
  const required = ['long_play', 'short_play', ...fixtureAdjustedStats].map(points);
  if (required.includes(null)) return null;
  const [longPlay, shortPlay, goals, assists, cleanSheets] = required;
  const other = otherScoredStats.reduce((sum, name) => sum + (points(name) ?? 0), 0);
  const fixturePoints = scheduled.reduce((sum, factor) => sum + longPlay + shortPlay + other
    + (goals + assists + cleanSheets) * factor, 0);
  return fixturePoints * availability(player);
}

export function withRuleBasedPredictions(players, dashboard, fixtures, { strategy = 'ranking', previous, recent } = {}) {
  const roster = new Map(dashboard.players.map(player => [player.id, player]));
  const positions = new Map(dashboard.positions.map(position => [position.id, position.singular_name_short]));
  const prior = new Map(previous?.players.map(player => [player.id, player]));
  const played = new Map();
  for (const fixture of dashboard.fixtures) {
    if (fixture.finished || fixture.finished_provisional) {
      if (strategy === 'previous' && fixture.event !== previous?.event) continue;
      for (const team of [fixture.team_h, fixture.team_a]) played.set(team, (played.get(team) ?? 0) + 1);
    }
  }
  const scheduled = new Map();
  for (const fixture of fixtures) {
    for (const [team, difficulty, home] of [[fixture.team_h, fixture.team_h_difficulty, true],
      [fixture.team_a, fixture.team_a_difficulty, false]]) {
      if (!scheduled.has(team)) scheduled.set(team, []);
      scheduled.get(team).push(fixtureFactor(difficulty, home));
    }
  }

  return players.map(player => {
    const stats = roster.get(player.id);
    if (!stats) return { ...player, predictedFplRuleBasedPoints: null };
    const sample = strategy === 'previous' ? prior.get(player.id) : stats;
    const baseline = sample?.minutes > 0 ? ruleBasedRateSample(sample, played.get(stats.team) ?? 0)?.rates : null;
    const rates = strategy === 'recent' ? recentRates(baseline, recent?.ruleBased?.[player.id]) : baseline;
    const points = projectPlayer(stats, positions.get(stats.element_type), dashboard.scoring, rates, scheduled.get(stats.team) ?? []);
    return { ...player, predictedFplRuleBasedPoints: points };
  });
}
