import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createFplClient, FplError } from './lib/fpl.mjs';
import { predictionService } from './lib/predictions.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/predictions.mjs', ['predictions.mjs', 'text/javascript']],
  ['/model.mjs', ['model.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']]
]);

const fpl = createFplClient();
const predictions = predictionService(fpl);
const api = [
  [/^\/api\/players\/(\d+)$/, fpl.getPlayer],
  [/^\/api\/gameweeks\/(\d+)\/live$/, fpl.getLive],
  [/^\/api\/entries\/(\d+)$/, fpl.getEntry]
];

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && ['/api/prediction-data', '/api/predictions'].includes(url.pathname)) {
      const gameweek = Number(url.searchParams.get('gameweek'));
      if (!Number.isInteger(gameweek) || gameweek < 1 || gameweek > 38) {
        return json(response, 400, { error: 'Choose a Gameweek from 1 to 38.' });
      }
      if (url.pathname === '/api/prediction-data') return json(response, 200, await predictions.refresh(gameweek));
      const { searchParams } = url;
      return json(response, 201, await predictions.analyse(gameweek, searchParams.get('strategy'), searchParams.get('token')));
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'Method unavailable for this endpoint.' });
    if (url.pathname === '/api/predictions') return json(response, 200, await predictions.history());
    if (files.has(url.pathname)) {
      const [filename, type] = files.get(url.pathname);
      const content = await readFile(new URL(`./public/${filename}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return response.end(content);
    }
    if (url.pathname === '/api/dashboard') {
      return json(response, 200, await fpl.getDashboard(url.searchParams.get('refresh') === '1'));
    }
    for (const [pattern, handler] of api) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id < 1) return json(response, 400, { error: 'Enter a positive numeric ID.' });
      return json(response, 200, await handler(id));
    }
    return json(response, 404, { error: 'Page or endpoint unavailable.' });
  } catch (error) {
    if (error instanceof FplError) return json(response, error.status, { error: error.message });
    console.error(error);
    return json(response, 500, { error: 'Could not process the FPL data.' });
  }
});

const port = Number(process.env.FPL_PORT ?? 3000);
server.listen(port, '127.0.0.1', () => console.log(`FPL Assistant: http://127.0.0.1:${server.address().port}/`));
