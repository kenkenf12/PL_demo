import { createFixturePlayerScorer, loadMatchPlayerEvidence } from './match-winner-strategy.mjs';
import { estimateSeasonMatchOutcome } from './season-match-outcome.mjs';

const positionGroups = { FWD: 'attacking', MID: 'attacking', DEF: 'defensive', GKP: 'defensive' };

function completedLeagueMatches(dashboard, gameweek) {
  const earlier = new Set(dashboard.events.filter(event => event.id < gameweek && event.finished && event.data_checked)
    .map(event => event.id));
  return dashboard.fixtures.filter(fixture => earlier.has(fixture.event) && fixture.finished
    && Number.isInteger(fixture.team_h_score) && fixture.team_h_score >= 0
    && Number.isInteger(fixture.team_a_score) && fixture.team_a_score >= 0);
}

function seasonPrediction(club, results) {
  let completedMatches = 0;
  let goalMatches = 0;
  let cleanSheetMatches = 0;
  for (const match of results) {
    const home = match.team_h === club.id;
    if (!home && match.team_a !== club.id) continue;
    completedMatches += 1;
    goalMatches += Number((home ? match.team_h_score : match.team_a_score) > 0);
    cleanSheetMatches += Number((home ? match.team_a_score : match.team_h_score) === 0);
  }
  const noGoalMatches = completedMatches - goalMatches;
  const noCleanSheetMatches = completedMatches - cleanSheetMatches;
  const rate = count => completedMatches ? count / completedMatches : null;
  return { ...club, completedMatches, goalMatches, noGoalMatches, cleanSheetMatches, noCleanSheetMatches,
    goalProbability: rate(goalMatches), noGoalProbability: rate(noGoalMatches),
    cleanSheetProbability: rate(cleanSheetMatches), noCleanSheetProbability: rate(noCleanSheetMatches) };
}

function comparePlayers(a, b) {
  return Number(b.performanceScore !== null) - Number(a.performanceScore !== null)
    || (b.priority ?? -1) - (a.priority ?? -1)
    || (b.performanceScore ?? 0) - (a.performanceScore ?? 0) || a.id - b.id;
}

export function createSeasonBinaryAnalysis(fpl) {
  return async (dashboard, fixtures, gameweek, previous, asOf = Date.now()) => {
    if (!fixtures.length) return { matches: [], completedMatches: 0, sources: [] };

    const results = completedLeagueMatches(dashboard, gameweek);
    const firstDeadline = Date.parse(dashboard.events.find(event => event.id === 1)?.deadline_time);
    const seasonStart = Number.isFinite(firstDeadline) ? firstDeadline : -Infinity;
    const teams = new Map(dashboard.teams.map(({ id, name }) => [id, { id, name }]));
    const matches = fixtures.map(fixture => {
      const kickoff = Date.parse(fixture.kickoff_time);
      const cutoff = Number.isFinite(kickoff) ? Math.min(kickoff, asOf) : asOf;
      const prior = results.filter(result => {
        const playedAt = Date.parse(result.kickoff_time);
        return result.id !== fixture.id && playedAt >= seasonStart && playedAt < cutoff;
      });
      const home = seasonPrediction(teams.get(fixture.team_h), prior);
      const away = seasonPrediction(teams.get(fixture.team_a), prior);
      return { id: fixture.id, kickoff: fixture.kickoff_time, home, away, outcomeAnalysis: estimateSeasonMatchOutcome(home, away) };
    });

    const { reports, sources } = await loadMatchPlayerEvidence(fpl, dashboard, gameweek, previous);
    const scorePlayer = createFixturePlayerScorer(dashboard, fixtures, gameweek, reports);
    const positions = new Map(dashboard.positions.map(position => [position.id, position]));
    const roster = new Map(dashboard.teams.map(team => [team.id, []]));
    for (const player of dashboard.players) roster.get(player.team)?.push(player);

    for (const match of matches) {
      const groups = { attacking: [], defensive: [] };
      for (const team of [match.home, match.away]) {
        for (const player of roster.get(team.id)) {
          const position = positions.get(player.element_type);
          const group = positionGroups[position?.singular_name_short];
          if (!group) continue;
          const points = scorePlayer(player, match.id);
          groups[group].push({ id: player.id, name: player.web_name, teamId: team.id, team: team.name,
            position: position.singular_name, positionCode: position.singular_name_short,
            priority: group === 'attacking' ? team.goalProbability : team.cleanSheetProbability,
            performanceScore: Number.isFinite(points) ? points : null });
        }
      }
      match.attacking = groups.attacking.sort(comparePlayers);
      match.defensive = groups.defensive.sort(comparePlayers);
    }
    return { matches, completedMatches: results.length, sources };
  };
}
