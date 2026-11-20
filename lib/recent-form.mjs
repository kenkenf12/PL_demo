import { createMatchReports } from './match-reports.mjs';
import { addRuleBasedRates, ruleBasedRateSample } from './fpl-rule-scoring.mjs';

const day = 86_400_000;
const lookback = 3;

export function createRecentForm(fpl, matchReports = createMatchReports()) {
  return async (input, cutoff) => {
    const { dashboard, week, previous } = input;
    const weeks = dashboard.events.filter(event => event.id < week.id && event.finished && event.data_checked)
      .sort((a, b) => b.id - a.id).slice(0, lookback);
    const [domestic, supplement] = await Promise.all([
      Promise.all(weeks.map(async event => {
        try {
          const report = previous?.event === event.id ? previous : await fpl.getLive(event.id, false, day);
          return report?.players?.length ? report : null;
        } catch {
          return null;
        }
      })),
      (async () => {
        const locations = await fpl.getRegions().catch(() => null);
        const result = await matchReports(dashboard, Array.isArray(locations?.regions) ? locations.regions : [], cutoff);
        return { ...result, sources: [...(locations?.sources ?? []), ...result.sources] };
      })()
    ]);

    const roster = new Map(dashboard.players.map(player => [player.id, player]));
    const performances = {};
    const ruleBased = {};
    function evidence(id) {
      return performances[id] ??= { points: 0, minutes: 0, matchWeight: 0, domesticWeeks: 0,
        cupMatches: 0, europeanMatches: 0, internationalMatches: 0, impact: 0, impactWeight: 0 };
    }

    for (const [index, report] of domestic.entries()) {
      if (!report) continue;
      const played = new Map();
      for (const fixture of dashboard.fixtures) {
        if (fixture.event !== report.event || !fixture.finished) continue;
        for (const club of [fixture.team_h, fixture.team_a]) played.set(club, (played.get(club) ?? 0) + 1);
      }
      const weight = [1, 0.75, 0.55][index];
      for (const record of report.players) {
        const player = roster.get(record.id);
        if (!player || !Number.isInteger(record.minutes)) continue;
        const matches = Math.max(played.get(player.team) ?? 0, Math.ceil(record.minutes / 90));
        const sample = ruleBasedRateSample(record, matches);
        if (sample) addRuleBasedRates(ruleBased, player.id, sample.rates, weight * sample.matches);
        if (!Number.isInteger(record.total_points)) continue;
        if (!matches) continue;
        const recent = evidence(player.id);
        recent.points += weight * record.total_points;
        recent.minutes += weight * record.minutes;
        recent.matchWeight += weight * matches;
        recent.domesticWeeks += 1;
      }
    }

    for (const report of supplement.reports) {
      const age = Math.max(0, (cutoff - report.kickoff) / day);
      const weight = (report.kind === 'international' ? 0.5 : 0.75) / (1 + age / 7);
      for (const [id, match] of report.matches) {
        addRuleBasedRates(ruleBased, id, { goals_scored: match.goals, assists: match.assists, red_cards: match.redCards }, weight);
        const recent = evidence(id);
        if (report.kind === 'cup') recent.cupMatches += 1;
        else if (report.kind === 'european') recent.europeanMatches += 1;
        else recent.internationalMatches += 1;
        // Supplementary stats supply a capped form adjustment, rather than projected FPL scoring rules.
        const contributions = Math.min(2.5, (match.goals ?? 0) + 0.6 * (match.assists ?? 0) + 0.08 * (match.saves ?? 0));
        const impact = (match.starter ? 0.35 : 0.1) + contributions - (match.redCards > 0 ? 0.8 : 0);
        recent.impact += weight * impact;
        recent.impactWeight += weight;
      }
    }

    const official = domestic.filter(Boolean);
    const supported = supplement.reports.filter(report => report.matches.size > 0);
    return {
      performances, ruleBased,
      summary: {
        domesticWeeks: official.map(report => report.event), requestedWeeks: weeks.length,
        ...supplement.coverage, cupReports: supported.filter(report => report.kind === 'cup').length,
        europeanReports: supported.filter(report => report.kind === 'european').length,
        internationalReports: supported.filter(report => report.kind === 'international').length
      },
      sources: [...official.flatMap(report => report.sources), ...supplement.sources, ...supplement.reports.map(report => report.source)]
    };
  };
}

export function recentPlayerForm(player, games, performance) {
  const season = player.minutes > 0 && games > 0 ? player.total_points / games : null;
  const recent = performance?.matchWeight > 0
    ? (0.9 * performance.points + 0.1 * performance.minutes / 60) / performance.matchWeight : null;
  const baseline = recent == null ? season : season == null ? recent : 0.65 * recent + 0.35 * season;
  const supplementaryImpact = performance?.impactWeight
    ? Math.min(1.25, Math.max(-0.5, performance.impact / Math.max(1, performance.impactWeight))) : 0;
  return {
    baseline: baseline == null ? null : baseline + supplementaryImpact,
    minutes: performance?.minutes ?? player.minutes,
    evidence: {
      domesticWeeks: performance?.domesticWeeks ?? 0,
      cupMatches: performance?.cupMatches ?? 0,
      europeanMatches: performance?.europeanMatches ?? 0,
      internationalMatches: performance?.internationalMatches ?? 0
    }
  };
}
