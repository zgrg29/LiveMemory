import {
  chip,
  clear,
  el,
  emptyState,
  formatDateTime,
  formatDecimal,
  formatInteger,
  formatTime
} from '../ui.js';

/**
 * AI analysis report renderer.
 *
 * Everything here comes from a validated, imported AI result. The renderer
 * never derives topics, sentiment or highlights from raw statistics; it only
 * displays what the imported answer contains and clearly separates AI output
 * from the deterministic local statistics shown elsewhere.
 *
 * All text goes through textContent (`el`), so an AI answer containing HTML or
 * script is displayed as plain text and can never execute.
 */

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, number)) * 100)}%`;
}

function rangeText(ctx, startAt, endAt) {
  if (!startAt || !Number.isFinite(startAt)) return '—';
  if (!endAt || !Number.isFinite(endAt)) return formatDateTime(startAt, ctx.locale);
  const sameDay = new Date(startAt).toDateString() === new Date(endAt).toDateString();
  if (sameDay) return `${formatTime(startAt, ctx.locale, {seconds: true})} – ${formatTime(endAt, ctx.locale, {seconds: true})}`;
  return `${formatDateTime(startAt, ctx.locale)} → ${formatDateTime(endAt, ctx.locale)}`;
}

function confidenceChip(t, confidence) {
  if (confidence === null || confidence === undefined) return null;
  if (Number(confidence) < 0.5) {
    return chip(`${t('ai.report.lowConfidence')} · ${percent(confidence)}`, 'warn');
  }
  return chip(t('ai.report.confidence', {value: percent(confidence)}), 'neutral');
}

function evidenceChip(t, evidence) {
  if (evidence === 'observed') return chip(t('ai.report.observed'), 'accent');
  if (evidence === 'inferred') return chip(t('ai.report.inferred'), 'neutral');
  return null;
}

function renderEvidence(ctx, refs) {
  const t = ctx.t;
  if (!Array.isArray(refs) || refs.length === 0) {
    return el('div', {className: 'report-evidence-empty', text: t('ai.report.evidenceEmpty')});
  }
  const rows = refs.map((ref) => {
    const time = ref.occurredAt ? formatTime(ref.occurredAt, ctx.locale, {seconds: true}) : '—';
    let body;
    if (!ref.available) {
      body = el('span', {className: 'report-evidence-unavailable', text: t('ai.report.evidenceUnavailable')});
    } else if (!ref.contentAvailable) {
      body = el('span', {
        className: 'report-evidence-unavailable',
        text: ref.purged ? t('ai.report.evidencePurged') : t('ai.report.evidenceUnavailable')
      });
    } else {
      body = el('span', {className: 'report-evidence-text', text: ref.content});
    }
    return el('div', {className: 'report-evidence-row'},
      el('span', {className: 'report-evidence-time', text: time}),
      el('span', {className: 'report-evidence-who', text: `${ref.displayName ?? '—'} · b${ref.batchIndex}:${ref.seq}`}),
      body);
  });
  const wrapper = el('div', {className: 'report-evidence'}, rows);
  return el('details', {className: 'report-evidence-block'},
    el('summary', {
      className: 'link-button report-evidence-toggle',
      text: t('ai.report.showEvidence', {n: formatInteger(refs.length, ctx.locale)})
    }),
    wrapper);
}

function evidenceWarnings(ctx, refs) {
  const missing = (refs ?? []).filter((ref) => !ref.available).length;
  if (missing === 0) return null;
  return el('div', {className: 'report-evidence-warning', text: t('ai.report.evidenceMissingCount', {
    n: formatInteger(missing, ctx.locale)
  })});
}

function sectionCard(title, {hint = null, body = null, className = ''} = {}) {
  return el('section', {className: `card report-card ${className}`.trim()},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: title}),
      hint ? el('div', {className: 'card-hint', text: hint}) : null),
    el('div', {className: 'card-body'}, body));
}

function renderTopics(ctx, report) {
  const t = ctx.t;
  if (!report.topics || report.topics.length === 0) {
    return emptyState({title: t('ai.report.topicsEmpty'), glyph: '·'});
  }
  return el('div', {className: 'report-topics'}, report.topics.map((topic, index) => el('div', {
    className: 'report-topic',
    dataset: {topicIndex: String(index)}
  },
    el('div', {className: 'report-topic-head'},
      el('span', {className: 'report-topic-time', text: rangeText(ctx, topic.startedAt, topic.endedAt)}),
      el('span', {className: 'report-topic-title', text: topic.title}),
      confidenceChip(t, topic.confidence),
      evidenceChip(t, topic.evidence)),
    topic.summary ? el('p', {className: 'report-text', text: topic.summary}) : null,
    topic.keyPoints.length > 0
      ? el('div', {className: 'report-points'},
        el('div', {className: 'report-subhead', text: t('ai.report.keyPoints')}),
        el('ul', {className: 'report-list'}, topic.keyPoints.map((point) => el('li', {text: point}))))
      : null,
    evidenceWarnings(ctx, topic.refs),
    renderEvidence(ctx, topic.refs))));
}

function renderSentiment(ctx, report) {
  const t = ctx.t;
  if (!report.sentiment || report.sentiment.length === 0) {
    return emptyState({title: t('ai.report.sentimentEmpty'), glyph: '·'});
  }
  return el('div', {className: 'report-sentiment'},
    el('div', {className: 'report-note', text: t('ai.report.sentimentNote')}),
    report.sentiment.map((entry) => el('div', {className: 'report-sentiment-row'},
      el('span', {className: 'report-sentiment-time', text: entry.at ? formatTime(entry.at, ctx.locale, {seconds: true}) : '—'}),
      chip(t(`ai.report.tone.${entry.tone}`), entry.tone === 'negative' ? 'warn' : (entry.tone === 'positive' ? 'accent' : 'neutral')),
      el('span', {className: 'report-sentiment-note', text: entry.note}),
      entry.sampleSize !== null ? chip(t('live.top.messages', {n: formatInteger(entry.sampleSize, ctx.locale)}), 'neutral') : null,
      entry.lowConfidence ? chip(`${t('ai.report.lowConfidence')} · ${percent(entry.confidence)}`, 'warn') : null,
      entry.evidenceNote ? el('span', {className: 'small tertiary', text: entry.evidenceNote}) : null)));
}

function renderDisputes(ctx, report) {
  const t = ctx.t;
  if (!report.disputes || report.disputes.length === 0) {
    return emptyState({title: t('ai.report.disputesEmpty'), glyph: '·'});
  }
  return el('div', {className: 'report-topics'}, report.disputes.map((entry) => el('div', {className: 'report-topic'},
    el('div', {className: 'report-topic-head'},
      el('span', {className: 'report-topic-time', text: rangeText(ctx, entry.startedAt, entry.endedAt ?? entry.startedAt)}),
      el('span', {className: 'report-topic-title', text: entry.title || entry.summary}),
      confidenceChip(t, entry.confidence),
      evidenceChip(t, entry.evidence)),
    entry.title && entry.summary ? el('p', {className: 'report-text', text: entry.summary}) : null,
    entry.viewpoints.length > 0
      ? el('div', {className: 'report-points'},
        el('div', {className: 'report-subhead', text: t('ai.report.viewpoints')}),
        el('ul', {className: 'report-list'}, entry.viewpoints.map((view) => el('li', {text: view}))))
      : null,
    entry.note ? el('div', {className: 'report-note', text: entry.note}) : null,
    evidenceWarnings(ctx, entry.refs),
    renderEvidence(ctx, entry.refs))));
}

function renderHighlights(ctx, report) {
  const t = ctx.t;
  if (!report.highlights || report.highlights.length === 0) {
    return emptyState({title: t('ai.report.highlightsEmpty'), glyph: '·'});
  }
  return el('div', {},
    el('div', {className: 'callout callout--neutral report-clip-notice'},
      el('div', {className: 'callout-title', text: t('ai.report.clipNoticeTitle')}),
      el('div', {text: t('ai.report.clipNotice')})),
    el('div', {className: 'report-highlights'}, report.highlights.map((entry) => el('div', {className: 'report-highlight'},
      el('div', {className: 'report-topic-head'},
        el('span', {className: 'report-topic-time', text: rangeText(ctx, entry.startedAt, entry.endedAt)}),
        el('span', {className: 'report-topic-title', text: entry.title || t('ai.report.clipSuggestion')}),
        confidenceChip(t, entry.confidence),
        evidenceChip(t, entry.evidence)),
      el('div', {className: 'report-highlight-row'},
        el('span', {className: 'report-subhead', text: t('ai.report.why')}),
        el('span', {className: 'report-text', text: entry.reason})),
      el('div', {className: 'report-highlight-row'},
        el('span', {className: 'report-subhead', text: t('ai.report.clipSuggestion')}),
        el('span', {className: 'report-text', text: entry.clipSuggestion})),
      evidenceWarnings(ctx, entry.refs),
      renderEvidence(ctx, entry.refs)))));
}

function renderViewerProfiles(ctx, viewerProfiles) {
  const t = ctx.t;
  if (!viewerProfiles || viewerProfiles.count === 0) {
    return emptyState({
      title: t('ai.report.viewerProfilesNone'),
      body: t('ai.report.viewerProfilesNoneBody'),
      glyph: '·'
    });
  }
  return el('div', {className: 'report-profiles'},
    el('div', {className: 'report-note', text: t('ai.report.viewerProfilesNote')}),
    el('div', {className: 'report-note'}, t('ai.report.viewerProfilesCount', {
      count: formatInteger(viewerProfiles.count, ctx.locale),
      low: formatInteger(viewerProfiles.lowConfidence, ctx.locale)
    })),
    viewerProfiles.items.map((profile) => el('div', {className: 'report-profile'},
      el('div', {className: 'report-topic-head'},
        el('span', {className: 'report-topic-title', text: profile.nickname || profile.viewerId}),
        profile.nickname ? el('span', {className: 'small tertiary mono', text: profile.viewerId}) : null,
        confidenceChip(t, profile.confidence)),
      profile.summary ? el('p', {className: 'report-text', text: profile.summary}) : null,
      profile.interests.length > 0
        ? el('div', {className: 'report-chips'}, profile.interests.map((interest) => chip(
          `${interest.topic} · ${t(`ai.report.${interest.evidence}`)}`,
          interest.strength === 'stable' ? 'accent' : 'neutral'
        )))
        : null)));
}

/**
 * Long-term memory is not part of the single-session result. It is a separate
 * job, but when it exists the report must show it; otherwise users reasonably
 * conclude that the paid memory run wrote nothing.
 */
function renderLongTermProfiles(ctx, data) {
  const t = ctx.t;
  if (!data || data.count === 0) {
    return emptyState({
      title: t('ai.report.longTermNone'),
      body: data?.reason === 'no_broadcaster'
        ? t('ai.report.longTermNoBroadcaster')
        : t('ai.report.longTermNoneBody'),
      glyph: '◇'
    });
  }
  return el('div', {className: 'report-profiles'},
    el('div', {className: 'report-note', text: t('ai.report.longTermNote')}),
    data.stats
      ? el('div', {className: 'def-list', style: {marginBottom: '10px'}},
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.report.longTermTotal')}),
          el('span', {className: 'def-value', text: formatInteger(data.stats.total, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.report.longTermProcessed')}),
          el('span', {className: 'def-value', text: formatInteger(data.stats.processed, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.report.longTermSemantic')}),
          el('span', {className: 'def-value', text: formatInteger(data.stats.semantic, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.report.longTermObjectiveLabel')}),
          el('span', {className: 'def-value', text: formatInteger(data.stats.objectiveOnly, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.report.longTermPending')}),
          el('span', {className: 'def-value', text: formatInteger(data.stats.pending, ctx.locale)})),
        data.stats.failed > 0
          ? el('div', {className: 'def-row'},
            el('span', {className: 'def-key', text: t('ai.report.longTermFailed')}),
            el('span', {className: 'def-value', text: formatInteger(data.stats.failed, ctx.locale)}))
          : null)
      : el('div', {className: 'report-note'}, t('ai.report.longTermCount', {
        count: formatInteger(data.count, ctx.locale)
      })),
    data.items.map((profile) => el('div', {className: 'report-profile'},
      el('div', {className: 'report-topic-head'},
        el('span', {className: 'report-topic-title', text: profile.nickname || profile.viewerId}),
        profile.nickname ? el('span', {className: 'small tertiary mono', text: profile.viewerId}) : null,
        chip(t('memory.versionLabel', {n: formatInteger(profile.version, ctx.locale)}), 'neutral')),
      profile.summary ? el('p', {className: 'report-text', text: profile.summary}) : null,
      !profile.summary && profile.facts.length === 0
        ? el('div', {className: 'small tertiary', text: t('ai.report.longTermObjectiveOnly')})
        : null,
      profile.facts.length > 0
        ? el('div', {className: 'report-points'},
          el('div', {className: 'report-subhead', text: t('ai.report.longTermFacts')}),
          el('ul', {className: 'report-list'}, profile.facts.map((fact) => el('li', {
            text: `${fact.topic ? `${fact.topic}: ` : ''}${fact.statement} · ${t(`memory.certainty${fact.certainty === 'stated' ? 'Stated' : fact.certainty === 'inferred' ? 'Inferred' : 'Uncertain'}`)}`
          }))))
        : null)));
}

function renderProvenance(ctx, payload) {
  const t = ctx.t;
  const job = payload.primaryJob ?? {};
  const result = payload.result;
  const rows = [
    [t('ai.report.resultVersion', {version: formatInteger(result?.resultVersion ?? 0, ctx.locale)}),
      result?.importedAt ? formatDateTime(result.importedAt, ctx.locale) : '—'],
    [t('ai.report.schemaVersion', {version: result?.schemaVersion ?? '—'}), result?.taskId ?? '—'],
    [t('ai.report.promptVersion', {version: job.promptVersion ?? '—'}), job.locale ?? '—'],
    [t('ai.report.batchCoverage', {
      done: formatInteger(job.batchesImported ?? 0, ctx.locale),
      total: formatInteger(job.batchTotal ?? 0, ctx.locale),
      messages: formatInteger(job.totalMessages ?? 0, ctx.locale)
    }), result?.source === 'api' || result?.source === 'auto'
      ? t('ai.report.sourceAuto')
      : result?.source === 'file'
        ? t('ai.report.sourceFile')
        : t('ai.report.sourcePaste')]
  ];
  return el('div', {className: 'def-list report-provenance'},
    rows.map(([key, value]) => el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: key}),
      el('span', {className: 'def-value', text: value}))),
    el('div', {className: 'report-note', text: t('ai.report.importedAt', {
      date: result?.importedAt ? formatDateTime(result.importedAt, ctx.locale) : '—'
    })}));
}

function renderReportBody(ctx, report) {
  const t = ctx.t;
  return el('div', {className: 'report-body'},
    sectionCard(t('ai.report.summaryTitle'), {
      body: report.summary
        ? el('p', {className: 'report-summary', text: report.summary})
        : el('div', {className: 'small tertiary', text: t('ai.report.summaryEmpty')})
    }),
    sectionCard(t('ai.report.topicsTitle'), {body: renderTopics(ctx, report)}),
    sectionCard(t('ai.report.sentimentTitle'), {body: renderSentiment(ctx, report)}),
    sectionCard(t('ai.report.disputesTitle'), {body: renderDisputes(ctx, report)}),
    sectionCard(t('ai.report.highlightsTitle'), {body: renderHighlights(ctx, report)}));
}

function localeName(t, locale) {
  if (locale === 'zh-CN') return t('settings.language.zh');
  if (locale === 'ja') return t('settings.language.ja');
  if (locale === 'en') return t('settings.language.en');
  return t('ai.report.languageSourceUnknown');
}

function formatCost(ctx, cost) {
  if (!cost || !Number.isFinite(Number(cost.amount)) || !cost.currency) return null;
  try {
    return new Intl.NumberFormat(ctx.locale, {
      maximumFractionDigits: 4
    }).format(Number(cost.amount));
  } catch {
    return String(Number(cost.amount));
  }
}

function translationReason(t, code) {
  if (!code) return t('ai.report.translationReasonUnknown');
  const key = `ai.report.translationReason.${code}`;
  const value = t(key);
  // Stable error codes are acceptable diagnostics; raw provider prose is not.
  return value === key ? code : value;
}

function translationUsageLine(ctx, usage) {  const t = ctx.t;
  if (!usage) return null;
  const tokens = t('ai.report.translationUsage', {
    input: formatInteger(usage.inputTokens ?? 0, ctx.locale),
    output: formatInteger(usage.outputTokens ?? 0, ctx.locale)
  });
  const cost = formatCost(ctx, usage.cost);
  return `${tokens} · ${cost
    ? t('ai.report.translationCost', {
      amount: cost,
      currency: String(usage.cost.currency ?? '').toUpperCase()
    })
    : t('ai.report.translationUnknownCost')}`;
}

/**
 * Translation controls. This is intentionally a small, local panel:
 *   - cached translation: explain that reading is free/cached;
 *   - missing/partial/failed: explicit provider, consent and retry;
 *   - running: real progress from the local run row.
 * It never claims that translation re-runs the analysis.
 */
function renderTranslationPanel(ctx, payload, {onTranslate, onOpenSettings, error = null}) {
  const t = ctx.t;
  const translation = payload.translation ?? {};
  const status = translation.status ?? 'unavailable';
  const target = translation.targetLocale ?? payload.displayLocale ?? null;
  const nodes = [];

  if (status === 'unavailable' || translation.total === 0) {
    return el('div', {className: 'report-translation report-translation--muted'},
      el('div', {className: 'small tertiary', text: t('ai.report.languageUnavailable')}));
  }

  if (status === 'original') {
    // Reading the stored original needs no provider, no cache note and no action.
    return null;
  }

  if (status === 'complete') {
    nodes.push(el('div', {className: 'report-translation-status'},
      chip(t('ai.report.translationComplete'), 'accent')));
    const usage = translation.run?.usage;
    if (usage) nodes.push(el('div', {className: 'small tertiary', text: translationUsageLine(ctx, usage)}));
    nodes.push(el('div', {className: 'small tertiary', text: t('ai.report.translationCacheReuse')}));
    return el('div', {className: 'report-translation'}, nodes);
  }

  if (status === 'running') {
    const run = translation.run ?? {};
    const progress = translation.progress ?? {};
    const done = Number(progress.itemsDone ?? ((run.translatedItems ?? 0) + (run.failedItems ?? 0)));
    const total = Number(progress.itemsTotal ?? run.totalItems ?? translation.total ?? 0);
    nodes.push(el('div', {className: 'report-translation-status'},
      chip(t('ai.report.translationRunning', {
        done: formatInteger(done, ctx.locale),
        total: formatInteger(total, ctx.locale)
      }), 'neutral')));
    nodes.push(el('div', {className: 'small tertiary', text: t('ai.report.translationRunningHint')}));
    return el('div', {className: 'report-translation'}, nodes);
  }

  // missing / partial / failed
  const notice = el('div', {className: 'callout callout--neutral'},
    el('div', {className: 'callout-title', text: t('ai.report.translationNoticeTitle')}),
    el('div', {text: t('ai.report.translationNotice')}));
  nodes.push(notice);

  if (status === 'partial' || status === 'failed') {
    nodes.push(el('div', {className: 'report-translation-status'},
      chip(t('ai.report.translationPartial', {
        missing: formatInteger(translation.missing ?? 0, ctx.locale),
        failed: formatInteger(translation.failed ?? 0, ctx.locale)
      }), 'warn')));
  }
  if (error) {
    nodes.push(el('div', {className: 'callout callout--danger', attrs: {role: 'alert'}},
      el('div', {text: t('ai.report.translationFailed', {reason: error})})));
  } else if (translation.run?.error?.code) {
    nodes.push(el('div', {className: 'callout callout--danger', attrs: {role: 'alert'}},
      el('div', {text: t('ai.report.translationFailed', {
        reason: translationReason(t, translation.run.error.code)
      })})));
  }

  const providers = (translation.providers ?? []).filter((provider) => provider.hasCredential);
  if (providers.length === 0) {
    nodes.push(el('div', {className: 'callout callout--warn'},
      el('div', {text: t('ai.report.translationNoProvider')}),
      onOpenSettings
        ? el('div', {className: 'inline', style: {marginTop: '10px'}},
          el('button', {
            className: 'button button--secondary button--small',
            type: 'button',
            text: t('ai.report.translationSettings'),
            onClick: onOpenSettings
          }))
        : null));
    return el('div', {className: 'report-translation'}, nodes);
  }

  const providerSelect = el('select', {
    className: 'select',
    attrs: {'aria-label': t('ai.report.translationProvider')}
  }, providers.map((provider) => el('option', {
    value: provider.id,
    text: `${provider.name || provider.modelId || provider.providerId} · ${provider.modelId ?? '—'}`
  })));
  const preferred = providers.find((provider) => provider.isDefault) ?? providers[0];
  providerSelect.value = preferred.id;

  const costLine = el('div', {className: 'small tertiary'});
  const updateCostLine = () => {
    const selected = providers.find((provider) => provider.id === providerSelect.value) ?? preferred;
    if (selected.pricingStatus === 'paid' && selected.pricing) {
      costLine.textContent = t('ai.v13.price.paidValue', {
        input: formatDecimal(selected.pricing.inputPerMillion ?? 0, ctx.locale, 4),
        output: formatDecimal(selected.pricing.outputPerMillion ?? 0, ctx.locale, 4),
        currency: String(selected.pricing.currency ?? '').toUpperCase()
      });
    } else {
      costLine.textContent = t('ai.report.translationUnknownCost');
    }
  };
  updateCostLine();
  providerSelect.addEventListener('change', updateCostLine);

  const consent = el('input', {type: 'checkbox'});
  const consentLabel = el('label', {className: 'checkbox-row'},
    consent,
    el('span', {text: t('ai.report.translationConsent')}));
  const action = el('button', {
    className: 'button button--primary button--small',
    type: 'button',
    text: status === 'missing'
      ? t('ai.report.translationStart', {language: localeName(t, target)})
      : t('ai.report.translationRetry')
  });
  action.disabled = true;
  consent.addEventListener('change', () => {
    action.disabled = consent.checked !== true;
  });
  action.addEventListener('click', () => {
    if (consent.checked !== true) return;
    action.disabled = true;
    onTranslate?.({configId: providerSelect.value, consent: true});
  });

  nodes.push(el('div', {className: 'field'},
    el('label', {className: 'label', text: t('ai.report.translationProvider')}),
    providerSelect,
    costLine));
  nodes.push(consentLabel);
  nodes.push(el('div', {className: 'inline'},
    action,
    el('span', {className: 'small tertiary', text: t('ai.report.translationCacheReuse')})));
  return el('div', {className: 'report-translation'}, nodes);
}

function languageBlock(ctx, payload, {onLocaleChange, onShowOriginal}) {
  const t = ctx.t;
  const supported = ['zh-CN', 'ja', 'en'];
  const source = payload.reportLocale ?? null;
  const selected = supported.includes(payload.displayLocale)
    ? payload.displayLocale
    : (supported.includes(source) ? source : ctx.locale);
  const select = el('select', {
    className: 'select select--compact',
    attrs: {'aria-label': t('ai.report.languageTitle')}
  }, supported.map((locale) => el('option', {value: locale, text: localeName(t, locale)})));
  select.value = selected;
  select.addEventListener('change', () => onLocaleChange?.(select.value));
  const status = payload.translation?.status ?? 'unavailable';
  const translated = selected !== source && (status === 'complete' || status === 'partial');
  return el('div', {className: 'report-language'},
    el('div', {className: 'report-language-row'},
      el('span', {className: 'label', text: t('ai.report.languageTitle')}),
      select,
      source === selected
        ? chip(t('ai.report.languageOriginalChip'), 'neutral')
        : (translated ? chip(t('ai.report.languageTranslatedChip'), 'accent') : null),
      translated && onShowOriginal
        ? el('button', {
          className: 'button button--ghost button--small',
          type: 'button',
          text: t('ai.report.translationShowOriginal'),
          onClick: () => onShowOriginal()
        })
        : null),
    el('div', {className: 'small tertiary', text: source
      ? t('ai.report.languageSource', {locale: localeName(t, source)})
      : t('ai.report.languageSourceUnknown')}),
    el('div', {className: 'small tertiary', text: t('ai.report.languageHint')}));
}

/**
 * Render the whole report section.
 * @param {object} ctx app context (t, locale, navigate)
 * @param {object} payload GET /api/ai/sessions/:id/report
 */
export function renderAnalysisReport(ctx, payload, {
  onAggregate = null,
  onLocaleChange = null,
  onTranslate = null,
  onOpenSettings = null,
  translationError = null
} = {}) {
  const t = ctx.t;
  if (!payload) return null;
  const head = el('div', {className: 'report-head'},
    el('div', {},
      el('div', {className: 'report-title-row'},
        el('h2', {className: 'report-title', text: t('ai.report.title')}),
        chip(t('ai.report.aiBadge'), 'accent'),
        payload.complete ? chip(t('ai.job.status.complete'), 'accent') : chip(t('ai.job.status.partial'), 'warn')),
      el('p', {className: 'report-subtitle', text: payload.report
        ? t('ai.report.evidenceNote')
        : t('ai.report.noReportBody')}),
      languageBlock(ctx, payload, {
        onLocaleChange,
        onShowOriginal: onLocaleChange && payload.reportLocale
          ? () => onLocaleChange(payload.reportLocale)
          : null
      })),
    el('div', {className: 'page-actions'},
      el('button', {
        className: 'button button--secondary button--small',
        type: 'button',
        text: t('ai.report.openHistory'),
        onClick: () => ctx.navigate(`/history/${encodeURIComponent(payload.session.id)}`)
      })));

  const panelHost = el('div', {className: 'report-translation-host'});
  const renderPanel = (state = payload) => {
    clear(panelHost);
    const panel = renderTranslationPanel(ctx, state, {
      onTranslate,
      onOpenSettings,
      error: translationError
    });
    if (panel) panelHost.append(panel);
  };
  renderPanel();

  const nodes = [head, panelHost];
  if (!payload.report && payload.perBatch.length === 0) {
    nodes.push(sectionCard(t('ai.report.noReport'), {
      body: el('div', {},
        el('div', {className: 'small tertiary', text: t('ai.report.noReportBody')}),
        el('div', {className: 'inline', style: {marginTop: '10px'}},
          el('button', {
            className: 'button button--secondary button--small',
            type: 'button',
            text: t('ai.report.openAi'),
            onClick: () => ctx.navigate(`/ai?session=${encodeURIComponent(payload.session.id)}`)
          })))
    }));
    if (payload.longTermProfiles?.count > 0) {
      nodes.push(sectionCard(t('ai.report.longTermProfilesTitle'), {
        body: renderLongTermProfiles(ctx, payload.longTermProfiles)
      }));
    }
    return {
      node: el('section', {className: 'report', id: 'ai-report'}, nodes),
      updateTranslation(state) {
        renderPanel(state);
      }
    };
  }

  if (payload.incompleteReason) {
    const reasons = [];
    if (payload.incompleteReason === 'missing_batches') {
      const missing = payload.primaryJob?.missingBatches ?? [];
      const shown = missing.slice(0, 16).join(', ');
      const suffix = missing.length > 16
        ? ` ${t('ai.report.missingBatchesMore', {count: formatInteger(missing.length - 16, ctx.locale)})}`
        : '';
      reasons.push(t('ai.report.missingBatches', {list: `${shown}${suffix}`}));
    } else if (payload.incompleteReason === 'awaiting_aggregate') {
      reasons.push(t('ai.report.awaitingAggregate'));
    } else {
      reasons.push(t('ai.report.incompleteBody'));
    }
    nodes.push(el('div', {className: 'callout callout--warn report-incomplete'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('ai.report.incompleteTitle')}),
        el('div', {text: reasons.join(' ')}),
        onAggregate && !payload.primaryJob?.aggregatePackageReady
          && (payload.primaryJob?.missingBatches?.length ?? 0) === 0
          ? el('div', {className: 'inline', style: {marginTop: '10px'}},
            el('button', {
              className: 'button button--primary button--small',
              type: 'button',
              text: t('ai.jobs.aggregate'),
              onClick: onAggregate
            }))
          : null,
        !onAggregate && payload.incompleteReason === 'awaiting_aggregate'
          ? el('div', {className: 'small tertiary', style: {marginTop: '8px'}, text: t('ai.report.awaitingAggregateAuto')})
          : null)));
  }

  if (payload.report) {
    nodes.push(renderReportBody(ctx, payload.report));
    nodes.push(sectionCard(t('ai.report.viewerProfilesTitle'), {
      body: renderViewerProfiles(ctx, payload.viewerProfiles)
    }));
    nodes.push(sectionCard(t('ai.report.longTermProfilesTitle'), {
      body: renderLongTermProfiles(ctx, payload.longTermProfiles)
    }));
    nodes.push(sectionCard(t('ai.report.provenanceTitle'), {body: renderProvenance(ctx, payload)}));
  }

  if (payload.mode === 'partial') {
    for (const entry of payload.perBatch) {
      nodes.push(el('section', {className: 'report-batch'},
        el('div', {className: 'report-batch-head'},
          el('h3', {className: 'report-batch-title', text: t('ai.report.partialBatchTitle', {
            index: formatInteger(entry.batchIndex, ctx.locale)
          })}),
          chip(t('ai.report.partialNote'), 'neutral')),
        renderReportBody(ctx, entry.report),
        sectionCard(t('ai.report.provenanceTitle'), {
          body: renderProvenance(ctx, {
            primaryJob: payload.primaryJob,
            result: entry.result
          })
        })));
    }
  }

  return {
    node: el('section', {className: 'report', id: 'ai-report'}, nodes),
    updateTranslation(state) {
      renderPanel(state);
    }
  };
}

export const __internal = {percent, rangeText, confidenceChip, renderEvidence};
