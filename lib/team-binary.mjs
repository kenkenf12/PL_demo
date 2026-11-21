import { createFixturePlayerScorer, loadMatchPlayerEvidence } from './match-winner-strategy.mjs';

const positionGroups = { FWD: 'attacking', MID: 'attacking', DEF: 'defensive', GKP: 'defensive' };
const goalThreshold = 0.5;
const venuePriorMatches = 3;
const emptyVenue = () => ({ matches: 0, scored: 0, conceded: 0 });

function completedLeagueMatches(dashboard, gameweek) {
  const earlier = new Set(dashboard.events.filter(event => event.id < gameweek && event.finished && event.data_checked)
    .map(event => event.id));
  return dashboard.fixtures.filter(fixture => earlier.has(fixture.event) && fixture.finished
    && Number.isInteger(fixture.team_h_score) && fixture.team_h_score >= 0
    && Number.isInteger(fixture.team_a_score) && fixture.team_a_score >= 0);
}

function goalEvidence(teams, matches) {
  const clubs = new Map(teams.map(team => [team.id, { home: emptyVenue(), away: emptyVenue() }]));
  const scored = { home: 0, away: 0 };
  for (const match of matches) {
    const homeScored = Number(match.team_h_score > 0);
    const awayScored = Number(match.team_a_score > 0);
    scored.home += homeScored;
    scored.away += awayScored;
    for (const [form, goals, conceded] of [[clubs.get(match.team_h).home, homeScored, awayScored],
      [clubs.get(match.team_a).away, awayScored, homeScored]]) {
      form.matches += 1;
      form.scored += goals;
      form.conceded += conceded;
    }
  }
  const leagueRates = { home: (scored.home + 1) / (matches.length + 2), away: (scored.away + 1) / (matches.length + 2) };
  return { clubs, leagueRates };
}

function goalProbability(attack, defence, leagueRate) {
  const rate = (observed, played) => (observed + venuePriorMatches * leagueRate) / (played + venuePriorMatches);
  return (rate(attack.scored, attack.matches) + rate(defence.conceded, defence.matches)) / 2;
}

function teamPrediction(club, scores, opponentScores) {
  return { ...club, goal: scores >= goalThreshold, cleanSheet: opponentScores < goalThreshold,
    goalProbability: scores, cleanSheetProbability: 1 - opponentScores };
}

function venuePredictions(home, away, { clubs, leagueRates }) {
  const homeForm = clubs.get(home.id).home;
  const awayForm = clubs.get(away.id).away;
  const homeScores = goalProbability(homeForm, awayForm, leagueRates.home);
  const awayScores = goalProbability(awayForm, homeForm, leagueRates.away);
  return { home: teamPrediction(home, homeScores, awayScores), away: teamPrediction(away, awayScores, homeScores) };
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
    || Number(b.priority ?? -1) - Number(a.priority ?? -1)
    || (b.performanceScore ?? 0) - (a.performanceScore ?? 0) || a.id - b.id;
}

export function createTeamBinaryAnalysis(fpl, { seasonBased = false } = {}) {
  return async (dashboard, fixtures, gameweek, previous, asOf = Date.now()) => {
    if (!fixtures.length) return { matches: [], completedMatches: 0, sources: [] };

    const results = completedLeagueMatches(dashboard, gameweek);
    const evidence = seasonBased ? null : goalEvidence(dashboard.teams, results);
    const firstDeadline = Date.parse(dashboard.events.find(event => event.id === 1)?.deadline_time);
    const seasonStart = Number.isFinite(firstDeadline) ? firstDeadline : -Infinity;
    const teams = new Map(dashboard.teams.map(({ id, name }) => [id, { id, name }]));
    const matches = fixtures.map(fixture => {
      const home = teams.get(fixture.team_h);
      const away = teams.get(fixture.team_a);
      const match = { id: fixture.id, kickoff: fixture.kickoff_time };
      if (!seasonBased) return { ...match, ...venuePredictions(home, away, evidence) };

      const kickoff = Date.parse(fixture.kickoff_time);
      const cutoff = Number.isFinite(kickoff) ? Math.min(kickoff, asOf) : asOf;
      const prior = results.filter(result => {
        const playedAt = Date.parse(result.kickoff_time);
        return result.id !== fixture.id && playedAt >= seasonStart && playedAt < cutoff;
      });
      return { ...match, home: seasonPrediction(home, prior), away: seasonPrediction(away, prior) };
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
          const priorityField = group === 'attacking' ? 'goal' : 'cleanSheet';
          groups[group].push({ id: player.id, name: player.web_name, teamId: team.id, team: team.name,
            position: position.singular_name, positionCode: position.singular_name_short,
            priority: team[seasonBased ? `${priorityField}Probability` : priorityField],
            performanceScore: Number.isFinite(points) ? points : null });
        }
      }
      match.attacking = groups.attacking.sort(comparePlayers);
      match.defensive = groups.defensive.sort(comparePlayers);
    }
    return { matches, completedMatches: results.length, sources };
  };
}
