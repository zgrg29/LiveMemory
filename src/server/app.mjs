import {buildRoutes, createRouter} from './routes.mjs';
import {
  isAllowedFetchSite,
  isAllowedHost,
  isAllowedOrigin,
  sendJson,
  sendText,
  serveStatic
} from './http.mjs';
import {isPublicApiPath} from './auth.mjs';

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
    // Origin is checked for every method, not only writes: a cross-site GET can
    // still leak data if a browser is tricked into sending it, and EventSource
    // is a GET. `Origin: null` is always rejected by isAllowedOrigin().
    if (!isAllowedOrigin(req.headers.origin, port)) {
      sendText(res, 403, 'Forbidden: cross-origin request');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // The browser's own cross-site marker is an additional, independent veto.
      // Direct local clients do not send Sec-Fetch-Site and still need a cookie.
      if (!isAllowedFetchSite(req.headers['sec-fetch-site'])) {
        sendText(res, 403, 'Forbidden: cross-site request');
        return;
      }
      // While a data-folder relocation is copying files the database is closed
      // and the services are being rebuilt. Only the relocation endpoint and
      // read-only health/auth probes may run.
      if (deps.maintenance && !isPublicApiPath(url.pathname)) {
        sendJson(res, 503, {error: {code: 'MAINTENANCE', messageKey: 'errors.maintenance'}});
        return;
      }
      if (!isPublicApiPath(url.pathname)) {
        const auth = deps.auth?.authenticate(req) ?? {ok: false, reason: 'no-auth-service'};
        if (!auth.ok) {
          // Deliberately identical for missing, expired and wrong credentials.
          deps.logger?.debug({event: 'auth.rejected', reason: auth.reason ?? 'unauthorized', path: url.pathname});
          sendJson(res, 401, {error: {code: 'AUTH_REQUIRED', messageKey: 'errors.authRequired'}});
          return;
        }
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
