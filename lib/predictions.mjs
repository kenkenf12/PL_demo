import { FplError } from './fpl.mjs';
import { roundRuleBasedPoints, withRuleBasedPredictions } from './fpl-rule-scoring.mjs';
import { predictSquad, strategies } from './squad-prediction.mjs';
import { createRecentForm } from './recent-form.mjs';
import { createNewsSearch } from './news-search.mjs';
import { createH2HIndexAnalysis, createH2HTeamIndices } from './h2h-index.mjs';
import { createSeasonIndexAnalysis } from './season-index.mjs';
import { createCombinedIndexAnalysis } from './combined-index.mjs';
import { isGameweekComplete, remainingFixtures } from '../public/model.mjs';

const day = 86_400_000;
const hasAttackingReturn = row => row?.goals_scored > 0 || row?.assists > 0;
const hasNoAttackingReturn = row => row?.goals_scored === 0 && row.assists === 0;
const hasStart = row => Number.isInteger(row?.starts) && row.starts > 0;
const areConsecutive = weeks => weeks.every((event, index) => event === weeks[0] + index);
const scoringUnavailable = event => `Official Gameweek ${event} scoring is unavailable. Try analysing again.`;
const byPlayerName = (a, b) => a.name.localeCompare(b.name) || a.id - b.id;

function specialRulePlayer(player, team, stats) {
  return { id: player.id, name: player.web_name, team,
    gameweeks: stats.map(({ starts, goals_scored, assists }) => ({ starts, goals: goals_scored, assists })) };
}

async function specialRules(fpl, { dashboard, week, previous }) {
  const recentWeeks = dashboard.events.filter(event => event.id < week.id && isGameweekComplete(event))
    .map(event => event.id).sort((a, b) => b - a).slice(0, 4).reverse();
  const weeks = recentWeeks.slice(-3);
  const consecutive = recentWeeks.length === 4 && areConsecutive(recentWeeks);
  const rule2 = { weeks: recentWeeks, players: [], error: consecutive ? null : 'Four consecutive completed Gameweeks are needed to check this rule.' };
  const threeWeekError = weeks.length === 3 && areConsecutive(weeks)
    ? null : 'Three consecutive completed Gameweeks are needed to check this rule.';
  const rule3 = { weeks, players: [], error: threeWeekError };
  const rule4 = { weeks, players: [], error: threeWeekError };
  const lastTwoWeeks = recentWeeks.slice(-2);
  const rule5 = { weeks: lastTwoWeeks, players: [], error: lastTwoWeeks.length === 2 && areConsecutive(lastTwoWeeks)
    ? null : 'Two consecutive completed Gameweeks are needed to check this rule.' };
  if (weeks.length < 3 && rule5.error) return { weeks, players: [], sources: [], rule2, rule3, rule4, rule5 };

  const requested = consecutive ? recentWeeks : weeks;
  const reports = await Promise.all(requested.map(async event => {
    const report = previous?.event === event ? previous : await fpl.getLive(event, false, day).catch(() => null);
    return report?.event === event && report.confirmedFinal !== false && report.players?.length ? report : null;
  }));
  const unavailable = requested.filter((event, index) => !reports[index]);
  function scoringError(gameweeks) {
    const event = gameweeks.find(id => unavailable.includes(id));
    return event == null ? null : scoringUnavailable(event);
  }
  const firstError = scoringError(weeks);
  const otherRules = [rule2, rule3, rule4, rule5];
  for (const rule of otherRules) rule.error ??= scoringError(rule.weeks);
  if (firstError && rule5.error) throw new FplError(firstError);

  const records = reports.map(report => new Map(report?.players.map(player => [player.id, player])));
  const teams = new Map(dashboard.teams.map(team => [team.id, team.name]));
  const players = [];
  for (const player of dashboard.players) {
    const stats = records.map(round => round.get(player.id));
    const team = teams.get(player.team);
    const lastTwo = stats.slice(-2);
    if (!rule5.error && lastTwo.every(row => hasStart(row) && hasAttackingReturn(row))) {
      rule5.players.push(specialRulePlayer(player, team, lastTwo));
    }
    if (weeks.length < 3 || firstError) continue;
    const lastThree = stats.slice(-3);
    const [first, second, latest] = lastThree;
    if (!hasAttackingReturn(first)) continue;
    const startedAllThree = lastThree.every(hasStart);
    if (!rule4.error && startedAllThree && hasAttackingReturn(latest) && hasAttackingReturn(second)) {
      rule4.players.push(specialRulePlayer(player, team, lastThree));
    }
    if (!hasNoAttackingReturn(latest)) continue;
    if (hasNoAttackingReturn(second)) {
      if (startedAllThree) players.push(specialRulePlayer(player, team, lastThree));
      if (!rule2.error && hasAttackingReturn(stats[0])) rule2.players.push(specialRulePlayer(player, team, stats));
    }
    if (!rule3.error && startedAllThree && hasAttackingReturn(second)) {
      rule3.players.push(specialRulePlayer(player, team, lastThree));
    }
  }
  players.sort(byPlayerName);
  for (const rule of otherRules) rule.players.sort(byPlayerName);
  return { weeks, players, sources: reports.flatMap(report => report?.sources ?? []),
    ...(firstError ? { error: firstError } : {}), rule2, rule3, rule4, rule5 };
}

export function predictionService(fpl, { history, refreshState,
  form = createRecentForm(fpl), news = createNewsSearch(),
  h2hTeamIndices = createH2HTeamIndices(), seasonIndex = createSeasonIndexAnalysis(fpl),
  h2hIndex = createH2HIndexAnalysis(fpl, undefined, h2hTeamIndices),
  combinedIndex = createCombinedIndexAnalysis(fpl, h2hTeamIndices), now = Date.now }) {
  const indexAnalyses = new Map([['season-index', seasonIndex], ['h2h-index', h2hIndex], ['combined-index', combinedIndex]]);
  let ready = refreshState?.read();
  let generation = ready?.sequence ?? 0;
  let recentRequest;

  function recentForm(input) {
    const cutoff = now();
    if (input.recent?.expiresAt > cutoff && input.recent.usesMatchScoringRules) return input.recent;
    if (recentRequest?.input === input) return recentRequest.promise;
    const promise = form(input, cutoff).then(data => {
      const partial = data.summary.days < data.summary.expectedDays || data.summary.reports < data.summary.requested
        || data.summary.domesticWeeks.length < data.summary.requestedWeeks;
      const recent = { ...data, expiresAt: cutoff + (partial ? 2 : 60) * 60_000 };
      if (ready === input) {
        input.recent = recent;
        refreshState?.write(input);
      }
      return recent;
    }).finally(() => {
      if (recentRequest?.promise === promise) recentRequest = undefined;
    });
    recentRequest = { input, promise };
    return promise;
  }

  async function refresh(gameweek) {
    const sequence = ++generation;
    const dashboard = await fpl.getDashboard(true);
    const week = dashboard.events.find(event => event.id === gameweek);
    if (!week) throw new FplError('Choose a Gameweek from this season.', 404);
    const previousWeek = dashboard.events.filter(event => event.id < gameweek && isGameweekComplete(event)).sort((a, b) => b.id - a.id)[0];
    const requests = new Map();
    function live(event) {
      if (!requests.has(event)) requests.set(event, fpl.getLive(event, true, undefined, event === previousWeek?.id));
      return requests.get(event);
    }

    async function reconcile() {
      const finalWeeks = new Set(dashboard.events.filter(isGameweekComplete).map(event => event.id));
      const needsActual = record => record.players.length && finalWeeks.has(record.gameweek)
        && record.accuracy?.actualCount !== record.players.length;
      const needsPreviousActual = record => record.players.length && finalWeeks.has(record.gameweek - 1)
        && record.previousActualWeek !== record.gameweek - 1;
      const requested = new Set();
      for (const record of await history.read()) {
        if (record.seasonYear !== dashboard.seasonYear) continue;
        if (needsActual(record)) requested.add(record.gameweek);
        if (needsPreviousActual(record)) requested.add(record.gameweek - 1);
      }
      const gameweeks = [...requested];
      const result = await Promise.allSettled(gameweeks.map(live));
      const scores = new Map();
      for (const [index, entry] of result.entries()) {
        const id = gameweeks[index];
        if (entry.status === 'fulfilled' && entry.value?.event === id && entry.value.confirmedFinal !== false
          && entry.value.players?.length) scores.set(id, entry.value);
      }
      if (scores.size) {
        const scoredAt = new Date(now()).toISOString();
        await history.update(records => records.map(record => {
          if (record.seasonYear !== dashboard.seasonYear) return record;
          const preceding = scores.get(record.gameweek - 1);
          const updated = preceding && needsPreviousActual(record) ? withPreviousActuals(record, preceding) : record;
          if (!needsActual(record) || !scores.has(record.gameweek)) return updated;
          const accuracy = scorePrediction(record, scores.get(record.gameweek), scoredAt);
          return accuracy && accuracy.actualCount >= (record.accuracy?.actualCount ?? 0) ? { ...updated, accuracy } : updated;
        }));
      }
      return scores.size < gameweeks.length;
    }

    const [prior, accuracy] = await Promise.allSettled([previousWeek ? live(previousWeek.id) : null, reconcile()]);
    if (ready?.sequence > sequence) throw new FplError('A newer FPL refresh finished. Refresh this Gameweek again.', 409);
    const token = crypto.randomUUID();
    const previous = prior.status === 'fulfilled' && prior.value?.event === previousWeek?.id
      && prior.value?.confirmedFinal !== false && prior.value?.players?.length ? prior.value : null;
    const previousError = previousWeek && !previous ? `Official Gameweek ${previousWeek.id} scoring is unavailable. Refresh to retry.` : null;
    const input = { token, sequence, dashboard, week, previous, previousError };
    refreshState?.write(input);
    ready = input;
    return { token, dashboard, week, previousWeek: previous?.event ?? null, previousError,
      previousSource: previous?.sources?.[0]?.origin ?? null,
      historyError: accuracy.status === 'rejected' || accuracy.value ? 'Some saved predictions could not be checked. Refresh to retry.' : null };
  }

  async function analyse(gameweek, strategy, token, { preview = false } = {}) {
    const analyseIndex = indexAnalyses.get(strategy);
    if (!analyseIndex && !['news', 'special-rules'].includes(strategy) && !strategies.includes(strategy)) {
      throw new FplError('Choose one prediction strategy.', 400);
    }
    const input = ready;
    if (!input || input.token !== token || input.week.id !== gameweek) {
      throw new FplError('Refresh FPL data for this Gameweek before analysing.', 409);
    }
    if (strategy === 'special-rules') {
      if (preview) throw new FplError('Use Analyse FPL Players to run Special Rules.', 400);
      const report = await specialRules(fpl, input);
      if (ready !== input) throw new FplError('The snapshot changed. Refresh before analysing again.', 409);
      return { strategy, gameweek, ...report };
    }
    const deadline = Date.parse(input.week.deadline_time);
    const requestedAt = now();
    const unlocked = time => !input.week.finished && deadline > time;
    if (!preview && !unlocked(requestedAt)) {
      throw new FplError('The Gameweek deadline has passed. Use Post-Deadline Preview for remaining fixtures or view Prediction history.', 409);
    }
    if (preview && (!Number.isFinite(deadline) || deadline > requestedAt)) {
      throw new FplError('Post-Deadline Preview opens after the published Gameweek deadline.', 409);
    }
    const { dashboard } = input;
    const fixtures = preview || analyseIndex ? remainingFixtures(dashboard.fixtures, gameweek, requestedAt)
      : dashboard.fixtures.filter(fixture => fixture.event === gameweek && !fixture.started && !fixture.finished);
    if (preview && (input.week.finished || !fixtures.length)) {
      throw new FplError('There are no remaining fixtures with a future kick-off to preview in this Gameweek.', 409);
    }
    const firstKickoff = preview ? Math.min(...fixtures.map(fixture => Date.parse(fixture.kickoff_time))) : Infinity;
    const reportContext = { strategy, gameweek, ...(preview ? { preview: { fixtureCount: fixtures.length } } : {}) };
    function checkCurrent() {
      const time = now();
      if (ready !== input || (!preview && !unlocked(time))) {
        throw new FplError('The Gameweek or snapshot changed. Refresh before analysing again.', 409);
      }
      if (preview && time >= firstKickoff) {
        throw new FplError('A fixture kicked off during the preview. Run another preview for the remaining fixtures.', 409);
      }
    }
    if (strategy === 'news') {
      const clubs = preview ? new Set(fixtures.flatMap(fixture => [fixture.team_h, fixture.team_a])) : null;
      const players = clubs ? dashboard.players.filter(player => clubs.has(player.team)) : dashboard.players;
      const report = await news(players, now());
      checkCurrent();
      return { ...reportContext, ...report };
    }
    if (strategy === 'previous' && !input.previous) {
      throw new FplError(input.previousError ?? 'There is no previous completed Gameweek to analyse.', 409);
    }
    if (analyseIndex) {
      const report = await analyseIndex(dashboard, fixtures, gameweek, input.previous, requestedAt);
      checkCurrent();
      return { ...reportContext, ...report, sources: [...dashboard.sources, ...report.sources] };
    }
    const recent = strategy === 'recent' ? await recentForm(input) : null;
    checkCurrent();
    const previous = strategy === 'previous' ? input.previous : null;
    const squad = predictSquad(dashboard, fixtures, strategy, previous, recent, { preview });
    const sources = [...dashboard.sources, ...(previous?.sources ?? []), ...(recent?.sources ?? [])];
    const histories = new Map();
    if (strategy === 'ranking' && fixtures.length) {
      const finalWeeks = new Set(dashboard.events.filter(event => event.id < gameweek && isGameweekComplete(event)).map(event => event.id));
      const finished = new Set(dashboard.fixtures.filter(fixture => fixture.finished && finalWeeks.has(fixture.event)).map(fixture => fixture.id));
      if (finished.size) {
        const clubs = new Set(fixtures.flatMap(fixture => [fixture.team_h, fixture.team_a]));
        const selected = squad.players.filter(player => clubs.has(player.teamId));
        const reports = await Promise.allSettled(selected.map(player => fpl.getPlayer(player.id)));
        checkCurrent();
        for (const [index, report] of reports.entries()) {
          if (report.status !== 'fulfilled') continue;
          histories.set(selected[index].id, report.value.history.filter(match => finished.has(match.fixture)));
          sources.push(...report.value.sources);
        }
      }
    }
    const players = withRuleBasedPredictions(squad.players, dashboard, fixtures, { strategy, previous, recent, histories });
    checkCurrent();
    const record = withPreviousActuals({
      ...reportContext, id: !preview && squad.players.length ? crypto.randomUUID() : null, seasonYear: dashboard.seasonYear,
      createdAt: new Date(now()).toISOString(), previousWeek: previous?.event ?? null,
      ...squad, players,
      ...(recent ? { recentForm: recent.summary } : {}),
      sources, accuracy: null
    }, input.previous?.event === gameweek - 1 ? input.previous : null);
    if (record.id) await history.update(records => [record, ...records]);
    return record;
  }

  async function savedPredictions() {
    return (await history.read()).map(record => {
      if (!record.players.some(player => Object.hasOwn(player, 'fplRuleBasedPredictedPoints')
        || Object.hasOwn(player, 'fplRuleBasedHistoricalBenchmark')
        || (Number.isFinite(player.predictedFplRuleBasedPoints) && !Number.isInteger(player.predictedFplRuleBasedPoints)))) return record;
      const players = record.players.map(({ fplRuleBasedPredictedPoints, fplRuleBasedHistoricalBenchmark, ...player }) => {
        if (Number.isFinite(player.predictedFplRuleBasedPoints)) {
          player.predictedFplRuleBasedPoints = roundRuleBasedPoints(player.predictedFplRuleBasedPoints);
        }
        return player;
      });
      return { ...record, players };
    });
  }

  return { refresh, analyse, preview: (gameweek, strategy, token) => analyse(gameweek, strategy, token, { preview: true }),
    history: savedPredictions };
}

function includeScoringSources(sources, live) {
  return [...sources, ...live.sources.filter(source => !sources.some(existing => existing.url === source.url))];
}

function playerTotals(live) {
  return new Map(live?.players.filter(player => Number.isInteger(player.total_points)).map(player => [player.id, player.total_points]));
}

function withPreviousActuals(record, live) {
  const points = playerTotals(live);
  return {
    ...record,
    previousActualWeek: live?.event ?? null,
    players: record.players.map(player => ({ ...player, previousActualPoints: points.get(player.id) ?? null })),
    sources: live ? includeScoringSources(record.sources, live) : record.sources
  };
}

function scorePrediction(prediction, live, scoredAt) {
  const results = playerTotals(live);
  const actual = prediction.players.map(player => ({ id: player.id, points: results.get(player.id) ?? null }));
  const known = actual.filter(record => record.points != null);
  if (!known.length) return null;
  const comparable = prediction.players.filter(player => player.predicted != null && results.has(player.id));
  const delta = comparable.reduce((sum, player) => sum + Math.abs(player.predicted - results.get(player.id)), 0);
  return { actual, actualCount: known.length, actualTotal: known.reduce((sum, result) => sum + result.points, 0),
    comparedCount: comparable.length, meanAbsoluteError: comparable.length ? delta / comparable.length : null,
    predictedComparableTotal: comparable.reduce((sum, player) => sum + player.predicted, 0),
    actualComparableTotal: comparable.reduce((sum, player) => sum + results.get(player.id), 0),
    scoredAt, sources: live.sources };
}
