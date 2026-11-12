import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRepairMessages} from '../../src/ai/api/prompts.mjs';

const prompt = {
  locale: 'en',
  estimatedTokens: 30000,
  messages: [
    {role: 'system', content: 'system'},
    {role: 'user', content: 'batch'}
  ]
};

test('a repair request keeps the batch prompt but truncates the previous answer', () => {
  const repair = buildRepairMessages({
    prompt,
    previousText: 'x'.repeat(50000),
    errors: [{path: 'viewers[0]', code: 'MEMORY_REQUIRED'}],
    locale: 'en',
    maxInputTokens: 34000
  });
  assert.equal(repair.truncated, true);
  assert.ok(repair.previousChars <= 12000);
  assert.ok(repair.estimatedInputTokens <= 34000 + 50);
  assert.equal(repair.messages.length, prompt.messages.length + 2);
  assert.equal(repair.messages[0].content, 'system', 'batch prompt is never dropped');
});

test('without a limit the repair keeps the historical 12k character window', () => {
  const repair = buildRepairMessages({
    prompt,
    previousText: 'y'.repeat(50000),
    errors: [],
    locale: 'en'
  });
  assert.equal(repair.truncated, true);
  assert.equal(repair.previousChars, 12000);
});
