import { randomUUID } from 'node:crypto';
import { FplError } from './fpl.mjs';
import { predictionHistory, scorePrediction } from './prediction-history.mjs';
import { predictSquad, strategies } from './squad-prediction.mjs';
import { fixtureWeather } from './weather.mjs';

const completed = event => event.finished && event.data_checked;

export function predictionService(fpl, { history = predictionHistory(), weather = fixtureWeather, now = Date.now } = {}) {
  let ready;
  let generation = 0;

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
    const token = randomUUID();
    const previous = prior.status === 'fulfilled' && prior.value?.players?.length ? prior.value : null;
    const previousError = previousWeek && !previous ? `Official Gameweek ${previousWeek.id} scoring is unavailable. Refresh to retry.` : null;
    ready = { token, sequence, dashboard, week, previous, previousError };
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
    if (!unlocked() || ready !== input) throw new FplError('The Gameweek or snapshot changed. Refresh before analysing again.', 409);
    const previous = strategy === 'previous' ? input.previous : null;
    const squad = predictSquad(dashboard, fixtures, strategy, previous, forecast);
    const record = {
      id: randomUUID(), seasonYear: dashboard.seasonYear, gameweek, strategy,
      createdAt: new Date(now()).toISOString(), previousWeek: previous?.event ?? null,
      ...squad, weather: forecast,
      sources: [...dashboard.sources, ...(previous?.sources ?? []), ...(forecast?.sources ?? [])], accuracy: null
    };
    await history.update(records => [record, ...records]);
    return record;
  }

  return { refresh, analyse, history: history.read };
}
