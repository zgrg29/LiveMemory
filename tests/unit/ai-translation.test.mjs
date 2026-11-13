import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCachedTranslations,
  collectTranslatableItems,
  sanitizeTranslatedText,
  summarizeTranslation,
  translationRowKey,
  TRANSLATION_VERSION
} from '../../src/ai/translation/fields.mjs';

/**
 * Pure translation mapping tests: these must guarantee that translation is a
 * display-only transform. Identity, topic matching keys, certainty, evidence,
 * timestamps and counts are not even collected as translatable fields.
 */

function payloadFixture() {
  return {
    session: {id: 'ses_test'},
    result: {id: 'air_test', locale: 'ja'},
    primaryJob: {locale: 'ja'},
    report: {
      summary: '視聴者は新作ゲームの難易度について議論していた。',
      topics: [{
        title: 'ゲームの難易度',
        summary: '難しいという意見が多かった。',
        keyPoints: ['難しい', 'それは楽しい'],
        confidence: 0.8,
        evidence: 'observed',
        refs: [{seq: 1, eventId: 10, content: '原文の発言', available: true}]
      }],
      sentiment: [{at: 100, tone: 'mixed', note: '反応は分かれた。', confidence: 0.4, evidenceNote: '小声。'}],
      disputes: [{
        title: '難易度の賛否',
        summary: '意見が対立した。',
        note: '断定はできない。',
        viewpoints: ['難しい', 'ちょうどいい'],
        evidence: 'inferred',
        refs: [{seq: 2, eventId: 11, content: '別の発言', available: true}]
      }],
      highlights: [{
        title: '盛り上がった瞬間',
        reason: '同時にコメントが増えた。',
        clipSuggestion: 'この区間を確認',
        confidence: 0.6,
        evidence: 'observed',
        refs: []
      }],
      evidenceBudgetExceeded: false
    },
    viewerProfiles: {
      count: 1,
      items: [{
        viewerId: 'youtube:UC_1',
        summary: 'テストが好きな視聴者。',
        interests: [{topic: 'testing', note: 'チャットで話していた。'}]
      }]
    },
    longTermProfiles: {
      count: 1,
      items: [{
        memoryId: 'vm_1',
        viewerId: 'youtube:UC_1',
        version: 3,
        summary: 'ゲームとテストについて話す視聴者。',
        facts: [{
          id: 'mfc_1',
          kind: 'interest',
          topic: 'ゲーム',
          statement: '新作ゲームを楽しみにしている。',
          certainty: 'stated',
          status: 'active',
          confidence: 0.9
        }]
      }]
    },
    perBatch: []
  };
}

test('translation only collects natural-language display fields', () => {
  const items = collectTranslatableItems(payloadFixture());
  const paths = items.map((item) => `${item.kind}:${item.targetId}:${item.path}`);
  assert.ok(paths.includes('session_result:air_test:summary'));
  assert.ok(paths.includes('session_result:air_test:topics.0.title'));
  assert.ok(paths.includes('session_result:air_test:topics.0.key_points.1'));
  assert.ok(paths.includes('session_result:air_test:sentiment.0.note'));
  assert.ok(paths.includes('session_result:air_test:disputes.0.viewpoints.1'));
  assert.ok(paths.includes('session_result:air_test:highlights.0.clip_suggestion'));
  assert.ok(paths.includes('session_result:air_test:viewer_profiles.0.summary'));
  assert.ok(paths.includes('memory_summary:vm_1:summary'));
  assert.ok(paths.includes('memory_fact:mfc_1:statement'));
  // The long-term matching key is never translated.
  assert.equal(items.some((item) => item.path.endsWith('.topic')), false);
  assert.equal(items.some((item) => item.text.includes('"candidate"')), false);
  assert.ok(items.every((item) => item.hash.length === 64));
});

test('cached translation changes only display text and preserves identity, topic and evidence', () => {
  const payload = payloadFixture();
  const items = collectTranslatableItems(payload);
  const byPath = new Map(items.map((item) => [`${item.targetId}:${item.path}`, item]));
  const rows = [
    {
      targetKind: 'session_result',
      targetId: 'air_test',
      itemPath: 'summary',
      sourceHash: byPath.get('air_test:summary').hash,
      targetLocale: 'zh-CN',
      status: 'ok',
      translatedText: '观众讨论了新游戏的难度。'
    },
    {
      targetKind: 'memory_fact',
      targetId: 'mfc_1',
      itemPath: 'statement',
      sourceHash: byPath.get('mfc_1:statement').hash,
      targetLocale: 'zh-CN',
      status: 'ok',
      translatedText: '期待新游戏。'
    },
    {
      targetKind: 'memory_summary',
      targetId: 'vm_1',
      itemPath: 'summary',
      sourceHash: byPath.get('vm_1:summary').hash,
      targetLocale: 'zh-CN',
      status: 'ok',
      translatedText: '一位聊游戏和测试的观众。'
    }
  ];
  const applied = applyCachedTranslations(payload, items, rows);
  assert.equal(applied, 3);
  assert.equal(payload.report.summary, '观众讨论了新游戏的难度。');
  assert.equal(payload.longTermProfiles.items[0].facts[0].statement, '期待新游戏。');
  assert.equal(payload.longTermProfiles.items[0].summary, '一位聊游戏和测试的观众。');
  // Everything structural is untouched.
  assert.equal(payload.longTermProfiles.items[0].facts[0].id, 'mfc_1');
  assert.equal(payload.longTermProfiles.items[0].facts[0].topic, 'ゲーム');
  assert.equal(payload.longTermProfiles.items[0].facts[0].certainty, 'stated');
  assert.equal(payload.longTermProfiles.items[0].facts[0].status, 'active');
  assert.equal(payload.longTermProfiles.items[0].version, 3);
  assert.equal(payload.report.topics[0].confidence, 0.8);
  assert.equal(payload.report.topics[0].evidence, 'observed');
  assert.equal(payload.report.topics[0].refs[0].eventId, 10);
  assert.equal(payload.report.topics[0].refs[0].content, '原文の発言');
  assert.equal(payload.report.summary.length > 0, true);
});

test('a stale translation is not applied after its source text changes', () => {
  const payload = payloadFixture();
  const items = collectTranslatableItems(payload);
  const summary = items.find((item) => item.path === 'summary' && item.kind === 'session_result');
  const stale = [{
    targetKind: 'session_result',
    targetId: 'air_test',
    itemPath: 'summary',
    sourceHash: '0'.repeat(64),
    targetLocale: 'zh-CN',
    status: 'ok',
    translatedText: '旧的翻译。'
  }];
  assert.equal(applyCachedTranslations(payload, [summary], stale), 0);
  assert.equal(payload.report.summary, '視聴者は新作ゲームの難易度について議論していた。');
});

test('partial batch reports translate in place without touching the main report slot', () => {
  const payload = {
    session: {id: 'ses_partial'},
    result: null,
    primaryJob: {locale: 'ja'},
    report: null,
    perBatch: [{
      batchIndex: 2,
      result: {id: 'air_partial', locale: 'ja'},
      report: {
        summary: 'バッチ2の要約。',
        topics: [],
        sentiment: [],
        disputes: [],
        highlights: [],
        evidenceBudgetExceeded: false
      }
    }],
    viewerProfiles: null,
    longTermProfiles: {items: []}
  };
  const items = collectTranslatableItems(payload);
  const summary = items.find((item) => item.targetId === 'air_partial' && item.path === 'summary');
  assert.ok(summary, 'batch summary must be translatable');
  applyCachedTranslations(payload, [summary], [{
    targetKind: 'session_result',
    targetId: 'air_partial',
    itemPath: 'summary',
    sourceHash: summary.hash,
    targetLocale: 'zh-CN',
    status: 'ok',
    translatedText: '批次 2 的摘要。'
  }]);
  assert.equal(payload.perBatch[0].report.summary, '批次 2 的摘要。');
  assert.equal(payload.report, null);
});

test('translation status distinguishes original, missing, partial, complete and failed', () => {
  const payload = payloadFixture();
  const items = collectTranslatableItems(payload);
  const rowFor = (item, status, text) => ({
    targetKind: item.kind,
    targetId: item.targetId,
    itemPath: item.path,
    sourceHash: item.hash,
    targetLocale: 'zh-CN',
    status,
    translatedText: text ?? null
  });

  const original = summarizeTranslation(items, [], {
    targetLocale: 'ja',
    sourceLocale: 'ja'
  });
  assert.equal(original.status, 'original');
  assert.equal(original.translated, original.total);

  const missing = summarizeTranslation(items, [], {
    targetLocale: 'zh-CN',
    sourceLocale: 'ja'
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.missing, missing.total);

  const one = summarizeTranslation(items, [rowFor(items[0], 'ok', '翻译')], {
    targetLocale: 'zh-CN',
    sourceLocale: 'ja'
  });
  assert.equal(one.status, 'partial');
  assert.equal(one.translated, 1);

  const all = summarizeTranslation(items, items.map((item) => rowFor(item, 'ok', '翻译')), {
    targetLocale: 'zh-CN',
    sourceLocale: 'ja'
  });
  assert.equal(all.status, 'complete');
  assert.equal(all.translated, all.total);

  const failed = summarizeTranslation(items, items.map((item) => rowFor(item, 'failed')), {
    targetLocale: 'zh-CN',
    sourceLocale: 'ja'
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failed, failed.total);

  const running = summarizeTranslation(items, [rowFor(items[0], 'ok', '翻译')], {
    targetLocale: 'zh-CN',
    sourceLocale: 'ja',
    run: {status: 'running', totalItems: items.length}
  });
  assert.equal(running.status, 'running');
});

test('translated text is sanitised as untrusted plain text', () => {
  assert.equal(sanitizeTranslatedText('  hello\u0000\u0007 world \n'), 'hello world');
  // HTML is not stripped here; the renderer uses textContent. Storing it as a
  // literal string is safe and preserves the original claim's wording.
  assert.equal(sanitizeTranslatedText('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(sanitizeTranslatedText(null), '');
  assert.equal(sanitizeTranslatedText('   '), '');
  assert.equal(translationRowKey('memory_fact', 'mfc_1', 'statement', 'abc'), 'memory_fact\u0000mfc_1\u0000statement\u0000abc');
  assert.equal(TRANSLATION_VERSION, 'lm-translation-v1');
});
