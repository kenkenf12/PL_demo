import { createFixturePlayerScorer, loadMatchPlayerEvidence } from './fixture-player-scoring.mjs';

const positionGroups = { FWD: 'attacking', MID: 'attacking', DEF: 'defensive', GKP: 'defensive' };
const squadLimits = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

export function completedLeagueMatches(dashboard, gameweek = Infinity) {
  const earlier = new Set(dashboard.events.filter(event => event.id < gameweek && event.finished && event.data_checked)
    .map(event => event.id));
  const results = dashboard.fixtures.filter(fixture => earlier.has(fixture.event) && fixture.finished
    && Number.isInteger(fixture.team_h_score) && fixture.team_h_score >= 0
    && Number.isInteger(fixture.team_a_score) && fixture.team_a_score >= 0);
  const firstDeadline = Date.parse(dashboard.events.find(event => event.id === 1)?.deadline_time);
  const seasonStart = Number.isFinite(firstDeadline) ? firstDeadline : -Infinity;
  return { results, seasonStart, latestCompletedGameweek: earlier.size ? Math.max(...earlier) : null };
}

export function seasonResultsBefore(results, seasonStart, cutoff, fixtureId) {
  return results.filter(result => {
    const playedAt = Date.parse(result.kickoff_time);
    return result.id !== fixtureId && playedAt >= seasonStart && playedAt < cutoff;
  });
}

export function seasonPrediction(club, results) {
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

export function selectSquad(matches) {
  const byPlayer = new Map();
  for (const match of matches) {
    for (const player of [...match.attacking, ...match.defensive]) {
      if (!byPlayer.has(player.id)) byPlayer.set(player.id, []);
      byPlayer.get(player.id).push(player);
    }
  }
  const candidates = [...byPlayer.values()].map(players => {
    const [player] = players;
    if (players.length === 1) return player;
    const performanceScore = players.every(item => item.performanceScore !== null)
      ? players.reduce((sum, item) => sum + item.performanceScore, 0) : null;
    const priority = players.every(item => item.priority !== null)
      ? players.reduce((sum, item) => sum + item.priority, 0) / players.length : null;
    return { ...player, performanceScore, priority };
  });
  return Object.entries(squadLimits).map(([positionCode, required]) => ({ positionCode, required,
    players: candidates.filter(player => player.positionCode === positionCode).sort(comparePlayers).slice(0, required) }));
}

export async function selectSeasonPlayers(fpl, dashboard, fixtures, gameweek, previous, matches,
  teamsForMatch = match => [match.home, match.away]) {
  const eligible = [];
  for (const match of matches) {
    const teams = teamsForMatch(match);
    if (teams.length) eligible.push({ match, teams });
    else {
      match.attacking = [];
      match.defensive = [];
    }
  }
  if (!eligible.length) return { squad: selectSquad(matches), sources: [] };

  const { reports, sources } = await loadMatchPlayerEvidence(fpl, dashboard, gameweek, previous);
  const scorePlayer = createFixturePlayerScorer(dashboard, fixtures, gameweek, reports);
  const positions = new Map(dashboard.positions.map(position => [position.id, position]));
  const roster = new Map(dashboard.teams.map(team => [team.id, []]));
  for (const player of dashboard.players) roster.get(player.team)?.push(player);

  for (const { match, teams } of eligible) {
    const groups = { attacking: [], defensive: [] };
    for (const team of teams) {
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
  return { squad: selectSquad(matches), sources };
}
