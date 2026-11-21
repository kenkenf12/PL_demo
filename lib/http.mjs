import { FplError } from './fpl.mjs';

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
};

export function json(status, data) {
  return Response.json(data, { status, headers: { ...securityHeaders, 'Cache-Control': 'no-store' } });
}

export function createApiHandler(fpl, predictions) {
  const routes = [
    [/^\/api\/players\/(\d+)$/, fpl.getPlayer],
    [/^\/api\/gameweeks\/(\d+)\/live$/, fpl.getLive],
    [/^\/api\/entries\/(\d+)$/, fpl.getEntry]
  ];

  return async (method, url) => {
    const { pathname, searchParams } = url;
    try {
      if (method === 'POST' && ['/api/prediction-data', '/api/predictions'].includes(pathname)) {
        const gameweek = Number(searchParams.get('gameweek'));
        if (!Number.isInteger(gameweek) || gameweek < 1 || gameweek > 38) {
          return json(400, { error: 'Choose a Gameweek from 1 to 38.' });
        }
        if (pathname === '/api/prediction-data') return json(200, await predictions.refresh(gameweek));
        return json(201, await predictions.analyse(gameweek, searchParams.get('strategy'), searchParams.get('token')));
      }
      if (method !== 'GET') return json(405, { error: 'Method unavailable for this endpoint.' });
      if (pathname === '/api/predictions') return json(200, await predictions.history());
      if (pathname === '/api/dashboard') return json(200, await fpl.getDashboard(true));
      for (const [pattern, handler] of routes) {
        const match = pattern.exec(pathname);
        if (!match) continue;
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || id < 1) return json(400, { error: 'Enter a positive numeric ID.' });
        return json(200, await handler(id));
      }
      return json(404, { error: 'Page or endpoint unavailable.' });
    } catch (error) {
      if (error instanceof FplError) return json(error.status, { error: error.message });
      console.error(error);
      return json(500, { error: 'Could not process the FPL data.' });
    }
  };
}
