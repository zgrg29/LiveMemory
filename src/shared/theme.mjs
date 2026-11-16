/**
 * Theme preference: "system" | "light" | "dark".
 *
 * The preference is stored server side (config/settings.json) and mirrored to
 * localStorage so the first paint can apply the correct theme without a flash.
 * The server never guesses the OS theme: only the browser's matchMedia knows it.
 */
export const THEMES = Object.freeze(['system', 'light', 'dark']);
export const THEME_PREFERENCE_SYSTEM = 'system';
export const DEFAULT_THEME = THEME_PREFERENCE_SYSTEM;

export function normalizeTheme(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return THEMES.includes(raw) ? raw : DEFAULT_THEME;
}

/**
 * Resolve the concrete theme for a preference and the current system theme.
 * @param {string} preference
 * @param {boolean} systemPrefersDark
 * @returns {"light"|"dark"}
 */
export function resolveTheme(preference, systemPrefersDark) {
  const normalized = normalizeTheme(preference);
  if (normalized === 'light') return 'light';
  if (normalized === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}
