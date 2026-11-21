import { completedLeagueMatches, seasonPrediction, seasonResultsBefore, selectSeasonPlayers } from './season-analysis.mjs';

const indexCount = team => team.goalMatches + team.cleanSheetMatches;

function predictOutcome(home, away) {
  if (!home.completedMatches || !away.completedMatches) return null;
  // Compare the fractions exactly even when the clubs have played different numbers of matches.
  const difference = indexCount(home) * away.completedMatches - indexCount(away) * home.completedMatches;
  return difference === 0 ? 'draw' : difference > 0 ? 'home' : 'away';
}

export function createSeasonIndexAnalysis(fpl) {
  return async (dashboard, fixtures, gameweek, previous, asOf = Date.now()) => {
    const { results, seasonStart, latestCompletedGameweek } = completedLeagueMatches(dashboard);
    const played = seasonResultsBefore(results, seasonStart, asOf);
    const teams = dashboard.teams.map(({ id, name }) => {
      const team = seasonPrediction({ id, name }, played);
      const teamIndex = team.completedMatches ? 100 * indexCount(team) / team.completedMatches : null;
      return { ...team, teamIndex };
    });
    const byTeam = new Map(teams.map(team => [team.id, team]));
    const matches = fixtures.map(({ id, kickoff_time: kickoff, team_h, team_a }) => {
      const home = byTeam.get(team_h);
      const away = byTeam.get(team_a);
      const outcome = predictOutcome(home, away);
      const eligibleTeamIds = { home: [team_h], draw: [team_h, team_a], away: [team_a] }[outcome] ?? [];
      return { id, kickoff, home, away, outcome, eligibleTeamIds };
    });
    const selection = await selectSeasonPlayers(fpl, dashboard, fixtures, gameweek, previous, matches,
      match => [match.home, match.away].filter(team => match.eligibleTeamIds.includes(team.id)));
    return { teams, matches, latestCompletedGameweek, ...selection };
  };
}
