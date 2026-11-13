import {
  chip,
  el,
  emptyState,
  formatDateTime,
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

/**
 * Render the whole report section.
 * @param {object} ctx app context (t, locale, navigate)
 * @param {object} payload GET /api/ai/sessions/:id/report
 * @param {{onAggregate?:Function, aggregateBusy?:boolean}} options
 */
export function renderAnalysisReport(ctx, payload, {onAggregate = null} = {}) {
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
        : t('ai.report.noReportBody')})),
    el('div', {className: 'page-actions'},
      el('button', {
        className: 'button button--secondary button--small',
        type: 'button',
        text: t('ai.report.openHistory'),
        onClick: () => ctx.navigate(`/history/${encodeURIComponent(payload.session.id)}`)
      })));

  const nodes = [head];
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
    return el('section', {className: 'report', id: 'ai-report'}, nodes);
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

  return el('section', {className: 'report', id: 'ai-report'}, nodes);
}

export const __internal = {percent, rangeText, confidenceChip, renderEvidence};
