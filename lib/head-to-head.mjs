import { createFixturePlayerScorer, loadMatchPlayerEvidence } from './match-winner-strategy.mjs';

const espn = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const sampleSize = 4;
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
    const sameOrder = homeId === String(fixture.home.id) && awayId === String(fixture.away.id);
    const reverseOrder = homeId === String(fixture.away.id) && awayId === String(fixture.home.id);
    if ((!sameOrder && !reverseOrder) || homeScore === null || awayScore === null) continue;

    const goalDifference = sameOrder ? homeScore - awayScore : awayScore - homeScore;
    const outcome = goalDifference === 0 ? 'draw' : goalDifference > 0 ? 'home' : 'away';
    meetings.set(id, { id, kickoff, competition: event.competitionName,
      home: home.team.displayName, away: away.team.displayName, homeScore, awayScore, outcome });
  }
  return [...meetings.values()].sort((a, b) => b.kickoff - a.kickoff).slice(0, sampleSize);
}

function predictOutcome(meetings) {
  if (meetings.length !== sampleSize) {
    return { teamRates: null, combined: null, probabilities: null, outcome: null,
      reason: 'Four verified meetings are needed for a prediction.' };
  }
  const counts = { home: 0, draw: 0, away: 0 };
  for (const meeting of meetings) counts[meeting.outcome] += 1;

  const home = { win: counts.home / sampleSize, draw: counts.draw / sampleSize, loss: counts.away / sampleSize };
  const away = { win: home.loss, draw: home.draw, loss: home.win };
  const combined = { win: (home.win + away.win) / 2, draw: (home.draw + away.draw) / 2, loss: (home.loss + away.loss) / 2 };
  const probabilities = { home: (home.win + away.loss) / 2, draw: combined.draw, away: (away.win + home.loss) / 2 };
  const highest = Math.max(...Object.values(probabilities));
  // The latest meeting with a tied outcome breaks the tie.
  const outcome = meetings.find(meeting => probabilities[meeting.outcome] === highest).outcome;
  return { teamRates: { home, away }, combined, probabilities, outcome, reason: null };
}

function rankPlayers(dashboard, clubs, matches, scorePlayer) {
  const eligibleFixtures = new Map();
  for (const match of matches) {
    for (const teamId of match.eligibleTeamIds) {
      if (!eligibleFixtures.has(teamId)) eligibleFixtures.set(teamId, []);
      eligibleFixtures.get(teamId).push(match.id);
    }
  }
  const positions = new Map(dashboard.positions.map(position => [position.id, position.singular_name]));
  return dashboard.players.flatMap(player => {
    const fixtures = eligibleFixtures.get(player.team);
    if (!fixtures) return [];
    const scores = fixtures.map(id => scorePlayer(player, id));
    return [{ id: player.id, name: player.web_name, teamId: player.team, team: clubs.get(player.team).name,
      position: positions.get(player.element_type), performanceScore: scores.every(Number.isFinite)
        ? scores.reduce((total, points) => total + points, 0) : null }];
  }).sort((a, b) => (b.performanceScore ?? -Infinity) - (a.performanceScore ?? -Infinity) || a.id - b.id).slice(0, 15);
}

export function createHeadToHeadAnalysis(fpl, fetchData = fetch) {
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

  return async (dashboard, fixtures, gameweek, cutoff, previous) => {
    if (!fixtures.length) return { matches: [], players: [], sources: [] };

    const clubs = new Map(dashboard.teams.map(team => [team.id, team]));
    const reports = await Promise.all(fixtures.map(async fixture => {
      const { id, kickoff_time: kickoff, team_h, team_a } = fixture;
      const home = clubs.get(team_h);
      const away = clubs.get(team_a);
      const kickoffTime = Date.parse(kickoff);
      const day = Number.isFinite(kickoffTime) ? kickoff.slice(0, 10) : null;
      const board = day ? await request(`/scoreboard?dates=${day.replaceAll('-', '')}`, `ESPN fixtures · ${day}`, scoreboardFixtures) : null;
      const candidates = board?.data.filter(event => event.date?.slice(0, 10) === day
        && sameClub(home, event.home) && sameClub(away, event.away)) ?? [];
      const espnFixture = candidates.length === 1 ? candidates[0] : null;
      const history = espnFixture ? await request(`/summary?event=${espnFixture.id}`, `ESPN H2H · ${home.name} v ${away.name}`,
        data => data.seasonseries?.find(series => series.type === 'head-to-head')?.events ?? []) : null;
      const meetings = Array.isArray(history?.data) ? historicalMeetings(history.data, espnFixture, Math.min(cutoff, kickoffTime)) : [];
      const prediction = predictOutcome(meetings);
      const eligibleTeamIds = { home: [team_h], draw: [team_h, team_a], away: [team_a] }[prediction.outcome] ?? [];
      return { match: { id, kickoff, home: { id: home.id, name: home.name }, away: { id: away.id, name: away.name },
        meetings, ...prediction, eligibleTeamIds }, sources: [board?.source, history?.source].filter(Boolean) };
    }));
    const matches = reports.map(report => report.match);
    const sources = new Map(reports.flatMap(report => report.sources.map(source => [source.url, source])));
    if (!matches.some(match => match.outcome)) return { matches, players: [], sources: [...sources.values()] };

    const evidence = await loadMatchPlayerEvidence(fpl, dashboard, gameweek, previous);
    const scorePlayer = createFixturePlayerScorer(dashboard, fixtures, gameweek, evidence.reports);
    for (const source of evidence.sources) sources.set(source.url, source);
    return { matches, players: rankPlayers(dashboard, clubs, matches, scorePlayer), sources: [...sources.values()] };
  };
}
