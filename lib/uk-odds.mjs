import { availability } from '../public/model.mjs';
import { createUkOddsFeed, marketKey, ukSportsbooks, validTimestamp } from './uk-odds-feed.mjs';

const providerDocs = 'https://the-odds-api.com/sports/epl-odds.html';
const minute = 60_000;
const market = 'Anytime goalscorer';
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
  const remote = events.filter(event => event.sport_key === 'soccer_epl' && /^[a-z\d_-]+$/i.test(event.id ?? ''));
  return fixtures.flatMap(fixture => {
    const kickoff = Date.parse(fixture.kickoff_time);
    const matches = remote.filter(event => aliases.get(teamKey(event.home_team)) === fixture.team_h
      && aliases.get(teamKey(event.away_team)) === fixture.team_a && Math.abs(Date.parse(event.commence_time) - kickoff) <= 60 * minute);
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

function matchPrices(snapshot, fixture, players, teams) {
  const identify = indexPlayers(players.filter(player => player.team === fixture.team_h || player.team === fixture.team_a));
  const priceByPlayer = new Map();
  for (const bookmaker of snapshot.bookmakers) {
    if (!ukSportsbooks.has(bookmaker.key) || !bookmaker.title) continue;
    for (const offer of bookmaker.markets ?? []) {
      if (offer.key !== marketKey) continue;
      const updatedAt = validTimestamp(offer.last_update) ?? validTimestamp(bookmaker.last_update);
      for (const outcome of offer.outcomes ?? []) {
        const side = normalize(outcome.name);
        const player = identify(side === 'yes' ? outcome.description : outcome.name);
        if (!player || availability(player) <= 0) continue;
        if (!priceByPlayer.has(player.id)) priceByPlayer.set(player.id, { player, quotes: new Map() });
        const record = priceByPlayer.get(player.id);
        // Conflicting prices under the same bookmaker are ambiguous, so exclude that quote.
        if (record.quotes.has(bookmaker.key) && record.quotes.get(bookmaker.key)?.price !== outcome.price) {
          record.quotes.set(bookmaker.key, null);
        } else if (!record.quotes.has(bookmaker.key)) {
          record.quotes.set(bookmaker.key, { bookmaker: bookmaker.title, price: outcome.price, updatedAt });
        }
      }
    }
  }

  return [...priceByPlayer.values()].flatMap(({ player, quotes }) => {
    const prices = [...quotes.values()].filter(Boolean).sort((a, b) => b.price - a.price || a.bookmaker.localeCompare(b.bookmaker));
    if (!prices.length) return [];
    const middle = Math.floor(prices.length / 2);
    const implied = prices.length % 2 ? 1 / prices[middle].price : (1 / prices[middle - 1].price + 1 / prices[middle].price) / 2;
    return [{ player, fixture: { id: fixture.id, kickoff: fixture.kickoff_time, home: teams.get(fixture.team_h), away: teams.get(fixture.team_a),
      implied, quotes: prices } }];
  });
}

const fixtureOrder = (a, b) => b.implied - a.implied || b.quotes.length - a.quotes.length || Date.parse(a.kickoff) - Date.parse(b.kickoff);

export function createUkOddsComparison(feed = createUkOddsFeed()) {
  return async (data, gameweek, now) => {
    const fixtures = data.fixtures.filter(fixture => fixture.event === gameweek && !fixture.started && !fixture.finished
      && Date.parse(fixture.kickoff_time) > now);
    const coverage = { fixtures: fixtures.length, matched: 0, compared: 0, singleBookPlayers: 0 };
    const report = { market, provider: { name: 'The Odds API', url: providerDocs }, coverage, recommendations: [], sources: [] };
    if (!fixtures.length) return { ...report, status: 'no-fixtures' };

    const events = await feed.listEvents();
    if (events.error) return { ...report, status: events.error };
    if (!Array.isArray(events.data)) {
      console.warn('The Odds API returned an unexpected Premier League events response.');
      return { ...report, status: 'unavailable' };
    }
    report.sources.push({ ...events.source, label: 'Premier League event list' });
    const matching = identifyEvents(data, fixtures, events.data);
    coverage.matched = matching.length;
    if (!matching.length) return { ...report, status: 'insufficient' };

    const { snapshots, paused, error } = await feed.prices(matching.map(({ event }) => event.id));
    const byEvent = new Map(snapshots.map(result => [result.data.id, result]));
    const teams = new Map(data.teams.map(team => [team.id, team.name]));
    const selected = new Map();
    const singles = new Set();
    const compared = new Set();
    for (const { fixture, event } of matching) {
      const result = byEvent.get(event.id);
      const snapshot = result?.data;
      const kickoff = Date.parse(snapshot?.commence_time);
      if (snapshot?.id !== event.id || snapshot.sport_key !== 'soccer_epl' || !Array.isArray(snapshot.bookmakers)
        || !Number.isFinite(kickoff) || Math.abs(kickoff - Date.parse(event.commence_time)) > 60 * minute) continue;
      report.sources.push({ ...result.source, label: `${teams.get(fixture.team_h)} v ${teams.get(fixture.team_a)} anytime goalscorer prices` });
      for (const { player, fixture: prices } of matchPrices(snapshot, fixture, data.players, teams)) {
        if (prices.quotes.length < 2) {
          singles.add(player.id);
          continue;
        }
        compared.add(fixture.id);
        if (!selected.has(player.id)) selected.set(player.id, { playerId: player.id, name: [player.first_name, player.second_name]
          .filter(Boolean).join(' ') || player.web_name, team: teams.get(player.team), matches: [] });
        selected.get(player.id).matches.push({ ...prices, saved: result.saved === true, retrievedAt: result.source.retrievedAt });
      }
    }
    coverage.compared = compared.size;
    coverage.singleBookPlayers = [...singles].filter(id => !selected.has(id)).length;
    report.recommendations = [...selected.values()].map(player => ({ ...player, matches: player.matches.sort(fixtureOrder) }))
      .sort((a, b) => b.matches[0].implied - a.matches[0].implied || b.matches[0].quotes.length - a.matches[0].quotes.length
        || a.name.localeCompare(b.name));
    return { ...report, paused, status: report.recommendations.length ? 'ready' : error ?? (paused ? 'quota-paused' : 'insufficient') };
  };
}
