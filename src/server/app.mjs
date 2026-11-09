import {buildRoutes, createRouter} from './routes.mjs';
import {isAllowedHost, isAllowedOrigin, sendJson, sendText, serveStatic} from './http.mjs';

/**
 * Request handler: security checks -> API router -> static files.
 * The same handler is used by the launcher and by integration tests.
 */
export function createApp(deps) {
  const router = createRouter(buildRoutes(), deps);

  return async function handle(req, res) {
    const port = deps.getPort();
    if (!isAllowedHost(req.headers.host, port)) {
      sendText(res, 403, 'Forbidden: unexpected Host header');
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (mutating && !isAllowedOrigin(req.headers.origin, port)) {
      sendText(res, 403, 'Forbidden: cross-origin request');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // While a data-folder relocation is copying files the database is closed
      // and the services are being rebuilt. Only the relocation endpoint and
      // read-only health/status probes may run.
      if (deps.maintenance && url.pathname !== '/api/health') {
        sendJson(res, 503, {error: {code: 'MAINTENANCE', messageKey: 'errors.maintenance'}});
        return;
      }
      const handled = await router(req, res, url);
      if (!handled) {
        sendJson(res, 404, {error: {code: 'NOT_FOUND', messageKey: 'errors.notFound'}});
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }
    await serveStatic(req, res, {webRoot: deps.webRoot, pathname: url.pathname});
  };
}
