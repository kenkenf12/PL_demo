import { availability, fixtureFactor, number } from '../public/model.mjs';
import { FplError } from './fpl.mjs';
import { recentPlayerForm } from './recent-form.mjs';
import { constrainedSquad } from './squad-constraints.mjs';

export const strategies = ['ranking', 'previous', 'recent'];
const positionLimits = new Map([[1, 2], [2, 5], [3, 5], [4, 3]]);
const squadSize = 15;
const budget = 1000;

function hasNonEplAppearance(performance) {
  return performance?.cupMatches > 0 || performance?.europeanMatches > 0 || performance?.internationalMatches > 0;
}

function candidatePool(data, fixtures, strategy, previous, recent) {
  const played = new Map(data.teams.map(team => [team.id, 0]));
  const schedule = new Map(data.teams.map(team => [team.id, []]));
  const previousGames = new Map(data.teams.map(team => [team.id, 0]));
  for (const fixture of data.fixtures) {
    if (fixture.finished || fixture.finished_provisional) {
      for (const team of [fixture.team_h, fixture.team_a]) {
        played.set(team, played.get(team) + 1);
        if (fixture.event === previous?.event) previousGames.set(team, previousGames.get(team) + 1);
      }
    }
  }
  for (const fixture of fixtures) {
    schedule.get(fixture.team_h).push({ home: true, difficulty: fixture.team_h_difficulty });
    schedule.get(fixture.team_a).push({ home: false, difficulty: fixture.team_a_difficulty });
  }
  const last = new Map(previous?.players.map(player => [player.id, player]));
  const ranks = strategy === 'ranking' ? new Map(data.players.slice().sort((a, b) => b.total_points - a.total_points
    || b.minutes - a.minutes).map((player, index) => [player.id, index + 1])) : null;
  const performance = {
    ranking(player, games) {
      const percentile = 1 - (ranks.get(player.id) - 1) / data.players.length;
      return { baseline: player.minutes > 0 && games > 0
        ? 0.68 * player.total_points / games + 0.32 * number(player.form) + 0.4 * percentile : null,
      minutes: player.minutes, rank: ranks.get(player.id) };
    },
    previous(player) {
      const record = last.get(player.id);
      const matches = Math.max(1, previousGames.get(player.team), Math.ceil(number(record?.minutes) / 90));
      if (!record?.minutes) return { baseline: null, minutes: 0 };
      const involvement = Math.min(2, number(record.expected_goal_involvements) * 0.7 / matches);
      const playingTime = 1.3 * record.minutes / matches / 90;
      return { baseline: 0.82 * record.total_points / matches + 0.18 * (playingTime + involvement), minutes: record.minutes };
    },
    recent(player, games) {
      return recentPlayerForm(player, games, recent.performances[player.id]);
    }
  }[strategy];

  return data.players.filter(player => positionLimits.has(player.element_type)
    && (strategy !== 'recent' || hasNonEplAppearance(recent.performances[player.id]))
    && Number.isInteger(player.now_cost) && player.now_cost > 0 && availability(player) > 0).map(player => {
    const games = Math.max(played.get(player.team), Math.ceil(player.minutes / 90));
    const { baseline, minutes, rank, evidence } = performance(player, games);
    const matches = schedule.get(player.team);
    const predicted = !matches.length ? 0 : baseline == null ? null : Math.max(0, baseline) * availability(player)
      * matches.reduce((sum, match) => sum + fixtureFactor(match.difficulty, match.home), 0);
    return { player, predicted, minutes, rank, evidence };
  });
}

const squadCost = squad => squad.reduce((sum, candidate) => sum + candidate.player.now_cost, 0);

function pickSquad(candidates, teams) {
  const clubIds = teams.map(team => team.id);
  const select = weight => constrainedSquad(candidates, positionLimits, clubIds, {
    positionOf: candidate => candidate.player.element_type, clubOf: candidate => candidate.player.team, weight
  });
  const rating = candidate => (candidate.predicted ?? -2) + Math.min(1000, candidate.minutes) / 100_000;
  const top = select(rating);
  if (top && squadCost(top) <= budget) return top;
  const cheapest = select(candidate => -candidate.player.now_cost);
  if (!cheapest || squadCost(cheapest) > budget) return null;

  // Increase the price penalty until the position- and club-constrained squad fits the budget.
  let best = cheapest;
  const total = squad => squad.reduce((sum, candidate) => sum + rating(candidate), 0);
  let low = 0;
  let high = 1 + 2 * squadSize * Math.max(...candidates.map(candidate => Math.abs(rating(candidate))));
  for (let i = 0; i < 24; i += 1) {
    const penalty = (low + high) / 2;
    const squad = select(candidate => rating(candidate) - penalty * candidate.player.now_cost);
    if (squadCost(squad) <= budget) {
      high = penalty;
      if (total(squad) > total(best)) best = squad;
    } else low = penalty;
  }
  return best;
}

export function predictSquad(data, fixtures, strategy, previous, recent, { preview = false } = {}) {
  const pool = candidatePool(data, fixtures, strategy, previous, recent);
  const clubs = preview ? new Set(fixtures.flatMap(fixture => [fixture.team_h, fixture.team_a])) : null;
  const candidates = clubs ? pool.filter(candidate => clubs.has(candidate.player.team)) : pool;
  const byRating = (a, b) => (b.predicted ?? -Infinity) - (a.predicted ?? -Infinity) || b.minutes - a.minutes
    || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.player.id - b.player.id;
  const squad = pickSquad(candidates, data.teams);
  if (!squad && strategy !== 'recent' && !preview) throw new FplError('FPL data has too few eligible players for a complete squad within £100m.', 409);
  const selected = squad ? squad.sort(byRating) : candidates.sort(byRating).slice(0, squadSize);
  const [captain, viceCaptain] = squad ? selected.map(({ player }) => player.id) : [null, null];
  const club = new Map(data.teams.map(team => [team.id, team.name]));
  const positions = new Map(data.positions.map(position => [position.id, position.singular_name]));
  if (squad) selected.sort((a, b) => a.player.element_type - b.player.element_type || byRating(a, b));
  const players = selected.map(({ player, predicted, evidence }) => ({
      id: player.id, name: player.web_name, team: club.get(player.team), teamId: player.team,
      position: positions.get(player.element_type), positionId: player.element_type,
    cost: player.now_cost, predicted, ...(evidence ? { evidence } : {})
  }));
  const projected = players.filter(player => player.predicted != null);
  return { players, captain, viceCaptain, ...(!squad ? { shortlist: true } : {}), cost: squadCost(selected), projectedCount: projected.length,
    total: projected.length ? projected.reduce((sum, player) => sum + player.predicted, 0) : null };
}
