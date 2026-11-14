/**
 * Theme application.
 *
 * The preference lives on the server; localStorage is only the first-paint
 * mirror written by theme-boot.js. When the preference is "system" the resolved
 * theme follows the OS and reacts to live OS changes without a reload.
 */
const STORAGE_KEY = 'livememory.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

let currentPreference = 'system';

export function resolveTheme(preference) {
  if (preference === 'light' || preference === 'dark') return preference;
  return media.matches ? 'dark' : 'light';
}

function applyAttributes() {
  const resolved = resolveTheme(currentPreference);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-preference', currentPreference);
  root.style.colorScheme = resolved;
  return resolved;
}

export function applyTheme(preference, {persistMirror = true, notify = true} = {}) {
  currentPreference = ['light', 'dark'].includes(preference) ? preference : 'system';
  if (persistMirror) {
    try {
      window.localStorage.setItem(STORAGE_KEY, currentPreference);
    } catch {
      /* storage may be unavailable */
    }
  }
  const resolved = applyAttributes();
  // Canvas charts read their colours at draw time, so they need to be told.
  if (notify) {
    window.dispatchEvent(new CustomEvent('livememory:themechange', {
      detail: {preference: currentPreference, resolved}
    }));
  }
  return resolved;
}

export function getThemePreference() {
  return currentPreference;
}

media.addEventListener('change', () => {
  if (currentPreference === 'system') {
    applyAttributes();
    window.dispatchEvent(new CustomEvent('livememory:themechange', {detail: {preference: currentPreference, resolved: resolveTheme(currentPreference)}}));
  }
});
