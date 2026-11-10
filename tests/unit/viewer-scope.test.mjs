import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  SCOPE_ALL,
  SCOPE_UNASSIGNED,
  resolveDetailScope,
  scopeOptions
} from '../../src/web/js/pages/viewer-scope.js';

const t = (key) => key;
const broadcasters = [
  {id: 'bilibili:1', platform: 'bilibili', platformUid: '1', displayName: 'Channel 1'},
  {id: 'bilibili:2', platform: 'bilibili', platformUid: '2', displayName: 'Channel 2'},
  {id: 'youtube:UC_3', platform: 'youtube', platformUid: 'UC_3', displayName: 'Channel 3'}
];

test('viewer detail options only contain the viewers actually related broadcasters', () => {
  const profile = {broadcasters: [broadcasters[0], broadcasters[2]]};
  const options = scopeOptions({broadcasters}, t, {profile, includeAll: false});
  assert.deepEqual(options.map((option) => option.value), ['bilibili:1', 'youtube:UC_3']);
  assert.equal(options.some((option) => option.value === SCOPE_ALL), false);
  assert.equal(options.some((option) => option.value === 'bilibili:2'), false);
});

test('the list scope still includes all and unassigned when requested', () => {
  const payload = {
    broadcasters,
    currentId: 'bilibili:2',
    unassigned: {sessionCount: 2}
  };
  const options = scopeOptions(payload, t, {includeAll: true});
  assert.equal(options[0].value, SCOPE_ALL);
  assert.deepEqual(
    options.map((option) => option.value),
    [SCOPE_ALL, 'bilibili:1', 'bilibili:2', 'youtube:UC_3', SCOPE_UNASSIGNED]
  );
});

test('detail scope resolves only a related broadcaster and safely falls back', () => {
  const profile = {broadcasters: [broadcasters[0], broadcasters[1]]};
  assert.equal(resolveDetailScope(profile, 'bilibili:2'), 'bilibili:2');
  assert.equal(resolveDetailScope(profile, 'youtube:UC_3'), 'bilibili:1');
  assert.equal(resolveDetailScope(profile, 'removed-channel'), 'bilibili:1');
  assert.equal(resolveDetailScope(profile, null, {currentId: 'bilibili:2'}), 'bilibili:2');
  assert.equal(resolveDetailScope(profile, null, {currentId: 'unrelated'}), 'bilibili:1');
  assert.equal(resolveDetailScope({broadcasters: []}, 'bilibili:1'), null);
});

test('the detail page uses related broadcasters, hides a one-option select and has an empty state', () => {
  const source = readFileSync(new URL('../../src/web/js/pages/viewers.js', import.meta.url), 'utf8');
  assert.match(source, /related = baseProfile\.broadcasters/);
  assert.match(source, /resolveDetailScope/);
  assert.match(source, /profile: baseProfile/);
  assert.match(source, /includeAll: false/);
  assert.match(source, /related\.length === 1/);
  assert.match(source, /scope-static/);
  assert.match(source, /viewers\.scope\.noRelatedTitle/);
});

