import {api} from '../api.js';
import {
  chip,
  el,
  emptyState,
  formatDateTime,
  formatInteger
} from '../ui.js';
import {createModal} from '../dialog.js';

/**
 * Long-term memory panels for one viewer profile.
 *
 * The tab is a read model over `/api/memory/viewers/:id`: facts are grouped by
 * how trustworthy they are, every fact shows where it came from, and a human can
 * confirm, age-out, restore or forget a single fact. Nothing here edits a fact's
 * text: the only write paths are review actions, version restore and deletion.
 */

const CERTAINTY_TONE = {
  stated: 'accent',
  inferred: 'neutral',
  uncertain: 'warn'
};

const STATUS_TONE = {
  active: 'neutral',
  outdated: 'warn',
  conflicted: 'danger',
  superseded: 'neutral',
  needs_confirmation: 'warn'
};

function keyOr(key, fallback, t) {
  const text = t(key);
  return text === key ? fallback : text;
}

function certaintyLabel(fact, t) {
  if (fact.userVerified) return t('memory.certaintyVerified');
  return keyOr(`memory.certainty${fact.certainty === 'stated' ? 'Stated' : (fact.certainty === 'inferred' ? 'Inferred' : 'Uncertain')}`, fact.certainty, t);
}

function statusLabel(fact, t) {
  const map = {
    active: 'Active',
    outdated: 'Outdated',
    conflicted: 'Conflicted',
    superseded: 'Superseded',
    needs_confirmation: 'NeedsConfirmation'
  };
  return keyOr(`memory.status${map[fact.status] ?? ''}`, fact.status, t);
}

function kindLabel(kind, t) {
  return keyOr(`memory.kind.${kind}`, kind, t);
}

function sourceLabel(fact, t) {
  if (fact.sourceKind === 'ai_memory_update') return t('memory.sourceAi');
  if (fact.sourceKind === 'session_result') return t('memory.sourceSessionResult');
  if (fact.sourceKind === 'session_analysis_result') return t('memory.sourceAnalysisResult');
  if (fact.sourceKind === 'rollback') return t('memory.sourceRollback');
  return t('memory.sourceManual');
}

function evidenceTone(status) {
  if (status === 'available') return 'accent';
  if (status === 'none') return 'neutral';
  return 'warn';
}

function evidenceLabel(status, t) {
  if (status === 'available') return t('memory.evidenceAvailable');
  if (status === 'partial') return t('memory.evidencePartial');
  if (status === 'purged') return t('memory.evidencePurged');
  if (status === 'unavailable') return t('memory.evidenceUnavailable');
  return t('memory.evidenceNone');
}

function confirmDialog(ctx, {title, body, confirmLabel, tone = 'neutral'}) {
  return new Promise((resolve) => {
    const modal = createModal({title, subtitle: body, t: ctx.t, tone});
    const cancel = el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: ctx.t('common.cancel'),
      onClick: () => {
        modal.close();
        resolve(false);
      }
    });
    const ok = el('button', {
      className: tone === 'danger' ? 'button button--danger' : 'button button--primary',
      type: 'button',
      text: confirmLabel,
      onClick: () => {
        modal.close();
        resolve(true);
      }
    });
    modal.actions.append(cancel, ok);
    ok.focus();
  });
}

function evidenceList(fact, ctx) {
  const t = ctx.t;
  const rows = (fact.evidence ?? []).map((entry) => {
    const hasMessage = Boolean(entry.eventId);
    const text = hasMessage
      ? (entry.snippet ?? (entry.purged ? t('memory.evidenceMissingText') : '—'))
      : t('memory.evidenceNone');
    return el('div', {className: 'memory-evidence-row'},
      el('div', {className: 'memory-evidence-meta'},
        el('span', {text: formatDateTime(entry.messageAt, ctx.locale)}),
        entry.nickname ? el('span', {className: 'tertiary', text: entry.nickname}) : null,
        hasMessage && entry.verified ? chip(t('memory.evidenceAvailable'), 'accent') : null,
        hasMessage && !entry.verified ? chip(t('memory.evidencePurged'), 'warn') : null),
      el('div', {
        className: `memory-evidence-text${hasMessage && !entry.verified ? ' memory-evidence-text--muted' : ''}`,
        text
      }));
  });
  return el('details', {className: 'memory-evidence'},
    el('summary', {text: `${t('memory.evidenceTitle')} · ${formatInteger(fact.evidenceCount, ctx.locale)}`}),
    el('div', {className: 'memory-evidence-list'},
      rows.length > 0 ? rows : el('div', {className: 'small tertiary', text: t('memory.evidenceNone')})));
}

function factActions(fact, ctx, {viewerId, broadcasterId, reload}) {
  const t = ctx.t;
  const run = async (action) => {
    try {
      await api.post(
        `/api/memory/viewers/${encodeURIComponent(viewerId)}/facts/${encodeURIComponent(fact.id)}/review`,
        {action, broadcasterId}
      );
      ctx.toast(t('memory.reviewed'));
      await reload();
    } catch (error) {
      const messageKey = error?.messageKey;
      ctx.toast(messageKey && t(messageKey) !== messageKey ? t(messageKey) : ctx.describeError(error), {tone: 'error'});
    }
  };
  const buttons = [];
  if (fact.status === 'superseded') {
    buttons.push(el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('memory.reviewForget'),
      onClick: async () => {
        const ok = await confirmDialog(ctx, {
          title: t('memory.reviewForget'),
          body: t('memory.forgetBody'),
          confirmLabel: t('memory.reviewForget'),
          tone: 'danger'
        });
        if (ok) await run('forget');
      }
    }));
    return el('div', {className: 'memory-fact-actions'}, buttons);
  }
  if (fact.status === 'needs_confirmation' || fact.status === 'conflicted'
    || (fact.status === 'active' && fact.certainty !== 'stated' && !fact.userVerified)) {
    buttons.push(el('button', {
      className: 'button button--secondary button--small',
      type: 'button',
      text: t('memory.reviewConfirm'),
      onClick: () => run('confirm')
    }));
  }
  if (fact.status === 'outdated') {
    buttons.push(el('button', {
      className: 'button button--secondary button--small',
      type: 'button',
      text: t('memory.reviewRestore'),
      onClick: () => run('restore')
    }));
  } else if (fact.status !== 'conflicted') {
    buttons.push(el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('memory.reviewDismiss'),
      onClick: () => run('dismiss')
    }));
  }
  buttons.push(el('button', {
    className: 'button button--ghost button--small',
    type: 'button',
    text: t('memory.reviewForget'),
    onClick: async () => {
      const ok = await confirmDialog(ctx, {
        title: t('memory.reviewForget'),
        body: t('memory.deleteBody'),
        confirmLabel: t('memory.reviewForget'),
        tone: 'danger'
      });
      if (ok) await run('forget');
    }
  }));
  return el('div', {className: 'memory-fact-actions'}, buttons);
}

function factCard(fact, ctx, options) {
  const t = ctx.t;
  const meta = [];
  meta.push(el('span', {text: `${t('memory.firstSeen')} · ${formatDateTime(fact.firstSeenAt, ctx.locale)}`}));
  meta.push(el('span', {text: `${t('memory.lastConfirmed')} · ${formatDateTime(fact.lastConfirmedAt, ctx.locale)}`}));
  if (fact.validFrom) {
    meta.push(el('span', {text: `${t('memory.validFrom')} · ${formatDateTime(fact.validFrom, ctx.locale)}`}));
  }
  if (fact.validUntil) {
    meta.push(el('span', {text: `${t('memory.validUntil')} · ${formatDateTime(fact.validUntil, ctx.locale)}`}));
  }
  return el('div', {className: 'memory-fact', dataset: {status: fact.status}},
    el('div', {className: 'memory-fact-head'},
      el('span', {className: 'memory-fact-topic', text: fact.topic || kindLabel(fact.kind, t)}),
      chip(certaintyLabel(fact, t), CERTAINTY_TONE[fact.certainty] ?? 'neutral'),
      chip(statusLabel(fact, t), STATUS_TONE[fact.status] ?? 'neutral')),
    el('div', {className: 'memory-fact-statement', text: fact.statement}),
    el('div', {className: 'memory-fact-meta'}, meta),
    el('div', {className: 'memory-fact-source'},
      chip(sourceLabel(fact, t), 'neutral'),
      fact.sourceSessionId
        ? el('button', {
          className: 'link-button',
          type: 'button',
          text: t('memory.sourceSession'),
          onClick: () => ctx.navigate(`/history/${encodeURIComponent(fact.sourceSessionId)}`)
        })
        : null,
      chip(evidenceLabel(fact.evidenceStatus, t), evidenceTone(fact.evidenceStatus))),
    (fact.evidence ?? []).length > 0 ? evidenceList(fact, ctx) : null,
    factActions(fact, ctx, options));
}

function groupSection(title, facts, ctx, options) {
  if (facts.length === 0) return null;
  return el('section', {className: 'memory-group'},
    el('div', {className: 'memory-group-title'},
      el('span', {text: title}),
      chip(formatInteger(facts.length, ctx.locale), 'neutral')),
    el('div', {className: 'memory-group-list'}, facts.map((fact) => factCard(fact, ctx, options))));
}

function groupFacts(view) {
  const byId = new Map((view.facts ?? []).map((fact) => [fact.id, fact]));
  const pick = (ids) => (ids ?? []).map((id) => byId.get(id)).filter(Boolean);
  return {
    attention: pick(view.groups?.attention),
    conflicts: pick(view.groups?.conflicts),
    confirmed: pick(view.groups?.confirmed),
    inferred: pick(view.groups?.inferred),
    outdated: pick(view.groups?.outdated),
    history: pick(view.groups?.history)
  };
}

function memoryHeader(view, ctx, {viewerId, broadcasterId, reload}) {
  const t = ctx.t;
  const memory = view.memory;
  const evidence = view.evidence ?? {};
  const summaryCard = memory?.summary
    ? el('div', {className: 'callout callout--neutral'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('memory.summaryTitle')}),
        el('div', {text: memory.summary}),
        el('div', {className: 'small tertiary', style: {marginTop: '6px'}, text: t('memory.summaryInferred')})))
    : null;
  const deleteButton = el('button', {
    className: 'button button--ghost button--small',
    type: 'button',
    text: t('memory.deleteTitle'),
    onClick: async () => {
      const ok = await confirmDialog(ctx, {
        title: t('memory.deleteTitle'),
        body: t('memory.deleteBody'),
        confirmLabel: t('memory.deleteConfirm'),
        tone: 'danger'
      });
      if (!ok) return;
      try {
        await api.post(`/api/memory/viewers/${encodeURIComponent(viewerId)}/delete`, {
          broadcasterId,
          confirm: true
        });
        ctx.toast(t('memory.deleted'));
        await reload();
      } catch (error) {
        const messageKey = error?.messageKey;
        ctx.toast(messageKey && t(messageKey) !== messageKey ? t(messageKey) : ctx.describeError(error), {tone: 'error'});
      }
    }
  });
  return el('div', {className: 'memory-head'},
    summaryCard,
    el('div', {className: 'def-list'},
      el('div', {className: 'def-row'},
        el('span', {className: 'def-key', text: t('memory.updatedAt')}),
        el('span', {className: 'def-value', text: formatDateTime(memory?.lastUpdateAt, ctx.locale)})),
      el('div', {className: 'def-row'},
        el('span', {className: 'def-key', text: t('memory.firstSeen')}),
        el('span', {className: 'def-value', text: formatDateTime(memory?.firstMemoryAt, ctx.locale)})),
      el('div', {className: 'def-row'},
        el('span', {className: 'def-key', text: t('memory.versionsTitle')}),
        el('span', {className: 'def-value', text: formatInteger(view.versions?.length ?? 0, ctx.locale)})),
      el('div', {className: 'def-row'},
        el('span', {className: 'def-key', text: t('memory.evidenceTitle')}),
        el('span', {className: 'def-value'},
          chip(t('memory.evidenceAvailable') + ' ' + formatInteger(evidence.available ?? 0, ctx.locale), 'accent'),
          chip(t('memory.evidencePurged') + ' ' + formatInteger(evidence.purged ?? 0, ctx.locale), 'warn')))),
    el('div', {className: 'inline'}, deleteButton));
}

function objectiveCard(view, ctx) {
  const t = ctx.t;
  const objective = view.objective;
  if (!objective) return null;
  const viewer = objective.viewer ?? {};
  const broadcaster = objective.broadcasterContext ?? null;
  const sessions = objective.recentSessions ?? [];
  const rows = [
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('memory.objective.firstSeen')}),
      el('span', {className: 'def-value', text: formatDateTime(broadcaster?.firstSeenAt ?? viewer.firstSeenAt, ctx.locale)})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('memory.objective.lastSeen')}),
      el('span', {className: 'def-value', text: formatDateTime(broadcaster?.lastSeenAt ?? viewer.lastSeenAt, ctx.locale)})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('memory.objective.sessions')}),
      el('span', {className: 'def-value', text: formatInteger(
        broadcaster?.sessionCount ?? viewer.sessionCount ?? 0,
        ctx.locale
      )})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('memory.objective.messages')}),
      el('span', {className: 'def-value', text: formatInteger(
        broadcaster?.messageCount ?? viewer.messageCount ?? 0,
        ctx.locale
      )})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('memory.objective.payments')}),
      el('span', {className: 'def-value', text: formatInteger(
        broadcaster?.paymentEventCount ?? viewer.paymentEventCount ?? 0,
        ctx.locale
      )}))
  ];
  return el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('memory.objective.title')}),
      el('div', {className: 'card-hint', text: t('memory.objective.hint')})),
    el('div', {className: 'card-body'},
      el('div', {className: 'def-list'}, rows),
      el('div', {className: 'memory-objective-sessions'},
        el('div', {className: 'small tertiary', text: t('memory.objective.recent')}),
        sessions.length > 0
          ? sessions.map((session) => el('button', {
            className: 'memory-objective-session',
            type: 'button',
            onClick: () => ctx.navigate(`/history/${encodeURIComponent(session.sessionId)}`)
          },
          el('span', {className: 'row-title-text', text: session.roomTitle || t('memory.objective.untitled')}),
          el('span', {className: 'small tertiary', text: `${formatDateTime(session.lastSeenAt ?? session.startedAt, ctx.locale)} · ${formatInteger(session.messageCount, ctx.locale)}`})))
          : el('div', {className: 'small tertiary', text: t('memory.objective.noSessions')}))));
}

/** Render the "long-term memory" tab into `host`. */
export function renderMemoryTab({ctx, host, view, viewerId, broadcasterId, reload}) {
  const t = ctx.t;
  host.replaceChildren();
  const memory = view.memory;
  if (!memory || memory.status === 'deleted') {
    if (view.objective) host.append(objectiveCard(view, ctx));
    host.append(el('section', {className: 'card'},
      el('div', {className: 'card-body'},
        emptyState({
          title: memory?.status === 'deleted' ? t('memory.deleted') : t('memory.noMemory'),
          body: memory?.status === 'deleted' ? t('memory.noMemoryBody') : t('memory.noSemanticBody'),
          glyph: '◇'
        }))));
    return;
  }
  const groups = groupFacts(view);
  host.append(memoryHeader(view, ctx, {viewerId, broadcasterId, reload}));
  const objective = objectiveCard(view, ctx);
  if (objective) host.append(objective);
  const sections = [
    groupSection(t('memory.groupAttention'), groups.attention, ctx, {viewerId, broadcasterId, reload}),
    groupSection(t('memory.groupConflicts'), groups.conflicts, ctx, {viewerId, broadcasterId, reload}),
    groupSection(t('memory.groupConfirmed'), groups.confirmed, ctx, {viewerId, broadcasterId, reload}),
    groupSection(t('memory.groupInferred'), groups.inferred, ctx, {viewerId, broadcasterId, reload}),
    groupSection(t('memory.groupOutdated'), groups.outdated, ctx, {viewerId, broadcasterId, reload}),
    groupSection(t('memory.groupHistory'), groups.history, ctx, {viewerId, broadcasterId, reload})
  ].filter(Boolean);
  if (sections.length === 0) {
    host.append(el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.noSemanticTitle')})),
      el('div', {className: 'card-body'},
        el('p', {className: 'small tertiary', text: t('memory.noSemanticBody')}))));
    return;
  }
  host.append(el('div', {className: 'memory-groups'}, sections));
}

function diffBlock(version, ctx) {
  const t = ctx.t;
  const diff = version.diff ?? {};
  const rows = [];
  for (const entry of diff.added ?? []) {
    rows.push(el('div', {className: 'memory-diff-row'},
      chip(resultText('added', t), 'accent'),
      el('span', {text: `${entry.topic ? `${entry.topic} · ` : ''}${entry.statement}`})));
  }
  for (const entry of diff.changed ?? []) {
    rows.push(el('div', {className: 'memory-diff-row'},
      chip(resultText('updated', t), 'warn'),
      el('span', {text: `${entry.topic ? `${entry.topic} · ` : ''}${entry.statement}`})));
  }
  for (const entry of diff.confirmed ?? []) {
    rows.push(el('div', {className: 'memory-diff-row'},
      chip(resultText('confirmed', t), 'neutral'),
      el('span', {text: `${entry.topic ? `${entry.topic} · ` : ''}${entry.statement}`})));
  }
  for (const entry of diff.removed ?? []) {
    rows.push(el('div', {className: 'memory-diff-row'},
      chip(resultText('removed', t), 'danger'),
      el('span', {text: `${entry.topic ? `${entry.topic} · ` : ''}${entry.statement}`})));
  }
  return el('details', {className: 'memory-diff'},
    el('summary', {text: t('memory.showDiff')}),
    el('div', {className: 'memory-diff-list'},
      rows.length > 0 ? rows : el('div', {className: 'small tertiary', text: t('memory.nothingHere')})));
}

function resultText(kind, t) {
  const key = `memory.import.result.${kind}`;
  const text = t(key);
  if (text !== key) return text;
  return kind;
}

/** Render the "versions" tab into `host`. */
export function renderVersionsTab({ctx, host, view, viewerId, broadcasterId, reload}) {
  const t = ctx.t;
  host.replaceChildren();
  const versions = view.versions ?? [];
  const memory = view.memory;
  if (!memory || memory.status === 'deleted' || versions.length === 0) {
    host.append(el('section', {className: 'card'},
      el('div', {className: 'card-body'}, emptyState({title: t('memory.noVersions'), glyph: '·'}))));
    return;
  }
  const rows = versions.map((version) => {
    const isCurrent = version.version === memory.version;
    const restore = el('button', {
      className: 'button button--secondary button--small',
      type: 'button',
      text: t('memory.restoreVersion'),
      disabled: isCurrent,
      onClick: async () => {
        const ok = await confirmDialog(ctx, {
          title: t('memory.restoreVersion'),
          body: t('memory.versionsHint'),
          confirmLabel: t('memory.restoreVersion')
        });
        if (!ok) return;
        try {
          await api.post(`/api/memory/viewers/${encodeURIComponent(viewerId)}/rollback`, {
            broadcasterId,
            version: version.version
          });
          ctx.toast(t('memory.restored'));
          await reload();
        } catch (error) {
          const messageKey = error?.messageKey;
          ctx.toast(messageKey && t(messageKey) !== messageKey ? t(messageKey) : ctx.describeError(error), {tone: 'error'});
        }
      }
    });
    return el('div', {className: `memory-version${isCurrent ? ' memory-version--current' : ''}`},
      el('div', {className: 'memory-version-head'},
        el('span', {className: 'memory-version-title', text: t('memory.versionLabel', {n: version.version})}),
        isCurrent ? chip(t('memory.statusActive'), 'accent') : null,
        chip(sourceLabel({sourceKind: version.sourceKind}, t), 'neutral')),
      el('div', {className: 'small tertiary', text: formatDateTime(version.appliedAt, ctx.locale)}),
      el('div', {className: 'small tertiary', text: t('memory.versionCounts', {
        added: formatInteger(version.counts?.added ?? 0, ctx.locale),
        changed: formatInteger(version.counts?.changed ?? 0, ctx.locale),
        confirmed: formatInteger(version.counts?.confirmed ?? 0, ctx.locale)
      })}),
      diffBlock(version, ctx),
      el('div', {className: 'memory-version-actions'},
        version.sourceSessionId
          ? el('button', {
            className: 'link-button',
            type: 'button',
            text: t('memory.sourceSession'),
            onClick: () => ctx.navigate(`/history/${encodeURIComponent(version.sourceSessionId)}`)
          })
          : null,
        restore));
  });
  host.append(el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('memory.versionsTitle')}),
      el('div', {className: 'card-hint', text: t('memory.versionsHint')})),
    el('div', {className: 'card-body'}, el('div', {className: 'memory-versions'}, rows))));
}

/** Overview card shown in the profile's overview tab. */
export function renderMemorySummaryCard({ctx, view, onOpen}) {
  const t = ctx.t;
  const memory = view.memory;
  if (!memory || memory.status === 'deleted') {
    return el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.pageTitle')})),
      el('div', {className: 'card-body'},
        emptyState({title: t('memory.noMemory'), body: t('memory.noMemoryBody'), glyph: '◇'}),
        el('div', {className: 'inline', style: {marginTop: '12px'}},
          el('button', {
            className: 'button button--secondary',
            type: 'button',
            text: t('memory.viewerTabMemory'),
            onClick: onOpen
          }))));
  }
  const groups = view.groups ?? {};
  return el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('memory.pageTitle')}),
      el('div', {className: 'card-hint', text: t('memory.versionLabel', {n: memory.version})})),
    el('div', {className: 'card-body'},
      memory.summary
        ? el('div', {className: 'small', text: memory.summary})
        : el('div', {className: 'small tertiary', text: t((view.facts ?? []).length === 0
          ? 'memory.noSemanticBody'
          : 'memory.nothingHere')}),
      (view.facts ?? []).length === 0
        ? el('div', {className: 'small tertiary', style: {marginTop: '8px'}, text: t('memory.noSemanticTitle')})
        : null,
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        chip(`${t('memory.groupConfirmed')} ${formatInteger((groups.confirmed ?? []).length, ctx.locale)}`, 'accent'),
        chip(`${t('memory.groupInferred')} ${formatInteger((groups.inferred ?? []).length, ctx.locale)}`, 'neutral'),
        chip(
          t('memory.attentionCount', {n: formatInteger((groups.attention ?? []).length + (groups.conflicts ?? []).length, ctx.locale)}),
          'warn'
        )),
      el('div', {className: 'small tertiary', style: {marginTop: '8px'}, text: t('memory.updatedAt') + ' · ' + formatDateTime(memory.lastUpdateAt, ctx.locale)}),
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        el('button', {
          className: 'button button--primary button--small',
          type: 'button',
          text: t('memory.viewerTabMemory'),
          onClick: onOpen
        }))));
}

export async function fetchMemoryView(viewerId, broadcasterId) {
  const query = broadcasterId ? `?broadcasterId=${encodeURIComponent(broadcasterId)}` : '';
  return api.get(`/api/memory/viewers/${encodeURIComponent(viewerId)}${query}`);
}
