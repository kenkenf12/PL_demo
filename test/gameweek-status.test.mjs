import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { setupPredictions } from '../public/predictions.mjs';

const currentSeason = {
  fixtures: [],
  dataStatus: { source: 'Latest API Data', lastSuccessfulFetch: '2026-09-01T12:00:00Z', gameweek: 7, complete: true }
};

function event(id, { finished = false, data_checked = false, is_current = false } = {}) {
  return { id, name: `Gameweek ${id}`, deadline_time: new Date(Date.now() + 60_000).toISOString(),
    finished, data_checked, is_current };
}

function dashboard(...events) {
  return { ...currentSeason, events };
}

function predictionPage(t, request) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, Object.assign(new EventTarget(), {
      hidden: true, innerHTML: '', textContent: '', value: '', options: [], selectedOptions: []
    }));
    return elements.get(selector);
  };
  const document = Object.assign(new EventTarget(), { hidden: false, querySelector: element });
  globalThis.document = document;
  t.after(() => { delete globalThis.document; });
  t.mock.timers.enable({ apis: ['setInterval'] });
  setupPredictions({ request, html: String, sourceTime: new Intl.DateTimeFormat('en-GB'), onRefresh() {} });
  const week = element('#prediction-week');
  return {
    element, document, week,
    async select(id) {
      week.value = String(id);
      week.dispatchEvent(new Event('change'));
      await setImmediate();
    }
  };
}

test('reports confirmed Gameweek completion on selection and while the page stays open', async t => {
  const complete = { finished: true, data_checked: true };
  let current = dashboard(event(6, complete), event(7, { is_current: true }), event(8), event(9));
  const calls = [];
  const { element, week, select } = predictionPage(t, async (path, method = 'GET') => {
    calls.push(`${method} ${path}`);
    return path === '/api/dashboard' ? current : [];
  });
  await setImmediate();
  const status = element('#gameweek-status');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Gameweek 6 · COMPLETE');

  current = dashboard(event(6, complete), event(7, { finished: true }), event(8, { is_current: true }), event(9));
  await select(8);
  assert.equal(status.textContent, 'Gameweek 6 · COMPLETE');
  assert.doesNotMatch(week.innerHTML, /Gameweek 7 · COMPLETE/);

  current = dashboard(event(6, complete), event(7, complete), event(8, { is_current: true }), event(9));
  t.mock.timers.tick(5 * 60_000);
  await setImmediate();
  assert.equal(status.textContent, 'Gameweek 7 · COMPLETE');
  assert.equal(week.value, '8');
  assert.equal(element('#prediction-strategy').disabled, true);

  current = dashboard(event(6, complete), event(7, complete), event(8, complete), event(9, { is_current: true }));
  await select(9);
  assert.equal(status.textContent, 'Gameweek 8 · COMPLETE');
  for (const id of [6, 7, 8]) assert.match(week.innerHTML, new RegExp(`Gameweek ${id} · COMPLETE`));
  assert.doesNotMatch(week.innerHTML, /Gameweek 9 · COMPLETE/);

  current = dashboard(event(6, complete), event(7, complete), event(8, complete), event(9, { ...complete, is_current: true }));
  t.mock.timers.tick(5 * 60_000);
  await setImmediate();
  assert.equal(status.textContent, 'Gameweek 9 · COMPLETE');
  assert.equal(calls.filter(call => call === 'GET /api/dashboard').length, 5);
  assert.ok(calls.every(call => call.startsWith('GET ')));
});

test('keeps the manual refresh status and prediction controls when an older check returns late', async t => {
  const stale = dashboard(event(7), event(8));
  const fresh = dashboard(event(7, { finished: true, data_checked: true }), event(8));
  const checking = Promise.withResolvers();
  let checks = 0;
  const { document, element, select } = predictionPage(t, async (path, method = 'GET') => {
    if (path === '/api/predictions?summary=1') return [];
    if (path === '/api/dashboard') return ++checks === 1 ? stale : checking.promise;
    assert.equal(method, 'POST');
    assert.equal(path, '/api/prediction-data?gameweek=8');
    return { dashboard: fresh, week: fresh.events[1], previousWeek: 7 };
  });
  await setImmediate();
  const status = element('#gameweek-status');
  assert.equal(status.textContent, 'No Gameweek has been confirmed complete.');

  document.hidden = true;
  t.mock.timers.tick(5 * 60_000);
  assert.equal(checks, 1);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  await select(8);
  assert.equal(checks, 2);
  element('#refresh').dispatchEvent(new Event('click'));
  await setImmediate();
  assert.equal(status.textContent, 'Gameweek 7 · COMPLETE');
  assert.equal(element('#prediction-strategy').disabled, false);

  checking.resolve(stale);
  await setImmediate();
  assert.equal(status.textContent, 'Gameweek 7 · COMPLETE');
  assert.match(element('#prediction-week').innerHTML, /Gameweek 7 · COMPLETE/);
  assert.equal(element('#prediction-strategy').disabled, false);
});
