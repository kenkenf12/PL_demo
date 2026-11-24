export const number = value => Number(value) || 0;
export const price = value => value == null ? '—' : `£${(value / 10).toFixed(1)}m`;
export const forecast = value => value == null ? '—' : value.toFixed(1);
export const isGameweekComplete = event => event?.finished === true && event.data_checked === true;

export function upcomingWeeks(events, count, now = Date.now()) {
  return events.filter(event => !event.finished && Date.parse(event.deadline_time) > now)
    .sort((a, b) => Date.parse(a.deadline_time) - Date.parse(b.deadline_time)).slice(0, count);
}

export function remainingFixtures(fixtures, gameweek, now) {
  return fixtures.filter(fixture => fixture.event === gameweek && !fixture.started && !fixture.finished
    && !fixture.finished_provisional && Date.parse(fixture.kickoff_time) > now);
}

export function availability(player) {
  if (player.status !== 'a' && player.status !== 'd') return 0;
  const reported = player.chance_of_playing_next_round;
  if (reported != null) return Math.max(0, Math.min(1, reported / 100));
  return player.status === 'd' ? 0.5 : 1;
}

export function fixtureFactor(difficulty, home) {
  return ([1.2, 1.1, 1, 0.88, 0.76][difficulty - 1] ?? 1) * (home ? 1.04 : 0.96);
}

export function makeModel(data, count, now = Date.now()) {
  const weeks = upcomingWeeks(data.events, count, now);
  const teams = new Map(data.teams.map(team => [team.id, team]));
  const positions = new Map(data.positions.map(position => [position.id, position]));
  const fixtureWeeks = new Map(weeks.map((week, index) => [week.id, index]));
  const clubFixtures = new Map(data.teams.map(team => [team.id, []]));
  const matchesPlayed = new Map(data.teams.map(team => [team.id, 0]));
  const averages = new Map(data.positions.map(position => [position.id, { points: 0, minutes: 0 }]));

  for (const fixture of data.fixtures) {
    const { team_h: home, team_a: away } = fixture;
    if (fixture.finished || fixture.finished_provisional) {
      for (const team of [home, away]) matchesPlayed.set(team, matchesPlayed.get(team) + 1);
    }
    if (!fixtureWeeks.has(fixture.event) || fixture.started || fixture.finished) continue;
    clubFixtures.get(home).push({ ...fixture, opponent: teams.get(away), home: true, difficulty: fixture.team_h_difficulty });
    clubFixtures.get(away).push({ ...fixture, opponent: teams.get(home), home: false, difficulty: fixture.team_a_difficulty });
  }
  for (const fixtures of clubFixtures.values()) {
    fixtures.sort((a, b) => fixtureWeeks.get(a.event) - fixtureWeeks.get(b.event)
      || Date.parse(a.kickoff_time) - Date.parse(b.kickoff_time));
  }
  for (const player of data.players) {
    const position = averages.get(player.element_type);
    position.points += number(player.total_points);
    position.minutes += number(player.minutes);
  }

  const players = data.players.map(player => {
    const minutes = number(player.minutes);
    const games = matchesPlayed.get(player.team);
    const position = averages.get(player.element_type);
    const positionRate = position.minutes ? 90 * position.points / position.minutes : 0;
    const expectedMinutes = games ? Math.min(90, minutes / games) : 0;
    // Shrink small samples toward observed scoring for the same position.
    const seasonRate = (90 * number(player.total_points) + 360 * positionRate) / (minutes + 360);
    const baseline = Math.max(0, 0.7 * seasonRate * expectedMinutes / 90 + 0.3 * number(player.form));
    const chance = availability(player);
    const schedule = clubFixtures.get(player.team);
    const canProject = weeks.length > 0 && games > 0 && minutes > 0;
    const pointsByWeek = new Map(weeks.map(week => [week.id, 0]));

    if (canProject) {
      for (const fixture of schedule) {
        const points = baseline * chance * fixtureFactor(fixture.difficulty, fixture.home);
        pointsByWeek.set(fixture.event, pointsByWeek.get(fixture.event) + points);
      }
    }
    const projected = canProject ? [...pointsByWeek.values()].reduce((sum, points) => sum + points, 0) : null;
    const next = canProject ? pointsByWeek.get(weeks[0].id) : null;
    return {
      ...player, teamInfo: teams.get(player.team), positionInfo: positions.get(player.element_type),
      schedule, expectedMinutes, chance, projected, next,
      value: projected == null || player.now_cost <= 0 ? null : projected / (player.now_cost / 10)
    };
  });
  players.sort((a, b) => (b.projected ?? -Infinity) - (a.projected ?? -Infinity) || b.total_points - a.total_points);
  return { players, byId: new Map(players.map(player => [player.id, player])), weeks, teams, positions };
}

export function captainOptions(players) {
  return players.filter(player => player.chance > 0 && player.next > 0)
    .sort((a, b) => b.next - a.next || b.expectedMinutes - a.expectedMinutes);
}

export function transferOptions(players, squad, outgoing, funds) {
  if (outgoing?.projected == null || !Number.isSafeInteger(funds) || funds < 0) return [];
  const owned = new Set(squad.map(player => player.id));
  const clubCounts = new Map();
  for (const player of squad) {
    if (player.id === outgoing.id) continue;
    clubCounts.set(player.team, (clubCounts.get(player.team) ?? 0) + 1);
  }
  return players.filter(player => !owned.has(player.id) && player.element_type === outgoing.element_type
    && player.now_cost <= funds && player.projected > outgoing.projected && player.chance > 0
    && (clubCounts.get(player.team) ?? 0) < 3)
    .map(player => ({ player, gain: player.projected - outgoing.projected, remaining: funds - player.now_cost }))
    .sort((a, b) => b.gain - a.gain || b.remaining - a.remaining);
}
