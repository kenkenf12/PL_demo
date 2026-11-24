import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { DomUtils, parseDocument } from 'htmlparser2';
import { setupPredictions } from '../public/predictions.mjs';

const timestamp = '2026-09-01T12:00:00Z';
const player = { id: 1, name: 'Selected player', team: 'Home Club', position: 'Forward', cost: 68, predicted: 7.4 };
const squadReport = { players: [player], captain: 1, projectedCount: 1, total: 7.4, cost: 68, sources: [] };
const home = { id: 1, name: 'Home Club', teamIndex: 180 };
const away = { id: 2, name: 'Away Club', teamIndex: 160 };
const indexReport = {
  teams: [home, away], requiredMeetings: 3, latestCompletedGameweek: 7, sources: [],
  matches: [{ home, away, outcome: 'home', meetings: [], attacking: [], defensive: [] }],
  squad: [{ positionCode: 'FWD', required: 3, players: [{ ...player, performanceScore: 7.4 }] }]
};
const rule = { weeks: [5, 6, 7], players: [{ ...player, gameweeks: [{ starts: 1, goals: 1, assists: 1 }] }] };
const newsReport = {
  since: timestamp, searchedAt: timestamp, coverage: { articles: 1, publishers: 1, expectedPublishers: 5 }, sources: [],
  recommendations: [{ name: player.name, count: 1, sentiment: 'Positive', explanation: 'Article evidence', sources: [] }]
};

function checkLayout(markup, finalContent, analysisContent, phases = 3) {
  const sections = parseDocument(markup).children.filter(node => node.name === 'section');
  assert.deepEqual(sections.map(section => section.attribs.class), ['analysis-results', 'analysis-breakdown']);
  const [results, breakdown] = sections.map(section => DomUtils.textContent(section));
  assert.match(results, /^Final (results|recommendations)/);
  assert.match(results, finalContent);
  assert.doesNotMatch(results, analysisContent);
  assert.match(breakdown, /^Analysis breakdown/);
  assert.match(breakdown, analysisContent);
  assert.deepEqual([...breakdown.matchAll(/Phase (\d+) ·/g)].map(match => Number(match[1])),
    Array.from({ length: phases }, (_, index) => index + 1));
}

test('shows final strategy results before numbered analysis phases', async t => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, Object.assign(new EventTarget(), { value: '', options: [], selectedOptions: [] }));
    return elements.get(selector);
  };
  globalThis.document = Object.assign(new EventTarget(), { querySelector: element });
  t.after(() => { delete globalThis.document; });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const week = { id: 8, name: 'Gameweek 8', deadline_time: new Date(Date.now() + 60_000).toISOString() };
  const dashboard = { events: [week], fixtures: [], dataStatus: { lastSuccessfulFetch: timestamp } };
  const saved = { ...squadReport, id: 'saved', strategy: 'ranking', gameweek: week.id, seasonYear: 2026, createdAt: timestamp,
    accuracy: { actual: [{ id: player.id, points: 8 }], actualCount: 1, actualTotal: 8, meanAbsoluteError: 0.6,
      comparedCount: 1, predictedComparableTotal: 7.4, actualComparableTotal: 8, sources: [] } };
  const archived = { ...saved, id: 'archived', strategy: 'match-winners', sampleWeeks: [7], candidateCount: 1, completedMatches: 1,
    matches: [{ home, away, reason: 'Insufficient match data' }] };
  let report;
  let savedView;
  setupPredictions({ html: String, sourceList: () => '', sourceTime: new Intl.DateTimeFormat('en-GB'), onRefresh() {},
    openDialog: (_title, content) => { savedView = content; },
    async request(path) {
      if (path === '/api/dashboard') return dashboard;
      if (path === '/api/predictions') return [saved, archived];
      if (path.startsWith('/api/prediction-data')) return { dashboard, week, token: 'test', previousWeek: 7 };
      return report;
    }
  });
  await setImmediate();
  element('#prediction-week').value = String(week.id);
  element('#prediction-week').dispatchEvent(new Event('change'));
  element('#refresh').dispatchEvent(new Event('click'));
  await setImmediate();

  const cases = [
    ['ranking', squadReport, /Selected player/, /Season points/],
    ['previous', { ...squadReport, previousWeek: 7 }, /Selected player/, /Uses final GW7 results/],
    ['recent', { ...squadReport, players: [{ ...player, evidence: { domesticWeeks: 3, cupMatches: 1, internationalMatches: 0 } }], shortlist: true },
      /Selected player/, /1 domestic cup/],
    ['season-index', indexReport, /Final Top 15 player selection.*Home Win/s, /Rates use completed Premier League matches/],
    ['h2h-index', indexReport, /Final Top 15 player selection.*Home Win/s, /verified meetings/],
    ['combined-index', indexReport, /Final Top 15 player selection.*Home Win/s, /10 percentage points/],
    ['special-rules', { ...rule, rule2: { ...rule, error: 'Four completed Gameweeks are needed.' }, rule3: rule, rule4: rule, rule5: rule, sources: [] },
      /Selected player.*Four completed Gameweeks are needed/s, /Starts \/ Goals \/ Assists/, 6],
    ['news', newsReport, /Selected player/, /Article evidence/]
  ];
  for (const [strategy, data, finalContent, analysisContent, phases] of cases) {
    report = { ...data, gameweek: week.id, strategy };
    element('#prediction-strategy').value = strategy;
    element('#analyse').dispatchEvent(new Event('click'));
    await setImmediate();
    const panel = element(strategy === 'news' ? '#news-result' : '#prediction-result');
    assert.equal(panel.hidden, false, strategy);
    checkLayout(panel.innerHTML, finalContent, analysisContent, phases);
  }

  report = { ...squadReport, gameweek: week.id, strategy: 'ranking', preview: { fixtureCount: 1 } };
  element('#prediction-strategy').value = report.strategy;
  element('#prediction-preview').dispatchEvent(new Event('click'));
  await setImmediate();
  assert.match(element('#prediction-result').innerHTML, /Post-deadline preview/);
  checkLayout(element('#prediction-result').innerHTML, /Selected player/, /Squad selection/);

  for (const [id, content, phases] of [['saved', /Mean absolute error/, 4], ['archived', /Insufficient match data/, 3]]) {
    const history = element('#history-content');
    history.closest = () => ({ dataset: { savedPrediction: id } });
    history.dispatchEvent(new Event('click'));
    checkLayout(savedView, /Selected player/, content, phases);
  }
});
