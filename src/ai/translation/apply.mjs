import {
  applyCachedTranslations,
  collectTranslatableItems,
  summarizeTranslation,
  TRANSLATION_VERSION
} from './fields.mjs';
import {
  latestTranslationRun,
  listTranslationItems
} from '../../storage/repositories/ai-translations.mjs';
import {SUPPORTED_LOCALES} from '../constants.mjs';

/**
 * Read-only bridge between the report read model and the translation cache.
 * It never writes and never calls a provider.
 */

export function normalizeReportLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale) ? locale : null;
}

export function translationSourceLocale(payload) {
  const fromResult = payload?.result?.locale;
  if (typeof fromResult === 'string' && fromResult) return fromResult;
  const fromJob = payload?.primaryJob?.locale;
  if (typeof fromJob === 'string' && fromJob) return fromJob;
  const first = payload?.jobs?.[0]?.locale;
  return typeof first === 'string' && first ? first : null;
}

/**
 * Apply cached translations in place and return the state description.
 *
 * @param {object} db
 * @param {object} payload buildSessionAnalysisReport() output
 * @param {{locale?:string, providers?:Array}} options
 */
export function applyReportTranslation(db, payload, {locale = null, providers = []} = {}) {
  const sourceLocale = translationSourceLocale(payload);
  const targetLocale = normalizeReportLocale(locale) ?? sourceLocale;
  const items = collectTranslatableItems(payload);
  const sessionId = payload?.session?.id;
  if (!targetLocale || !sessionId) {
    return {
      items,
      translation: summarizeTranslation(items, [], {
        targetLocale,
        sourceLocale,
        run: null,
        providers
      })
    };
  }
  const rows = listTranslationItems(db, {
    sessionId,
    targetLocale,
    translatorVersion: TRANSLATION_VERSION
  });
  const run = latestTranslationRun(db, {sessionId, targetLocale});
  // The stored text *is* the original when the requested language matches the
  // report language. Never overwrite it from a cache row, even if one exists.
  if (!sourceLocale || targetLocale !== sourceLocale) {
    applyCachedTranslations(payload, items, rows);
  }
  return {
    items,
    translation: summarizeTranslation(items, rows, {
      targetLocale,
      sourceLocale,
      run,
      providers
    })
  };
}

export const __internal = {translationSourceLocale};
