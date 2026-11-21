import { completeLive, completePlayer, completeSeason } from './fpl-validation.mjs';

const official = 'https://fantasy.premierleague.com';
const version = 3;
const minute = 60_000;
const latestSource = 'Latest API Data';
const cachedSource = 'Cached Historical Data';
const completed = event => event.finished && event.data_checked;

export class FplError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function headerTimestamp(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

async function officialData(path, fetchData, now) {
  const url = official + path;
  let response;
  try {
    response = await fetchData(url, {
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
        retrievedAt: new Date(now()).toISOString(),
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

function expectedSeasonStart(now) {
  return now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0);
}

function coveredGameweek(events) {
  return events.find(event => event.is_current)?.id
    ?? (events.filter(completed).reduce((latest, event) => Math.max(latest, event.id), 0)
      || events.find(event => event.is_next)?.id || null);
}

const playerFields = [
  'id', 'first_name', 'second_name', 'web_name', 'known_name', 'region', 'team', 'element_type', 'now_cost',
  'total_points', 'minutes', 'starts', 'goals_scored', 'assists', 'clean_sheets',
  'saves', 'bonus', 'own_goals', 'penalties_saved', 'penalties_missed', 'yellow_cards', 'red_cards',
  'form', 'selected_by_percent', 'expected_goals', 'expected_assists',
  'defensive_contribution', 'status', 'chance_of_playing_next_round', 'news', 'news_added'
];
const matchScoringFields = ['minutes', 'clean_sheets', 'saves', 'goals_conceded', 'defensive_contribution', 'yellow_cards', 'red_cards'];

function takeFields(record, fields) {
  return Object.fromEntries(fields.map(field => [field, record[field]]));
}

function matchScoringStats(explain, finishedFixtures) {
  return (explain ?? []).flatMap(match => {
    if (!finishedFixtures.has(match.fixture) || !Array.isArray(match.stats)) return [];
    const stats = new Map(match.stats.map(({ identifier, value }) => [identifier, value]));
    if (!Number.isInteger(stats.get('minutes'))) return [];
    // The official per-fixture explanation lists qualifying entries and omits the rest.
    return [{ fixture: match.fixture, ...Object.fromEntries(matchScoringFields.map(name => [name, stats.get(name) ?? 0])) }];
  });
}

function describeSnapshot(saved, origin, stale, refreshError) {
  const { dashboard } = saved;
  const lastSuccessfulFetch = saved.fetchedAt ?? new Date(Math.max(...dashboard.sources.map(source => Date.parse(source.retrievedAt)))).toISOString();
  const gameweek = saved.gameweek ?? coveredGameweek(dashboard.events);
  return { ...dashboard, stale, ...(refreshError ? { refreshError } : {}),
    dataStatus: { source: origin, lastSuccessfulFetch, gameweek, complete: true },
    sources: dashboard.sources.map(source => ({ ...source, origin, gameweek })) };
}

function fixturesMatchSeason(fixtures, events, year) {
  const firstDeadline = Date.parse(events.find(event => event.id === 1).deadline_time);
  return fixtures.some(fixture => Date.parse(fixture.kickoff_time) >= firstDeadline
    && new Date(fixture.kickoff_time).getUTCFullYear() === year);
}

function validSnapshot(saved, year) {
  return [1, 2, version].includes(saved?.version) && saved.dashboard?.seasonYear === year
    && completeSeason(saved.dashboard) && seasonStart(saved.dashboard.events) === year
    && fixturesMatchSeason(saved.dashboard.fixtures, saved.dashboard.events, year)
    && (saved.version < version || (Number.isFinite(Date.parse(saved.fetchedAt)) && saved.gameweek === coveredGameweek(saved.dashboard.events)))
    && saved.dashboard.sources[0].url === `${official}/api/bootstrap-static/`
    && saved.dashboard.sources[1].url === `${official}/api/fixtures/`;
}

export function createFplClient(snapshot, { fetchData = fetch, now = Date.now } = {}) {
  let saved;
  let savedRequest;
  let dashboardRequest;
  let generation = 0;
  const records = new Map();

  async function cachedRecord(path, maxAge, { seasonYear, gameweek, variant = '', validate } = {}) {
    const key = validate ? `${seasonYear}${path}${variant}` : path;
    const existing = records.get(key);
    if (existing?.pending || (existing?.generation === generation && !existing.recovered && now() - existing.startedAt < maxAge)) {
      return existing.request;
    }
    const entry = { startedAt: now(), generation, pending: true, validated: existing?.validated };

    async function lastValidated() {
      if (entry.validated === undefined) {
        const record = await Promise.resolve().then(() => snapshot.readRecord?.(key)).catch(() => null);
        entry.validated = record?.seasonYear === seasonYear && record.source?.url === `${official}${path}`
          && Number.isFinite(Date.parse(record.source.retrievedAt)) && validate(record.data) ? record : null;
      }
      return entry.validated;
    }

    entry.request = (async () => {
      try {
        const fresh = await officialData(path, fetchData, now);
        if (!validate) return fresh;
        const previous = await lastValidated();
        if (!validate(fresh.data, previous?.data)) throw new FplError('The official FPL feed returned incomplete scoring or player data.');
        const record = { ...fresh, seasonYear, gameweek };
        entry.validated = record;
        try {
          await snapshot.writeRecord?.(key, record);
        } catch (error) {
          console.warn('Could not save the FPL record:', error.code ?? error.message);
        }
        return { ...record, source: { ...record.source, origin: latestSource, gameweek } };
      } catch (error) {
        if (!validate) throw error;
        const record = await lastValidated();
        if (!record || !validate(record.data)) throw error;
        entry.recovered = true;
        return { ...record, source: { ...record.source, origin: cachedSource, gameweek: record.gameweek } };
      } finally {
        entry.pending = false;
      }
    })();

    records.set(key, entry);
    if (records.size > 250) records.delete(records.keys().next().value);
    try {
      return await entry.request;
    } catch (error) {
      if (records.get(key) === entry) records.delete(key);
      throw error;
    }
  }

  async function savedDashboard(year) {
    if (saved?.dashboard.seasonYear === year) return saved;
    if (savedRequest?.year === year) return savedRequest.promise;
    const promise = (async () => {
      const latest = await Promise.resolve().then(() => snapshot.read()).catch(() => null);
      if (saved?.dashboard.seasonYear === year) return saved;
      if (validSnapshot(latest, year)) return saved = latest;
      const history = await Promise.resolve().then(() => snapshot.readHistory?.(year)).catch(() => []);
      if (saved?.dashboard.seasonYear === year) return saved;
      return saved = (history ?? []).filter(record => validSnapshot(record, year)).sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
    })().finally(() => { if (savedRequest?.promise === promise) savedRequest = undefined; });
    savedRequest = { year, promise };
    return promise;
  }

  async function updateDashboard(year) {
    const [bootstrap, fixtures] = await Promise.all([
      officialData('/api/bootstrap-static/', fetchData, now), officialData('/api/fixtures/', fetchData, now)
    ]);
    const { elements, element_types, teams, events, game_config } = bootstrap.data ?? {};
    const sources = [{ ...bootstrap.source, label: 'Players, clubs and Gameweeks' }, { ...fixtures.source, label: 'Fixtures and results' }];
    if (!completeSeason({ teams, events, positions: element_types, players: elements, fixtures: fixtures.data,
      scoring: game_config?.scoring, sources })) throw new FplError('The official FPL season feeds returned incomplete or inconsistent data.');
    if (seasonStart(events) !== year) throw new FplError('The official feed has yet to provide the current season.');
    if (!fixturesMatchSeason(fixtures.data, events, year)) {
      throw new FplError('The official FPL fixtures do not match this season.');
    }

    const dashboard = {
      seasonYear: year,
      players: elements.map(player => takeFields(player, playerFields)),
      positions: element_types.map(position => takeFields(position, ['id', 'singular_name', 'singular_name_short', 'element_count'])),
      scoring: game_config.scoring,
      teams: teams.map(team => takeFields(team, ['id', 'name', 'short_name'])),
      events: events.map(event => takeFields(event, ['id', 'name', 'deadline_time', 'is_current', 'is_next', 'finished', 'data_checked'])),
      fixtures: fixtures.data.map(fixture => takeFields(fixture, [
        'id', 'event', 'kickoff_time', 'team_h', 'team_a', 'team_h_score', 'team_a_score',
        'started', 'finished', 'finished_provisional', 'team_h_difficulty', 'team_a_difficulty'
      ])),
      sources
    };
    const record = { version, dashboard, fetchedAt: new Date(now()).toISOString(), gameweek: coveredGameweek(dashboard.events) };
    saved = record;
    try {
      await snapshot.write(record);
    } catch (error) {
      console.warn('Could not save the FPL snapshot:', error.code ?? error.message);
    }
    return describeSnapshot(record, latestSource, false);
  }

  async function getDashboard(force = false) {
    const year = expectedSeasonStart(new Date(now()));
    if (!force) {
      const record = await savedDashboard(year);
      if (!record) throw new FplError('No validated cached data is available for this season. Refresh FPL data to load it.', 409);
      const age = now() - Math.min(...record.dashboard.sources.map(source => Date.parse(source.retrievedAt)));
      return describeSnapshot(record, cachedSource, age >= 10 * minute);
    }
    if (dashboardRequest) return dashboardRequest;

    generation += 1;
    dashboardRequest = updateDashboard(year).catch(async error => {
      const record = await savedDashboard(year);
      if (record) return describeSnapshot(record, cachedSource, true, error.message);
      throw new FplError(`${error.message} No validated cached data is available for this season.`);
    }).finally(() => { dashboardRequest = undefined; });
    return dashboardRequest;
  }

  async function getPlayer(id) {
    const current = await getDashboard();
    const player = current.players.find(player => player.id === id);
    if (!player) throw new FplError('Player ID is outside the current FPL season.', 404);
    const fixtureIds = new Set(current.fixtures.map(fixture => fixture.id));
    const { data, source } = await cachedRecord(`/api/element-summary/${id}/`, 10 * minute, {
      seasonYear: current.seasonYear, gameweek: current.dataStatus.gameweek,
      validate: (data, previous) => completePlayer(data, player, previous, fixtureIds)
    });
    return {
      history: data.history.map(match => takeFields(match, [
        'fixture', 'opponent_team', 'round', 'kickoff_time', 'was_home', 'total_points',
        'value', 'goals_scored', 'assists', 'expected_goals', 'expected_assists', ...matchScoringFields
      ])),
      fixtures: data.fixtures.map(fixture => takeFields(fixture, [
        'id', 'event', 'kickoff_time', 'team_h', 'team_a', 'is_home', 'difficulty'
      ])),
      sources: [{ ...source, label: 'Player match history and fixtures' }]
    };
  }

  async function getLive(event, fresh = false, maxAge = minute, includeScoringMatches = false) {
    const current = await getDashboard();
    const week = current.events.find(week => week.id === event);
    if (!week) throw new FplError('Unknown Gameweek.', 404);
    const confirmedFinal = completed(week);
    const finishedFixtures = new Set(current.fixtures.filter(fixture => fixture.event === event && fixture.finished).map(fixture => fixture.id));
    const { data, source } = await cachedRecord(`/api/event/${event}/live/`, fresh ? 0 : maxAge, {
      seasonYear: current.seasonYear, gameweek: event, variant: confirmedFinal ? 'final' : 'provisional',
      validate: (data, previous) => completeLive(data, finishedFixtures, previous)
    });
    return {
      event, confirmedFinal,
      players: data.elements.map(({ id, stats, explain }) => ({ id, ...takeFields(stats, [
        'minutes', 'starts', 'total_points', 'goals_scored', 'assists', 'bonus', 'played',
        'expected_goals', 'expected_assists', 'expected_goal_involvements', 'clean_sheets', 'saves', 'defensive_contribution',
        'own_goals', 'penalties_saved', 'penalties_missed', 'yellow_cards', 'red_cards'
      ]), ...(includeScoringMatches ? { scoringMatches: matchScoringStats(explain, finishedFixtures) } : {}) })),
      sources: [{ ...source, label: `Gameweek ${event} scoring` }]
    };
  }

  async function getRegions() {
    const current = await getDashboard();
    const { data, source } = await cachedRecord('/api/regions/', 7 * 24 * 60 * minute, {
      seasonYear: current.seasonYear, gameweek: current.dataStatus.gameweek,
      validate: data => Array.isArray(data) && data.length > 0 && data.every(region => Number.isInteger(region?.id) && typeof region.name === 'string')
    });
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
