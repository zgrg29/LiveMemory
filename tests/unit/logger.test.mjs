import test from 'node:test';
import assert from 'node:assert/strict';
import {redactValue} from '../../src/server/logger.mjs';

test('secret keys are replaced whatever their nesting', () => {
  const redacted = redactValue({
    SESSDATA: 'abc',
    nested: {cookie: 'SESSDATA=abc', apiKey: 'k', list: [{token: 't'}]},
    safe: 'visible'
  });
  assert.equal(redacted.SESSDATA, '[redacted]');
  assert.equal(redacted.nested.cookie, '[redacted]');
  assert.equal(redacted.nested.apiKey, '[redacted]');
  assert.equal(redacted.nested.list[0].token, '[redacted]');
  assert.equal(redacted.safe, 'visible');
});

test('credential-looking values inside free text are redacted in place', () => {
  const input = 'Cookie: SESSDATA=abc123; bili_jct=def456; DedeUserID=789';
  const output = redactValue(input);
  assert.equal(output.includes('abc123'), false);
  assert.equal(output.includes('def456'), false);
  assert.equal(output.includes('789'), false);
  assert.match(output, /SESSDATA=\[redacted\]/);
  assert.match(output, /bili_jct=\[redacted\]/);
});

test('a JSON fragment with a token is redacted', () => {
  const output = redactValue('body {"token":"supersecret","other":"keep"}');
  assert.equal(output.includes('supersecret'), false);
  assert.match(output, /\[redacted\]/);
  assert.match(output, /"other":"keep"/);
});

test('redaction does not corrupt unrelated text', () => {
  assert.equal(redactValue('plain message 123'), 'plain message 123');
  assert.equal(redactValue(''), '');
});
