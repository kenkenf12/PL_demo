import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createFplClient } from './lib/fpl.mjs';
import { createApiHandler, json, securityHeaders } from './lib/http.mjs';
import { predictionHistory, seasonSnapshot } from './lib/node-storage.mjs';
import { predictionService } from './lib/predictions.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/predictions.mjs', ['predictions.mjs', 'text/javascript']],
  ['/model.mjs', ['model.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']]
]);

const fpl = createFplClient(seasonSnapshot());
const api = createApiHandler(fpl, predictionService(fpl, { history: predictionHistory(), ukOddsApiKey: process.env.UK_ODDS_API_KEY }));

async function send(response, result) {
  const body = await result.arrayBuffer();
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(body));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && files.has(url.pathname)) {
      const [filename, type] = files.get(url.pathname);
      const content = await readFile(new URL(`./public/${filename}`, import.meta.url));
      response.writeHead(200, { ...securityHeaders, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return response.end(content);
    }
    await send(response, await api(request.method, url));
  } catch (error) {
    console.error(error);
    await send(response, json(500, { error: 'Could not process the FPL data.' }));
  }
});

const port = Number(process.env.FPL_PORT ?? 3000);
server.listen(port, '127.0.0.1', () => console.log(`FPL Assistant: http://127.0.0.1:${server.address().port}/`));
