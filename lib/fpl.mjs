const official = 'https://fantasy.premierleague.com';
const version = 2;
const minute = 60_000;

export class FplError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function headerTimestamp(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

async function officialData(path) {
  const url = official + path;
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw new FplError('Could not reach the official FPL feed.');
  }
  if (response.status === 404) throw new FplError('This record is unavailable on official FPL.', 404);
  if (!response.ok) throw new FplError(`The official FPL feed returned HTTP ${response.status}.`);

  try {
    const data = await response.json();
    return {
      data,
      source: {
        url,
        retrievedAt: new Date().toISOString(),
        upstreamDate: headerTimestamp(response.headers.get('date')),
        lastModified: headerTimestamp(response.headers.get('last-modified'))
      }
    };
  } catch {
    throw new FplError('The official FPL feed returned an unreadable response.');
  }
}

function seasonStart(events) {
  const first = events.find(event => event.id === 1);
  return first && Number.isFinite(Date.parse(first.deadline_time))
    ? new Date(first.deadline_time).getUTCFullYear()
    : null;
}

function expectedSeasonStart(now = new Date()) {
  return now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0);
}

function assertCurrentSeason(events) {
  if (seasonStart(events) !== expectedSeasonStart()) {
    throw new FplError('The official feed has yet to provide the current season in this environment.');
  }
}

const playerFields = [
  'id', 'first_name', 'second_name', 'web_name', 'known_name', 'region', 'team', 'element_type', 'now_cost',
  'total_points', 'minutes', 'starts', 'goals_scored', 'assists', 'clean_sheets',
  'saves', 'bonus', 'form', 'selected_by_percent', 'expected_goals', 'expected_assists',
  'defensive_contribution', 'status', 'chance_of_playing_next_round', 'news', 'news_added'
];

function takeFields(record, fields) {
  return Object.fromEntries(fields.map(field => [field, record[field]]));
}

export function createFplClient(snapshot) {
  let dashboard;
  let dashboardRequest;
  const records = new Map();

  async function cachedRecord(path, maxAge) {
    const existing = records.get(path);
    if (existing && Date.now() - existing.startedAt < maxAge) return existing.request;
    const request = officialData(path);
    records.set(path, { startedAt: Date.now(), request });
    if (records.size > 250) records.delete(records.keys().next().value);
    try {
      return await request;
    } catch (error) {
      if (records.get(path)?.request === request) records.delete(path);
      throw error;
    }
  }

  async function savedDashboard() {
    if (dashboard) return dashboard;
    try {
      const saved = await snapshot.read();
      if (saved && [1, version].includes(saved.version) && saved.dashboard?.seasonYear === expectedSeasonStart()) {
        dashboard = saved.dashboard;
      }
      return dashboard;
    } catch {
      return undefined;
    }
  }

  async function updateDashboard() {
    const [bootstrap, fixtures] = await Promise.all([
      officialData('/api/bootstrap-static/'), officialData('/api/fixtures/')
    ]);
    const { elements, element_types, teams, events } = bootstrap.data;
    if (![elements, element_types, teams, events, fixtures.data].every(Array.isArray)
      || !elements.length || !teams.length || !events.length || !fixtures.data.length) {
      throw new FplError('The official FPL season feeds are missing required records.');
    }
    assertCurrentSeason(events);
    const teamIds = new Set(teams.map(team => team.id));
    const eventIds = new Set(events.map(event => event.id));
    const positionIds = new Set(element_types.map(position => position.id));
    const fixtureTeams = fixtures.data.every(fixture => teamIds.has(fixture.team_h)
      && teamIds.has(fixture.team_a) && (fixture.event == null || eventIds.has(fixture.event)));
    const fixtureDates = fixtures.data.some(fixture => Number.isFinite(Date.parse(fixture.kickoff_time))
      && Date.parse(fixture.kickoff_time) >= Date.parse(events.find(event => event.id === 1).deadline_time)
      && new Date(fixture.kickoff_time).getUTCFullYear() === seasonStart(events));
    if (!fixtureTeams || !fixtureDates || !elements.every(player => teamIds.has(player.team)
      && positionIds.has(player.element_type))) {
      throw new FplError('The official FPL feeds do not agree on this season’s records.');
    }

    if (dashboard && dashboard.seasonYear !== seasonStart(events)) records.clear();
    dashboard = {
      seasonYear: seasonStart(events),
      players: elements.map(player => takeFields(player, playerFields)),
      positions: element_types.map(position => takeFields(position, ['id', 'singular_name', 'singular_name_short'])),
      teams: teams.map(team => takeFields(team, ['id', 'name', 'short_name'])),
      events: events.map(event => takeFields(event, ['id', 'name', 'deadline_time', 'is_current', 'is_next', 'finished', 'data_checked'])),
      fixtures: fixtures.data.map(fixture => takeFields(fixture, [
        'id', 'event', 'kickoff_time', 'team_h', 'team_a', 'team_h_score', 'team_a_score',
        'started', 'finished', 'finished_provisional', 'team_h_difficulty', 'team_a_difficulty'
      ])),
      sources: [
        { ...bootstrap.source, label: 'Players, clubs and Gameweeks' },
        { ...fixtures.source, label: 'Fixtures and results' }
      ]
    };
    try {
      await snapshot.write({ version, dashboard });
    } catch (error) {
      console.warn('Could not save the FPL snapshot:', error.code ?? error.message);
    }
    return { ...dashboard, stale: false };
  }

  async function getDashboard(force = false) {
    const saved = await savedDashboard();
    const valid = saved?.seasonYear === expectedSeasonStart();
    const age = valid ? Date.now() - Math.min(...saved.sources.map(source => Date.parse(source.retrievedAt))) : Infinity;
    if (!force) {
      if (valid) return { ...saved, stale: age >= 10 * minute };
      throw new FplError('Select a Gameweek and refresh FPL data to load this season.', 409);
    }
    if (dashboardRequest) return dashboardRequest;

    dashboardRequest = updateDashboard().catch(error => {
      if (valid) return { ...saved, stale: true, refreshError: error.message };
      throw error;
    }).finally(() => { dashboardRequest = undefined; });
    return dashboardRequest;
  }

  async function getPlayer(id) {
    const current = await getDashboard();
    if (!current.players.some(player => player.id === id)) throw new FplError('Player ID is outside the current FPL season.', 404);
    const { data, source } = await cachedRecord(`/api/element-summary/${id}/`, 10 * minute);
    return {
      history: data.history.map(match => takeFields(match, [
        'fixture', 'opponent_team', 'round', 'kickoff_time', 'was_home', 'minutes', 'total_points',
        'value', 'goals_scored', 'assists', 'clean_sheets', 'expected_goals', 'expected_assists'
      ])),
      fixtures: data.fixtures.map(fixture => takeFields(fixture, [
        'id', 'event', 'kickoff_time', 'team_h', 'team_a', 'is_home', 'difficulty'
      ])),
      sources: [{ ...source, label: 'Player match history and fixtures' }]
    };
  }

  async function getLive(event, fresh = false, maxAge = minute) {
    const current = await getDashboard();
    if (!current.events.some(week => week.id === event)) throw new FplError('Unknown Gameweek.', 404);
    const { data, source } = await cachedRecord(`/api/event/${event}/live/`, fresh ? 0 : maxAge);
    return {
      event,
      players: data.elements.map(({ id, stats }) => ({ id, ...takeFields(stats, [
        'minutes', 'total_points', 'goals_scored', 'assists', 'bonus', 'played',
        'expected_goal_involvements', 'clean_sheets', 'saves', 'defensive_contribution'
      ]) })),
      sources: [{ ...source, label: `Gameweek ${event} scoring` }]
    };
  }

  async function getRegions() {
    const { data, source } = await cachedRecord('/api/regions/', 7 * 24 * 60 * minute);
    return { regions: data, sources: [{ ...source, label: 'Official FPL player nationalities' }] };
  }

  async function getEntry(id) {
    const current = await getDashboard();
    const { data: entry, source } = await cachedRecord(`/api/entry/${id}/`, 2 * minute);
    const event = entry.current_event;
    const sources = [{ ...source, label: 'Public FPL entry' }];
    if (!event || !current.events.some(week => week.id === event)) {
      return { entry: takeFields(entry, ['id', 'name', 'summary_overall_points', 'summary_overall_rank']), event: null, picks: [], sources };
    }
    try {
      const result = await cachedRecord(`/api/entry/${id}/event/${event}/picks/`, 2 * minute);
      return {
        entry: takeFields(entry, ['id', 'name', 'summary_overall_points', 'summary_overall_rank']),
        event,
        picks: result.data.picks.map(pick => takeFields(pick, ['element', 'position', 'multiplier', 'is_captain', 'is_vice_captain'])),
        bank: result.data.entry_history.bank,
        squadValue: result.data.entry_history.value,
        activeChip: result.data.active_chip,
        sources: [...sources, { ...result.source, label: `Gameweek ${event} locked picks` }]
      };
    } catch (error) {
      if (error.status !== 404) throw error;
      return { entry: takeFields(entry, ['id', 'name', 'summary_overall_points', 'summary_overall_rank']), event, picks: [], sources };
    }
  }

  return { getDashboard, getPlayer, getLive, getEntry, getRegions };
}
