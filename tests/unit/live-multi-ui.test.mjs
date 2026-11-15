import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * Structural guard for the tabbed live page and the Top 100 leaderboard.
 *
 * The actual behaviour is covered by the HTTP/manager integration tests. This
 * file catches regressions where the UI silently falls back to a single-stream
 * data source, re-introduces innerHTML, or loses the searchable, scrollable
 * leaderboard container.
 */

const liveSource = readFileSync(new URL('../../src/web/js/pages/live.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../src/web/js/app.js', import.meta.url), 'utf8');
const pagesCss = readFileSync(new URL('../../src/web/styles/pages.css', import.meta.url), 'utf8');

test('the live page reads the multi-recording API and keeps per-tab async tokens', () => {
  assert.match(liveSource, /\/api\/live\/recordings/);
  assert.match(liveSource, /\/api\/live\/recordings\/\$\{[^}]+\}\/stop/);
  assert.match(liveSource, /\/top-viewers\?limit=100/);
  assert.match(liveSource, /viewToken/);
  assert.match(liveSource, /selectedId/);
  assert.match(liveSource, /recording-tabs/);
  assert.match(liveSource, /leaderboard-scroll/);
  assert.match(liveSource, /live\.top\.search/);
  assert.match(liveSource, /broadcaster=/);
  assert.doesNotMatch(liveSource, /innerHTML/);
  // The old single-stream summary polling must not come back.
  assert.doesNotMatch(appSource, /livesummary/);
  assert.doesNotMatch(appSource, /refreshLive\(/);
});

test('tab and leaderboard styles exist for desktop and narrow layouts', () => {
  assert.match(pagesCss, /\.recording-tabs-bar/);
  assert.match(pagesCss, /overflow-x:\s*auto/);
  assert.match(pagesCss, /\.recording-tab-dot\[data-state="reconnecting"\]/);
  assert.match(pagesCss, /\.leaderboard-scroll\s*\{[^}]*max-height/s);
  assert.match(pagesCss, /\.top-item--interactive/);
  assert.match(pagesCss, /@media \(max-width: 700px\)[\s\S]*\.leaderboard-scroll/);
  // A live update must not throw the reader back to rank 1 while scrolling.
  assert.match(liveSource, /const scrollTop = host\.scrollTop/);
  assert.match(liveSource, /host\.scrollTop = resetScroll \? 0 : scrollTop/);
});
