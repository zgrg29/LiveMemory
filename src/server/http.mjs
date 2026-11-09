import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync, statSync} from 'node:fs';
import {extname, join, normalize, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppError, ERROR_CODES, isAppError, toAppError} from '../shared/errors.mjs';

/**
 * Local HTTP server.
 *
 * Hard requirements implemented here:
 * - binds to 127.0.0.1 only (the caller to `listen` decides the port);
 * - rejects unexpected Host headers (DNS-rebinding protection) and cross-site
 *   mutations (Origin check);
 * - strict CSP, no inline scripts, no framing;
 * - path-traversal safe static serving;
 * - JSON body limit and content-type enforcement for writes.
 */

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}));

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join('; ')
};

export const MAX_BODY_BYTES = 1024 * 1024;

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function sendError(res, error) {
  const appError = toAppError(error);
  sendJson(res, appError.httpStatus || 500, {error: appError.toJSON()});
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export async function readJsonBody(req, {limit = MAX_BODY_BYTES} = {}) {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.jsonRequired', httpStatus: 415});
  }
  const maxBytes = Number(limit) > 0 ? Number(limit) : MAX_BODY_BYTES;
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  // Drain the remainder of an oversized request instead of destroying the
  // socket mid-upload: the client must still receive a readable 413 JSON error.
  // Reading stops after a generous hard cap so a hostile client cannot make the
  // server consume an unbounded stream.
  const drainLimit = maxBytes + 32 * 1024 * 1024;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) tooLarge = true;
    if (!tooLarge) chunks.push(chunk);
    if (size > drainLimit) break;
  }
  if (tooLarge) {
    throw new AppError(ERROR_CODES.PAYLOAD_TOO_LARGE, {
      messageKey: 'errors.payloadTooLarge',
      details: {limit: maxBytes},
      httpStatus: 413
    });
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('object required');
    }
    return parsed;
  } catch (error) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.invalidJson', httpStatus: 400, cause: error});
  }
}

/** Reject requests whose Host header is not this local server. */
export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  const host = String(hostHeader).toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/** Mutations must come from this origin when a browser sends Origin at all. */
export function isAllowedOrigin(originHeader, port) {
  if (!originHeader) return true; // same-origin fetch from our own page may omit it
  const origin = String(originHeader).toLowerCase();
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`;
}

export function resolveWebRoot(metaUrl = import.meta.url) {
  // src/server/http.mjs -> ../web
  return fileURLToPath(new URL('../web/', metaUrl));
}

export async function serveStatic(req, res, {webRoot, pathname}) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  if (decoded.includes('\u0000')) {
    sendText(res, 400, 'Bad request');
    return;
  }
  const rootResolved = resolve(webRoot);
  const candidate = normalize(join(rootResolved, decoded));
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }
  const extension = extname(candidate).toLowerCase();
  const contentType = MIME.get(extension) ?? 'application/octet-stream';
  const data = await readFile(candidate);
  const stat = statSync(candidate);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': data.length,
    // The console is served from localhost; revalidating every file avoids a
    // stale UI after an upgrade (there is no ETag/304 path yet).
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString()
  });
  res.end(data);
}

/**
 * Start the HTTP server on 127.0.0.1.
 * @param {{handler: Function, preferredPort?: number, host?: string, logger?: object}} options
 */
export function startHttpServer({handler, preferredPort = 47800, host = '127.0.0.1', logger = null}) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((error) => {
        if (!res.writableEnded) sendError(res, error);
        if (!isAppError(error)) {
          logger?.error({event: 'http.handler.failed', code: error?.code ?? 'unknown'});
        }
      });
    });
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' && !server.listening) {
        const retry = new AppError('PORT_UNAVAILABLE', {messageKey: 'errors.portUnavailable', httpStatus: 409});
        retry.cause = error;
        retry.port = preferredPort;
        reject(retry);
        return;
      }
      reject(error);
    });
    server.listen({port: preferredPort, host, exclusive: true}, () => {
      resolvePromise(server);
    });
  });
}
