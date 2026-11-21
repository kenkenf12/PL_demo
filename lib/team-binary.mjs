import { createFixturePlayerScorer, loadMatchPlayerEvidence } from './match-winner-strategy.mjs';

const positionGroups = { FWD: 'attacking', MID: 'attacking', DEF: 'defensive', GKP: 'defensive' };
const goalThreshold = 0.5;
const venuePriorMatches = 3;
const emptyVenue = () => ({ matches: 0, scored: 0, conceded: 0 });

function goalEvidence(dashboard, gameweek) {
  const earlier = new Set(dashboard.events.filter(event => event.id < gameweek && event.finished && event.data_checked)
    .map(event => event.id));
  const matches = dashboard.fixtures.filter(fixture => earlier.has(fixture.event) && fixture.finished
    && Number.isInteger(fixture.team_h_score) && fixture.team_h_score >= 0
    && Number.isInteger(fixture.team_a_score) && fixture.team_a_score >= 0);
  const clubs = new Map(dashboard.teams.map(team => [team.id, { home: emptyVenue(), away: emptyVenue() }]));
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
  return { clubs, leagueRates, completedMatches: matches.length };
}

function goalProbability(attack, defence, leagueRate) {
  const rate = (observed, played) => (observed + venuePriorMatches * leagueRate) / (played + venuePriorMatches);
  return (rate(attack.scored, attack.matches) + rate(defence.conceded, defence.matches)) / 2;
}

function teamPrediction(club, scores, opponentScores) {
  return { ...club, goal: scores >= goalThreshold, cleanSheet: opponentScores < goalThreshold,
    goalProbability: scores, cleanSheetProbability: 1 - opponentScores };
}

function comparePlayers(a, b) {
  return Number(b.performanceScore !== null) - Number(a.performanceScore !== null)
    || Number(b.priority) - Number(a.priority)
    || (b.performanceScore ?? 0) - (a.performanceScore ?? 0) || a.id - b.id;
}

export function createTeamBinaryAnalysis(fpl) {
  return async (dashboard, fixtures, gameweek, previous) => {
    if (!fixtures.length) return { matches: [], completedMatches: 0, sources: [] };

    const { clubs, leagueRates, completedMatches } = goalEvidence(dashboard, gameweek);
    const teams = new Map(dashboard.teams.map(({ id, name }) => [id, { id, name }]));
    const matches = fixtures.map(fixture => {
      const home = clubs.get(fixture.team_h).home;
      const away = clubs.get(fixture.team_a).away;
      const homeScores = goalProbability(home, away, leagueRates.home);
      const awayScores = goalProbability(away, home, leagueRates.away);
      return { id: fixture.id, kickoff: fixture.kickoff_time,
        home: teamPrediction(teams.get(fixture.team_h), homeScores, awayScores),
        away: teamPrediction(teams.get(fixture.team_a), awayScores, homeScores) };
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
            priority: group === 'attacking' ? team.goal : team.cleanSheet,
            performanceScore: Number.isFinite(points) ? points : null });
        }
      }
      match.attacking = groups.attacking.sort(comparePlayers);
      match.defensive = groups.defensive.sort(comparePlayers);
    }
    return { matches, completedMatches, sources };
  };
}
