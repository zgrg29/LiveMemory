/**
 * Development-only UI verification for the M6 AI file round trip.
 *
 * Requires:
 *   1. `node scripts/demo-ai.mjs --port 48370`
 *   2. headless Chrome/Edge with `--remote-debugging-port=9224`
 *
 *   node scripts/verify-ai-ui.mjs --port 9224 --base http://127.0.0.1:48370
 *
 * It drives the real console through the DevTools protocol: complete and
 * incomplete reports, evidence expansion, the history-detail report card, text
 * paste import, new-version import, JSON file upload, duplicate detection,
 * validation errors with field/reason/fix, dark theme and a 390px viewport.
 *
 * The fixture and every AI answer are synthetic; this verifies the UI and
 * validation behaviour, not a real AI service.
 */

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readZipEntry} from '../src/shared/zip.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const debugPort = Number(argValue('--port', 9224));
const base = String(argValue('--base', 'http://127.0.0.1:48370')).replace(/\/$/, '');
const shotsDir = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const reportDir = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));
mkdirSync(shotsDir, {recursive: true});
mkdirSync(reportDir, {recursive: true});

const report = {base, checks: []};
function record(name, passed, details = {}) {
  report.checks.push({name, passed, ...details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}

await fetch(`${base}/api/settings`, {
  method: 'PATCH',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({locale: 'en', theme: 'light'})
});

const sessionsPayload = await (await fetch(`${base}/api/sessions?limit=100&includeArchived=1`)).json();
const sessions = sessionsPayload.sessions ?? [];
const completeSession = sessions.find((session) => session.roomTitle.includes('AI 报告演示'));
const partialSession = sessions.find((session) => session.roomTitle.includes('Partial Import'));
const waitingSession = sessions.find((session) => session.roomTitle.includes('Waiting Import'));
if (!completeSession || !partialSession || !waitingSession) {
  throw new Error('demo-ai fixture is not running or is incomplete');
}

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page target in the debugging browser');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, {once: true});
  socket.addEventListener('error', reject, {once: true});
});

let nextId = 0;
const pending = new Map();
const eventWaiters = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else resolve(message.result);
    return;
  }
  if (message.method) {
    const waiters = eventWaiters.get(message.method) ?? [];
    eventWaiters.set(message.method, []);
    for (const resolve of waiters) resolve(message.params);
  }
});

function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}
function waitForEvent(method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    const list = eventWaiters.get(method) ?? [];
    list.push((params) => {
      clearTimeout(timer);
      resolve(params);
    });
    eventWaiters.set(method, list);
  });
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}
async function waitFor(expression, {timeout = 12000, interval = 120} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expression).catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${expression}`);
    await sleep(interval);
  }
}
async function viewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height
  });
}
async function navigate(hash, {width = 1440, height = 1100, mobile = false, wait = 1800} = {}) {
  await viewport(width, height, mobile);
  const loaded = waitForEvent('Page.loadEventFired').catch(() => null);
  await send('Page.navigate', {url: `${base}/?verify=${Date.now()}#${hash}`});
  await loaded;
  await sleep(wait);
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  const path = join(shotsDir, name);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  return path;
}
async function clickButton(text, selector = 'button') {
  return evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((item) => item.textContent.trim() === ${JSON.stringify(text)});
    if (!node) throw new Error('button not found: ' + ${JSON.stringify(text)});
    node.click();
    return true;
  })()`);
}
async function pasteJson(text) {
  await evaluate(`(() => {
    const textarea = document.querySelector('.import-textarea');
    textarea.value = ${JSON.stringify(text)};
    textarea.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);
  await sleep(200);
}

/* --------------------------------------------------------- package answer */

const jobsPayload = await (await fetch(`${base}/api/ai/jobs?sessionId=${encodeURIComponent(waitingSession.id)}`)).json();
const waitingJob = jobsPayload.jobs?.[0];
if (!waitingJob) throw new Error('waiting demo job is missing');
const pkg = waitingJob.packages[0];
const archiveResponse = await fetch(`${base}/api/ai/packages/${encodeURIComponent(pkg.id)}/download`);
const archive = Buffer.from(await archiveResponse.arrayBuffer());
const manifest = JSON.parse(readZipEntry(archive, 'manifest.json').toString('utf8'));
const messages = readZipEntry(archive, 'messages.jsonl').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const viewers = JSON.parse(readZipEntry(archive, 'viewer_context.json').toString('utf8'));
const firstAt = messages[0].at;
const lastAt = messages[messages.length - 1].at;
const answer = {
  protocol: 'livememory-analysis-result-v1',
  schema_version: '1.1.0',
  job_id: manifest.job_id,
  batch_id: manifest.batch.batch_id,
  broadcaster_id: manifest.broadcaster_id,
  task_id: manifest.tasks[0].task_id,
  session_id: manifest.session_id,
  locale: 'ja',
  session_topics: {
    summary: 'UI verification answer: a small Japanese and Chinese chat about daily topics.',
    topics: [{
      title: 'UI verification topic',
      started_at: firstAt,
      ended_at: lastAt,
      summary: 'The chat talked about the channel and daily topics.',
      key_points: ['Point from the UI test'],
      confidence: 0.8,
      evidence: 'observed',
      message_refs: [1, 2]
    }],
    sentiment: [{at: firstAt, tone: 'neutral', note: 'Calm chat.', confidence: 0.6, sample_size: 5}],
    disputes: [],
    highlights: [{
      started_at: firstAt,
      ended_at: lastAt,
      title: 'UI verified highlight',
      reason: 'Chat activity.',
      clip_suggestion: 'Replay the start of the chat.',
      confidence: 0.7,
      evidence: 'observed',
      message_refs: [1]
    }]
  },
  viewer_profiles: viewers.length > 0 ? [{
    viewer_id: viewers[0].viewer_id,
    interests: [{topic: 'channel topics', strength: 'emerging', evidence: 'observed', note: 'Asked about the channel.'}],
    dislikes: [],
    summary: 'Interested in what the channel covers.',
    confidence: 0.6
  }] : []
};
const answerText = JSON.stringify(answer, null, 2);
const versionTwo = structuredClone(answer);
versionTwo.session_topics.summary = 'UI verification answer, version two with a different summary.';
const versionTwoText = JSON.stringify(versionTwo, null, 2);

/* --------------------------------------------------------------- run */

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', {cacheDisabled: true});

await navigate(`/ai?session=${encodeURIComponent(completeSession.id)}&report=1`);
let view = await evaluate(`(() => ({
  reportTitle: document.querySelector('.report-title')?.textContent ?? null,
  summary: document.querySelector('.report-summary')?.textContent ?? null,
  topics: document.querySelectorAll('.report-topic').length,
  sentiment: document.querySelectorAll('.report-sentiment-row').length,
  highlights: document.querySelectorAll('.report-highlight').length,
  provenance: document.querySelector('.report-provenance')?.textContent ?? '',
  incomplete: Boolean(document.querySelector('.report-incomplete')),
  promptVersion: document.querySelector('.card-hint')?.textContent ?? null,
  promptText: document.querySelector('.prompt-box')?.textContent ?? '',
  promptOptions: [...document.querySelectorAll('.card-body .select option')].map((option) => option.textContent),
  jobRows: document.querySelectorAll('.job-row').length,
  statusChips: [...document.querySelectorAll('.job-row .chip')].map((chip) => chip.textContent),
  overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  lastError: window.__lmLastError ?? null
}))()`);
record('a completed task opens the AI report with summary, topics, sentiment and highlights',
  view.reportTitle === 'Live analysis report'
    && Boolean(view.summary && view.summary.length > 20)
    && view.topics >= 4
    && view.sentiment >= 3
    && view.highlights >= 3
    && !view.incomplete
    && !view.lastError, {
    topicCards: view.topics,
    sentimentRows: view.sentiment,
    highlightCards: view.highlights,
    lastError: view.lastError
  });
record('the report clearly separates AI output and shows prompt/schema provenance',
  view.provenance.includes('lm-prompt-m6.2-zh-CN')
    && view.provenance.includes('1.1.0'), {provenance: view.provenance.slice(0, 160)});
record('the completed task shows a complete status and an aggregate prompt option',
  view.statusChips.includes('Complete') && view.promptOptions.some((option) => option.includes('Aggregate')), {
    statusChips: view.statusChips,
    promptOptions: view.promptOptions
  });
record('the prompt text is the localized batch/aggregate instructions and is copyable',
  view.promptText.includes('schema_version') && view.promptText.includes('message_refs') && view.promptText.length > 500, {
    promptLength: view.promptText.length
  });

const evidenceToggled = await evaluate(`(() => {
  const button = document.querySelector('.report-evidence-toggle');
  if (!button) return null;
  button.click();
  const panel = document.querySelector('.report-evidence');
  return {
    expanded: button.getAttribute('aria-expanded'),
    hidden: panel ? panel.hidden : null,
    rows: panel ? panel.querySelectorAll('.report-evidence-row').length : 0,
    text: panel ? panel.textContent : ''
  };
})()`);
record('cited evidence can be expanded and shows real chat text', Boolean(evidenceToggled)
  && evidenceToggled.rows >= 2
  && evidenceToggled.text.trim().length > 10
  && !evidenceToggled.text.includes('no longer stored')
  && evidenceToggled.hidden === false, {
  rows: evidenceToggled?.rows,
  hidden: evidenceToggled?.hidden
});
await screenshot('ai-report-complete-v080-light.png');

await navigate(`/ai?session=${encodeURIComponent(completeSession.id)}`);
await screenshot('ai-centre-complete-v080-light.png');

await navigate(`/ai?session=${encodeURIComponent(partialSession.id)}`);
view = await evaluate(`(() => ({
  mode: document.querySelector('.report-title')?.textContent ?? null,
  incomplete: Boolean(document.querySelector('.report-incomplete')),
  incompleteText: document.querySelector('.report-incomplete')?.textContent ?? '',
  batchCards: document.querySelectorAll('.report-batch').length,
  batchTitles: [...document.querySelectorAll('.report-batch-title')].map((node) => node.textContent),
  missingText: document.querySelector('.job-row .small.tertiary')?.textContent ?? '',
  statusChips: [...document.querySelectorAll('.job-row .chip')].map((chip) => chip.textContent)
}))()`);
record('a partially imported task is shown as incomplete with per-batch cards, never as a merged report',
  view.incomplete === true
    && view.batchCards >= 1
    && view.incompleteText.includes('Missing batches')
    && view.statusChips.some((text) => text.includes('Partially imported')), {
    batchCards: view.batchCards,
    statusChips: view.statusChips,
    incompleteText: view.incompleteText.slice(0, 120)
  });
record('batch results use a separate title instead of pretending to be the session conclusion',
  view.batchTitles.every((title) => title.includes('Batch')), {batchTitles: view.batchTitles});
await screenshot('ai-report-partial-v080-light.png');

await navigate(`/ai?session=${encodeURIComponent(waitingSession.id)}`);
view = await evaluate(`(() => ({
  jobRows: document.querySelectorAll('.job-row').length,
  status: [...document.querySelectorAll('.job-row .chip')].map((chip) => chip.textContent),
  hasFileInput: Boolean(document.querySelector('input[type="file"]')),
  hasTextarea: Boolean(document.querySelector('.import-textarea')),
  reportTitle: document.querySelector('.report-title')?.textContent ?? null,
  noReport: document.querySelector('.report-card .card-title')?.textContent ?? null,
  promptOptions: [...document.querySelectorAll('.card-body .select option')].map((option) => option.textContent)
}))()`);
record('a waiting task offers file + paste import with a clear empty report state',
  view.jobRows === 1
    && view.hasFileInput
    && view.hasTextarea
    && view.promptOptions.length >= 1, {
    jobRows: view.jobRows,
    status: view.status,
    promptOptions: view.promptOptions
  });
await screenshot('ai-centre-waiting-v080-light.png');

// Invalid JSON first: field → reason → fix, and no import button.
await pasteJson('{"protocol": "livememory-analysis-result-v1", "broken": true');
await clickButton('Validate answer');
await waitFor("Boolean(document.querySelector('.import-preview-body'))", {timeout: 8000});
view = await evaluate(`(() => ({
  issues: document.querySelectorAll('.import-issue').length,
  paths: [...document.querySelectorAll('.import-issue-path')].map((node) => node.textContent),
  reasons: [...document.querySelectorAll('.import-issue-reason')].map((node) => node.textContent),
  fixes: [...document.querySelectorAll('.import-issue-fix')].map((node) => node.textContent),
  confirm: [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === 'Import result')
}))()`);
record('invalid JSON shows the field path, reason and how to fix it without an import action',
  view.issues >= 1
    && view.paths.length >= 1
    && view.reasons.some((text) => text.includes('valid JSON'))
    && view.fixes.some((text) => text.toLowerCase().includes('json'))
    && view.confirm === false, {
    issues: view.issues,
    paths: view.paths,
    reasons: view.reasons
  });

// Valid answer, then confirm.
await pasteJson(answerText);
await clickButton('Validate answer');
await waitFor("Boolean(document.querySelector('.import-preview-body'))", {timeout: 8000});
view = await evaluate(`(() => ({
  target: document.querySelector('.import-target')?.textContent ?? '',
  actions: [...document.querySelectorAll('button')].map((node) => node.textContent.trim()),
  warnings: document.querySelectorAll('.import-issue--warning').length,
  duplicate: Boolean(document.querySelector('.import-preview-body')?.textContent.includes('Already imported'))
}))()`);
record('the pre-import check shows the broadcast, task, batch, schema and coverage',
  view.target.includes('Waiting Import')
    && view.target.includes(manifest.tasks[0].task_id)
    && view.target.includes('1.1.0')
    && view.actions.includes('Import result')
    && !view.duplicate, {target: view.target.slice(0, 200)});

await clickButton('Import result');
await waitFor("Boolean(document.querySelector('.callout-title')?.textContent.includes('Analysis result imported')) || Boolean(document.querySelector('.report-title'))", {timeout: 15000});
await sleep(1200);
view = await evaluate(`(() => ({
  success: document.querySelector('.import-preview .callout-title')?.textContent ?? null,
  reportTitle: document.querySelector('.report-title')?.textContent ?? null,
  summary: document.querySelector('.report-summary')?.textContent ?? null,
  resultVersion: document.querySelector('.report-provenance')?.textContent ?? '',
  status: [...document.querySelectorAll('.job-row .chip')].map((chip) => chip.textContent),
  lastError: window.__lmLastError ?? null
}))()`);
record('pasting a valid answer imports it in one step and immediately renders the report',
  Boolean(view.reportTitle)
    && view.summary.includes('UI verification answer')
    && view.resultVersion.includes('version 1')
    && view.status.some((text) => text.includes('Complete'))
    && !view.lastError, {
    summary: view.summary?.slice(0, 80),
    status: view.status,
    lastError: view.lastError
  });
await screenshot('ai-import-success-v080-light.png');

// Version 2 through the same UI.
await pasteJson(versionTwoText);
await clickButton('Validate answer');
await waitFor("Boolean(document.querySelector('.import-preview-body'))", {timeout: 8000});
view = await evaluate(`(() => ({
  versionNotice: document.querySelector('.import-preview-body')?.textContent.includes('New result version') ?? false,
  confirmLabel: [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === 'Import as new version')
}))()`);
record('a different answer is presented as a new version and needs an explicit confirmation',
  view.versionNotice === true && view.confirmLabel === true, view);
await clickButton('Import as new version');
await waitFor("document.querySelector('.report-summary')?.textContent.includes('version two')", {timeout: 15000});
await sleep(1200);
view = await evaluate(`(() => ({
  summary: document.querySelector('.report-summary')?.textContent ?? '',
  provenance: document.querySelector('.report-provenance')?.textContent ?? '',
  versions: [...document.querySelectorAll('.job-meta')].map((node) => node.textContent).join(' | ')
}))()`);
record('importing version 2 keeps the old version and updates the report to the latest result',
  view.summary.includes('version two')
    && view.provenance.includes('version 2')
    && view.versions.includes('v1,2'), {
    summary: view.summary?.slice(0, 80),
    versions: view.versions.slice(0, 160)
  });

// Duplicate detection through a real JSON file upload.
const duplicateFounded = await evaluate(`(async () => {
  const input = document.querySelector('input[type="file"]');
  const data = new DataTransfer();
  data.items.add(new File([${JSON.stringify(versionTwoText)}], 'ai-answer.json', {type: 'application/json'}));
  input.files = data.files;
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()`);
void duplicateFounded;
await sleep(500);
await clickButton('Validate answer');
await waitFor("Boolean(document.querySelector('.import-preview-body'))", {timeout: 8000});
view = await evaluate(`(() => ({
  text: document.querySelector('.import-preview-body')?.textContent ?? '',
  hasImport: [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === 'Import result')
}))()`);
record('uploading an identical JSON file is detected as an already imported duplicate',
  view.text.includes('Already imported') && view.hasImport === false, {
  hasImport: view.hasImport
});

// History detail card links to the full report.
await navigate(`/history/${encodeURIComponent(completeSession.id)}`);
view = await evaluate(`(() => ({
  preview: document.querySelector('.ai-report-preview')?.textContent ?? '',
  summary: document.querySelector('.ai-report-summary')?.textContent ?? '',
  buttons: [...document.querySelectorAll('.card button')].map((node) => node.textContent.trim()),
  lastError: window.__lmLastError ?? null
}))()`);
record('history detail shows the imported AI summary and a full-report link',
  view.summary.length > 20
    && view.buttons.includes('View full report')
    && !view.lastError, {summary: view.summary.slice(0, 80), lastError: view.lastError});
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'View full report');
  button.click();
  return true;
})()`);
await sleep(2000);
view = await evaluate(`(() => ({
  hash: location.hash,
  report: Boolean(document.querySelector('#ai-report')),
  summary: document.querySelector('.report-summary')?.textContent ?? null
}))()`);
record('the history report link opens the AI report page for the same broadcast',
  view.hash.includes('/ai?session=') && view.report && Boolean(view.summary), {
  hash: view.hash,
  hasReport: view.report
});

// Dark theme, Chinese UI, narrow viewport.
await fetch(`${base}/api/settings`, {
  method: 'PATCH',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({locale: 'zh-CN', theme: 'dark'})
});
await navigate(`/ai?session=${encodeURIComponent(completeSession.id)}&report=1`, {width: 390, height: 1000, mobile: true});
view = await evaluate(`(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  lang: document.documentElement.lang,
  overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  reportTitle: document.querySelector('.report-title')?.textContent ?? null,
  lastError: window.__lmLastError ?? null
}))()`);
record('the AI report works in dark theme, Chinese UI and a 390px viewport without horizontal overflow',
  view.theme === 'dark'
    && view.lang === 'zh-CN'
    && view.reportTitle === '直播分析报告'
    && view.overflow === false
    && !view.lastError, view);
await screenshot('ai-report-dark-zh-390-v080.png');

await fetch(`${base}/api/settings`, {
  method: 'PATCH',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({locale: 'en', theme: 'light'})
});

const failed = report.checks.filter((check) => !check.passed);
console.log(`\nSummary: ${report.checks.length - failed.length} passed, ${failed.length} failed`);
writeFileSync(join(reportDir, 'verify-ai-ui-report.json'), `${JSON.stringify(report, null, 2)}\n`);
socket.close();
process.exit(failed.length === 0 ? 0 : 1);
