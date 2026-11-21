import { availability } from '../public/model.mjs';
import { applyWeight, ruleBasedMatchUnits } from './fpl-rule-scoring.mjs';

const day = 86_400_000;
const positions = ['GKP', 'DEF', 'MID', 'FWD'];
const otherStats = ['own_goals', 'penalties_saved', 'penalties_missed', 'red_cards', 'bonus'];
const matchStats = ['saves', 'defensive_contribution', 'yellow_cards'];
const total = values => values.reduce((sum, value) => sum + value, 0);
const finished = event => event.finished && event.data_checked;

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

function forecastFixture(fixture, strengths) {
  if (!Number.isFinite(Date.parse(fixture.kickoff_time))) return null;
  const { summaries, homeMean, awayMean } = strengths;
  const homeForm = summaries.get(fixture.team_h);
  const awayForm = summaries.get(fixture.team_a);
  if (homeForm.matches < 3 || awayForm.matches < 3 || !homeForm.home.weight || !awayForm.away.weight || !(homeMean > 0 && awayMean > 0)) {
    return null;
  }
  // Shrink venue-specific rates toward three matches at the league average.
  const rate = (sum, weight, average) => (sum + 3 * average) / (weight + 3);
  const homeAttack = rate(homeForm.home.scored, homeForm.home.weight, homeMean);
  const awayAttack = rate(awayForm.away.scored, awayForm.away.weight, awayMean);
  const homeExpected = homeAttack * rate(awayForm.away.conceded, awayForm.away.weight, homeMean) / homeMean;
  const awayExpected = awayAttack * rate(homeForm.home.conceded, homeForm.home.weight, awayMean) / awayMean;
  return { home: { id: fixture.team_h, expectedGoals: homeExpected, attackingFactor: homeExpected / homeAttack },
    away: { id: fixture.team_a, expectedGoals: awayExpected, attackingFactor: awayExpected / awayAttack } };
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
  return { chance, minutes, concessionMinutes,
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

export function createFixturePlayerScorer(dashboard, fixtures, gameweek, reports) {
  const earlier = new Set(dashboard.events.filter(event => event.id < gameweek && finished(event)).map(event => event.id));
  const results = dashboard.fixtures.filter(fixture => earlier.has(fixture.event) && fixture.finished
    && Number.isFinite(Date.parse(fixture.kickoff_time)) && Number.isInteger(fixture.team_h_score) && Number.isInteger(fixture.team_a_score));
  const strengths = teamStrengths(dashboard.teams, results);
  const forecasts = new Map(fixtures.map(fixture => [fixture.id, forecastFixture(fixture, strengths)]));
  const positionCodes = new Map(dashboard.positions.map(position => [position.id, position.singular_name_short]));
  const history = reports.filter(report => earlier.has(report.event))
    .map(report => new Map(report.players.map(player => [player.id, player])));
  return (player, fixtureId) => {
    const match = forecasts.get(fixtureId);
    if (!match) return null;
    const side = player.team === match.home.id ? 'home' : player.team === match.away.id ? 'away' : null;
    const position = positionCodes.get(player.element_type);
    if (!side || !positions.includes(position)) return null;
    const profile = playerProfile(player, position, history.map(players => players.get(player.id)).filter(Boolean));
    if (!profile) return null;
    const opponent = side === 'home' ? match.away : match.home;
    return fixturePoints(profile, position, dashboard.scoring, match[side].attackingFactor, opponent.expectedGoals);
  };
}

export async function loadMatchPlayerEvidence(fpl, dashboard, gameweek, previous) {
  const weeks = dashboard.events.filter(event => event.id < gameweek && finished(event))
    .sort((a, b) => b.id - a.id).slice(0, 3);
  const responses = await Promise.allSettled(weeks.map(async ({ id }) =>
    previous?.event === id && Array.isArray(previous.players[0]?.scoringMatches)
      ? previous : fpl.getLive(id, false, day, true)));
  const reports = responses.flatMap((response, index) => response.status === 'fulfilled' && response.value?.event === weeks[index].id
    && response.value.confirmedFinal !== false && response.value.players?.length ? [response.value] : []);
  return { reports, sources: reports.flatMap(report => report.sources) };
}
