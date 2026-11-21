const playerCounts = ['minutes', 'starts', 'goals_scored', 'assists', 'clean_sheets', 'saves', 'bonus',
  'own_goals', 'penalties_saved', 'penalties_missed', 'yellow_cards', 'red_cards', 'defensive_contribution'];
const count = value => Number.isInteger(value) && value >= 0;
const finiteStat = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
  && Number.isFinite(Number(value));
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const name = value => typeof value === 'string' && value.trim() !== '';
const scoringFields = ['long_play', 'short_play', 'goals_conceded', 'saves', 'goals_scored', 'assists', 'clean_sheets',
  'penalties_saved', 'penalties_missed', 'yellow_cards', 'red_cards', 'own_goals', 'bonus', 'defensive_contribution'];
const positionCodes = ['GKP', 'DEF', 'MID', 'FWD'];

function uniqueIds(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => positiveId(row?.id))
    && new Set(rows.map(row => row.id)).size === rows.length;
}

export function completeSeason(data) {
  const { teams, events, positions, players, fixtures, scoring, sources } = data ?? {};
  if (![teams, events, positions, players, fixtures].every(uniqueIds) || teams.length !== 20 || events.length !== 38
    || fixtures.length !== teams.length * (teams.length - 1)
    || !scoringFields.every(field => Number.isFinite(scoring?.[field])
      || positionCodes.every(position => Number.isFinite(scoring?.[field]?.[position])))
    || !Array.isArray(sources) || sources.length !== 2 || !sources.every(source => timestamp(source?.retrievedAt))) return false;

  const teamIds = new Set(teams.map(team => team.id));
  const eventsById = new Map(events.map(event => [event.id, event]));
  const positionsById = new Map(positions.map(position => [position.id, position]));
  if (!teams.every(team => name(team.name) && name(team.short_name))
    || !events.every(event => event.id <= 38 && name(event.name) && timestamp(event.deadline_time)
      && ['finished', 'data_checked', 'is_current', 'is_next'].every(flag => typeof event[flag] === 'boolean'))
    || ![1, 2, 3, 4].every(id => positionsById.has(id))
    || !positions.every(position => name(position.singular_name) && name(position.singular_name_short))) return false;

  const representedTeams = new Set(players.map(player => player.team));
  if (representedTeams.size !== teams.length || !players.every(player => teamIds.has(player.team)
    && positionsById.has(player.element_type) && name(player.web_name) && name(player.status) && finiteStat(player.form)
    && count(player.now_cost) && Number.isInteger(player.total_points)
    && playerCounts.every(stat => count(player[stat])))) return false;
  if (!positions.every(position => !Object.hasOwn(position, 'element_count') || position.element_count === undefined
    || position.element_count === players.filter(player => player.element_type === position.id).length)) return false;

  const pairings = new Set(fixtures.map(fixture => `${fixture.team_h}:${fixture.team_a}`));
  return pairings.size === fixtures.length && fixtures.every(fixture => {
    const event = eventsById.get(fixture.event);
    const finished = fixture.finished || fixture.finished_provisional;
    return fixture.team_h !== fixture.team_a && teamIds.has(fixture.team_h) && teamIds.has(fixture.team_a)
      && (fixture.event === null || event) && (fixture.kickoff_time === null || timestamp(fixture.kickoff_time))
      && (typeof fixture.started === 'boolean' || (fixture.started === null && fixture.kickoff_time === null))
      && typeof fixture.finished === 'boolean' && typeof fixture.finished_provisional === 'boolean'
      && [fixture.team_h_difficulty, fixture.team_a_difficulty].every(value => Number.isInteger(value) && value >= 1 && value <= 5)
      && (!finished || (count(fixture.team_h_score) && count(fixture.team_a_score) && timestamp(fixture.kickoff_time)))
      && (!(event?.finished && event.data_checked) || fixture.finished);
  });
}

export function completeLive(data, finishedFixtures, previous) {
  const rows = data?.elements;
  if (!uniqueIds(rows) || !rows.every(({ stats, explain }) => stats && Number.isInteger(stats.total_points)
    && playerCounts.every(stat => count(stats[stat]))
    && ['expected_goals', 'expected_assists', 'expected_goal_involvements'].every(stat => finiteStat(stats[stat]) && Number(stats[stat]) >= 0)
    && Array.isArray(explain) && explain.every(match => positiveId(match?.fixture) && Array.isArray(match.stats)
      && match.stats.every(stat => name(stat?.identifier) && Number.isFinite(stat.value))))) return false;

  if (previous) {
    const ids = new Set(rows.map(row => row.id));
    if (!previous.elements.every(row => ids.has(row.id))) return false;
  }
  const covered = new Set(rows.flatMap(row => row.explain.filter(match => match.stats.some(stat => stat.identifier === 'minutes'
    && stat.value > 0)).map(match => match.fixture)));
  return [...finishedFixtures].every(id => covered.has(id));
}

export function completePlayer(data, player, previous, fixtures) {
  if (!Array.isArray(data?.history) || !Array.isArray(data.fixtures) || !data.history.every(match => positiveId(match?.fixture)
    && positiveId(match.round) && positiveId(match.opponent_team) && timestamp(match.kickoff_time)
    && typeof match.was_home === 'boolean' && Number.isInteger(match.total_points)
    && ['minutes', 'goals_scored', 'assists', 'clean_sheets'].every(stat => count(match[stat])))
    || !data.fixtures.every(fixture => positiveId(fixture?.id) && positiveId(fixture.team_h) && positiveId(fixture.team_a)
      && (fixture.event === null || positiveId(fixture.event)) && typeof fixture.is_home === 'boolean')) return false;
  if (data.history.length === 0 && player.minutes > 0) return false;
  const ids = new Set(data.history.map(match => match.fixture));
  return ids.size === data.history.length && (!previous || previous.history.every(match => ids.has(match.fixture)))
    && data.history.every(match => fixtures.has(match.fixture));
}
