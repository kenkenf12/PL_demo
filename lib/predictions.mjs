import { FplError } from './fpl.mjs';
import { roundRuleBasedPoints, withRuleBasedPredictions } from './fpl-rule-scoring.mjs';
import { predictSquad, strategies } from './squad-prediction.mjs';
import { createRecentForm } from './recent-form.mjs';
import { createNewsSearch } from './news-search.mjs';
import { createMatchWinnerStrategy } from './match-winner-strategy.mjs';

const completed = event => event.finished && event.data_checked;

export function predictionService(fpl, { history, refreshState,
  form = createRecentForm(fpl), news = createNewsSearch(),
  matchWinners = createMatchWinnerStrategy(fpl), now = Date.now }) {
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
    if (dashboard.stale) throw new FplError(dashboard.refreshError ?? 'The FPL refresh failed.');
    const week = dashboard.events.find(event => event.id === gameweek);
    if (!week) throw new FplError('Choose a Gameweek from this season.', 404);
    const previousWeek = dashboard.events.filter(event => event.id < gameweek && completed(event)).sort((a, b) => b.id - a.id)[0];
    const requests = new Map();
    function live(event) {
      if (!requests.has(event)) requests.set(event, fpl.getLive(event, true, undefined, event === previousWeek?.id));
      return requests.get(event);
    }

    async function reconcile() {
      const finalWeeks = new Set(dashboard.events.filter(completed).map(event => event.id));
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
        if (entry.status === 'fulfilled' && entry.value?.event === id && entry.value.players?.length) scores.set(id, entry.value);
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
      && prior.value?.players?.length ? prior.value : null;
    const previousError = previousWeek && !previous ? `Official Gameweek ${previousWeek.id} scoring is unavailable. Refresh to retry.` : null;
    const input = { token, sequence, dashboard, week, previous, previousError };
    refreshState?.write(input);
    ready = input;
    return { token, dashboard, week, previousWeek: previous?.event ?? null, previousError,
      historyError: accuracy.status === 'rejected' || accuracy.value ? 'Some saved predictions could not be checked. Refresh to retry.' : null };
  }

  async function analyse(gameweek, strategy, token) {
    if (!['news', 'match-winners'].includes(strategy) && !strategies.includes(strategy)) {
      throw new FplError('Choose one prediction strategy.', 400);
    }
    const input = ready;
    if (!input || input.token !== token || input.week.id !== gameweek) {
      throw new FplError('Refresh FPL data for this Gameweek before analysing.', 409);
    }
    const unlocked = () => !input.week.finished && Date.parse(input.week.deadline_time) > now();
    if (!unlocked()) throw new FplError('The Gameweek deadline has passed. View saved results in Prediction history.', 409);
    function checkCurrent() {
      if (!unlocked() || ready !== input) throw new FplError('The Gameweek or snapshot changed. Refresh before analysing again.', 409);
    }
    if (strategy === 'news') {
      const report = await news(input.dashboard.players, now());
      checkCurrent();
      return { strategy, gameweek, ...report };
    }
    if (strategy === 'previous' && !input.previous) {
      throw new FplError(input.previousError ?? 'There is no previous completed Gameweek to analyse.', 409);
    }
    const { dashboard } = input;
    const fixtures = dashboard.fixtures.filter(fixture => fixture.event === gameweek && !fixture.started && !fixture.finished);
    if (strategy === 'match-winners') {
      const report = await matchWinners(dashboard, fixtures, gameweek, input.previous);
      checkCurrent();
      const record = withPreviousActuals({
        ...report, id: report.matches.some(match => match.score) ? crypto.randomUUID() : null, seasonYear: dashboard.seasonYear,
        gameweek, strategy, createdAt: new Date(now()).toISOString(), accuracy: null,
        sources: [...dashboard.sources, ...report.sources]
      }, input.previous?.event === gameweek - 1 ? input.previous : null);
      if (record.id) await history.update(records => [record, ...records]);
      return record;
    }
    const recent = strategy === 'recent' ? await recentForm(input) : null;
    checkCurrent();
    const previous = strategy === 'previous' ? input.previous : null;
    const squad = predictSquad(dashboard, fixtures, strategy, previous, recent);
    const sources = [...dashboard.sources, ...(previous?.sources ?? []), ...(recent?.sources ?? [])];
    const histories = new Map();
    if (strategy === 'ranking' && fixtures.length) {
      const finalWeeks = new Set(dashboard.events.filter(event => event.id < gameweek && completed(event)).map(event => event.id));
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
    const record = withPreviousActuals({
      id: squad.players.length ? crypto.randomUUID() : null, seasonYear: dashboard.seasonYear, gameweek, strategy,
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

  return { refresh, analyse, history: savedPredictions };
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
