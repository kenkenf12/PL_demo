import { calculateTeamIndex, indexMatch, selectMatchPlayers } from './match-index.mjs';

const provider = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const requiredMeetings = 4;
const clubAliases = { MUN: ['Man United', 'Manchester United'], NFO: ['Nottm Forest', 'Nottingham Forest'] };
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const validId = value => /^\d+$/.test(String(value ?? ''));

function sameClub(club, team) {
  const names = [club.name, club.short_name, ...(clubAliases[club.short_name] ?? [])].map(normalize).filter(Boolean);
  return [team.displayName, team.shortDisplayName, team.abbreviation].some(name => names.includes(normalize(name)));
}

function matchSides(competitors) {
  if (!Array.isArray(competitors)) return [];
  return ['home', 'away'].map(side => competitors.find(competitor => competitor?.homeAway === side));
}

function scoreboardFixtures(data) {
  if (!Array.isArray(data.events)) throw new Error('ESPN fixture data is unavailable.');
  return data.events.flatMap(event => {
    const [home, away] = matchSides(event?.competitions?.[0]?.competitors);
    return typeof event?.date === 'string' && validId(event.id) && validId(home?.team?.id) && validId(away?.team?.id)
      ? [{ id: String(event.id), date: event.date, home: home.team, away: away.team }] : [];
  });
}

function headToHeadEvents(data) {
  const series = Array.isArray(data.seasonseries) ? data.seasonseries.find(entry => entry?.type === 'head-to-head') : null;
  return Array.isArray(series?.events) ? series.events : [];
}

function matchGoals(value) {
  const goals = /^\d+$/.test(String(value ?? '')) ? Number(value) : NaN;
  return Number.isSafeInteger(goals) ? goals : null;
}

function latestMeetings(events, espnFixture, fixture, cutoff) {
  const teamIds = new Map([[String(espnFixture.home.id), fixture.team_h], [String(espnFixture.away.id), fixture.team_a]]);
  const meetings = new Map();
  for (const event of events) {
    const kickoff = Date.parse(event?.date);
    const id = String(event?.id ?? '');
    if (event?.statusType?.completed !== true || !Number.isFinite(kickoff) || kickoff >= cutoff
      || !validId(id) || id === espnFixture.id || meetings.has(id)) continue;

    const [home, away] = matchSides(event.competitors);
    const team_h = teamIds.get(String(home?.team?.id));
    const team_a = teamIds.get(String(away?.team?.id));
    const team_h_score = matchGoals(home?.score);
    const team_a_score = matchGoals(away?.score);
    if (!team_h || !team_a || team_h === team_a || team_h_score === null || team_a_score === null) continue;

    meetings.set(id, { id, kickoff, competition: event.competitionName ?? '', team_h, team_a, team_h_score, team_a_score });
  }
  return [...meetings.values()].sort((a, b) => b.kickoff - a.kickoff).slice(0, requiredMeetings);
}

export function createH2HIndexAnalysis(fpl, fetchData = fetch) {
  const cache = new Map();

  function request(path, label, parse) {
    const saved = cache.get(path);
    if (saved?.expiresAt > Date.now()) return saved.result;
    const entry = { expiresAt: Date.now() + 30 * 60_000 };
    const url = provider + path;
    entry.result = (async () => {
      try {
        const response = await fetchData(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
        if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}.`);
        return { data: parse(await response.json()), source: { label, url, retrievedAt: new Date().toISOString() } };
      } catch {
        entry.expiresAt = Date.now() + 60_000;
        return null;
      }
    })();
    cache.set(path, entry);
    if (cache.size > 120) cache.delete(cache.keys().next().value);
    return entry.result;
  }

  return async (dashboard, fixtures, gameweek, previous, asOf = Date.now()) => {
    const clubs = new Map(dashboard.teams.map(club => [club.id, club]));
    const reports = await Promise.all(fixtures.map(async fixture => {
      const home = clubs.get(fixture.team_h);
      const away = clubs.get(fixture.team_a);
      const kickoff = Date.parse(fixture.kickoff_time);
      const day = Number.isFinite(kickoff) ? fixture.kickoff_time.slice(0, 10) : null;
      const board = day ? await request(`/scoreboard?dates=${day.replaceAll('-', '')}`, `ESPN fixtures · ${day}`, scoreboardFixtures) : null;
      const candidates = board?.data.filter(event => event.date?.slice(0, 10) === day
        && sameClub(home, event.home) && sameClub(away, event.away)) ?? [];
      const espnFixture = candidates.length === 1 ? candidates[0] : null;
      const history = espnFixture ? await request(`/summary?event=${espnFixture.id}`, `ESPN head-to-head · ${home.name} v ${away.name}`,
        headToHeadEvents) : null;
      const meetings = history ? latestMeetings(history.data, espnFixture, fixture, Math.min(asOf, kickoff)) : [];
      const homeIndex = calculateTeamIndex({ id: home.id, name: home.name }, meetings, requiredMeetings);
      const awayIndex = calculateTeamIndex({ id: away.id, name: away.name }, meetings, requiredMeetings);
      return { match: { ...indexMatch(fixture, homeIndex, awayIndex), meetings }, sources: [board?.source, history?.source].filter(Boolean) };
    }));
    const matches = reports.map(report => report.match);
    const { squad, sources: playerSources } = await selectMatchPlayers(fpl, dashboard, fixtures, gameweek, previous, matches);
    const sources = new Map([...reports.flatMap(report => report.sources), ...playerSources].map(source => [source.url, source]));
    return { matches, squad, requiredMeetings, sources: [...sources.values()] };
  };
}
