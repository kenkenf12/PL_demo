const venueSource = 'https://www.premierleague.com/en/news/4725666/all-you-need-to-know-about-the-20-premier-league-stadiums';
const forecastApi = 'https://api.open-meteo.com/v1/forecast';
const forecastDays = 16;
const hour = 3_600;

// Home grounds for the 2026/27 league. Coordinates identify the stadium area.
const grounds = {
  ARS: ['Emirates Stadium', 51.555, -0.108], AVL: ['Villa Park', 52.509, -1.885],
  BOU: ['Vitality Stadium', 50.735, -1.838], BRE: ['Gtech Community Stadium', 51.491, -0.288],
  BHA: ['American Express Stadium', 50.862, -0.084], CHE: ['Stamford Bridge', 51.482, -0.191],
  COV: ['Coventry Building Society Arena', 52.448, -1.496], CRY: ['Selhurst Park', 51.398, -0.086],
  EVE: ['Hill Dickinson Stadium', 53.425, -3.003], FUL: ['Craven Cottage', 51.475, -0.221],
  HUL: ['MKM Stadium', 53.746, -0.368], IPS: ['Portman Road', 52.055, 1.145],
  LEE: ['Elland Road', 53.778, -1.572], LIV: ['Anfield', 53.431, -2.961],
  MCI: ['Etihad Stadium', 53.483, -2.200], MUN: ['Old Trafford', 53.463, -2.291],
  NEW: ["St James’ Park", 54.975, -1.622], NFO: ['The City Ground', 52.940, -1.133],
  TOT: ['Tottenham Hotspur Stadium', 51.604, -0.067], SUN: ['Stadium of Light', 54.914, -1.388]
};

function headerTime(response, name) {
  const time = Date.parse(response.headers.get(name));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function sampleWeather(hourly, kickoff) {
  const first = Math.ceil(kickoff / hour) * hour;
  const buckets = [first, first + hour].map(time => hourly?.time?.indexOf(time) ?? -1);
  const keys = ['temperature_2m', 'rain', 'showers', 'wind_gusts_10m'];
  if (buckets.some(index => index < 0 || keys.some(key => !Number.isFinite(hourly[key]?.[index])))) return null;
  const temperature = hourly.temperature_2m[buckets[0]];
  const rain = Math.max(...buckets.map(i => hourly.rain[i] + hourly.showers[i]));
  const gust = Math.max(...buckets.map(i => hourly.wind_gusts_10m[i]));
  const risks = [];
  if (rain >= 4) risks.push('Heavy rain may affect footing');
  if (gust >= 50) risks.push('Strong gusts may affect aerial play');
  if (temperature <= 2) risks.push('Low temperature may affect pitch conditions');
  if (temperature >= 28) risks.push('High temperature may affect match tempo');
  return { temperature, rain, gust, risks };
}

export async function fixtureWeather(fixtures, teams, now = Date.now()) {
  const club = new Map(teams.map(team => [team.id, team]));
  const locations = new Map();
  const finalDate = Math.floor(now / 86_400_000 + forecastDays) * 86_400;
  const rows = fixtures.map(fixture => {
    const home = club.get(fixture.team_h);
    const away = club.get(fixture.team_a);
    const ground = grounds[home?.short_name];
    const kickoff = Date.parse(fixture.kickoff_time) / 1000;
    const row = {
      id: fixture.id, home: home?.name, away: away?.name, venue: ground?.[0], kickoff: fixture.kickoff_time,
      unavailable: 'Forecast feed unavailable'
    };
    if (!ground) row.unavailable = 'Home ground unavailable';
    else if (!Number.isFinite(kickoff)) row.unavailable = 'Kickoff time unavailable';
    else if (kickoff < now / 1000 || Math.ceil(kickoff / hour) * hour + hour >= finalDate) {
      row.unavailable = 'Outside the available forecast window';
    } else {
      if (!locations.has(home.id)) locations.set(home.id, { ground, rows: [] });
      locations.get(home.id).rows.push({ row, kickoff });
    }
    return row;
  });
  const points = [...locations.values()];
  if (!points.length) return { fixtures: rows, sources: [], venueSource };

  const url = new URL(forecastApi);
  url.search = new URLSearchParams({
    latitude: points.map(({ ground }) => ground[1]).join(','),
    longitude: points.map(({ ground }) => ground[2]).join(','),
    hourly: 'temperature_2m,rain,showers,wind_gusts_10m',
    forecast_days: String(forecastDays), timeformat: 'unixtime', timezone: 'GMT'
  });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return { fixtures: rows, sources: [], venueSource };
    const data = await response.json();
    const sources = [{ label: 'Open-Meteo stadium forecasts', url: url.href, retrievedAt: new Date().toISOString(),
      upstreamDate: headerTime(response, 'date'), lastModified: headerTime(response, 'last-modified') }];
    const forecasts = Array.isArray(data) ? data : [data];
    for (const [index, location] of points.entries()) {
      for (const { row, kickoff } of location.rows) {
        const sample = sampleWeather(forecasts[index]?.hourly, kickoff);
        if (sample) Object.assign(row, sample, { unavailable: null });
        else row.unavailable = 'Kickoff forecast unavailable';
      }
    }
    return { fixtures: rows, sources, venueSource };
  } catch {
    return { fixtures: rows, sources: [], venueSource };
  }
}
