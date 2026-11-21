import { createFixturePlayerScorer, loadMatchPlayerEvidence } from './fixture-player-scoring.mjs';

const positionGroups = { FWD: 'attacking', MID: 'attacking', DEF: 'defensive', GKP: 'defensive' };
const squadLimits = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

const indexCount = team => team.goalMatches + team.cleanSheetMatches + team.winOrDrawMatches;

export function calculateTeamIndex(club, results, minimumMatches = 1) {
  let completedMatches = 0;
  let goalMatches = 0;
  let cleanSheetMatches = 0;
  let winOrDrawMatches = 0;
  for (const match of results) {
    const home = match.team_h === club.id;
    if (!home && match.team_a !== club.id) continue;
    const goalsFor = home ? match.team_h_score : match.team_a_score;
    const goalsAgainst = home ? match.team_a_score : match.team_h_score;
    completedMatches += 1;
    goalMatches += Number(goalsFor > 0);
    cleanSheetMatches += Number(goalsAgainst === 0);
    winOrDrawMatches += Number(goalsFor >= goalsAgainst);
  }
  const noGoalMatches = completedMatches - goalMatches;
  const noCleanSheetMatches = completedMatches - cleanSheetMatches;
  const hasSample = completedMatches >= minimumMatches;
  const rate = count => hasSample ? count / completedMatches : null;
  const team = { ...club, completedMatches, goalMatches, noGoalMatches, cleanSheetMatches, noCleanSheetMatches, winOrDrawMatches,
    goalProbability: rate(goalMatches), noGoalProbability: rate(noGoalMatches),
    cleanSheetProbability: rate(cleanSheetMatches), noCleanSheetProbability: rate(noCleanSheetMatches),
    winOrDrawProbability: rate(winOrDrawMatches) };
  return { ...team, teamIndex: hasSample ? 100 * indexCount(team) / completedMatches : null };
}

function predictOutcome(home, away) {
  if (home.teamIndex === null || away.teamIndex === null) return null;
  // Compare the fractions exactly even when the clubs have played different numbers of matches.
  const difference = indexCount(home) * away.completedMatches - indexCount(away) * home.completedMatches;
  return difference === 0 ? 'draw' : difference > 0 ? 'home' : 'away';
}

export function indexMatch({ id, kickoff_time: kickoff }, home, away) {
  const outcome = predictOutcome(home, away);
  const eligibleTeamIds = { home: [home.id], draw: [home.id, away.id], away: [away.id] }[outcome] ?? [];
  return { id, kickoff, home, away, outcome, eligibleTeamIds };
}

function comparePlayers(a, b) {
  return Number(b.performanceScore !== null) - Number(a.performanceScore !== null)
    || (b.priority ?? -1) - (a.priority ?? -1)
    || (b.performanceScore ?? 0) - (a.performanceScore ?? 0) || a.id - b.id;
}

function selectSquad(matches) {
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

export async function selectMatchPlayers(fpl, dashboard, fixtures, gameweek, previous, matches) {
  const eligible = [];
  for (const match of matches) {
    const teams = [match.home, match.away].filter(team => match.eligibleTeamIds.includes(team.id));
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
