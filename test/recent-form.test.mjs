import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecentForm } from '../lib/recent-form.mjs';
import { predictSquad } from '../lib/squad-prediction.mjs';

test('recent form selects verified non-EPL participants and excludes unused or EPL-only players', async t => {
  const cutoff = Date.parse('2026-11-06T12:00:00Z');
  const players = ['Cup Player', 'European Player', 'International Player', 'Unused Substitute', 'League Leader']
    .map((name, index) => {
      const [first_name, second_name] = name.split(' ');
      return { id: index + 1, first_name, second_name, web_name: name, team: 1, region: 11, element_type: 3,
        now_cost: 50, minutes: 270, total_points: index === 4 ? 99 : 10, status: 'a' };
    });
  const teams = [{ id: 1, name: 'Test City', short_name: 'TST' }, { id: 2, name: 'Test United', short_name: 'UTD' }];
  const fixture = { id: 1, event: 11, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3 };
  const dashboard = { players, teams, positions: [{ id: 3, singular_name: 'Midfielder' }],
    fixtures: [{ ...fixture, id: 2, event: 10, finished: true }, fixture],
    events: [{ id: 10, finished: true, data_checked: true }, { id: 11 }] };
  const previous = { event: 10, players: players.map(player => ({ id: player.id, minutes: 90, total_points: player.total_points })),
    sources: [] };
  const club = { id: '21', displayName: 'Test City', abbreviation: 'TST' };
  const nation = { id: '22', displayName: 'England', abbreviation: 'ENG' };
  const status = { type: { completed: true } };
  const event = (id, league, team) => ({ id, status, date: '2026-11-05T20:00:00Z',
    links: [{ href: 'https://www.espn.com/soccer/team-stats/_/gameId/' + id + '/league/' + league }],
    competitions: [{ competitors: [{ team }] }] });
  const events = [event('1', 'eng.league_cup', club), event('2', 'uefa.champions', club),
    event('3', 'uefa.nations', nation), event('4', 'eng.1', club),
    { ...event('5', 'uefa.europa', club), status: { type: { completed: false } } }];
  const member = (index, flags) => ({ ...flags, athlete: { fullName: players[index].web_name } });
  const rosters = {
    1: [member(0, { starter: true }), member(3, { starter: false, subbedIn: false })],
    2: [member(1, { subbedIn: true })],
    3: [member(2, { stats: [{ name: 'appearances', value: 1 }] })]
  };
  const summaries = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/scoreboard')) return Response.json({ events: searchParams.get('dates') === '20261105' ? events : [] });
    const id = searchParams.get('event');
    summaries.push(id);
    return Response.json({ header: { competitions: [{ status }] },
      rosters: [{ team: id === '3' ? nation : club, roster: rosters[id] }] });
  });

  const form = createRecentForm({
    getRegions: async () => ({ regions: [{ id: 11, name: 'England', iso_code_long: 'ENG' }] }),
    getLive: () => assert.fail('Reuse the official results fetched during refresh')
  });
  const recent = await form({ dashboard, week: { id: 11 }, previous }, cutoff);
  const result = predictSquad(dashboard, [fixture], 'recent', null, recent);
  assert.deepEqual(summaries.sort(), ['1', '2', '3']);
  assert.equal(recent.performances[4].domesticWeeks, 1);
  assert.deepEqual(result.players.map(player => player.id).sort(), [1, 2, 3]);
  assert.ok(result.players.every(player => player.evidence.cupMatches + player.evidence.europeanMatches + player.evidence.internationalMatches === 1));
  assert.equal(result.shortlist, true);
  assert.equal(result.captain, null);
  assert.equal(result.viceCaptain, null);
  const empty = predictSquad(dashboard, [fixture], 'recent', null, { performances: {} });
  assert.equal(empty.shortlist, true);
  assert.deepEqual(empty.players, []);
});
