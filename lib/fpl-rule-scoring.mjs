import { availability, fixtureFactor } from '../public/model.mjs';

const otherScoredStats = ['own_goals', 'penalties_saved', 'penalties_missed', 'red_cards', 'bonus'];
const fixtureAdjustedStats = ['goals_scored', 'assists', 'clean_sheets'];
const matchScoredStats = ['long_play', 'short_play', 'clean_sheets', 'saves', 'goals_conceded', 'defensive_contribution', 'yellow_cards'];
const scoringStats = [...new Set([...matchScoredStats, ...fixtureAdjustedStats, ...otherScoredStats])];
// FPL publishes these thresholds separately from the point weights in game_config.scoring.
// https://fantasy.premierleague.com/en/help/rules
const fullAppearance = 60;
const savesPerPoint = 3;
const concededPerDeduction = 2;
const defensiveThresholds = { DEF: 10, MID: 12, FWD: 12 };

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

export function ruleBasedMatchUnits(match, position) {
  const minutes = stat(match.minutes);
  const cleanSheets = stat(match.clean_sheets);
  const saves = stat(match.saves);
  const conceded = stat(match.goals_conceded);
  const contributions = stat(match.defensive_contribution);
  const threshold = defensiveThresholds[position];
  return {
    long_play: minutes === null ? null : Number(minutes >= fullAppearance),
    short_play: minutes === null ? null : Number(minutes > 0 && minutes < fullAppearance),
    // The API tracks clean sheets and concessions while the player is responsible, including dismissals.
    clean_sheets: minutes === null || cleanSheets === null ? null : Number(minutes >= fullAppearance && cleanSheets > 0),
    saves: saves === null ? null : Math.floor(saves / savesPerPoint),
    goals_conceded: conceded === null ? null : Math.floor(conceded / concededPerDeduction),
    defensive_contribution: !threshold ? 0 : contributions === null ? null : Number(contributions >= threshold),
    yellow_cards: stat(match.red_cards) > 0 ? 0 : stat(match.yellow_cards)
  };
}

export function ruleBasedRateSample(player, played, position, scoringMatches = player?.scoringMatches ?? []) {
  const minutes = stat(player?.minutes);
  if (minutes === null) return null;
  const matches = Math.max(played, scoringMatches.length, stat(player.starts) ?? 0, Math.ceil(minutes / 90));
  if (!matches) return null;
  const totals = {
    goals_scored: stat(player.expected_goals) ?? stat(player.goals_scored),
    assists: stat(player.expected_assists) ?? stat(player.assists),
    ...Object.fromEntries(otherScoredStats.map(name => [name, stat(player[name])]))
  };
  const rates = Object.fromEntries(Object.entries(totals)
    .filter(([, amount]) => amount !== null).map(([name, amount]) => [name, amount / matches]));
  const units = scoringMatches.map(match => ruleBasedMatchUnits(match, position));
  for (const name of matchScoredStats) {
    const observed = units.map(match => match[name]).filter(Number.isFinite);
    if (observed.length) rates[name] = observed.reduce((sum, value) => sum + value, 0) / observed.length;
  }
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
  const core = scoringStats.filter(name => !otherScoredStats.includes(name)).map(points);
  if (core.includes(null)) return null;
  const adjusted = fixtureAdjustedStats.reduce((sum, name) => sum + points(name), 0);
  const fixed = scoringStats.filter(name => !fixtureAdjustedStats.includes(name))
    .reduce((sum, name) => sum + (points(name) ?? 0), 0);
  const fixturePoints = scheduled.reduce((sum, factor) => sum + fixed + adjusted * factor, 0);
  return fixturePoints * availability(player);
}

export function withRuleBasedPredictions(players, dashboard, fixtures, { strategy = 'ranking', previous, recent, histories } = {}) {
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
    const position = positions.get(stats.element_type);
    const baseline = sample?.minutes > 0
      ? ruleBasedRateSample(sample, played.get(stats.team) ?? 0, position, histories?.get(player.id))?.rates : null;
    const rates = strategy === 'recent' ? recentRates(baseline, recent?.ruleBased?.[player.id]) : baseline;
    const points = projectPlayer(stats, position, dashboard.scoring, rates, scheduled.get(stats.team) ?? []);
    return { ...player, predictedFplRuleBasedPoints: points };
  });
}
