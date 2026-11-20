const provider = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all';
const day = 86_400_000;
const lookbackDays = 14;
const reportLimit = { international: 20, cup: 6 };
const cupLeagues = new Set(['eng.fa', 'eng.league_cup']);
const seniorInternational = /^(?:fifa\.(?:friendly|world(?:q\.[a-z]+)?)|uefa\.(?:nations|euro(?:_qual)?)|concacaf\.(?:nations\.league|gold)|conmebol\.america|caf\.nations(?:_qual)?|afc\.asian\.cup(?:_qual)?|ofc\.nations)$/;

function normalize(value) {
  return (value ?? '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
    .replace(/[øłđß]/g, character => ({ ø: 'o', ł: 'l', đ: 'd', ß: 'ss' })[character])
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const countryNames = {
  czechia: 'czech republic', 'cote d ivoire': 'ivory coast', 'dr congo': 'congo democratic republic of',
  'united states': 'united states of america', 'republic of ireland': 'ireland', 'korea republic': 'south korea'
};

function identities(values) {
  return new Set(values.map(normalize).filter(name => name.includes(' ')));
}

function matchKind(event) {
  const slug = event.links?.map(link => link.href?.match(/\/league\/([\w.]+)(?:[/?#]|$)/)?.[1]).find(Boolean);
  if (cupLeagues.has(slug)) return 'cup';
  return seniorInternational.test(slug) ? 'international' : null;
}

function collectPlayers(event, report, playerIndex) {
  const fixture = report.header?.competitions?.[0];
  if (!fixture?.status?.type?.completed || !Array.isArray(report.rosters)) return null;
  const matches = new Map();
  for (const roster of report.rosters) {
    if (!Array.isArray(roster.roster)) continue;
    const team = event.teams.get(String(roster.team?.id));
    for (const member of roster.roster) {
      const stats = new Map((member.stats ?? []).map(stat => [stat.name, stat.value]));
      if (!member.starter && !member.subbedIn && !(stats.get('appearances') > 0)) continue;
      const names = identities([member.athlete?.fullName, member.athlete?.displayName]);
      const candidates = new Set([...names].flatMap(name => playerIndex.get(name) ?? []));
      const sameTeam = [...candidates].filter(player => event.kind === 'cup'
        ? team === player.team : !team || !player.region || team === player.region);
      if (sameTeam.length !== 1) continue;
      const stat = name => Number.isFinite(stats.get(name)) ? stats.get(name) : undefined;
      matches.set(sameTeam[0].id, { starter: member.starter === true,
        goals: stat('totalGoals'), assists: stat('goalAssists'), saves: stat('saves'), redCards: stat('redCards') });
    }
  }
  return matches;
}

async function batch(items, load) {
  const results = [];
  for (let start = 0; start < items.length; start += 5) {
    results.push(...await Promise.all(items.slice(start, start + 5).map(load)));
  }
  return results;
}

function headerDate(headers, name) {
  const value = Date.parse(headers.get(name));
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export function createMatchReports() {
  const cache = new Map();

  function request(path, label) {
    const current = cache.get(path);
    if (current && current.expiresAt > Date.now()) return current.result;
    const entry = { expiresAt: Date.now() + day / 2 };
    entry.result = (async () => {
      try {
        const url = `${provider}${path}`;
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.json();
        const data = path.startsWith('/scoreboard')
          ? { events: raw.events?.map(event => ({ event, kind: matchKind(event) })).filter(item => item.kind) }
          : { header: { competitions: raw.header?.competitions }, rosters: raw.rosters };
        return { data, source: { label, url, retrievedAt: new Date().toISOString(),
          upstreamDate: headerDate(response.headers, 'date'), lastModified: headerDate(response.headers, 'last-modified') } };
      } catch {
        entry.expiresAt = Date.now() + 120_000;
        return null;
      }
    })();
    cache.set(path, entry);
    if (cache.size > 160) cache.delete(cache.keys().next().value);
    return entry.result;
  }

  return async ({ players, teams }, regions, cutoff) => {
    const dates = Array.from({ length: lookbackDays }, (_, offset) => new Date(cutoff - offset * day).toISOString().slice(0, 10));
    const regionIndex = new Map(regions.flatMap(region => [region.name, region.iso_code_long].map(name => [normalize(name), region.id])));
    const clubIndex = new Map(teams.flatMap(team => [team.name, team.short_name].map(name => [normalize(name), team.id])));
    const eligible = new Map();
    const playerIndex = new Map();
    for (const player of players) {
      if (player.region) eligible.set(player.region, (eligible.get(player.region) ?? 0) + 1);
      for (const name of identities([`${player.first_name} ${player.second_name}`, player.known_name, player.web_name])) {
        if (!playerIndex.has(name)) playerIndex.set(name, []);
        playerIndex.get(name).push(player);
      }
    }
    const scoreboards = (await batch(dates, date => request(`/scoreboard?dates=${date.replaceAll('-', '')}`, `ESPN fixtures · ${date}`)))
      .filter(result => Array.isArray(result?.data?.events));
    const unique = new Map();
    for (const { data } of scoreboards) {
      for (const { event, kind } of data.events) {
        const kickoff = Date.parse(event.date);
        if (!/^\d+$/.test(event.id) || !event.status?.type?.completed || !Number.isFinite(kickoff) || kickoff > cutoff || unique.has(event.id)) continue;
        const participants = event.competitions?.[0]?.competitors ?? [];
        const mapped = new Map(participants.filter(side => side.team?.id).map(({ team }) => {
          const name = normalize(team.displayName);
          const short = normalize(team.abbreviation);
          const id = kind === 'cup' ? clubIndex.get(short) ?? clubIndex.get(name)
            : regionIndex.get(countryNames[name] ?? name) ?? regionIndex.get(name) ?? regionIndex.get(short);
          return [String(team.id), id];
        }));
        const weights = [...mapped.values()].filter(Boolean).map(id => kind === 'cup' ? 1 : Math.sqrt(eligible.get(id) ?? 0));
        if (kind === 'cup' && !weights.length || kind === 'international' && regions.length && !weights.some(weight => weight > 0)) continue;
        unique.set(event.id, { id: event.id, kind, kickoff, name: event.shortName, teams: mapped,
          weight: weights.reduce((sum, weight) => sum + weight, 0) });
      }
    }

    const groups = [...unique.values()].sort((a, b) => b.weight - a.weight || b.kickoff - a.kickoff);
    const selected = Object.keys(reportLimit).flatMap(kind => groups.filter(event => event.kind === kind).slice(0, reportLimit[kind]));
    const reports = await batch(selected, async event => {
      const result = await request(`/summary?event=${event.id}`, `ESPN report · ${event.name ?? event.id}`);
      const matches = result && collectPlayers(event, result.data, playerIndex);
      return matches && { ...event, matches, source: result.source };
    });
    return { reports: reports.filter(Boolean), sources: scoreboards.map(item => item.source),
      coverage: { days: scoreboards.length, expectedDays: dates.length, reports: reports.filter(Boolean).length, requested: selected.length } };
  };
}
