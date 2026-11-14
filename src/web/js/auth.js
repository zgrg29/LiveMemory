/**
 * One-time browser sign-in for the local console.
 *
 * The launcher opens `http://127.0.0.1:<port>/#lm_bootstrap=<token>`. The
 * fragment never goes to the server; this module reads it, exchanges it for an
 * HttpOnly SameSite=Strict cookie, then removes it from the address bar so it
 * does not survive in history or a copied URL.
 *
 * The token is never placed in a query string, localStorage or a log.
 */
const BOOTSTRAP_PARAM = 'lm_bootstrap';

function hashBody() {
  return String(window.location.hash ?? '').replace(/^#/, '');
}

export function readBootstrapToken() {
  const hash = hashBody();
  if (!hash) return null;
  const queryIndex = hash.indexOf('?');
  if (queryIndex >= 0) {
    return new URLSearchParams(hash.slice(queryIndex + 1)).get(BOOTSTRAP_PARAM);
  }
  if (hash.startsWith(`${BOOTSTRAP_PARAM}=`)) {
    return new URLSearchParams(hash).get(BOOTSTRAP_PARAM);
  }
  return null;
}

/** Remove the token while preserving the current hash route and other params. */
export function clearBootstrapToken() {
  const hash = hashBody();
  if (!hash) return;
  const queryIndex = hash.indexOf('?');
  let route = hash;
  let params = new URLSearchParams();
  if (queryIndex >= 0) {
    route = hash.slice(0, queryIndex);
    params = new URLSearchParams(hash.slice(queryIndex + 1));
  } else if (hash.startsWith(`${BOOTSTRAP_PARAM}=`)) {
    route = '';
    params = new URLSearchParams(hash);
  } else {
    return;
  }
  params.delete(BOOTSTRAP_PARAM);
  const suffix = params.toString();
  const nextRoute = route || '/live';
  const nextHash = `#${nextRoute}${suffix ? `?${suffix}` : ''}`;
  try {
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}${nextHash}`);
  } catch {
    /* history may be unavailable in a locked-down browser; the token is
       short-lived and already consumed on success */
  }
}

async function exchange(token) {
  let response;
  try {
    response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token}),
      credentials: 'same-origin',
      cache: 'no-store'
    });
  } catch {
    // Do not clear the fragment: no request reached the server, so a reload may
    // still be able to complete the one-time exchange.
    return {ok: false, code: 'NETWORK'};
  }
  clearBootstrapToken();
  if (!response.ok) return {ok: false, code: 'AUTH_INVALID'};
  return {ok: true};
}

async function sessionStatus() {
  try {
    const response = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) return {ok: false, code: 'NETWORK'};
    const payload = await response.json();
    return payload?.authenticated === true
      ? {ok: true}
      : {ok: false, code: 'AUTH_REQUIRED'};
  } catch {
    return {ok: false, code: 'NETWORK'};
  }
}

/** Establish the browser session or report why it cannot be established. */
export async function establishSession() {
  const token = readBootstrapToken();
  if (token) return exchange(token);
  return sessionStatus();
}
