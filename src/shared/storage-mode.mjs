/**
 * Storage modes.
 *
 * compact (default): raw chat text is kept only while a session is being
 *   processed, then purged after a verified AI import while aggregates survive.
 * full: raw chat and events are kept indefinitely for re-analysis.
 */
export const STORAGE_MODES = Object.freeze(['compact', 'full']);
export const DEFAULT_STORAGE_MODE = 'compact';

export function normalizeStorageMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return STORAGE_MODES.includes(raw) ? raw : DEFAULT_STORAGE_MODE;
}
