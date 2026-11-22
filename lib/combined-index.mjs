import { createH2HTeamIndices } from './h2h-index.mjs';
import { indexMatch, indexPoints, selectMatchPlayers } from './match-index.mjs';
import { seasonTeamIndices } from './season-index.mjs';

const average = (first, second) => first === null || second === null ? null : (first + second) / 2;

function combinedTeam(season, h2h) {
  // Average the source index fractions before rounding so mathematically equal averages stay equal.
  const numerator = indexPoints(season) * h2h.completedMatches + indexPoints(h2h) * season.completedMatches;
  const denominator = 2 * season.completedMatches * h2h.completedMatches;
  const hasBoth = season.teamIndex !== null && h2h.teamIndex !== null;
  const team = { id: season.id, name: season.name, seasonTeamIndex: season.teamIndex, h2hTeamIndex: h2h.teamIndex,
    teamIndex: hasBoth ? numerator * 100 / denominator : null,
    goalProbability: average(season.goalProbability, h2h.goalProbability),
    cleanSheetProbability: average(season.cleanSheetProbability, h2h.cleanSheetProbability) };
  return { team, numerator, denominator };
}

export function createCombinedIndexAnalysis(fpl, readH2HIndices = createH2HTeamIndices()) {
  return async (dashboard, fixtures, gameweek, previous, asOf = Date.now()) => {
    const { teams, latestCompletedGameweek } = seasonTeamIndices(dashboard, asOf);
    const seasonByTeam = new Map(teams.map(team => [team.id, team]));
    const evidence = await readH2HIndices(dashboard, fixtures, asOf);
    const matches = evidence.fixtures.map(({ fixture, home: h2hHome, away: h2hAway, meetings }) => {
      const seasonHome = seasonByTeam.get(h2hHome.id);
      const seasonAway = seasonByTeam.get(h2hAway.id);
      const home = combinedTeam(seasonHome, h2hHome);
      const away = combinedTeam(seasonAway, h2hAway);
      const match = indexMatch(fixture, home.team, away.team, () => home.numerator * away.denominator - away.numerator * home.denominator);
      return { ...match, meetings };
    });
    const { squad, sources: playerSources } = await selectMatchPlayers(fpl, dashboard, fixtures, gameweek, previous, matches);
    const sources = new Map([...evidence.sources, ...playerSources].map(source => [source.url, source]));
    return { matches, squad, latestCompletedGameweek, requiredMeetings: evidence.requiredMeetings, sources: [...sources.values()] };
  };
}
