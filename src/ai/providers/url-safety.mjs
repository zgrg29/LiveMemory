import {isIP} from 'node:net';
import {lookup} from 'node:dns/promises';

/**
 * Base URL safety for user-supplied OpenAI-compatible endpoints.
 *
 * The console must not become an SSRF proxy for local admin interfaces, LAN
 * management pages or cloud metadata addresses. At the same time, a user who
 * deliberately runs a local model is a legitimate use case, so localhost is not
 * blanket-forbidden: it requires an explicit per-config `allowLocalNetwork`
 * acknowledgement.
 */

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal'
]);

function parseIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

export function isPrivateOrReservedIp(address) {
  const family = isIP(address);
  if (family === 4) {
    const parts = parseIPv4(address);
    if (!parts) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
    if (a >= 224) return true; // multicast / reserved / broadcast
    return false;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('ff')) return true;
    // IPv4-mapped ::ffff:127.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }
  return true;
}

export function isLocalHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  return host === 'localhost'
    || host === 'localhost.localdomain'
    || host.endsWith('.localhost')
    || host === '::1';
}

export class UrlSafetyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UrlSafetyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate a base URL synchronously (syntax and literal IP checks).
 * @returns {URL}
 */
export function validateBaseUrl(value, {allowLocalNetwork = false} = {}) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new UrlSafetyError('URL_INVALID', 'Base URL is not a valid URL');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new UrlSafetyError('URL_SCHEME', 'Only http(s) base URLs are supported');
  }
  if (url.username || url.password) {
    throw new UrlSafetyError('URL_CREDENTIALS', 'Base URL must not embed credentials');
  }
  if (url.hash) {
    throw new UrlSafetyError('URL_FRAGMENT', 'Base URL must not contain a fragment');
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) throw new UrlSafetyError('URL_HOST', 'Base URL has no host');
  if (hostname === '169.254.169.254' || METADATA_HOSTS.has(hostname)) {
    throw new UrlSafetyError('URL_METADATA', 'Cloud metadata addresses are not allowed');
  }
  if (isIP(hostname) && isPrivateOrReservedIp(hostname) && !allowLocalNetwork) {
    throw new UrlSafetyError('URL_PRIVATE', 'Local/private network addresses need explicit permission');
  }
  if (!isIP(hostname) && isLocalHostname(hostname) && !allowLocalNetwork) {
    throw new UrlSafetyError('URL_LOCAL', 'Localhost needs explicit permission');
  }
  if (url.protocol === 'http:' && !allowLocalNetwork && !isLocalHostname(hostname)) {
    throw new UrlSafetyError('URL_INSECURE', 'Remote endpoints must use https');
  }
  return url;
}

/**
 * Resolve the hostname and reject DNS names that point at private ranges unless
 * the user explicitly allowed a local service. This blocks a public-looking
 * hostname from reaching 127.0.0.1 / 169.254.169.254.
 */
export async function assertSafeResolvedUrl(value, {
  allowLocalNetwork = false,
  lookupImpl = lookup
} = {}) {
  const url = validateBaseUrl(value, {allowLocalNetwork});
  const hostname = url.hostname;
  if (isIP(hostname)) return url;
  if (allowLocalNetwork && isLocalHostname(hostname)) return url;
  let addresses;
  try {
    addresses = await lookupImpl(hostname, {all: true, verbatim: true});
  } catch {
    // Network failures are reported by the real request, not as an SSRF error.
    return url;
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.some((entry) => entry?.address && isPrivateOrReservedIp(entry.address)) && !allowLocalNetwork) {
    throw new UrlSafetyError('URL_PRIVATE_DNS', 'Hostname resolves to a private address');
  }
  return url;
}

export function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const suffix = String(path ?? '').startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
