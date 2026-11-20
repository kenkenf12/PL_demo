import { DurableObject } from 'cloudflare:workers';
import { createFplClient } from './lib/fpl.mjs';
import { createApiHandler, json, securityHeaders } from './lib/http.mjs';
import { predictionService } from './lib/predictions.mjs';

const cookieName = '__Host-fpl_session';
const sessionLifetime = 365 * 24 * 60 * 60;
const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function existingSession(request) {
  const cookies = (request.headers.get('Cookie') ?? '').split(';');
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  const value = cookie?.slice(cookieName.length + 1);
  return sessionId.test(value) ? value : null;
}

export class FplSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const { storage } = ctx;
    const { sql } = storage;
    sql.exec('CREATE TABLE IF NOT EXISTS session_state (key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS predictions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');

    const state = key => ({
      read() {
        const [row] = sql.exec('SELECT payload FROM session_state WHERE key = ?', key).toArray();
        return row ? JSON.parse(row.payload) : undefined;
      },
      write(value) {
        sql.exec('INSERT INTO session_state (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload',
          key, JSON.stringify(value));
      }
    });

    const read = () => sql.exec('SELECT payload FROM predictions ORDER BY rowid DESC').toArray().map(row => JSON.parse(row.payload));
    const history = {
      read,
      update(transform) {
        storage.transactionSync(() => {
          const previous = read();
          const updated = transform(previous);
          const old = new Map(previous.map(record => [record.id, record]));
          for (const record of updated) {
            if (old.get(record.id) !== record) {
              sql.exec('INSERT INTO predictions (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
                record.id, JSON.stringify(record));
            }
          }
        });
      }
    };

    const fpl = createFplClient(state('snapshot'));
    this.api = createApiHandler(fpl, predictionService(fpl, { history, refreshState: state('refresh'), ukOddsApiKey: env.UK_ODDS_API_KEY }));
  }

  fetch(request) {
    return this.api(request.method, new URL(request.url));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const api = url.pathname.startsWith('/api/');
    const isDashboard = request.method === 'GET' && ['/', '/index.html'].includes(url.pathname);
    const current = api || isDashboard ? existingSession(request) : null;
    const newSession = !current && (api || isDashboard) ? crypto.randomUUID() : null;
    const origin = request.headers.get('Origin');
    if (api && request.method === 'POST' && origin && origin !== url.origin) {
      return json(403, { error: 'Open the FPL Assistant to submit this request.' });
    }

    let upstream;
    if (api) {
      const session = env.FPL_SESSION.getByName(current ?? newSession);
      upstream = await session.fetch(request.url, { method: request.method });
    } else {
      upstream = await env.ASSETS.fetch(request);
    }
    const response = new Response(upstream.body, upstream);
    for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
    if (newSession) {
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.append('Set-Cookie', `${cookieName}=${newSession}; Path=/; Max-Age=${sessionLifetime}; Secure; HttpOnly; SameSite=Lax`);
    }
    return response;
  }
};
