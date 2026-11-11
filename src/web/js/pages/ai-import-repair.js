/**
 * Build a copyable repair instruction for a failed manual AI import.
 *
 * This never changes the answer and never guesses an id: it only repeats the
 * exact viewer ids that are missing, the unknown ids the model invented, and
 * the validator field paths, so the user can paste it back into the same AI
 * service. Pure function so the text can be unit-tested without a browser.
 */
export function buildRepairInstruction({
  missing = [],
  unknown = [],
  duplicate = [],
  errors = [],
  t,
  limit = 30
}) {
  const lines = [t('ai.import.repairIntro')];
  if (missing.length > 0) {
    lines.push('', t('ai.import.repairMissingTitle', {n: missing.length}));
    for (const entry of missing.slice(0, limit)) {
      lines.push(`- ${entry.nickname ?? '(no nickname)'} · ${entry.viewerId}`);
    }
    if (missing.length > limit) lines.push(`- … +${missing.length - limit}`);
  }
  if (unknown.length > 0) {
    lines.push('', t('ai.import.repairUnknownTitle', {n: unknown.length}));
    for (const entry of unknown.slice(0, limit)) {
      lines.push(`- ${entry.viewerId || '(empty)'}`);
    }
    if (unknown.length > limit) lines.push(`- … +${unknown.length - limit}`);
  }
  if (duplicate.length > 0) {
    lines.push('', t('ai.import.repairDuplicateViewersTitle', {n: duplicate.length}));
    for (const entry of duplicate.slice(0, limit)) {
      lines.push(`- ${entry.nickname ?? '(no nickname)'} · ${entry.viewerId}`);
    }
  }
  if (errors.length > 0) {
    lines.push('', t('ai.import.repairErrorsTitle'));
    for (const error of errors.slice(0, limit)) {
      lines.push(`- ${error.path || '(root)'} · ${error.code || 'INVALID'}`);
    }
    if (errors.length > limit) lines.push(`- … +${errors.length - limit}`);
  }
  lines.push(
    '',
    t('ai.import.repairRules'),
    `- ${t('ai.import.repairRuleExactId')}`,
    `- ${t('ai.import.repairRuleCoverage')}`,
    `- ${t('ai.import.repairRuleNoNew')}`,
    `- ${t('ai.import.repairRuleEvidence')}`,
    `- ${t('ai.import.repairRuleNoNickname')}`,
    '',
    t('ai.import.repairAsk')
  );
  return lines.join('\n');
}

/** Summarise coverage gaps for the preview card; ids are never altered. */
export function importGapSummary(memory) {
  const gaps = memory?.gaps ?? {};
  return {
    missing: Array.isArray(gaps.missing) ? gaps.missing : [],
    unknown: Array.isArray(gaps.unknown) ? gaps.unknown : [],
    duplicate: Array.isArray(gaps.duplicate) ? gaps.duplicate : [],
    empty: (gaps.missing?.length ?? 0) === 0
      && (gaps.unknown?.length ?? 0) === 0
      && (gaps.duplicate?.length ?? 0) === 0
  };
}
