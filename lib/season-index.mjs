import { calculateTeamIndex, indexMatch, selectMatchPlayers } from './match-index.mjs';

function completedLeagueMatches(dashboard, asOf) {
  const completedWeeks = new Set(dashboard.events.filter(event => event.finished && event.data_checked)
    .map(event => event.id));
  const firstDeadline = Date.parse(dashboard.events.find(event => event.id === 1)?.deadline_time);
  const seasonStart = Number.isFinite(firstDeadline) ? firstDeadline : -Infinity;
  const results = dashboard.fixtures.filter(fixture => {
    const kickoff = Date.parse(fixture.kickoff_time);
    return completedWeeks.has(fixture.event) && fixture.finished && kickoff >= seasonStart && kickoff < asOf
      && Number.isInteger(fixture.team_h_score) && fixture.team_h_score >= 0
      && Number.isInteger(fixture.team_a_score) && fixture.team_a_score >= 0;
  });
  return { results, latestCompletedGameweek: completedWeeks.size ? Math.max(...completedWeeks) : null };
}

export function createSeasonIndexAnalysis(fpl) {
  return async (dashboard, fixtures, gameweek, previous, asOf = Date.now()) => {
    const { results, latestCompletedGameweek } = completedLeagueMatches(dashboard, asOf);
    const teams = dashboard.teams.map(({ id, name }) => calculateTeamIndex({ id, name }, results));
    const byTeam = new Map(teams.map(team => [team.id, team]));
    const matches = fixtures.map(fixture => indexMatch(fixture, byTeam.get(fixture.team_h), byTeam.get(fixture.team_a)));
    const selection = await selectMatchPlayers(fpl, dashboard, fixtures, gameweek, previous, matches);
    return { teams, matches, latestCompletedGameweek, ...selection };
  };
}
