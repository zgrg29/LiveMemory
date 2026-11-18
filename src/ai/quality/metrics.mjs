/**
 * Long-term viewer memory quality metrics.
 *
 * This module is deliberately pure and dependency-free. It does not know about
 * providers, prompts or the database: it scores a set of *saved facts* against a
 * human-annotated gold set and a set of explicitly *not-to-save* messages.
 *
 * Why a separate semantic layer is required
 * -----------------------------------------
 * The local importer can prove four things deterministically: the answer has a
 * valid schema, every ref exists, every evidence seq belongs to the same
 * viewer, and the fact was written. It cannot prove that the statement is
 * *entailed* by the cited chat line, that a durable fact was not omitted, or
 * that a temporary joke was not stored as a life event. Those are semantic
 * questions, so they need an explicit gold set and an explicit match rule.
 *
 * Matching is intentionally conservative:
 *   - a gold fact is counted as recalled only when a saved fact is semantically
 *     matched AND the saved fact's own cited text supports it;
 *   - `inferred` / `uncertain` facts are reported as review cases and are never
 *     silently promoted to "correct";
 *   - ambiguous gold facts (a request, a one-day event, a joke that can be read
 *     either way) are excluded from the strict denominator and listed
 *     separately. They are never counted as automatically correct.
 *
 * The output contains every per-fact decision so a human can re-check it; the
 * summary numbers are derived from that table, not produced by a black box.
 */

export const MATCH_THRESHOLDS = Object.freeze({
  /** A direct alias hit plus a weak lexical overlap is enough. */
  alias: 0.62,
  /** Pure lexical similarity must be this high for a match. */
  fuzzy: 0.72,
  /** Below this a saved fact is "unmatched"; between the two it is ambiguous. */
  ambiguous: 0.45,
  /** Two saved statements above this are treated as the same fact. */
  duplicate: 0.9
});

export function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

function bigrams(text) {
  const chars = [...text];
  if (chars.length < 2) return chars.length === 1 ? new Map([[chars[0], 1]]) : new Map();
  const map = new Map();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = `${chars[index]}${chars[index + 1]}`;
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}

/** Sørensen–Dice coefficient over character bigrams (works for zh/ja/en). */
export function diceCoefficient(left, right) {
  const a = normalizeForMatch(left);
  const b = normalizeForMatch(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of gramsA.values()) totalA += count;
  for (const count of gramsB.values()) totalB += count;
  for (const [gram, count] of gramsA) {
    if (gramsB.has(gram)) overlap += Math.min(count, gramsB.get(gram));
  }
  return (2 * overlap) / (totalA + totalB || 1);
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * A one-character Chinese/Japanese/Korean alias ("猫", "絵") is meaningful;
 * a one-character Latin alias ("a") is not. This distinction matters for
 * Japanese chat where the whole topic can be a single kanji.
 */
function isMeaningfulAlias(value) {
  const text = normalizeForMatch(value);
  return text.length >= 2 || CJK.test(text);
}

function aliasesOf(gold) {
  const list = [
    ...(Array.isArray(gold.aliases) ? gold.aliases : []),
    ...(Array.isArray(gold.topics) ? gold.topics : []),
    gold.statement
  ];
  return [...new Set(list.map((entry) => String(entry ?? '').trim()).filter(Boolean))];
}

function factText(fact) {
  return `${fact?.topic ?? ''} ${fact?.statement ?? ''}`.trim();
}

function eventKeyOf(evidence) {
  if (!evidence) return null;
  if (evidence.eventKey) return String(evidence.eventKey);
  if (evidence.sessionKey && evidence.seq !== undefined && evidence.seq !== null) {
    return `${evidence.sessionKey}#${evidence.seq}`;
  }
  if (evidence.sessionId && evidence.seq !== undefined && evidence.seq !== null) {
    return `${evidence.sessionId}#${evidence.seq}`;
  }
  return null;
}

function evidenceKeysOf(items) {
  return (Array.isArray(items) ? items : [])
    .map(eventKeyOf)
    .filter(Boolean);
}

/**
 * Score one saved fact against one gold fact.
 *
 * Alias containment dominates because it is the only signal that is stable
 * across paraphrase and across the three task languages. Dice similarity is a
 * secondary signal and never enough on its own below `fuzzy`.
 */
export function scoreFactAgainstGold(fact, gold) {
  const text = normalizeForMatch(factText(fact));
  if (!text) return {score: 0, aliasHit: false, bestAlias: null, dice: 0};
  let best = {score: 0, aliasHit: false, bestAlias: null, dice: 0};
  for (const alias of aliasesOf(gold)) {
    const normalizedAlias = normalizeForMatch(alias);
    if (!normalizedAlias) continue;
    const aliasHit = isMeaningfulAlias(normalizedAlias) && text.includes(normalizedAlias);
    const dice = diceCoefficient(text, alias);
    const score = aliasHit ? Math.min(1, 0.82 + dice * 0.18) : dice;
    if (score > best.score) best = {score, aliasHit, bestAlias: alias, dice};
  }
  return best;
}

function citedText(fact) {
  return (Array.isArray(fact?.evidence) ? fact.evidence : [])
    .map((entry) => entry?.content ?? '')
    .filter(Boolean)
    .join('\n');
}

function goldEventKeys(gold) {
  return new Set(evidenceKeysOf(gold?.evidence));
}

function supportedByCitation(fact, gold) {
  if (!gold) return false;
  const keys = evidenceKeysOf(fact?.evidence);
  if (keys.length === 0) return false;
  const wanted = goldEventKeys(gold);
  if (keys.some((key) => wanted.has(key))) return true;
  const text = normalizeForMatch(citedText(fact));
  if (!text) return false;
  return aliasesOf(gold).some((alias) => {
    const normalizedAlias = normalizeForMatch(alias);
    return isMeaningfulAlias(normalizedAlias) && text.includes(normalizedAlias);
  });
}

/**
 * @param {object} input
 * @param {Array<object>} input.facts saved facts
 * @param {Array<object>} input.goldFacts annotated gold facts
 * @param {Array<object>} [input.negatives] messages that must not become facts
 * @param {object|null} [input.usage] provider usage & estimated cost
 * @returns {object} per-fact table + summary metrics
 */
export function evaluateMemoryQuality({facts = [], goldFacts = [], negatives = [], usage = null} = {}) {
  const cleanFacts = (facts ?? []).map((fact) => ({
    ...fact,
    viewerKey: String(fact.viewerKey ?? fact.viewer_id ?? fact.viewerId ?? ''),
    certainty: fact.certainty ?? 'uncertain',
    status: fact.status ?? 'unknown',
    evidence: Array.isArray(fact.evidence) ? fact.evidence : []
  }));
  const currentGold = (goldFacts ?? []).filter((gold) => (
    gold.status !== 'superseded' && gold.shouldPersist !== false
  ));
  const strictGold = currentGold.filter((gold) => gold.shouldPersist !== 'ambiguous' && gold.ambiguous !== true);
  const ambiguousGold = currentGold.filter((gold) => gold.shouldPersist === 'ambiguous' || gold.ambiguous === true);
  const negativeKeys = new Set();
  const negativeByViewer = new Map();
  for (const negative of negatives ?? []) {
    for (const key of evidenceKeysOf([negative])) {
      negativeKeys.add(key);
      const viewer = String(negative.viewerKey ?? '');
      if (!negativeByViewer.has(viewer)) negativeByViewer.set(viewer, new Set());
      negativeByViewer.get(viewer).add(key);
    }
  }

  const goldById = new Map((goldFacts ?? []).map((gold) => [String(gold.id), gold]));
  const goldMatches = new Map();
  const records = [];

  for (const fact of cleanFacts) {
    const candidates = [];
    for (const gold of currentGold) {
      if (String(gold.viewerKey) !== fact.viewerKey) continue;
      const scored = scoreFactAgainstGold(fact, gold);
      if (scored.score <= 0) continue;
      const supported = supportedByCitation(fact, gold);
      const evidenceBonus = supported ? 0.08 : 0;
      candidates.push({
        gold,
        score: Math.min(1, scored.score + evidenceBonus),
        baseScore: scored.score,
        aliasHit: scored.aliasHit,
        bestAlias: scored.bestAlias,
        supported
      });
    }
    candidates.sort((left, right) => right.score - left.score);
    // A statement like "the cat stepped on the keyboard" contains both the cat
    // and the keyboard topic. The cited chat line decides which one it is about:
    // prefer a candidate whose own evidence supports it when the scores are
    // close, instead of letting a generic word win by a few points.
    const topScore = candidates[0]?.score ?? 0;
    const supportedCandidate = candidates.find((candidate) => (
      candidate.supported && candidate.score >= topScore - 0.12
    ));
    const best = supportedCandidate ?? candidates[0] ?? null;
    const matched = best && best.score >= MATCH_THRESHOLDS.alias ? best : null;
    const ambiguousCandidate = !matched && best && best.score >= MATCH_THRESHOLDS.ambiguous ? best : null;
    const keys = evidenceKeysOf(fact.evidence);
    const ownNegative = negativeByViewer.get(fact.viewerKey) ?? new Set();
    const noSaveCitation = keys.some((key) => ownNegative.has(key) || negativeKeys.has(key));
    const crossViewerEvidence = (fact.evidence ?? []).some((entry) => (
      entry?.viewerKey && String(entry.viewerKey) !== fact.viewerKey
    ));
    const contentSupported = matched ? supportedByCitation(fact, matched.gold) : false;
    const stated = fact.certainty === 'stated';
    const ambiguousMatch = Boolean(
      matched
      && (matched.gold.ambiguous === true || matched.gold.shouldPersist === 'ambiguous')
    );
    let classification = 'review';
    if (noSaveCitation) classification = 'no_save_evidence';
    else if (crossViewerEvidence) classification = 'cross_viewer_evidence';
    else if (ambiguousMatch) classification = 'ambiguous';
    else if (!matched) classification = ambiguousCandidate ? 'ambiguous' : 'wrong_unsupported';
    else if (!contentSupported) classification = 'wrong_unsupported';
    else if (!stated) classification = 'review';
    else classification = 'correct';

    const record = {
      factId: fact.id ?? null,
      viewerKey: fact.viewerKey,
      kind: fact.kind ?? null,
      topic: fact.topic ?? null,
      statement: fact.statement ?? '',
      certainty: fact.certainty,
      status: fact.status,
      matchedGoldId: matched?.gold?.id ?? ambiguousCandidate?.gold?.id ?? null,
      matchScore: Number((matched?.score ?? ambiguousCandidate?.score ?? 0).toFixed(3)),
      matchAlias: matched?.bestAlias ?? ambiguousCandidate?.bestAlias ?? null,
      contentSupported,
      citedEventKeys: keys,
      crossViewerEvidence,
      noSaveCitation,
      ambiguous: Boolean(ambiguousCandidate) || matched?.gold?.ambiguous === true
        || matched?.gold?.shouldPersist === 'ambiguous',
      classification
    };
    records.push(record);

    if (matched && (classification === 'correct' || classification === 'review')) {
      const list = goldMatches.get(String(matched.gold.id)) ?? [];
      list.push({record, certain: classification === 'correct'});
      goldMatches.set(String(matched.gold.id), list);
    }
    if (ambiguousCandidate) {
      const list = goldMatches.get(String(ambiguousCandidate.gold.id)) ?? [];
      list.push({record, certain: false, ambiguous: true});
      goldMatches.set(String(ambiguousCandidate.gold.id), list);
    }
  }

  const matchedGoldIds = new Set();
  const strictRecallIds = new Set();
  for (const gold of strictGold) {
    const matches = goldMatches.get(String(gold.id)) ?? [];
    if (matches.length > 0) matchedGoldIds.add(String(gold.id));
    if (matches.some((entry) => entry.certain)) strictRecallIds.add(String(gold.id));
  }
  for (const gold of ambiguousGold) {
    if ((goldMatches.get(String(gold.id)) ?? []).length > 0) matchedGoldIds.add(String(gold.id));
  }

  const correct = records.filter((record) => record.classification === 'correct');
  const review = records.filter((record) => record.classification === 'review');
  const wrong = records.filter((record) => (
    record.classification === 'wrong_unsupported'
    || record.classification === 'no_save_evidence'
    || record.classification === 'cross_viewer_evidence'
  ));
  const ambiguousRecords = records.filter((record) => record.classification === 'ambiguous');
  const statedRecords = records.filter((record) => record.certainty === 'stated');
  const uncertain = records.filter((record) => record.certainty === 'uncertain');
  const inferred = records.filter((record) => record.certainty === 'inferred');

  const duplicateGroups = new Map();
  for (const record of records) {
    const key = `${record.viewerKey}|${normalizeForMatch(record.kind)}|${normalizeForMatch(record.topic)}`;
    const list = duplicateGroups.get(key) ?? [];
    list.push(record);
    duplicateGroups.set(key, list);
  }
  let duplicateExtras = 0;
  const duplicateExamples = [];
  for (const list of duplicateGroups.values()) {
    if (list.length < 2) continue;
    duplicateExtras += list.length - 1;
    duplicateExamples.push({
      viewerKey: list[0].viewerKey,
      kind: list[0].kind,
      topic: list[0].topic,
      count: list.length,
      factIds: list.map((entry) => entry.factId)
    });
  }

  const importantGold = strictGold.filter((gold) => gold.importance === 'high');
  const importantMatched = importantGold.filter((gold) => strictRecallIds.has(String(gold.id)));

  const savedTotal = records.length;
  const correctCount = correct.length;
  const statedWrong = statedRecords.filter((record) => record.classification !== 'correct');
  const accuracy = statedRecords.length > 0 ? correctCount / statedRecords.length : null;
  const recall = strictGold.length > 0 ? strictRecallIds.size / strictGold.length : null;
  const recallIncludingReview = strictGold.length > 0 ? matchedGoldIds.size / strictGold.length : null;
  const importantRecall = importantGold.length > 0 ? importantMatched.length / importantGold.length : null;
  const crossViewerRate = savedTotal > 0
    ? records.filter((record) => record.crossViewerEvidence).length / savedTotal
    : null;
  const duplicateRate = savedTotal > 0 ? duplicateExtras / savedTotal : null;
  const noSaveRate = savedTotal > 0
    ? records.filter((record) => record.noSaveCitation).length / savedTotal
    : null;

  const inputTokens = Number(usage?.inputTokens ?? 0);
  const outputTokens = Number(usage?.outputTokens ?? 0);
  const totalTokens = Number.isFinite(Number(usage?.totalTokens))
    ? Number(usage.totalTokens)
    : inputTokens + outputTokens;
  const cost = Number(usage?.cost?.amount ?? usage?.cost ?? NaN);
  const estimatedCost = Number.isFinite(cost) ? cost : null;
  const tokensPerCorrectFact = correctCount > 0 ? totalTokens / correctCount : null;
  const costPerCorrectFact = estimatedCost !== null && correctCount > 0
    ? estimatedCost / correctCount
    : null;

  return {
    summary: {
      gold: {
        total: strictGold.length,
        current: strictGold.length,
        important: importantGold.length,
        ambiguous: ambiguousGold.length,
        superseded: (goldFacts ?? []).filter((gold) => gold.status === 'superseded').length
      },
      saved: {
        total: savedTotal,
        stated: statedRecords.length,
        inferred: inferred.length,
        uncertain: uncertain.length,
        active: records.filter((record) => record.status === 'active').length,
        needsConfirmation: records.filter((record) => record.status === 'needs_confirmation').length
      },
      correct: correctCount,
      missed: strictGold.length - strictRecallIds.size,
      wrong: statedWrong.length,
      review: review.length,
      ambiguous: ambiguousRecords.length,
      duplicates: duplicateExtras,
      noSaveEvidence: records.filter((record) => record.noSaveCitation).length,
      crossViewerEvidence: records.filter((record) => record.crossViewerEvidence).length,
      accuracy,
      recall,
      recallIncludingReview,
      importantRecall,
      crossViewerRate,
      duplicateRate,
      noSaveRate,
      falsePositiveRate: savedTotal > 0 ? wrong.length / savedTotal : null,
      tokens: {
        requests: Number(usage?.requests ?? 0),
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost,
        tokensPerCorrectFact,
        costPerCorrectFact
      }
    },
    matches: records.filter((record) => record.classification === 'correct' || record.classification === 'review'),
    wrong: wrong.map((record) => ({
      ...record,
      gold: record.matchedGoldId ? goldById.get(record.matchedGoldId) ?? null : null
    })),
    ambiguous: ambiguousRecords,
    missed: strictGold.filter((gold) => !strictRecallIds.has(String(gold.id))),
    review,
    duplicates: {
      extras: duplicateExtras,
      groups: duplicateExamples
    },
    negatives: {
      total: (negatives ?? []).length,
      cited: records.filter((record) => record.noSaveCitation).length
    },
    perFact: records
  };
}

/** Convenience: render a deterministic markdown summary from an evaluation. */
export function renderQualityMarkdown(evaluation, {title = 'Memory quality evaluation'} = {}) {
  const s = evaluation?.summary ?? {};
  const pct = (value) => (value === null || value === undefined
    ? 'n/a'
    : `${(Number(value) * 100).toFixed(1)}%`);
  const num = (value) => (value === null || value === undefined ? 'n/a' : String(value));
  const lines = [
    `# ${title}`,
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 人工标注事实（严格） | ${num(s.gold?.total)} |`,
    `| 重要事实 | ${num(s.gold?.important)} |`,
    `| 歧义事实（单列） | ${num(s.gold?.ambiguous)} |`,
    `| 保存事实总数 | ${num(s.saved?.total)} |`,
    `| stated / inferred / uncertain | ${num(s.saved?.stated)} / ${num(s.saved?.inferred)} / ${num(s.saved?.uncertain)} |`,
    `| 正确提取（stated 且证据支持） | ${num(s.correct)} |`,
    `| 漏提 | ${num(s.missed)} |`,
    `| 错误事实 | ${num(s.wrong)} |`,
    `| 事实召回率 | ${pct(s.recall)} |`,
    `| 含待复核的召回率 | ${pct(s.recallIncludingReview)} |`,
    `| 重要事实召回率 | ${pct(s.importantRecall)} |`,
    `| 事实准确率（stated） | ${pct(s.accuracy)} |`,
    `| 跨观众证据错误率 | ${pct(s.crossViewerRate)} |`,
    `| 重复事实率 | ${pct(s.duplicateRate)} |`,
    `| 不应保存内容误收率 | ${pct(s.noSaveRate)} |`,
    `| 请求 / 输入 / 输出 / 总 Token | ${num(s.tokens?.requests)} / ${num(s.tokens?.inputTokens)} / ${num(s.tokens?.outputTokens)} / ${num(s.tokens?.totalTokens)} |`,
    `| 估算费用 | ${s.tokens?.estimatedCost === null ? 'n/a' : `$${Number(s.tokens.estimatedCost).toFixed(6)}`} |`,
    `| 每条正确事实 Token | ${s.tokens?.tokensPerCorrectFact === null ? 'n/a' : Math.round(Number(s.tokens.tokensPerCorrectFact))} |`,
    `| 每条正确事实费用 | ${s.tokens?.costPerCorrectFact === null ? 'n/a' : `$${Number(s.tokens.costPerCorrectFact).toFixed(6)}`} |`
  ];
  if ((evaluation?.ambiguous ?? []).length > 0) {
    lines.push('', '## 语义歧义（不自动计为正确）', '');
    for (const record of evaluation.ambiguous.slice(0, 40)) {
      lines.push(`- ${record.viewerKey} · ${record.topic ?? ''} · ${record.statement} · score ${record.matchScore}`);
    }
  }
  if ((evaluation?.wrong ?? []).length > 0) {
    lines.push('', '## 错误/无证据支持（人工复核表）', '');
    for (const record of evaluation.wrong.slice(0, 40)) {
      lines.push(`- ${record.viewerKey} · ${record.classification} · ${record.topic ?? ''} · ${record.statement}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
