const provider = 'https://api.the-odds-api.com/v4/sports/soccer_epl';
const minute = 60_000;
const minimumCredits = 10;
export const marketKey = 'player_goal_scorer_anytime';
// The provider's UK bookmaker directory also lists exchanges, which are excluded here.
export const ukSportsbooks = new Set(['sport888', 'betano_uk', 'betfair_sb_uk', 'betfred_uk', 'betvictor', 'betway',
  'boylesports', 'casumo', 'coral', 'grosvenor', 'ladbrokes_uk', 'leovegas', 'livescorebet', 'paddypower',
  'skybet', 'unibet_uk', 'virginbet', 'williamhill']);

export function validTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function decimalPrice(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 1 ? price : null;
}

function sanitizeBookmakers(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(book => ukSportsbooks.has(book?.key) && typeof book.title === 'string' && Array.isArray(book.markets))
    .flatMap(book => {
      const markets = book.markets.filter(offer => offer?.key === marketKey && Array.isArray(offer.outcomes)).flatMap(offer => {
        const outcomes = offer.outcomes.flatMap(outcome => {
          const price = decimalPrice(outcome?.price);
          if (price == null || typeof outcome.name !== 'string' || !outcome.name.trim()) return [];
          const side = outcome.name.trim().toLowerCase();
          const description = typeof outcome.description === 'string' ? outcome.description : undefined;
          if (side === 'no' || (side === 'yes' && !description?.trim())) return [];
          return [{ name: outcome.name, description, price }];
        });
        return outcomes.length ? [{ key: offer.key, last_update: validTimestamp(offer.last_update), outcomes }] : [];
      });
      return markets.length ? [{ key: book.key, title: book.title, last_update: validTimestamp(book.last_update), markets }] : [];
    });
}

function memoryStore() {
  const records = new Map();
  return { read: key => records.get(key), write: (key, value) => records.set(key, value) };
}

export function createUkOddsFeed(apiKey, { store = memoryStore(), fetcher = (url, options) => globalThis.fetch(url, options),
  clock = Date.now } = {}) {
  const key = apiKey?.trim();
  let queue = Promise.resolve();

  function serialized(work) {
    const operation = queue.then(work);
    queue = operation.catch(() => {});
    return operation;
  }

  function isFresh(result, ttl) {
    const age = clock() - Date.parse(result?.source?.retrievedAt);
    return age >= 0 && age < ttl;
  }

  async function request(path, params = {}) {
    const source = new URL(provider + path);
    source.search = new URLSearchParams(params);
    const url = new URL(source);
    url.searchParams.set('apiKey', key);
    try {
      const response = await fetcher(url.href, {
        redirect: 'manual', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000)
      });
      const header = response.headers.get('x-requests-remaining');
      const remaining = /^\d+$/.test(header ?? '') && Number.isSafeInteger(Number(header)) ? Number(header) : null;
      const observedAt = clock();
      let retryAt = 0;
      let error;
      if (!response.ok) {
        console.warn(`The Odds API ${source.pathname} returned HTTP ${response.status}.`);
        error = response.status === 401 || response.status === 403 ? 'access-denied' : response.status === 429 ? 'rate-limited' : 'unavailable';
        if (error === 'rate-limited') {
          const value = response.headers.get('Retry-After');
          const delay = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - observedAt;
          retryAt = observedAt + Math.max(minute, delay || 0);
        }
      }
      // Keep the response headers even when the odds body is missing or unreadable.
      const data = response.ok ? await response.json().catch(() => null) : null;
      return { data, error: error ?? (data == null ? 'unavailable' : undefined), quota: { remaining, observedAt, retryAt },
        source: { url: source.href, retrievedAt: new Date(observedAt).toISOString(), lastModified: validTimestamp(response.headers.get('Last-Modified')) } };
    } catch (error) {
      console.warn(`The Odds API ${source.pathname} request failed (${error?.name ?? 'Error'}).`);
      return { error: 'unavailable', quota: { remaining: null, observedAt: clock(), retryAt: 0 } };
    }
  }

  async function checkEvents() {
    const result = await request('/events'); // The provider does not charge quota for this endpoint.
    await store.write('quota', result.quota);
    if (Array.isArray(result.data)) {
      result.data = result.data.filter(event => event?.sport_key === 'soccer_epl').map(({ id, sport_key, commence_time, home_team, away_team }) =>
        ({ id, sport_key, commence_time, home_team, away_team }));
      await store.write('events', { data: result.data, source: result.source });
    }
    return result;
  }

  function listEvents() {
    return serialized(async () => {
      if (!key) return { error: 'missing-key' };
      const saved = await store.read('events');
      const quota = await store.read('quota');
      if (isFresh(saved, 30 * minute)) return saved;
      if (quota?.retryAt > clock()) return saved ?? { error: 'rate-limited' };
      const current = await checkEvents();
      if (Array.isArray(current.data)) return { data: current.data, source: current.source };
      return saved ?? { error: current.error ?? 'unavailable' };
    });
  }

  function prices(eventIds) {
    return serialized(async () => {
      if (!key) return { snapshots: [], error: 'missing-key' };
      const ids = [...new Set(eventIds)].filter(id => /^[a-z\d_-]+$/i.test(id ?? ''));
      const saved = await Promise.all(ids.map(id => store.read(`event-${id}`)));
      let quota = await store.read('quota');
      if (saved.some(result => !isFresh(result, 5 * minute)) && !(quota?.retryAt > clock())
        && (!quota || clock() - quota.observedAt >= minute)) {
        quota = (await checkEvents()).quota;
      }

      const snapshots = [];
      let error = quota?.retryAt > clock() ? 'rate-limited' : undefined;
      for (const [index, id] of ids.entries()) {
        const cached = saved[index];
        if (isFresh(cached, 5 * minute)) {
          snapshots.push({ ...cached, saved: true });
          continue;
        }
        if (quota?.remaining >= minimumCredits && !(quota.retryAt > clock()) && !error) {
          // Persist the debit before making the request, so a restart cannot reuse this credit.
          await store.write('quota', { ...quota, remaining: quota.remaining - 1 });
          const result = await request(`/events/${id}/odds`, { regions: 'uk', markets: marketKey, oddsFormat: 'decimal' });
          quota = result.quota;
          await store.write('quota', quota);
          const { data, source } = result;
          const bookmakers = sanitizeBookmakers(data?.bookmakers);
          if (data?.id === id && data.sport_key === 'soccer_epl' && validTimestamp(data.commence_time) && bookmakers.length) {
            const snapshot = { data: { id: data.id, sport_key: data.sport_key, commence_time: data.commence_time, bookmakers }, source };
            await store.write(`event-${id}`, snapshot);
            snapshots.push(snapshot);
            continue;
          }
          error = result.error;
        }
        if (cached) snapshots.push({ ...cached, saved: true });
      }
      const paused = quota?.remaining == null ? 'unverified' : quota.remaining < minimumCredits ? 'low-credits' : null;
      return { snapshots, paused, error };
    });
  }

  return { listEvents, prices };
}
