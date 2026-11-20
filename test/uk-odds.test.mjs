import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUkOddsComparison } from '../lib/uk-odds.mjs';
import { createUkOddsFeed } from '../lib/uk-odds-feed.mjs';

const now = Date.parse('2026-11-20T12:00:00Z');
const kickoff = '2026-11-21T15:00:00Z';
const captured = '2026-11-20T11:45:00Z';
const fixture = { id: 100, event: 11, team_h: 1, team_a: 2, kickoff_time: kickoff };
const teams = [{ id: 1, short_name: 'MCI', name: 'Man City' }, { id: 2, short_name: 'TOT', name: 'Spurs' }];
const players = [
  { id: 1, first_name: 'Aléx', second_name: 'Example', web_name: 'Example', team: 1, status: 'a' },
  { id: 2, first_name: 'Sam', second_name: 'Sample', web_name: 'Sample', team: 2, status: 'a' },
  { id: 3, first_name: 'Lee', second_name: 'Single', web_name: 'Single', team: 2, status: 'a' },
  { id: 4, first_name: 'Pat', second_name: 'Injured', web_name: 'Injured', team: 1, status: 'i' }
];
const data = { teams, players, fixtures: [fixture, { ...fixture, id: 101, event: 12 }] };
const event = { id: 'evt_example', sport_key: 'soccer_epl', home_team: 'Manchester City',
  away_team: 'Tottenham Hotspur FC', commence_time: kickoff };
const yes = (description, price) => ({ name: 'Yes', description, price });
const anytime = (outcomes, last_update) => ({ key: 'player_goal_scorer_anytime', last_update, outcomes });
const bookmaker = (key, title, markets) => ({ key, title, last_update: captured, markets });
const apiResponse = (body, remaining) => Response.json(body, { headers: { 'x-requests-remaining': String(remaining) } });
const odds = { ...event, bookmakers: [
  bookmaker('williamhill', 'William Hill', [anytime([yes('Alex Example', 2), yes('A. Example', 2), yes('Sam Sample', 3),
    yes('Lee Single', 2.3), yes('Pat Injured', 1.5)])]),
  bookmaker('betway', 'Betway', [anytime([{ name: 'Example', price: '2.50' }, yes('Sample', 4), yes('Pat Injured', 1.7),
    { name: 'No', description: 'Lee Single', price: 1.66 }], '2026-11-20T11:46:00Z'),
  { key: 'player_first_goal_scorer', outcomes: [yes('Lee Single', 4.5)] }]),
  bookmaker('williamhill_us', 'US Book', [anytime([yes('Alex Example', 1.02)])]),
  bookmaker('betfair_ex_uk', 'UK Exchange', [anytime([yes('Alex Example', 1.03)])]),
  bookmaker('unknown', 'Unverified Book', [anytime([yes('Alex Example', 1.04)])])
] };

test('compares the same upcoming Premier League market only across verified UK sportsbooks', async () => {
  const requests = [];
  const search = createUkOddsComparison(createUkOddsFeed('test-key', { fetcher: async (input, options) => {
    const url = new URL(input);
    assert.equal(url.host, 'api.the-odds-api.com');
    assert.equal(url.searchParams.get('apiKey'), 'test-key');
    assert.equal(options.redirect, 'manual');
    requests.push([url, options]);
    if (url.pathname.endsWith('/events')) {
      assert.equal(url.pathname, '/v4/sports/soccer_epl/events');
      const events = [event, { ...event, id: 'foreign', sport_key: 'soccer_uefa_champs_league' },
        { ...event, id: 'other-week', commence_time: '2026-11-26T15:00:00Z' }];
      return apiResponse(events, 50);
    }
    assert.equal(url.pathname, '/v4/sports/soccer_epl/events/evt_example/odds');
    assert.equal(url.searchParams.get('regions'), 'uk');
    assert.equal(url.searchParams.get('markets'), 'player_goal_scorer_anytime');
    assert.equal(url.searchParams.get('oddsFormat'), 'decimal');
    return apiResponse(odds, 49);
  } }));
  const report = await search(data, 11, now);
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.coverage, { fixtures: 1, matched: 1, compared: 1, singleBookPlayers: 1 });
  assert.deepEqual(report.recommendations.map(player => player.playerId), [1, 2]);
  const [lead] = report.recommendations[0].matches;
  assert.equal(lead.implied, 0.45);
  assert.deepEqual(lead.quotes, [
    { bookmaker: 'Betway', price: 2.5, updatedAt: new Date('2026-11-20T11:46:00Z').toISOString() },
    { bookmaker: 'William Hill', price: 2, updatedAt: new Date(captured).toISOString() }
  ]);
  assert.ok(!JSON.stringify(report).includes('test-key'));
  assert.ok(report.sources.every(source => !new URL(source.url).searchParams.has('apiKey')));
  const repeat = await search(data, 11, now);
  assert.deepEqual(repeat.recommendations[0].matches[0], { ...lead, saved: true });
  assert.equal(requests.length, 2);
});

test('reports unavailable credentials and honours provider throttling without publishing quotes', async () => {
  const missing = createUkOddsComparison(createUkOddsFeed(undefined, { fetcher: () => assert.fail('missing credentials must skip fetch') }));
  assert.equal((await missing(data, 11, now)).status, 'missing-key');
  let batchCalls = 0;
  const search = createUkOddsComparison(createUkOddsFeed('test-key', { fetcher: async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/events')) return apiResponse([event], 100);
    batchCalls += 1;
    return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
  } }));
  const limited = await search(data, 11, now);
  assert.equal(limited.status, 'rate-limited');
  assert.deepEqual(limited.recommendations, []);
  await search(data, 11, now);
  assert.equal(batchCalls, 1);
});

test('keeps the key on the configured provider when a response redirects', async () => {
  const requests = [];
  const search = createUkOddsComparison(createUkOddsFeed('test-key', { fetcher: async (url, options) => {
    requests.push(new URL(url).hostname);
    assert.equal(options.redirect, 'manual');
    return Response.redirect('https://redirect.example/');
  } }));
  const report = await search(data, 11, now);
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(requests, ['api.the-odds-api.com']);
  assert.deepEqual(report.sources, []);
});

test('pauses below ten credits and reuses saved quotes after restart', async () => {
  let clock = now;
  let remaining = 10;
  let priceCalls = 0;
  const saved = new Map();
  const store = { read: key => saved.get(key), write: (key, value) => saved.set(key, value) };
  const fetcher = async url => {
    if (new URL(url).pathname.endsWith('/events')) return apiResponse([event], remaining);
    priceCalls += 1;
    remaining -= 1;
    return apiResponse(odds, remaining);
  };
  const start = () => createUkOddsComparison(createUkOddsFeed('test-key', { store, clock: () => clock, fetcher }));
  const first = await start()(data, 11, now);
  assert.equal(first.paused, 'low-credits');
  assert.equal(priceCalls, 1);
  const original = first.recommendations[0].matches[0];
  assert.equal(original.saved, false);
  assert.ok(!JSON.stringify([...saved]).includes('test-key'));

  clock += 6 * 60_000;
  const restarted = start();
  const frozen = await restarted(data, 11, clock);
  assert.equal(frozen.paused, 'low-credits');
  assert.deepEqual(frozen.recommendations[0].matches[0], { ...original, saved: true });
  assert.equal(priceCalls, 1);

  remaining = 25;
  clock += 60_000;
  const resumed = await restarted(data, 11, clock);
  assert.equal(resumed.paused, null);
  assert.equal(resumed.recommendations[0].matches[0].saved, false);
  assert.equal(priceCalls, 2);
});

test('serializes refreshes across requests to respect the credit floor', async () => {
  const moreEvents = [event, { ...event, id: 'second' }, { ...event, id: 'third' }, { ...event, id: 'fourth' }];
  let remaining = 11;
  const paid = [];
  const feed = createUkOddsFeed('test-key', { clock: () => now, fetcher: async raw => {
    const path = new URL(raw).pathname;
    if (path.endsWith('/events')) return apiResponse(moreEvents, remaining);
    const id = path.split('/').at(-2);
    paid.push(id);
    return apiResponse({ ...odds, id }, --remaining);
  } });
  await feed.listEvents();
  const results = await Promise.all([feed.prices(['evt_example', 'second']), feed.prices(['third', 'fourth'])]);
  assert.deepEqual(paid, ['evt_example', 'second']);
  assert.deepEqual(results.map(result => result.paused), ['low-credits', 'low-credits']);
  assert.equal(results[1].snapshots.length, 0);
});

test('pauses metered odds requests when the quota header is unavailable', async () => {
  const feed = createUkOddsFeed('test-key', { fetcher: async url => {
    assert.ok(new URL(url).pathname.endsWith('/events'));
    return Response.json([event]);
  } });
  const report = await createUkOddsComparison(feed)(data, 11, now);
  assert.equal(report.status, 'quota-paused');
  assert.equal(report.paused, 'unverified');
  assert.deepEqual(report.recommendations, []);
});

test('preserves the last usable odds when a refresh returns malformed markets', async () => {
  let clock = now;
  let currentOdds = odds;
  const feed = createUkOddsFeed('test-key', { clock: () => clock, fetcher: async url =>
    apiResponse(new URL(url).pathname.endsWith('/events') ? [event] : currentOdds, 20) });
  const search = createUkOddsComparison(feed);
  const first = await search(data, 11, now);
  currentOdds = { ...event, bookmakers: [null, bookmaker('williamhill', 'William Hill', [anytime([null, yes('Example', 0)])])] };
  clock += 6 * 60_000;
  const fallback = await search(data, 11, clock);
  assert.equal(fallback.status, 'ready');
  assert.deepEqual(fallback.recommendations[0].matches[0], { ...first.recommendations[0].matches[0], saved: true });
});
