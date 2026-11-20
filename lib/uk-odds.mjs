import { availability } from '../public/model.mjs';

const provider = 'https://api.ukoddsapi.com';
const providerDocs = 'https://ukoddsapi.com/market-coverage';
const minute = 60_000;
const day = 24 * 60 * minute;
const market = 'Anytime goalscorer';
const leagueNames = new Set(['premier league', 'english premier league', 'england premier league', 'premier league england']);
const ukRegions = new Set(['uk', 'gb', 'great britain', 'united kingdom']);
// The provider publishes this UK registry, including which codes are exchanges.
const documentedUkBooks = /^UO0(?:0[1-5]|0[7-9]|1[0-7]|19|2[0-3]|2[5-9]|3[0-4])$/;
const teamNames = {
  BHA: ['Brighton and Hove Albion'], EVE: ['Everton'], IPS: ['Ipswich Town'], LEE: ['Leeds United'],
  MCI: ['Manchester City'], MUN: ['Manchester United', 'Manchester Utd'], NEW: ['Newcastle United'],
  NFO: ['Nottingham Forest', 'Nottm Forest'], TOT: ['Tottenham', 'Tottenham Hotspur'],
  WHU: ['West Ham United'], WOL: ['Wolverhampton Wanderers']
};

function normalize(value) {
  return String(value ?? '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
    .replace(/[øłđðß]/g, ch => ({ ø: 'o', ł: 'l', đ: 'd', ð: 'd', ß: 'ss' })[ch])
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function teamKey(value) {
  return normalize(value).replace(/^afc /, '').replace(/ (?:fc|afc)$/, '').replace(/ and /g, ' ');
}

function identifyEvents(data, fixtures, events) {
  const aliases = new Map(data.teams.flatMap(team => [team.name, team.short_name, ...(teamNames[team.short_name] ?? [])]
    .map(name => [teamKey(name), team.id])));
  const remote = events.filter(event => leagueNames.has(normalize(event.league_name)) && /^[a-z\d_-]+$/i.test(event.event_id ?? ''));
  return fixtures.flatMap(fixture => {
    const kickoff = Date.parse(fixture.kickoff_time);
    const matches = remote.filter(event => aliases.get(teamKey(event.home_team)) === fixture.team_h
      && aliases.get(teamKey(event.away_team)) === fixture.team_a && Math.abs(Date.parse(event.kickoff_utc) - kickoff) <= 60 * minute);
    return matches.length === 1 ? [{ fixture, event: matches[0] }] : [];
  });
}

function indexPlayers(players) {
  const index = new Map();
  for (const player of players) {
    const full = normalize([player.first_name, player.second_name].filter(Boolean).join(' '));
    const names = full.split(' ');
    const first = names[0];
    const last = names.at(-1);
    for (const name of new Set([full, normalize(player.web_name), normalize(player.known_name), normalize(player.second_name),
      `${first} ${last}`, `${first?.[0]} ${last}`])) {
      if (!name || (!name.includes(' ') && name.length < 3)) continue;
      if (index.has(name) && index.get(name)?.id !== player.id) index.set(name, null);
      else index.set(name, player);
    }
  }
  return name => {
    const key = normalize(name);
    if (index.has(key)) return index.get(key);
    const parts = key.split(' ');
    return parts.length > 2 ? index.get(`${parts[0]} ${parts.at(-1)}`) : undefined;
  };
}

function validTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function decimalPrice(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 1 ? price : null;
}

function matchPrices(snapshot, fixture, sportsbook, players, teams) {
  const identify = indexPlayers(players.filter(player => player.team === fixture.team_h || player.team === fixture.team_a));
  const priceByPlayer = new Map();
  for (const offer of snapshot.markets ?? []) {
    const key = normalize(offer.market_key ?? offer.key ?? offer.market_name ?? offer.name);
    if (!['anytime goalscorer', 'anytime goal scorer', 'anytime scorer'].includes(key)) continue;
    for (const selection of offer.selections ?? offer.outcomes ?? []) {
      const bookmaker = sportsbook.get(selection.bookmaker_code);
      const price = decimalPrice(selection.odds);
      if (!bookmaker || price == null || normalize(selection.status) !== 'active' || selection.line != null
        || (selection.bookmaker_type && normalize(selection.bookmaker_type) !== 'sportsbook')) continue;
      const player = identify(selection.selection_name ?? selection.name);
      if (!player || availability(player) <= 0) continue;
      if (!priceByPlayer.has(player.id)) priceByPlayer.set(player.id, { player, quotes: new Map() });
      const record = priceByPlayer.get(player.id);
      // Conflicting prices under the same bookmaker are ambiguous, so exclude that quote.
      if (record.quotes.has(bookmaker.code) && record.quotes.get(bookmaker.code)?.price !== price) {
        record.quotes.set(bookmaker.code, null);
      } else if (!record.quotes.has(bookmaker.code)) {
        record.quotes.set(bookmaker.code, { bookmaker: bookmaker.name, price });
      }
    }
  }

  return [...priceByPlayer.values()].flatMap(({ player, quotes }) => {
    const prices = [...quotes.values()].filter(Boolean).sort((a, b) => b.price - a.price || a.bookmaker.localeCompare(b.bookmaker));
    if (!prices.length) return [];
    const middle = Math.floor(prices.length / 2);
    const implied = prices.length % 2 ? 1 / prices[middle].price : (1 / prices[middle - 1].price + 1 / prices[middle].price) / 2;
    return [{ player, fixture: { id: fixture.id, kickoff: fixture.kickoff_time, home: teams.get(fixture.team_h), away: teams.get(fixture.team_a),
      capturedAt: validTimestamp(snapshot.captured_at), implied, quotes: prices } }];
  });
}

const fixtureOrder = (a, b) => b.implied - a.implied || b.quotes.length - a.quotes.length || Date.parse(a.kickoff) - Date.parse(b.kickoff);

export function createUkOddsComparison(apiKey, fetcher = fetch) {
  const cache = new Map();
  const key = apiKey?.trim();

  function request(path, lifetime, payload) {
    const id = `${path}${payload ? JSON.stringify(payload) : ''}`;
    const existing = cache.get(id);
    if (existing && existing.until > Date.now()) return existing.pending;
    const entry = { until: Date.now() + lifetime };
    entry.pending = (async () => {
      const url = provider + path;
      try {
        const response = await fetcher(url, { method: payload ? 'POST' : 'GET', redirect: 'error',
          headers: { 'X-Api-Key': key, accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
          body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(9000) });
        if (!response.ok) {
          const error = response.status === 401 || response.status === 403 ? 'access-denied' : response.status === 429 ? 'rate-limited' : 'unavailable';
          const retryHeader = response.headers.get('Retry-After');
          const retry = Number(retryHeader);
          const wait = retryHeader && Number.isFinite(retry) ? retry * 1000 : Date.parse(retryHeader) - Date.now();
          entry.until = Date.now() + (error === 'rate-limited' ? Math.max(minute, wait || 0) : minute);
          return { error };
        }
        const data = await response.json();
        return { data, source: { url, retrievedAt: new Date().toISOString(), lastModified: validTimestamp(response.headers.get('Last-Modified')) } };
      } catch {
        entry.until = Date.now() + minute;
        return { error: 'unavailable' };
      }
    })();
    cache.set(id, entry);
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    return entry.pending;
  }

  return async (data, gameweek, now) => {
    const fixtures = data.fixtures.filter(fixture => fixture.event === gameweek && !fixture.started && !fixture.finished
      && Date.parse(fixture.kickoff_time) > now);
    const coverage = { fixtures: fixtures.length, matched: 0, compared: 0, singleBookPlayers: 0 };
    const report = { market, provider: { name: 'UK Odds API', url: providerDocs }, coverage, recommendations: [], sources: [] };
    if (!key) return { ...report, status: 'missing-key' };
    if (!fixtures.length) return { ...report, status: 'no-fixtures' };

    const times = fixtures.map(fixture => Date.parse(fixture.kickoff_time));
    const params = new URLSearchParams({ from: new Date(Math.min(...times) - day).toISOString().slice(0, 10),
      to: new Date(Math.max(...times) + day).toISOString().slice(0, 10), league: 'Premier League', upcoming: 'true', per_page: '200' });
    const [events, books] = await Promise.all([request(`/v1/football/events?${params}`, 30 * minute), request('/v1/bookmakers', day)]);
    if (events.error || books.error) return { ...report, status: events.error ?? books.error };
    if (!Array.isArray(events.data?.events) || !Array.isArray(books.data?.bookmakers)) return { ...report, status: 'unavailable' };
    report.sources.push({ ...events.source, label: 'Premier League event list' }, { ...books.source, label: 'UK bookmaker catalogue' });
    const sportsbook = new Map(books.data.bookmakers.filter(book => normalize(book.type) === 'sportsbook'
      && (book.region ? ukRegions.has(normalize(book.region)) : documentedUkBooks.test(book.bookmaker_code))
      && book.bookmaker_code && book.name)
      .map(book => [book.bookmaker_code, { code: book.bookmaker_code, name: book.name }]));
    const matching = identifyEvents(data, fixtures, events.data.events);
    coverage.matched = matching.length;
    if (!matching.length || sportsbook.size < 2) return { ...report, status: 'insufficient' };

    const batch = await request('/v1/football/odds/batch', 5 * minute, { event_ids: matching.map(({ event }) => event.event_id).sort(),
      package: 'core', market: 'anytime', odds_format: 'decimal', best_only: false });
    if (batch.error || !batch.data?.odds || typeof batch.data.odds !== 'object') return { ...report, status: batch.error ?? 'unavailable' };
    report.sources.push({ ...batch.source, label: 'Anytime goalscorer prices' });
    const teams = new Map(data.teams.map(team => [team.id, team.name]));
    const selected = new Map();
    const singles = new Set();
    const compared = new Set();
    for (const { fixture, event } of matching) {
      const snapshot = batch.data.odds[event.event_id];
      if (snapshot?.event_id !== event.event_id || Math.abs(Date.parse(snapshot.kickoff_utc) - Date.parse(event.kickoff_utc)) > 60 * minute
        || !Number.isFinite(Date.parse(snapshot.kickoff_utc))) continue;
      for (const { player, fixture: prices } of matchPrices(snapshot, fixture, sportsbook, data.players, teams)) {
        if (prices.quotes.length < 2) {
          singles.add(player.id);
          continue;
        }
        compared.add(fixture.id);
        if (!selected.has(player.id)) selected.set(player.id, { playerId: player.id, name: [player.first_name, player.second_name]
          .filter(Boolean).join(' ') || player.web_name, team: teams.get(player.team), matches: [] });
        selected.get(player.id).matches.push(prices);
      }
    }
    coverage.compared = compared.size;
    coverage.singleBookPlayers = [...singles].filter(id => !selected.has(id)).length;
    report.recommendations = [...selected.values()].map(player => ({ ...player, matches: player.matches.sort(fixtureOrder) }))
      .sort((a, b) => b.matches[0].implied - a.matches[0].implied || b.matches[0].quotes.length - a.matches[0].quotes.length
        || a.name.localeCompare(b.name));
    return { ...report, status: report.recommendations.length ? 'ready' : 'insufficient' };
  };
}
