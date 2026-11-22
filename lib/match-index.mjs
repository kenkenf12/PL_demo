import { createFixturePlayerScorer, loadMatchPlayerEvidence } from './fixture-player-scoring.mjs';
import { constrainedSquad } from './squad-constraints.mjs';

const positionGroups = { FWD: 'attacking', MID: 'attacking', DEF: 'defensive', GKP: 'defensive' };
const squadLimits = new Map([['GKP', 2], ['DEF', 5], ['MID', 5], ['FWD', 3]]);

export const indexPoints = team => team.goalMatches + team.cleanSheetMatches + team.winOrDrawPoints;

export function calculateTeamIndex(club, results, minimumMatches = 1) {
  let completedMatches = 0;
  let goalMatches = 0;
  let cleanSheetMatches = 0;
  let wins = 0;
  let draws = 0;
  for (const match of results) {
    const home = match.team_h === club.id;
    if (!home && match.team_a !== club.id) continue;
    const goalsFor = home ? match.team_h_score : match.team_a_score;
    const goalsAgainst = home ? match.team_a_score : match.team_h_score;
    completedMatches += 1;
    goalMatches += Number(goalsFor > 0);
    cleanSheetMatches += Number(goalsAgainst === 0);
    wins += Number(goalsFor > goalsAgainst);
    draws += Number(goalsFor === goalsAgainst);
  }
  const noGoalMatches = completedMatches - goalMatches;
  const noCleanSheetMatches = completedMatches - cleanSheetMatches;
  const winOrDrawMatches = wins + draws;
  const winOrDrawPoints = wins + draws * 0.5;
  const hasSample = completedMatches >= minimumMatches;
  const rate = count => hasSample ? count / completedMatches : null;
  const team = { ...club, completedMatches, goalMatches, noGoalMatches, cleanSheetMatches, noCleanSheetMatches,
    winOrDrawMatches, winOrDrawPoints,
    goalProbability: rate(goalMatches), noGoalProbability: rate(noGoalMatches),
    cleanSheetProbability: rate(cleanSheetMatches), noCleanSheetProbability: rate(noCleanSheetMatches),
    winOrDrawProbability: rate(winOrDrawPoints) };
  return { ...team, teamIndex: hasSample ? 100 * indexPoints(team) / completedMatches : null };
}

function indexDifference(home, away) {
  // Compare the fractions exactly even when the clubs have played different numbers of matches.
  return indexPoints(home) * away.completedMatches - indexPoints(away) * home.completedMatches;
}

function predictOutcome(home, away, compareIndices) {
  if (home.teamIndex === null || away.teamIndex === null) return null;
  const difference = compareIndices(home, away);
  return difference === 0 ? 'draw' : difference > 0 ? 'home' : 'away';
}

export function indexMatch({ id, kickoff_time: kickoff }, home, away, compareIndices = indexDifference) {
  const outcome = predictOutcome(home, away, compareIndices);
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
  const groups = Array.from(squadLimits, ([positionCode, required]) => ({ positionCode, required,
    players: candidates.filter(player => player.positionCode === positionCode).sort(comparePlayers) }));
  const ranked = groups.flatMap(group => group.players.map((player, rank) => ({ player, rank })));
  const clubIds = new Set(candidates.map(player => player.teamId));
  const selected = constrainedSquad(ranked, squadLimits, clubIds, {
    positionOf: ({ player }) => player.positionCode, clubOf: ({ player }) => player.teamId,
    weight: ({ rank }) => -rank, allowPartial: true
  });
  const selectedIds = new Set(selected.map(({ player }) => player.id));
  return groups.map(group => ({ ...group, players: group.players.filter(player => selectedIds.has(player.id)) }));
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
