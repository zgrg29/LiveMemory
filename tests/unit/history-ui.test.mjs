import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * Structural guard for history management and search.
 *
 * Behaviour is covered by integration tests; this file catches regressions that
 * would reintroduce two divergent implementations, load chat into the browser,
 * use innerHTML, or drop a required search/filter/action affordance.
 */

const historySource = readFileSync(new URL('../../src/web/js/pages/history.js', import.meta.url), 'utf8');
const actionsSource = readFileSync(new URL('../../src/web/js/session-actions.js', import.meta.url), 'utf8');
const menuSource = readFileSync(new URL('../../src/web/js/actions-menu.js', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('../../src/web/js/dialog.js', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../../src/web/js/pages/settings.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../src/web/js/api.js', import.meta.url), 'utf8');
const pagesCss = readFileSync(new URL('../../src/web/styles/pages.css', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../../src/server/routes.mjs', import.meta.url), 'utf8');
const searchSource = readFileSync(new URL('../../src/analytics/sessions/history-search.mjs', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('../../src/server/session-admin.mjs', import.meta.url), 'utf8');

function dictionary(locale) {
  return JSON.parse(readFileSync(new URL(`../../src/web/i18n/${locale}.json`, import.meta.url), 'utf8'));
}

test('both history surfaces share one management implementation', () => {
  assert.match(historySource, /from '\.\.\/session-actions\.js'/);
  assert.match(historySource, /openSessionMenu\(/);
  assert.match(historySource, /dataset: \{sessionId: row\.id\}/);
  assert.match(historySource, /history-actions/);
  // List and detail both call the same menu, and detail stops/deletes via it.
  assert.equal([...historySource.matchAll(/openSessionMenu\(/g)].length >= 2, true);
  assert.match(actionsSource, /\/api\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/stop/);
  assert.match(actionsSource, /\/archive`, \{archived\}/);
  assert.match(actionsSource, /api\.delete\(/);
  assert.match(actionsSource, /sessionMenuItems/);
  // Only executable actions are offered.
  assert.match(actionsSource, /if \(live\)/);
  assert.match(actionsSource, /session\.archived[\s\S]*unarchive/);
});

test('history search uses the server endpoint and never loads chat rows', () => {
  assert.match(historySource, /\/api\/history\/search\?/);
  assert.match(historySource, /set\('scope', state\.scope\)/);
  assert.match(historySource, /set\('platform', state\.platform\)/);
  assert.match(historySource, /set\('status', state\.status\)/);
  assert.match(historySource, /set\('from', String\(from\)\)/);
  assert.match(historySource, /set\('to', String\(to\)\)/);
  assert.match(historySource, /set\('includeArchived', '1'\)/);
  assert.match(historySource, /history\.search\.loadMore/);
  assert.match(historySource, /history\.search\.reason\.title/);
  assert.match(historySource, /history\.search\.reason\.broadcaster/);
  assert.match(historySource, /history\.search\.reason\.viewer/);
  assert.match(historySource, /history\.search\.identityHint/);
  // Search never touches the event endpoint: no chat body is loaded for search.
  assert.doesNotMatch(historySource, /\/api\/events/);
  assert.match(searchSource, /FROM sessions s/);
  // The only event access is an indexed per-session COUNT; no chat body is read.
  assert.match(searchSource, /FROM events e WHERE e\.session_id = s\.id/);
  assert.doesNotMatch(searchSource, /listEvents|\.content\b/);
});

test('delete requires an explicit confirmation with session facts', () => {
  assert.match(actionsSource, /history\.delete\.title/);
  assert.match(actionsSource, /history\.delete\.ackTitle/);
  assert.match(actionsSource, /history\.manage\.broadcaster/);
  assert.match(actionsSource, /history\.manage\.title/);
  assert.match(actionsSource, /history\.manage\.date/);
  assert.match(actionsSource, /api\.delete\(`\/api\/sessions\/\$\{encodeURIComponent\(session\.id\)\}`, \{confirm: true\}\)/);
  assert.match(actionsSource, /history\.delete\.deletesBody/);
  assert.match(actionsSource, /history\.delete\.keepsBody/);
  assert.match(actionsSource, /history\.stop\.noteTitle/);
});

test('the API client supports DELETE and no UI source uses innerHTML', () => {
  assert.match(apiSource, /delete: \(path, body = \{\}, options\)/);
  for (const source of [historySource, actionsSource, menuSource, dialogSource]) {
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
  }
  // The modal implementation is shared, not duplicated in settings.
  assert.match(settingsSource, /from '\.\.\/dialog\.js'/);
  assert.doesNotMatch(settingsSource, /function createModal\(/);
});

test('action menu, toolbar and viewer drill-down styles exist responsively', () => {
  assert.match(pagesCss, /\.action-menu\s*\{/);
  assert.match(pagesCss, /\.action-menu-item--danger/);
  assert.match(pagesCss, /\.history-toolbar/);
  assert.match(pagesCss, /\.history-filters/);
  assert.match(pagesCss, /\.filter-field/);
  assert.match(pagesCss, /@media \(max-width: 620px\)[\s\S]*\.history-filters/);
  assert.match(pagesCss, /\.history-row[\s\S]*grid-template-areas:\s*"title actions"/);
  assert.match(pagesCss, /\.history-viewer-messages/);
});

test('menu supports keyboard, outside click and viewport clamping', () => {
  assert.match(menuSource, /role: 'menu'/);
  assert.match(menuSource, /role: 'menuitem'/);
  assert.match(menuSource, /ArrowDown/);
  assert.match(menuSource, /ArrowUp/);
  assert.match(menuSource, /Home/);
  assert.match(menuSource, /End/);
  assert.match(menuSource, /Escape/);
  assert.match(menuSource, /pointerdown/);
  assert.match(menuSource, /window\.innerWidth/);
  assert.match(menuSource, /window\.innerHeight/);
  assert.match(menuSource, /restoreFocus/);
});

test('server exposes search, archive, delete and viewer drill-down routes', () => {
  assert.match(routesSource, /path: '\/api\/history\/search'/);
  assert.match(routesSource, /path: '\/api\/sessions\/:id\/archive'/);
  assert.match(routesSource, /method: 'DELETE',\s*\n\s*path: '\/api\/sessions\/:id'/);
  assert.match(routesSource, /path: '\/api\/sessions\/:id\/viewers\/:viewerId'/);
  assert.match(routesSource, /stopSessionRecording\(\{deps, sessionId: params\.sessionId\}\)/);
  assert.match(routesSource, /stopSessionRecording\(\{deps, sessionId: params\.id\}\)/);
  // Deletion is transactional and verifies that no session rows remain.
  assert.match(adminSource, /withTransaction\(db/);
  assert.match(adminSource, /assertNoResidue/);
  assert.match(adminSource, /rebuildViewerAggregates/);
  assert.match(adminSource, /rebuildViewerBroadcasterAggregates/);
  assert.match(adminSource, /safeExportPath/);
});

test('all three dictionaries describe the new search, archive and delete flows', () => {
  const keys = [
    'history.search.placeholder',
    'history.search.scope.viewer',
    'history.search.reason.title',
    'history.filters.includeArchived',
    'history.actions.stop',
    'history.actions.archive',
    'history.actions.unarchive',
    'history.actions.delete',
    'history.delete.ackTitle',
    'history.detail.archivedBody',
    'history.detail.viewerTitle',
    'status.stopped',
    'errors.sessionArchiveLive',
    'errors.sessionStillRecording',
    'errors.sessionDeleteIncomplete'
  ];
  for (const locale of ['en', 'zh-CN', 'ja']) {
    for (const key of keys) {
      const parts = key.split('.');
      let data = dictionary(locale);
      for (const part of parts) {
        assert.ok(data && typeof data === 'object' && part in data, `${locale} missing ${key}`);
        data = data[part];
      }
      assert.equal(typeof data, 'string', `${locale} ${key} must be a string`);
      assert.ok(data.trim().length > 0, `${locale} ${key} is empty`);
    }
  }
});
