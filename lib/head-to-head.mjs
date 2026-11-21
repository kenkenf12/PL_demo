import { predictMatchWinners } from './match-winner-strategy.mjs';

const espn = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const sampleSize = 4;
const outcomes = ['draw', 'home', 'away'];
const clubAliases = { MUN: ['Man United', 'Manchester United'], NFO: ['Nottm Forest', 'Nottingham Forest'] };
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const score = value => /^\d+$/.test(String(value)) ? Number(value) : null;

function sameClub(club, team) {
  const names = [club.name, club.short_name, ...(clubAliases[club.short_name] ?? [])].map(normalize).filter(Boolean);
  return [team?.displayName, team?.shortDisplayName, team?.abbreviation].some(name => names.includes(normalize(name)));
}

function scoreboardFixtures(data) {
  if (!Array.isArray(data.events)) throw new Error('ESPN fixture data is unavailable.');
  return data.events.flatMap(event => {
    const teams = event.competitions?.[0]?.competitors;
    const home = teams?.find(side => side.homeAway === 'home')?.team;
    const away = teams?.find(side => side.homeAway === 'away')?.team;
    return /^\d+$/.test(event.id) && home?.id && away?.id ? [{ id: event.id, date: event.date, home, away }] : [];
  });
}

function historicalMeetings(events, fixture, cutoff) {
  const meetings = new Map();
  for (const event of events) {
    const kickoff = Date.parse(event.date);
    const id = String(event.id ?? '');
    if (!event.statusType?.completed || !Number.isFinite(kickoff) || kickoff >= cutoff || !/^\d+$/.test(id)
      || id === String(fixture.id) || meetings.has(id)) continue;

    const home = event.competitors?.find(side => side.homeAway === 'home');
    const away = event.competitors?.find(side => side.homeAway === 'away');
    const homeScore = score(home?.score);
    const awayScore = score(away?.score);
    const homeId = String(home?.team?.id);
    const awayId = String(away?.team?.id);
    const sameVenue = homeId === String(fixture.home.id) && awayId === String(fixture.away.id);
    const reverseVenue = homeId === String(fixture.away.id) && awayId === String(fixture.home.id);
    if ((!sameVenue && !reverseVenue) || homeScore === null || awayScore === null) continue;

    const goalDifference = sameVenue ? homeScore - awayScore : awayScore - homeScore;
    const outcome = goalDifference === 0 ? 'draw' : goalDifference > 0 ? 'home' : 'away';
    meetings.set(id, { id, kickoff, competition: event.competitionName,
      home: home.team.displayName, away: away.team.displayName, homeScore, awayScore, outcome });
  }
  return [...meetings.values()].sort((a, b) => b.kickoff - a.kickoff).slice(0, sampleSize);
}

function predictOutcome(match, meetings) {
  const baseline = match.probabilities;
  const counts = { home: 0, draw: 0, away: 0 };
  for (const meeting of meetings) counts[meeting.outcome] += 1;
  const h2h = meetings.length ? Object.fromEntries(outcomes.map(outcome => [outcome, counts[outcome] / meetings.length])) : null;
  const h2hWeight = baseline ? 0.25 * meetings.length / sampleSize : meetings.length === sampleSize ? 1 : 0;
  if (!h2hWeight) {
    const winner = match.winner;
    const outcome = winner ? (winner.id === match.home.id ? 'home' : 'away') : baseline ? 'draw' : null;
    return { h2h, h2hWeight, probabilities: baseline ?? null, outcome };
  }
  const probabilities = baseline
    ? Object.fromEntries(outcomes.map(outcome => [outcome, (1 - h2hWeight) * baseline[outcome] + h2hWeight * h2h[outcome]]))
    : h2h;
  const outcome = outcomes.reduce((best, side) => probabilities[side] > probabilities[best] ? side : best);
  return { h2h, h2hWeight, probabilities, outcome };
}

export function createHeadToHeadAnalysis(fetchData = fetch) {
  const cache = new Map();

  async function request(path, label, parse) {
    const saved = cache.get(path);
    if (saved?.expiresAt > Date.now()) return saved.result;
    const entry = { expiresAt: Date.now() + 30 * 60_000 };
    const url = espn + path;
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

  return async (dashboard, fixtures, gameweek, cutoff) => {
    if (!fixtures.length) return { matches: [], sources: [] };

    const { matches: baseline } = predictMatchWinners({ ...dashboard, players: [] }, fixtures, gameweek, []);
    const clubs = new Map(dashboard.teams.map(team => [team.id, team]));
    const positions = new Map(dashboard.positions.map(position => [position.id, position.singular_name]));
    const roster = new Map(dashboard.teams.map(team => [team.id, []]));
    for (const player of dashboard.players) {
      const club = clubs.get(player.team);
      roster.get(player.team)?.push({ id: player.id, name: player.web_name, teamId: player.team,
        team: club?.name, position: positions.get(player.element_type) });
    }
    for (const players of roster.values()) players.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

    const reports = await Promise.all(baseline.map(async match => {
      const { id, kickoff, home, away } = match;
      const day = kickoff?.slice(0, 10);
      const board = day ? await request(`/scoreboard?dates=${day.replaceAll('-', '')}`, `ESPN fixtures · ${day}`, scoreboardFixtures) : null;
      const candidates = board?.data.filter(fixture => fixture.date?.slice(0, 10) === day
        && sameClub(clubs.get(home.id), fixture.home) && sameClub(clubs.get(away.id), fixture.away)) ?? [];
      const espnFixture = candidates.length === 1 ? candidates[0] : null;
      const history = espnFixture ? await request(`/summary?event=${espnFixture.id}`, `ESPN H2H · ${home.name} v ${away.name}`,
        data => data.seasonseries?.find(series => series.type === 'head-to-head')?.events ?? []) : null;
      const meetings = Array.isArray(history?.data) ? historicalMeetings(history.data, espnFixture, Math.min(cutoff, Date.parse(kickoff))) : [];
      const prediction = predictOutcome(match, meetings);
      const sides = prediction.outcome === 'draw' ? [home, away] : prediction.outcome ? [match[prediction.outcome]] : [];
      return { match: { id, kickoff, home: { id: home.id, name: home.name }, away: { id: away.id, name: away.name },
        meetings, ...prediction, players: sides.flatMap(side => roster.get(side.id)),
        reason: prediction.outcome ? null : match.reason }, sources: [board?.source, history?.source].filter(Boolean) };
    }));
    const sources = new Map(reports.flatMap(report => report.sources.map(source => [source.url, source])));
    return { matches: reports.map(report => report.match), sources: [...sources.values()] };
  };
}
