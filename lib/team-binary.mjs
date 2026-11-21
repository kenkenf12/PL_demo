import { completedLeagueMatches, seasonPrediction, seasonResultsBefore, selectSeasonPlayers, selectSquad } from './season-analysis.mjs';
import { estimateSeasonMatchOutcome } from './season-match-outcome.mjs';

export function createSeasonBinaryAnalysis(fpl) {
  return async (dashboard, fixtures, gameweek, previous, asOf = Date.now()) => {
    if (!fixtures.length) return { matches: [], squad: selectSquad([]), completedMatches: 0, sources: [] };

    const { results, seasonStart } = completedLeagueMatches(dashboard, gameweek);
    const teams = new Map(dashboard.teams.map(({ id, name }) => [id, { id, name }]));
    const matches = fixtures.map(fixture => {
      const kickoff = Date.parse(fixture.kickoff_time);
      const cutoff = Number.isFinite(kickoff) ? Math.min(kickoff, asOf) : asOf;
      const prior = seasonResultsBefore(results, seasonStart, cutoff, fixture.id);
      const home = seasonPrediction(teams.get(fixture.team_h), prior);
      const away = seasonPrediction(teams.get(fixture.team_a), prior);
      return { id: fixture.id, kickoff: fixture.kickoff_time, home, away, outcomeAnalysis: estimateSeasonMatchOutcome(home, away) };
    });

    const { squad, sources } = await selectSeasonPlayers(fpl, dashboard, fixtures, gameweek, previous, matches);
    return { matches, squad, completedMatches: results.length, sources };
  };
}
