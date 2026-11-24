/** Packaged report translation regression. Local synthetic provider only. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync, readFileSync, existsSync, openSync, closeSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster, seedSession, parsePromptMemoryRefs, makeBatchResult} from '../tests/helpers/ai-fixtures.mjs';
import {createSessionAnalysisJob} from '../src/ai/export/split-jobs.mjs';
import {importAnalysisResult} from '../src/ai/import/importer.mjs';
import {readZipEntry} from '../src/shared/zip.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';
import {WindowsCredentialStore} from '../src/platforms/shared/credential-store.mjs';
const baseline = process.argv.includes('--baseline');
const root = resolve('tests/.tmp', `translation-exe-${Date.now()}`);
mkdirSync(root, {recursive: true});
const exe = prepareTestExe({source: resolve('dist/LiveMemory.exe'), target: join(root, 'LiveMemory-test.exe')});
const dataDir = join(root, 'data');
let mode = 'fail', calls = 0, child, store, reference;
let truncatedInputSize = null, recoveredSource = null, resumedInputSize = null;
const mock = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  calls++;
  if (mode === 'fail') { res.writeHead(401, {'content-type': 'application/json'}); res.end('{"error":{"message":"synthetic authentication failure"}}'); return; }
  const body = JSON.parse(text);
  const user = body.messages.at(-1).content;
  if (!user.includes('Input JSON:')) {
    const refs = parsePromptMemoryRefs(body.messages.map((m) => m.content).join('\n'));
    assert.ok(refs.size, 'only memory recovery, never session reanalysis');
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: JSON.stringify({viewers: [...refs.values()].map((r) => ({ref: r.ref, memory: {no_new_information: true, operations: []}}))})}, finish_reason: 'stop'}], usage: {prompt_tokens: 15, completion_tokens: 6}})); return;
  }
  const input = JSON.parse(/Input JSON:\n\n([\s\S]*?)\n\nReturn only/.exec(user)[1]);
  assert.ok(body.max_tokens > 1200, 'translation budget must include JSON overhead');
  if (mode === 'truncate') {
    truncatedInputSize = input.items.length; recoveredSource = input.items[0].text;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: '{"items":[' + JSON.stringify({id: input.items[0].id, text: '已恢复译文'}) + ',{"id":"t2","text":"未完成'}, finish_reason: 'length'}], usage: {prompt_tokens: 12, completion_tokens: 8}})); return;
  }
  if (recoveredSource) {assert.ok(input.items.every((item) => item.text !== recoveredSource)); resumedInputSize = input.items.length;}
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify({choices: [{message: {content: JSON.stringify({items: input.items.map((item) => ({id: item.id, text: `译文 ${item.text}`}))})}, finish_reason: 'stop'}], usage: {prompt_tokens: 12, completion_tokens: 8}}));
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn) { const end = Date.now() + 60000; while (Date.now() < end) { const r = await fn(); if (r) return r; await pause(100); } throw new Error('Timed out'); }
const output = [];
function record(name, details) { output.push({name, details}); console.log(`PASS ${name}: ${JSON.stringify(details)}`); }
try {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const seed = await startServer({auth: false, dataDir, port: 0, useWindowsCredentialManager: true});
  let session, config, resultBefore, jobId;
  try {
    addBroadcaster(seed.db);
    session = seedSession(seed.db, {messageCount: 3, viewerCount: 1});
    const created = await createSessionAnalysisJob({db: seed.db, sessionId: session.id, locale: 'ja', exportsDir: seed.paths.exports});
    jobId = created.job.id;
    const archive = readFileSync(join(seed.paths.exports, created.packages[0].fileName));
    const files = {manifest: JSON.parse(readZipEntry(archive, 'manifest.json').toString()),
      messages: readZipEntry(archive, 'messages.jsonl').toString().split('\n').filter(Boolean).map(JSON.parse), viewers: []};
    const result = makeBatchResult(files.manifest, files.messages, files.viewers);
    result.schema_version = '1.3.0'; result.analysis_scope = 'session';
    result.session_topics.summary = '視聴者は新作ゲームについて話した。';
    importAnalysisResult({db: seed.db, text: JSON.stringify(result), source: 'api'});
    resultBefore = seed.db.prepare('SELECT result_json FROM ai_results LIMIT 1').get().result_json;
    config = seed.providerConfigStore.create({providerId: 'custom', regionId: 'custom', baseUrl: `http://127.0.0.1:${mockPort}/v1`, modelId: 'synthetic-translator', apiKey: 'synthetic-test-key', allowLocalNetwork: true});
    seed.providerConfigStore.recordTest(config.id, {status: 'passed', capabilities: {session: true, memory: true}});
    reference = seed.providerConfigStore.get(config.id).credentialReference;
    seed.analysisRunner.state.set(session.id, {status: 'partial', stage: 'session_done', mode: 'combined', locale: 'ja', sessionJobId: jobId, configId: config.id, providerId: config.providerId, modelId: config.modelId, sessionReportDone: true, error: {code: 'ANALYSIS_MEMORY_OUT_OF_ORDER', recoverable: false}});
  } finally { await seed.close(); }
  const bootstrap = join(root, 'bootstrap.url');
  const appData = join(root, 'local-appdata'), tempDir = join(root, 'temp');
  mkdirSync(appData, {recursive: true}); mkdirSync(tempDir, {recursive: true});
  const stdout = openSync(join(root, 'stdout.log'), 'a'), stderr = openSync(join(root, 'stderr.log'), 'a');
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const appPort = probe.address().port; await new Promise((r) => probe.close(r));
  child = spawn(exe, ['--no-open', '--no-wait', '--port', String(appPort), '--data-dir', dataDir, '--lang', 'en'], {windowsHide: true, cwd: root, env: {...process.env, LOCALAPPDATA: appData, TEMP: tempDir, TMP: tempDir, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrap}, stdio: ['ignore', stdout, stderr]});
  closeSync(stdout); closeSync(stderr);
  child.on('error', (e) => console.error(e.code));
  const url = await wait(() => existsSync(bootstrap) && readFileSync(bootstrap, 'utf8').trim());
  const origin = new URL(url).origin;
  const token = decodeURIComponent(new URL(url).hash.replace(/^#lm_bootstrap=/, ''));
  const auth = await fetch(`${origin}/api/auth/session`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token})});
  assert.equal(auth.status, 200); const cookie = auth.headers.get('set-cookie').split(';')[0];
  async function json(path, body) { const r = await fetch(`${origin}${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body && JSON.stringify(body)}); const payload = await r.json(); assert.ok(r.ok, JSON.stringify(payload)); return payload; }
  const reportPath = `/api/ai/sessions/${session.id}/report?locale=zh-CN`;
  const translatePath = `/api/ai/sessions/${session.id}/translation`;
  const before = await json(reportPath); assert.match(before.report.summary, /視聴者/);
  const status = await json(`/api/ai/analyze/status?sessionId=${session.id}`);
  if (!baseline) { assert.equal(status.recovery?.action, 'resume-memory'); record('legacy out-of-order failure offers memory-only recovery', status.recovery.action); }
  await json(translatePath, {locale: 'zh-CN', configId: config.id, consent: true});
  const failed = await wait(async () => { const r = await json(reportPath); return r.translation.status === 'failed' ? r : null; });
  const code = failed.translation.run.error.code;
  if (baseline) {
    record('v0.19.1 failure reproduction', {code, calls, itemCode: failed.translation.items?.[0]?.errorCode});
    assert.equal(code, 'ERR_INVALID_ARG_TYPE');
  } else {
    assert.equal(code, 'PROVIDER_AUTH_FAILED'); assert.equal(calls, 1);
    record('401 cause survives progress persistence without parameter error or retry', {code, calls});
    mode = 'truncate';
    await json(translatePath, {locale: 'zh-CN', configId: config.id, consent: true});
    const partial = await wait(async () => {const r = await json(reportPath); return r.translation.status === 'partial' ? r : null;});
    assert.equal(partial.translation.run.error.code, 'TRANSLATION_OUTPUT_TRUNCATED');
    assert.equal(partial.translation.translated, 1);
    record('truncated JSON retains its complete paragraph with precise diagnostics', {code: partial.translation.run.error.code, recovered: partial.translation.translated});
    mode = 'ok';
    await json(translatePath, {locale: 'zh-CN', configId: config.id, consent: true});
    const translated = await wait(async () => { const r = await json(reportPath); return r.translation.status === 'complete' ? r : null; });
    assert.match(translated.report.summary, /译文/); record('Japanese report translates to Chinese despite memory failure', {status: translated.translation.status});
    assert.equal(resumedInputSize, truncatedInputSize - 1);
    record('translation retry does not purchase the recovered paragraph again', {before: truncatedInputSize, retried: resumedInputSize});
    const cachedCalls = calls;
    await json(translatePath, {locale: 'zh-CN', configId: config.id, consent: true});
    assert.equal(calls, cachedCalls); record('valid cache sends no extra request', calls);
    const original = await json(`/api/ai/sessions/${session.id}/report`); assert.match(original.report.summary, /視聴者/);
    record('stored Japanese original remains readable', original.result.locale);
    const preRecoveryCalls = calls;
    await json('/api/ai/analyze/resume', {sessionId: session.id, consent: true});
    const recovered = await wait(async () => {const r = await json(`/api/ai/analyze/status?sessionId=${session.id}`);
      if (['failed', 'partial', 'needs_action'].includes(r.status)) throw new Error(JSON.stringify(r.error));
      return r.status === 'complete' ? r : null;});
    assert.equal(recovered.sessionJobId, jobId); assert.equal(recovered.sessionReportDone, true);
    assert.equal(recovered.memoryDone, true); assert.equal(calls - preRecoveryCalls, 1);
    record('legacy task resumes only missing memory with the original saved report', {memoryCalls: calls - preRecoveryCalls, status: recovered.status});
  }
  const health = await json('/api/health'); record('packaged runtime identity', health);
} finally {
  if (child && child.exitCode === null) { child.kill(); await pause(800); }
  await new Promise((r) => mock.close(r));
  if (reference) { store = new WindowsCredentialStore({tempDir: join(root, 'cleanup')}); store.remove(reference); }
  writeFileSync(join(root, 'results.json'), JSON.stringify(output, null, 2));
}
console.log(`Artifacts: ${root}`);
