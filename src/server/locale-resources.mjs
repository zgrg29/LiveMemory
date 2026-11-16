import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {AVAILABLE_LOCALES, DEFAULT_LOCALE} from '../shared/locale.mjs';

/**
 * Installed interface-language resources.
 *
 * The registry is the single declaration of supported languages; this helper
 * turns it into "what can actually be loaded right now" by checking the real
 * dictionary files under `src/web/i18n/`. If a dictionary is missing (partial
 * extraction, damaged install), the language is not offered and resolution
 * degrades to another available language instead of returning 404/blank text.
 */
export function detectInstalledLocales(webRoot, {exists = existsSync} = {}) {
  const installed = AVAILABLE_LOCALES.filter((code) => exists(join(webRoot, 'i18n', `${code}.json`)));
  if (installed.length > 0) return installed;
  // Keep the console bootable even when the whole i18n directory is missing;
  // the client's dictionary loader then shows its existing localized failure
  // page instead of an empty language control.
  return [DEFAULT_LOCALE];
}
