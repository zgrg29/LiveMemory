import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseInitialSessionId} from '../../src/web/js/pages/ai-selection.js';

const sessions = [
  {id: 'ses_older', roomTitle: 'Same title'},
  {id: 'ses_newer', roomTitle: 'Same title'}
];

test('the requested stable session id wins over the first list row', () => {
  assert.equal(chooseInitialSessionId(sessions, 'ses_older'), 'ses_older');
  assert.equal(chooseInitialSessionId(sessions, 'ses_newer'), 'ses_newer');
});

test('an unknown or deleted session falls back to the first available row', () => {
  assert.equal(chooseInitialSessionId(sessions, 'ses_deleted'), 'ses_older');
  assert.equal(chooseInitialSessionId(sessions, null), 'ses_older');
  assert.equal(chooseInitialSessionId([], 'ses_deleted'), null);
});
