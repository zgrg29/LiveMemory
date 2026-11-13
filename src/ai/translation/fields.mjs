import {createHash} from 'node:crypto';

/**
 * Translatable display fields of the saved report.
 *
 * Only natural-language fields that a reader sees are collected. Identity,
 * timestamps, counts, confidence, evidence references, enum values and the
 * long-term fact `topic` matching key are never part of an item, so a
 * translation cannot change them.
 *
 * Each item carries a stable cache key:
 *   target kind + original object id + field path + target locale + source hash
 * plus the translator implementation version. A new result version / a changed
 * fact statement therefore gets a different key instead of reusing an old
 * translation.
 */

export const TRANSLATION_VERSION = 'lm-translation-v1';

export function sourceTextHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function translationRowKey(kind, targetId, itemPath, hash) {
  return `${kind}\u0000${targetId}\u0000${itemPath}\u0000${hash}`;
}

export function sanitizeTranslatedText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 8000);
}

function textOf(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function pushItem(items, {
  kind,
  targetId,
  path,
  text,
  sourceLocale,
  apply
}) {
  const value = textOf(text);
  if (!value || !targetId) return;
  items.push({
    kind,
    targetId: String(targetId),
    path,
    text: value,
    sourceLocale: sourceLocale ?? null,
    hash: sourceTextHash(value),
    apply
  });
}

function collectReportItems(items, report, {resultId, sourceLocale}) {
  if (!report || !resultId) return;
  const kind = 'session_result';
  const add = (path, text, apply) => pushItem(items, {
    kind, targetId: resultId, path, text, sourceLocale, apply
  });

  add('summary', report.summary, (payload, text) => {
    report.summary = text;
  });
  (report.topics ?? []).forEach((topic, index) => {
    add(`topics.${index}.title`, topic.title, (payload, text) => {
      report.topics[index].title = text;
    });
    add(`topics.${index}.summary`, topic.summary, (payload, text) => {
      report.topics[index].summary = text;
    });
    (topic.keyPoints ?? []).forEach((point, pointIndex) => {
      add(`topics.${index}.key_points.${pointIndex}`, point, (payload, text) => {
        report.topics[index].keyPoints[pointIndex] = text;
      });
    });
  });
  (report.sentiment ?? []).forEach((entry, index) => {
    add(`sentiment.${index}.note`, entry.note, (payload, text) => {
      report.sentiment[index].note = text;
    });
    add(`sentiment.${index}.evidence_note`, entry.evidenceNote, (payload, text) => {
      report.sentiment[index].evidenceNote = text;
    });
  });
  (report.disputes ?? []).forEach((entry, index) => {
    add(`disputes.${index}.title`, entry.title, (payload, text) => {
      report.disputes[index].title = text;
    });
    add(`disputes.${index}.summary`, entry.summary, (payload, text) => {
      report.disputes[index].summary = text;
    });
    add(`disputes.${index}.note`, entry.note, (payload, text) => {
      report.disputes[index].note = text;
    });
    (entry.viewpoints ?? []).forEach((view, viewIndex) => {
      add(`disputes.${index}.viewpoints.${viewIndex}`, view, (payload, text) => {
        report.disputes[index].viewpoints[viewIndex] = text;
      });
    });
  });
  (report.highlights ?? []).forEach((entry, index) => {
    add(`highlights.${index}.title`, entry.title, (payload, text) => {
      report.highlights[index].title = text;
    });
    add(`highlights.${index}.reason`, entry.reason, (payload, text) => {
      report.highlights[index].reason = text;
    });
    add(`highlights.${index}.clip_suggestion`, entry.clipSuggestion, (payload, text) => {
      report.highlights[index].clipSuggestion = text;
    });
  });
}

/**
 * @returns {Array<{kind:string,targetId:string,path:string,text:string,sourceLocale:string|null,hash:string,apply:Function}>}
 */
export function collectTranslatableItems(payload) {
  const items = [];
  const sourceLocale = payload?.result?.locale
    ?? payload?.primaryJob?.locale
    ?? payload?.jobs?.[0]?.locale
    ?? null;

  collectReportItems(items, payload?.report, {
    resultId: payload?.result?.id ?? null,
    sourceLocale
  });
  for (const entry of payload?.perBatch ?? []) {
    collectReportItems(items, entry?.report, {
      resultId: entry?.result?.id ?? null,
      sourceLocale: entry?.result?.locale ?? sourceLocale
    });
  }

  const displayedResultId = payload?.result?.id ?? null;
  (payload?.viewerProfiles?.items ?? []).forEach((profile, index) => {
    pushItem(items, {
      kind: 'session_result',
      targetId: displayedResultId,
      path: `viewer_profiles.${index}.summary`,
      text: profile.summary,
      sourceLocale,
      apply: (target, text) => {
        target.viewerProfiles.items[index].summary = text;
      }
    });
    (profile.interests ?? []).forEach((interest, interestIndex) => {
      pushItem(items, {
        kind: 'session_result',
        targetId: displayedResultId,
        path: `viewer_profiles.${index}.interests.${interestIndex}.note`,
        text: interest.note,
        sourceLocale,
        apply: (target, text) => {
          target.viewerProfiles.items[index].interests[interestIndex].note = text;
        }
      });
    });
  });

  (payload?.longTermProfiles?.items ?? []).forEach((profile, index) => {
    pushItem(items, {
      kind: 'memory_summary',
      targetId: profile.memoryId ?? null,
      path: 'summary',
      text: profile.summary,
      sourceLocale: profile.sourceLocale ?? null,
      apply: (target, text) => {
        target.longTermProfiles.items[index].summary = text;
      }
    });
    (profile.facts ?? []).forEach((fact, factIndex) => {
      // `topic` is the stable matching key and is deliberately not collected.
      pushItem(items, {
        kind: 'memory_fact',
        targetId: fact.id ?? null,
        path: 'statement',
        text: fact.statement,
        sourceLocale: profile.sourceLocale ?? null,
        apply: (target, text) => {
          target.longTermProfiles.items[index].facts[factIndex].statement = text;
        }
      });
    });
  });

  return items;
}

/**
 * Apply cached translations to a freshly built report payload.
 * Only `ok` rows whose source hash matches the current text are used.
 */
export function applyCachedTranslations(payload, items, rows) {
  const byKey = new Map();
  for (const row of rows ?? []) {
    byKey.set(
      translationRowKey(row.targetKind, row.targetId, row.itemPath, row.sourceHash),
      row
    );
  }
  let applied = 0;
  for (const item of items) {
    const row = byKey.get(translationRowKey(item.kind, item.targetId, item.path, item.hash));
    if (!row || row.status !== 'ok') continue;
    const text = sanitizeTranslatedText(row.translatedText);
    if (!text) continue;
    item.apply(payload, text);
    applied += 1;
  }
  return applied;
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    totalItems: run.totalItems,
    translatedItems: run.translatedItems,
    failedItems: run.failedItems,
    pendingItems: run.pendingItems,
    usage: run.usage,
    error: run.error,
    providerConfigId: run.providerConfigId,
    providerId: run.providerId,
    modelId: run.modelId,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt
  };
}

/**
 * Read-only translation state for a report in the requested language.
 *
 * This function never calls a provider. It only reports which fields are
 * already cached, which failed, and which have never been translated.
 */
export function summarizeTranslation(items, rows, {
  targetLocale,
  sourceLocale = null,
  run = null,
  providers = []
} = {}) {
  const byKey = new Map();
  for (const row of rows ?? []) {
    const key = translationRowKey(row.targetKind, row.targetId, row.itemPath, row.sourceHash);
    // Latest row wins if a retry produced both a failed and a successful row
    // for the same hash (the unique key prevents that today, but this keeps the
    // summary correct if storage changes).
    const existing = byKey.get(key);
    if (!existing || Number(row.updatedAt) >= Number(existing.updatedAt)) byKey.set(key, row);
  }
  let translated = 0;
  let failed = 0;
  const failedPaths = [];
  for (const item of items) {
    const row = byKey.get(translationRowKey(item.kind, item.targetId, item.path, item.hash));
    if (!row) continue;
    if (row.status === 'ok' && sanitizeTranslatedText(row.translatedText)) translated += 1;
    else if (row.status === 'failed') {
      failed += 1;
      if (failedPaths.length < 20) {
        failedPaths.push({kind: item.kind, path: item.path});
      }
    }
  }
  const total = items.length;
  const missing = Math.max(0, total - translated - failed);
  const isOriginal = Boolean(targetLocale && sourceLocale && targetLocale === sourceLocale);
  let status;
  if (total === 0) status = 'unavailable';
  else if (isOriginal) status = 'original';
  else if (run?.status === 'running') status = 'running';
  else if (translated === total) status = 'complete';
  else if (translated > 0) status = 'partial';
  else if (failed > 0 && missing === 0) status = 'failed';
  else status = 'missing';

  return {
    targetLocale: targetLocale ?? null,
    sourceLocale,
    status,
    total: total,
    translated: isOriginal ? total : translated,
    failed: isOriginal ? 0 : failed,
    missing: isOriginal ? 0 : missing,
    failedPaths,
    translatorVersion: TRANSLATION_VERSION,
    cacheable: !isOriginal && total > 0,
    run: publicRun(run),
    providers: (providers ?? []).map((config) => ({
      id: config.id,
      name: config.name ?? null,
      modelId: config.modelId ?? null,
      providerId: config.providerId ?? null,
      hasCredential: config.hasCredential === true,
      isDefault: config.isDefault === true,
      pricingStatus: config.pricingStatus ?? null,
      pricing: config.pricing ?? null
    }))
  };
}

export const __internal = {collectReportItems, publicRun};
