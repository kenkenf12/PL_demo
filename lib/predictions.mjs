import { FplError } from './fpl.mjs';
import { predictSquad, strategies } from './squad-prediction.mjs';
import { fixtureWeather } from './weather.mjs';
import { createRecentForm } from './recent-form.mjs';

const completed = event => event.finished && event.data_checked;

export function predictionService(fpl, { history, refreshState, weather = fixtureWeather, form = createRecentForm(fpl), now = Date.now }) {
  let ready = refreshState?.read();
  let generation = ready?.sequence ?? 0;
  let recentRequest;

  function recentForm(input) {
    const cutoff = now();
    if (input.recent?.expiresAt > cutoff) return input.recent;
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
      if (!requests.has(event)) requests.set(event, fpl.getLive(event, true));
      return requests.get(event);
    }

    async function reconcile() {
      const finalWeeks = new Set(dashboard.events.filter(completed).map(event => event.id));
      const pending = record => record.seasonYear === dashboard.seasonYear && finalWeeks.has(record.gameweek)
        && record.accuracy?.actualCount !== record.players.length;
      const gameweeks = [...new Set((await history.read()).filter(pending).map(record => record.gameweek))];
      const result = await Promise.allSettled(gameweeks.map(live));
      const scores = new Map();
      for (const [index, entry] of result.entries()) {
        if (entry.status === 'fulfilled') scores.set(gameweeks[index], entry.value);
      }
      if (scores.size) {
        const scoredAt = new Date(now()).toISOString();
        await history.update(records => records.map(record => {
          if (!pending(record) || !scores.has(record.gameweek)) return record;
          const accuracy = scorePrediction(record, scores.get(record.gameweek), scoredAt);
          return accuracy && accuracy.actualCount >= (record.accuracy?.actualCount ?? 0) ? { ...record, accuracy } : record;
        }));
      }
      return result.some(entry => entry.status === 'rejected');
    }

    const [prior, accuracy] = await Promise.allSettled([previousWeek ? live(previousWeek.id) : null, reconcile()]);
    if (ready?.sequence > sequence) throw new FplError('A newer FPL refresh finished. Refresh this Gameweek again.', 409);
    const token = crypto.randomUUID();
    const previous = prior.status === 'fulfilled' && prior.value?.players?.length ? prior.value : null;
    const previousError = previousWeek && !previous ? `Official Gameweek ${previousWeek.id} scoring is unavailable. Refresh to retry.` : null;
    const input = { token, sequence, dashboard, week, previous, previousError };
    refreshState?.write(input);
    ready = input;
    return { token, dashboard, week, previousWeek: previous?.event ?? null, previousError,
      historyError: accuracy.status === 'rejected' || accuracy.value ? 'Some saved predictions could not be checked. Refresh to retry.' : null };
  }

  async function analyse(gameweek, strategy, token) {
    if (!strategies.includes(strategy)) throw new FplError('Choose one prediction strategy.', 400);
    const input = ready;
    if (!input || input.token !== token || input.week.id !== gameweek) {
      throw new FplError('Refresh FPL data for this Gameweek before analysing.', 409);
    }
    const unlocked = () => !input.week.finished && Date.parse(input.week.deadline_time) > now();
    if (!unlocked()) throw new FplError('The Gameweek deadline has passed. View saved results in Prediction history.', 409);
    if (strategy === 'previous' && !input.previous) {
      throw new FplError(input.previousError ?? 'There is no previous completed Gameweek to analyse.', 409);
    }
    const { dashboard } = input;
    const fixtures = dashboard.fixtures.filter(fixture => fixture.event === gameweek && !fixture.started && !fixture.finished);
    const forecast = strategy === 'weather' ? await weather(fixtures, dashboard.teams, now()) : null;
    const recent = strategy === 'recent' ? await recentForm(input) : null;
    if (!unlocked() || ready !== input) throw new FplError('The Gameweek or snapshot changed. Refresh before analysing again.', 409);
    const previous = strategy === 'previous' ? input.previous : null;
    const squad = predictSquad(dashboard, fixtures, strategy, previous, forecast, recent);
    const record = {
      id: crypto.randomUUID(), seasonYear: dashboard.seasonYear, gameweek, strategy,
      createdAt: new Date(now()).toISOString(), previousWeek: previous?.event ?? null,
      ...squad, weather: forecast,
      ...(recent ? { recentForm: recent.summary } : {}),
      sources: [...dashboard.sources, ...(previous?.sources ?? []), ...(forecast?.sources ?? []), ...(recent?.sources ?? [])], accuracy: null
    };
    await history.update(records => [record, ...records]);
    return record;
  }

  return { refresh, analyse, history: history.read };
}

function scorePrediction(prediction, live, scoredAt) {
  const results = new Map(live.players.filter(player => Number.isInteger(player.total_points)).map(player => [player.id, player.total_points]));
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
