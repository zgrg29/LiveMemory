import {readRuntimeInfo} from './lock.mjs';
import {APP_NAME} from '../shared/app-info.mjs';

/**
 * Decide whether a recorded instance is really running.
 *
 * A PID alone is not enough: Windows reuses PIDs, and a non-elevated process
 * gets EPERM (not ESRCH) when it asks about an elevated process it did not
 * start. Trusting the PID would make the launcher believe a dead instance is
 * still running, print a dead URL, open a dead tab and exit — which looks like
 * "the exe flashes and nothing happens". So the recorded console URL is probed
 * and must identify itself as LiveMemory.
 */
export async function probeInstance({
  runtimeFile,
  lockPid = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500
} = {}) {
  const runtime = readRuntimeInfo(runtimeFile);
  if (!runtime || !runtime.url) {
    return {running: false, reason: 'no-runtime-info', url: null};
  }
  if (lockPid && runtime.pid && Number(runtime.pid) !== Number(lockPid)) {
    return {running: false, reason: 'pid-mismatch', url: runtime.url};
  }
  if (typeof fetchImpl !== 'function') {
    return {running: false, reason: 'no-fetch', url: runtime.url};
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(new URL('/api/health', runtime.url), {
      signal: controller.signal,
      headers: {accept: 'application/json'}
    });
    if (!response?.ok) {
      return {running: false, reason: `http-${response?.status ?? 'unknown'}`, url: runtime.url};
    }
    const body = await response.json();
    if (body?.name === APP_NAME) {
      return {running: true, reason: 'healthy', url: runtime.url, health: body, runtime};
    }
    return {running: false, reason: 'foreign-service', url: runtime.url};
  } catch (error) {
    return {running: false, reason: 'unreachable', code: error?.code ?? 'unknown', url: runtime.url};
  } finally {
    clearTimeout(timer);
  }
}

export const __internal = {APP_NAME};
