import {existsSync, readFileSync} from 'node:fs';

/**
 * Developer (one-time) YouTube OAuth configuration.
 *
 * LiveMemory is a local Windows application with no vendor server. Google's
 * "Desktop app" (installed application) OAuth client is designed for exactly
 * this case: the application carries the client id, opens the *system* browser,
 * and receives the redirect on a loopback address. Per Google's installed-app
 * documentation the client secret of such a client is not treated as
 * confidential, which is why it can ship inside a desktop binary.
 *
 * Two different things must not be confused:
 *
 * 1. Maintainer configuration (once per release): create one Google Cloud
 *    project, enable "YouTube Data API v3", create an OAuth client of type
 *    "Desktop app", and put the client id/secret into the constants below
 *    (or the environment / config file used during the build).
 * 2. Streamer usage (per user): click "Sign in with Google" once. The streamer
 *    never registers a Google Cloud project, never creates an API key and never
 *    copies a token by hand.
 *
 * When the maintainer has not configured a client yet, the application must say
 * so explicitly instead of pretending that login is possible.
 */

/**
 * Google Cloud project OAuth client (type: Desktop app).
 * Filled by the maintainer before a public release; empty by default so a
 * development checkout cannot silently claim that YouTube login works.
 */
export const YOUTUBE_OAUTH_CLIENT = Object.freeze({
  clientId: '',
  clientSecret: ''
});

/** Minimal read-only scope: locate a broadcast and read public live chat. */
export const YOUTUBE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly'
]);

export const OAUTH_ENV_KEYS = Object.freeze({
  clientId: 'LIVE_MEMORY_YOUTUBE_CLIENT_ID',
  clientSecret: 'LIVE_MEMORY_YOUTUBE_CLIENT_SECRET'
});

/** Development-only file inside the data directory; never committed. */
export const OAUTH_CONFIG_FILE_NAME = 'youtube-oauth.json';

/**
 * Optional application-level API key for *public data only*.
 *
 * Official documentation allows an API key - instead of user OAuth - for requests
 * that only read public data, "such as public live chat messages". That is the
 * anonymous mode: no Google account, no consent screen, no OAuth.
 *
 * The key is deliberately NOT bundled: the YouTube Developer Policies forbid
 * embedding API Credentials in open source projects, and a key placed inside a
 * distributed desktop binary cannot be restricted to a real application identity
 * (Google offers referrer/IP/Android/iOS restrictions, not desktop ones). A
 * deployment that has an authorised key can supply it through the environment or
 * a private config file; every other installation uses the user's own OAuth.
 */
export const API_KEY_ENV_KEY = 'LIVE_MEMORY_YOUTUBE_API_KEY';
export const API_KEY_FILE_NAME = 'youtube-api-key.json';

export function isValidClientId(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(text);
}

/** Google API keys have a stable prefix and are long enough to be recognisable. */
export function isValidApiKey(value) {
  const text = String(value ?? '').trim();
  return /^AIza[0-9A-Za-z_-]{20,80}$/.test(text);
}

function readConfigFile(file, fs, logger) {
  if (!file || typeof fs?.readFileSync !== 'function' || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      clientId: String(parsed.clientId ?? parsed.client_id ?? '').trim(),
      clientSecret: String(parsed.clientSecret ?? parsed.client_secret ?? '').trim()
    };
  } catch {
    logger?.warn?.({event: 'youtube.oauth.config.invalid'});
    return null;
  }
}

/**
 * Resolve the OAuth client for this installation.
 *
 * Precedence: environment (developer testing) -> data directory config file
 * (developer testing) -> bundled constants (release build). Nothing here logs a
 * secret.
 *
 * @returns {{configured:boolean, clientId:string, clientSecret:string, source:'bundled'|'env'|'file'|'none'}}
 */
export function resolveOAuthClient({
  env = process.env,
  configFile = null,
  fs = {existsSync, readFileSync},
  logger = null,
  bundled = YOUTUBE_OAUTH_CLIENT
} = {}) {
  const envId = String(env?.[OAUTH_ENV_KEYS.clientId] ?? '').trim();
  const envSecret = String(env?.[OAUTH_ENV_KEYS.clientSecret] ?? '').trim();
  if (isValidClientId(envId) && envSecret) {
    return {configured: true, clientId: envId, clientSecret: envSecret, source: 'env'};
  }
  const fromFile = readConfigFile(configFile, fs, logger);
  if (fromFile && isValidClientId(fromFile.clientId) && fromFile.clientSecret) {
    return {configured: true, clientId: fromFile.clientId, clientSecret: fromFile.clientSecret, source: 'file'};
  }
  const bundledId = String(bundled?.clientId ?? '').trim();
  const bundledSecret = String(bundled?.clientSecret ?? '').trim();
  if (isValidClientId(bundledId) && bundledSecret) {
    return {configured: true, clientId: bundledId, clientSecret: bundledSecret, source: 'bundled'};
  }
  return {configured: false, clientId: '', clientSecret: '', source: 'none'};
}

/** Safe for the UI/logs: never returns the secret or the full API key. */
export function describeOAuthClient(client) {
  return {
    configured: Boolean(client?.configured),
    source: client?.source ?? 'none',
    clientIdHint: client?.configured ? `…${String(client.clientId).slice(-18)}` : null
  };
}

/**
 * Resolve an optional application-level API key (anonymous mode).
 * @returns {{configured:boolean, apiKey:string, source:'env'|'file'|'none'}}
 */
export function resolveApiKey({
  env = process.env,
  configFile = null,
  fs = {existsSync, readFileSync},
  logger = null
} = {}) {
  const fromEnv = String(env?.[API_KEY_ENV_KEY] ?? '').trim();
  if (isValidApiKey(fromEnv)) return {configured: true, apiKey: fromEnv, source: 'env'};
  if (configFile && typeof fs?.readFileSync === 'function' && fs.existsSync(configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const candidate = String(parsed?.apiKey ?? parsed?.api_key ?? '').trim();
      if (isValidApiKey(candidate)) return {configured: true, apiKey: candidate, source: 'file'};
      logger?.warn?.({event: 'youtube.apikey.invalid'});
    } catch {
      logger?.warn?.({event: 'youtube.apikey.unreadable'});
    }
  }
  return {configured: false, apiKey: '', source: 'none'};
}

/** Safe for the UI/logs: only a short suffix is ever returned. */
export function describeApiKey(key) {
  return {
    configured: Boolean(key?.configured),
    source: key?.source ?? 'none',
    hint: key?.configured ? `…${String(key.apiKey).slice(-4)}` : null
  };
}

export const __internal = {readConfigFile};
