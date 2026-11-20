import { availability } from '../public/model.mjs';
import { applyWeight, roundRuleBasedPoints, ruleBasedMatchUnits } from './fpl-rule-scoring.mjs';

const day = 86_400_000;
const positions = ['GKP', 'DEF', 'MID', 'FWD'];
const otherStats = ['own_goals', 'penalties_saved', 'penalties_missed', 'red_cards', 'bonus'];
const matchStats = ['saves', 'defensive_contribution', 'yellow_cards'];
const compare = (a, b) => b.points - a.points || a.id - b.id;
const total = values => values.reduce((sum, value) => sum + value, 0);
const finished = event => event.finished && event.data_checked;

function goalDistribution(mean) {
  const probabilities = [Math.exp(-mean)];
  const limit = Math.ceil(mean + 10 * Math.sqrt(mean + 1) + 8);
  for (let goals = 1; goals <= limit; goals += 1) {
    probabilities.push(probabilities[goals - 1] * mean / goals);
  }
  return probabilities;
}

export function matchProbabilities(homeGoals, awayGoals) {
  const home = goalDistribution(homeGoals);
  const away = goalDistribution(awayGoals);
  const probabilities = { home: 0, draw: 0, away: 0 };
  const scores = {};
  for (const [h, homeProbability] of home.entries()) {
    for (const [a, awayProbability] of away.entries()) {
      const outcome = h > a ? 'home' : a > h ? 'away' : 'draw';
      const probability = homeProbability * awayProbability;
      probabilities[outcome] += probability;
      if (!scores[outcome] || probability > scores[outcome].probability) scores[outcome] = { home: h, away: a, probability };
    }
  }
  const normalization = total(Object.values(probabilities));
  for (const key of Object.keys(probabilities)) probabilities[key] /= normalization;
  // Pick the highest-probability outcome and its most probable exact score.
  const { home: winHome, away: winAway, draw } = probabilities;
  const outcome = draw >= Math.max(winHome, winAway) || Math.abs(winHome - winAway) < 1e-12
    ? 'draw' : winHome > winAway ? 'home' : 'away';
  return { outcome, probabilities, score: scores[outcome], cleanSheets: { home: away[0], away: home[0] } };
}

function teamStrengths(clubs, results) {
  const summaries = new Map(clubs.map(team => [team.id, { matches: 0,
    home: { weight: 0, scored: 0, conceded: 0 }, away: { weight: 0, scored: 0, conceded: 0 } }]));
  const latest = Math.max(...results.map(fixture => Date.parse(fixture.kickoff_time)));
  let weight = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  for (const fixture of results) {
    const influence = 2 ** (-(latest - Date.parse(fixture.kickoff_time)) / (45 * day));
    const { team_h, team_a, team_h_score, team_a_score } = fixture;
    weight += influence;
    homeGoals += team_h_score * influence;
    awayGoals += team_a_score * influence;
    for (const [id, side, scored, conceded] of [[team_h, 'home', team_h_score, team_a_score],
      [team_a, 'away', team_a_score, team_h_score]]) {
      const team = summaries.get(id);
      team.matches += 1;
      team[side].weight += influence;
      team[side].scored += influence * scored;
      team[side].conceded += influence * conceded;
    }
  }
  return { summaries, homeMean: homeGoals / weight, awayMean: awayGoals / weight };
}

function forecastMatch(fixture, teams, strengths) {
  const home = teams.get(fixture.team_h);
  const away = teams.get(fixture.team_a);
  const row = { id: fixture.id, kickoff: fixture.kickoff_time, home, away, picks: [], missingPositions: [] };
  if (!Number.isFinite(Date.parse(fixture.kickoff_time))) return { ...row, kickoff: null, reason: 'Kick-off unavailable' };
  const { summaries, homeMean, awayMean } = strengths;
  const homeForm = summaries.get(home.id);
  const awayForm = summaries.get(away.id);
  if (homeForm.matches < 3 || awayForm.matches < 3 || !homeForm.home.weight || !awayForm.away.weight || !(homeMean > 0 && awayMean > 0)) {
    return { ...row, reason: 'Insufficient completed match data' };
  }
  // Shrink venue-specific rates toward three matches at the league average.
  const rate = (sum, weight, average) => (sum + 3 * average) / (weight + 3);
  const homeAttack = rate(homeForm.home.scored, homeForm.home.weight, homeMean);
  const awayAttack = rate(awayForm.away.scored, awayForm.away.weight, awayMean);
  const homeExpected = homeAttack * rate(awayForm.away.conceded, awayForm.away.weight, homeMean) / homeMean;
  const awayExpected = awayAttack * rate(homeForm.home.conceded, homeForm.home.weight, awayMean) / awayMean;
  const { outcome, probabilities, score, cleanSheets } = matchProbabilities(homeExpected, awayExpected);
  const winner = score.home === score.away ? null : score.home > score.away ? home : away;
  return { ...row, score, winner, probabilities, uncertain: probabilities[outcome] < 0.5,
    home: { ...home, expectedGoals: homeExpected, cleanSheetProbability: cleanSheets.home, cleanSheet: score.away === 0 },
    away: { ...away, expectedGoals: awayExpected, cleanSheetProbability: cleanSheets.away, cleanSheet: score.home === 0 },
    attackFactors: { home: homeExpected / homeAttack, away: awayExpected / awayAttack } };
}

function stat(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function playerProfile(player, position, reports) {
  const chance = availability(player);
  if (!chance || (player.status === 'd' && player.chance_of_playing_next_round == null)) return null;
  const records = reports.filter(record => record.scoringMatches?.length && Number.isInteger(record.starts));
  const matches = records.flatMap(record => record.scoringMatches);
  if (!matches.length) return null;
  const minutes = matches.map(match => Math.min(90, match.minutes));
  const played = total(minutes);
  if (played <= 0) return null;
  const average = values => total(values) / values.length;
  const units = matches.map(match => ruleBasedMatchUnits(match, position));
  const rate = (key, fallback = key) => {
    const seasonCount = stat(player[key]) ?? stat(player[fallback]);
    const usable = records.filter(record => record.minutes > 0 && (stat(record[key]) ?? stat(record[fallback])) !== null);
    const recentMinutes = total(usable.map(record => record.minutes));
    const recent = recentMinutes ? total(usable.map(record => stat(record[key]) ?? stat(record[fallback]))) / recentMinutes : null;
    const season = player.minutes > 0 && seasonCount != null ? seasonCount / player.minutes : null;
    return recent == null ? season : season == null ? recent : 0.6 * season + 0.4 * recent;
  };
  const goals = rate('expected_goals', 'goals_scored');
  const assists = rate('expected_assists', 'assists');
  const expectedMinutes = played / matches.length * chance;
  const appearances = Object.fromEntries(['long_play', 'short_play', ...matchStats].map(name =>
    [name, units.every(match => Number.isFinite(match[name])) ? chance * average(units.map(match => match[name])) : null]));
  const concessionMinutes = matches.map((match, index) => match.red_cards > 0 ? 90 : minutes[index]);
  return { chance, minutes, concessionMinutes, expectedMinutes,
    startProbability: chance * Math.min(1, total(records.map(record => record.starts)) / matches.length),
    goals: goals == null ? null : goals * expectedMinutes, assists: assists == null ? null : assists * expectedMinutes,
    other: Object.fromEntries(otherStats.map(name => {
      const perMinute = rate(name);
      return [name, perMinute == null ? null : perMinute * expectedMinutes];
    })), appearances };
}

function fixturePoints(profile, position, scoring, attackingFactor, oppositeGoals) {
  const { minutes, chance } = profile;
  const cleanSheetRate = chance * total(minutes.map((played, index) =>
    played >= 60 ? Math.exp(-oppositeGoals * profile.concessionMinutes[index] / 90) : 0)) / minutes.length;
  // For Poisson goals, E[floor(goals / 2)] is (E[goals] - P(odd goals)) / 2.
  const concededRate = chance * total(profile.concessionMinutes.map(played => {
    const mean = oppositeGoals * played / 90;
    return (mean - (1 - Math.exp(-2 * mean)) / 2) / 2;
  })) / minutes.length;
  const terms = { ...profile.appearances, ...profile.other, clean_sheets: cleanSheetRate, goals_conceded: concededRate,
    goals_scored: profile.goals == null ? null : profile.goals * attackingFactor,
    assists: profile.assists == null ? null : profile.assists * attackingFactor };
  const scores = Object.entries(terms).map(([name, value]) => applyWeight(scoring, position, name, value));
  return scores.includes(null) ? null : total(scores);
}

export function predictMatchWinners(dashboard, fixtures, gameweek, reports) {
  const earlier = new Set(dashboard.events.filter(event => event.id < gameweek && finished(event)).map(event => event.id));
  const results = dashboard.fixtures.filter(fixture => earlier.has(fixture.event) && fixture.finished
    && Number.isFinite(Date.parse(fixture.kickoff_time)) && Number.isInteger(fixture.team_h_score) && Number.isInteger(fixture.team_a_score));
  const teams = new Map(dashboard.teams.map(team => [team.id, { id: team.id, name: team.name }]));
  const strengths = teamStrengths(dashboard.teams, results);
  const matches = fixtures.map(fixture => forecastMatch(fixture, teams, strengths));
  const winners = new Set(matches.flatMap(match => match.winner ? [match.winner.id] : []));
  const positionInfo = new Map(dashboard.positions.map(position => [position.id, position]));
  const history = reports.filter(report => earlier.has(report.event)).map(report => new Map(report.players.map(player => [player.id, player])));
  const byTeam = new Map([...winners].map(id => [id, []]));
  for (const player of dashboard.players) {
    if (!winners.has(player.team)) continue;
    const position = positionInfo.get(player.element_type);
    if (!positions.includes(position?.singular_name_short)) continue;
    const profile = playerProfile(player, position.singular_name_short, history.map(players => players.get(player.id)).filter(Boolean));
    if (profile) byTeam.get(player.team).push({ id: player.id, name: player.web_name, team: teams.get(player.team).name,
      teamId: player.team, position: position.singular_name, positionCode: position.singular_name_short, profile });
  }
  const candidates = new Map();
  const projected = new Map();
  const scheduled = new Map();
  for (const match of matches) {
    for (const [side, opponent] of [['home', 'away'], ['away', 'home']]) {
      const team = match[side];
      if (!winners.has(team.id)) continue;
      scheduled.set(team.id, (scheduled.get(team.id) ?? 0) + 1);
      if (!match.score) continue;
      const picks = [];
      for (const { profile, ...player } of byTeam.get(team.id)) {
        const points = fixturePoints(profile, player.positionCode, dashboard.scoring, match.attackFactors[side], match[opponent].expectedGoals);
        if (!Number.isFinite(points)) continue;
        const pick = { ...player, points, expectedMinutes: Math.round(profile.expectedMinutes), startProbability: profile.startProbability };
        picks.push(pick);
        const accumulated = projected.get(player.id) ?? { points: 0, fixtures: 0 };
        projected.set(player.id, { points: accumulated.points + points, fixtures: accumulated.fixtures + 1 });
      }
      if (match.winner?.id !== team.id) continue;
      picks.sort(compare);
      for (const position of positions) {
        const pick = picks.find(player => player.positionCode === position);
        if (!pick) {
          match.missingPositions.push(position);
          continue;
        }
        const { points, ...player } = pick;
        match.picks.push({ ...player, predicted: roundRuleBasedPoints(points) });
        candidates.set(player.id, player);
      }
    }
  }
  const eligible = [...candidates.values()].flatMap(({ startProbability, expectedMinutes, ...player }) => {
    const aggregate = projected.get(player.id);
    return aggregate.fixtures === scheduled.get(player.teamId) ? [{ ...player, ...aggregate }] : [];
  });
  const players = eligible.sort(compare).slice(0, 15)
    .map(({ points, ...player }) => ({ ...player, predicted: roundRuleBasedPoints(points) }));
  return { matches: matches.map(({ attackFactors, ...match }) => match), players,
    captain: players[0]?.id ?? null, viceCaptain: players[1]?.id ?? null,
    total: players.length ? total(players.map(player => player.predicted)) : null,
    projectedCount: players.length, candidateCount: candidates.size, incompleteCandidates: candidates.size - eligible.length,
    sampleWeeks: reports.map(report => report.event), completedMatches: results.length };
}

export function createMatchWinnerStrategy(fpl) {
  return async (dashboard, fixtures, gameweek, previous) => {
  if (!fixtures.length) return { ...predictMatchWinners(dashboard, fixtures, gameweek, []), requestedWeeks: 0, sources: [] };
    const weeks = dashboard.events.filter(event => event.id < gameweek && finished(event))
      .sort((a, b) => b.id - a.id).slice(0, 3);
    const responses = await Promise.allSettled(weeks.map(async ({ id }) =>
      previous?.event === id && Array.isArray(previous.players[0]?.scoringMatches)
        ? previous : fpl.getLive(id, false, day, true)));
    const reports = responses.flatMap((response, index) => response.status === 'fulfilled' && response.value?.event === weeks[index].id
      && response.value.players?.length ? [response.value] : []);
    return { ...predictMatchWinners(dashboard, fixtures, gameweek, reports), requestedWeeks: weeks.length,
      sources: reports.flatMap(report => report.sources) };
  };
}
