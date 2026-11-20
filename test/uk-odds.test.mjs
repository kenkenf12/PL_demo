import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUkOddsComparison } from '../lib/uk-odds.mjs';

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
const event = { event_id: 'evt_example', league_name: 'England - Premier League', home_team: 'Manchester City',
  away_team: 'Tottenham Hotspur FC', kickoff_utc: kickoff };
const bookmakers = [
  { bookmaker_code: 'UO001', name: 'UK Book A', type: 'sportsbook', region: 'uk' },
  { bookmaker_code: 'UO004', name: 'UK Book B', type: 'sportsbook' },
  { bookmaker_code: 'UO007', name: 'US Book', type: 'sportsbook', region: 'us' },
  { bookmaker_code: 'UO006', name: 'UK Exchange', type: 'exchange', region: 'uk' },
  { bookmaker_code: 'unknown', name: 'Unverified Book', type: 'sportsbook' }
];

const quote = (selection_name, odds, bookmaker_code, status = 'ACTIVE') => ({ selection_name, odds, bookmaker_code, status });
const odds = { [event.event_id]: { event_id: event.event_id, kickoff_utc: kickoff, captured_at: captured, markets: [
  { market_name: 'Anytime Goalscorer', selections: [
    quote('Alex Example', 2, 'UO001'), quote('Example', '2.50', 'UO004'), quote('A. Example', 2, 'UO001'),
    quote('Alex Example', 1.02, 'UO007'), quote('Alex Example', 1.03, 'UO006'), quote('Alex Example', 1.04, 'unknown'),
    quote('Sam Sample', 3, 'UO001'), quote('Sample', 4, 'UO004'), quote('Lee Single', 2.3, 'UO001'),
    quote('Lee Single', 2.33, 'UO004', 'SUSPENDED'), quote('Pat Injured', 1.5, 'UO001'), quote('Pat Injured', 1.7, 'UO004')
  ] },
  { market_key: 'first_goalscorer', selections: [quote('Lee Single', 4.5, 'UO004')] }
] } };

test('compares the same upcoming Premier League market only across verified UK sportsbooks', async () => {
  const requests = [];
  const search = createUkOddsComparison('test-key', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.host, 'api.ukoddsapi.com');
    assert.equal(options.headers['X-Api-Key'], 'test-key');
    assert.ok(!url.href.includes('test-key'));
    requests.push([url, options]);
    if (url.pathname.endsWith('/events')) {
      assert.equal(url.searchParams.get('league'), 'Premier League');
      const events = [event, { ...event, event_id: 'foreign', league_name: 'Russian Premier League' },
        { ...event, event_id: 'other-week', kickoff_utc: '2026-11-26T15:00:00Z' }];
      return Response.json({ events });
    }
    if (url.pathname.endsWith('/bookmakers')) return Response.json({ bookmakers });
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { event_ids: ['evt_example'], package: 'core', market: 'anytime',
      odds_format: 'decimal', best_only: false });
    return Response.json({ odds });
  });
  const report = await search(data, 11, now);
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.coverage, { fixtures: 1, matched: 1, compared: 1, singleBookPlayers: 1 });
  assert.deepEqual(report.recommendations.map(player => player.playerId), [1, 2]);
  const [lead] = report.recommendations[0].matches;
  assert.equal(lead.implied, 0.45);
  assert.equal(lead.capturedAt, new Date(captured).toISOString());
  assert.deepEqual(lead.quotes.map(offer => [offer.bookmaker, offer.price]), [['UK Book B', 2.5], ['UK Book A', 2]]);
  assert.ok(!JSON.stringify(report).includes('test-key'));
  assert.deepEqual(await search(data, 11, now), report);
  assert.equal(requests.length, 3);
});

test('reports unavailable credentials and honours provider throttling without publishing quotes', async () => {
  const missing = createUkOddsComparison(undefined, () => assert.fail('missing credentials must skip fetch'));
  assert.equal((await missing(data, 11, now)).status, 'missing-key');
  let batchCalls = 0;
  const search = createUkOddsComparison('test-key', async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/events')) return Response.json({ events: [event] });
    if (path.endsWith('/bookmakers')) return Response.json({ bookmakers });
    batchCalls += 1;
    return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
  });
  const limited = await search(data, 11, now);
  assert.equal(limited.status, 'rate-limited');
  assert.deepEqual(limited.recommendations, []);
  await search(data, 11, now);
  assert.equal(batchCalls, 1);
});
