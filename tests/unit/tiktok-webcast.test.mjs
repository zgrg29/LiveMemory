import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  TIKTOK_WS_HOSTS,
  TtwidProvider,
  WebcastSocket,
  buildSocketUrl,
  encodeAck,
  encodeEnterRoom,
  encodeHeartbeat,
  encodePushFrame
} from '../../src/platforms/tiktok/webcast.mjs';
import {decodePushFrame} from '../../src/platforms/tiktok/messages.mjs';
import {readFields, field, asString} from '../../src/platforms/tiktok/protobuf.mjs';
import {chatMessage, fetchResult} from '../helpers/tiktok-frames.mjs';
import {FakeWebSocket, cookieResponse, fakeFetch} from '../helpers/tiktok-ws-fake.mjs';
import {cleanupLegacyTikTokArtifacts, inspectLegacyTikTokArtifacts} from '../../src/platforms/tiktok/legacy-cleanup.mjs';
import {createTtwidStore} from '../../src/platforms/tiktok/state.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

function framePayload(buffer) {
  const fields = readFields(buffer);
  return {
    payloadType: asString(field(fields, 7, 2)),
    payload: field(fields, 8, 2)?.bytes ?? null,
    logId: field(fields, 2, 0)?.value?.toString() ?? null,
    encoding: asString(field(fields, 6, 2))
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'lm-tiktok-'));
}

test('client frames are PushFrame envelopes the decoder reads back', () => {
  const enter = framePayload(encodeEnterRoom('7706695538414062349'));
  assert.equal(enter.payloadType, 'im_enter_room');
  assert.equal(enter.encoding, 'pb');
  const enterFields = readFields(enter.payload);
  assert.equal(field(enterFields, 1, 0).value.toString(), '7706695538414062349');
  assert.equal(field(enterFields, 4, 0).value, 12n);
  assert.equal(asString(field(enterFields, 5, 2)), 'audience');

  const heartbeat = framePayload(encodeHeartbeat('7706695538414062349'));
  assert.equal(heartbeat.payloadType, 'hb');
  assert.equal(field(readFields(heartbeat.payload), 1, 0).value.toString(), '7706695538414062349');

  const ack = framePayload(encodeAck('123456'));
  assert.equal(ack.payloadType, 'ack');
  assert.equal(ack.logId, '123456');
  assert.equal(ack.payload.toString(), '-');

  // The server-side decoder must recognise the envelope we send.
  const decoded = decodePushFrame(encodePushFrame({payloadType: 'msg', payload: Buffer.from([1, 2, 3])}));
  assert.equal(decoded.payloadType, 'msg');
  assert.deepEqual([...decoded.payload], [1, 2, 3]);
});

test('the socket URL mirrors the web player handshake', () => {
  const url = new URL(buildSocketUrl({
    host: TIKTOK_WS_HOSTS[0],
    roomId: '7706695538414062349',
    heartbeatIntervalMs: 10000,
    timeZone: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0'
  }));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.hostname, 'webcast-ws.tiktok.com');
  assert.equal(url.pathname, '/webcast/im/ws_proxy/ws_reuse_supplement/');
  assert.equal(url.searchParams.get('room_id'), '7706695538414062349');
  assert.equal(url.searchParams.get('identity'), 'audience');
  assert.equal(url.searchParams.get('compress'), 'gzip');
  assert.equal(url.searchParams.get('resp_content_type'), 'protobuf');
  assert.equal(url.searchParams.get('heartbeat_duration'), '10000');
  assert.equal(url.searchParams.get('aid'), '1988');
  assert.equal(url.searchParams.get('tz_name'), 'Asia/Shanghai');
  // No signature, token or login parameter exists on this path.
  for (const key of ['signature', 'X-Bogus', 'token', 'sessionid']) {
    assert.equal(url.searchParams.has(key), false, key);
  }
});

test('the anonymous cookie is fetched once, persisted and refreshed explicitly', async () => {
  const dir = tempDir();
  try {
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls += 1;
      return cookieResponse([`ttwid=anon-device-cookie-${calls}-value; Path=/; Domain=.tiktok.com`]);
    });
    const store = createTtwidStore(dir);
    const provider = new TtwidProvider({fetchImpl, store, attempts: 1, retryDelayMs: 0});
    assert.equal(await provider.load(), null);
    assert.equal(await provider.get(), 'anon-device-cookie-1-value');
    assert.equal(await provider.get(), 'anon-device-cookie-1-value', 'cached value is reused');
    assert.equal(calls, 1, 'no second page request for a cached cookie');
    assert.equal(await provider.get({refresh: true}), 'anon-device-cookie-2-value');
    assert.equal(calls, 2);

    // A new provider restores the persisted cookie without the network.
    const restored = new TtwidProvider({fetchImpl: fakeFetch(() => { throw new Error('must not fetch'); }), store});
    assert.equal(await restored.load(), 'anon-device-cookie-2-value');
    assert.equal(await restored.get(), 'anon-device-cookie-2-value');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a throttled cookie request is retried and then reported as rate limited', async () => {
  let calls = 0;
  const throttled = fakeFetch(() => {
    calls += 1;
    return cookieResponse([], {body: '<html>error</html>'});
  });
  const provider = new TtwidProvider({fetchImpl: throttled, attempts: 3, retryDelayMs: 1});
  await assert.rejects(() => provider.get(), (error) => {
    assert.equal(error.code, 'TIKTOK_RATE_LIMITED');
    assert.equal(error.details.reason, 'ttwid_throttled');
    assert.ok(error.retryAfterMs > 0);
    return true;
  });
  assert.equal(calls, 3, 'all attempts were used');
  assert.equal(provider.snapshot().cached, false);

  // A transient success after one refusal must win.
  let attempts = 0;
  const flaky = fakeFetch(() => {
    attempts += 1;
    return attempts === 1 ? cookieResponse([]) : cookieResponse(['ttwid=good']);
  });
  const recovering = new TtwidProvider({fetchImpl: flaky, attempts: 3, retryDelayMs: 1});
  assert.equal(await recovering.get(), 'good');
  assert.equal(attempts, 2);
});

test('the socket sends enter, acknowledges batches and keeps heartbeats alive', async () => {
  FakeWebSocket.reset();
  const frames = [];
  const socket = new WebcastSocket({
    roomId: '7706695538414062349',
    WebSocketImpl: FakeWebSocket,
    heartbeatIntervalMs: 15,
    idleTimeoutMs: 5000,
    onFrame: ({frame, result}) => frames.push({frame, result})
  });
  const connecting = socket.connect({ttwid: 'anon-cookie'});
  const ws = FakeWebSocket.last;
  assert.ok(ws.url.includes('room_id=7706695538414062349'));
  assert.equal(ws.options.headers.cookie, 'ttwid=anon-cookie');
  assert.equal(ws.options.headers.origin, 'https://www.tiktok.com');
  ws.open();
  await connecting;
  // The first frame is the room enter.
  await waitFor(() => ws.sent.length >= 1);
  assert.equal(framePayload(ws.sent[0]).payloadType, 'im_enter_room');
  // Heartbeats keep the socket from being closed by TikTok's ping timeout.
  await waitFor(() => ws.sent.some((frame) => framePayload(frame).payloadType === 'hb'));
  const heartbeats = ws.sent.filter((frame) => framePayload(frame).payloadType === 'hb').length;
  assert.ok(heartbeats >= 1);

  // A gzip event batch is decoded, and its logId is acknowledged.
  const batch = fetchResult({messages: [{method: 'WebcastChatMessage', payload: chatMessage({msgId: '9001', content: 'hello'}), msgId: 9001n}]});
  ws.deliver(encodePushFrame({payload: gzipSync(batch), logId: 77n}));
  await waitFor(() => frames.length >= 1);
  assert.equal(frames[0].result.messages.length, 1);
  assert.equal(frames[0].result.messages[0].method, 'WebcastChatMessage');
  await waitFor(() => ws.sent.some((frame) => framePayload(frame).payloadType === 'ack'));
  const ack = ws.sent.map(framePayload).find((frame) => frame.payloadType === 'ack');
  assert.equal(ack.logId, '77');

  // An uncompressed batch is accepted too.
  ws.deliver(encodePushFrame({payload: batch}));
  await waitFor(() => frames.length >= 2);
  assert.equal(frames[1].result.messages.length, 1);

  // Control frames are reported but never decoded as event batches.
  ws.deliver(encodePushFrame({payloadType: 'hb', payload: Buffer.from([0x08, 0x01])}));
  await waitFor(() => frames.length >= 3);
  assert.equal(frames[2].result, null);

  socket.close({code: 1000, reason: 'test_done'});
  assert.equal(ws.closeCalls.length, 1);
  assert.equal(socket.snapshot().frames, 3);
});

test('the socket reports a drop instead of pretending to stay connected', async () => {
  FakeWebSocket.reset();
  const closes = [];
  const socket = new WebcastSocket({
    roomId: '123456789',
    WebSocketImpl: FakeWebSocket,
    idleTimeoutMs: 5000,
    onClose: (info) => closes.push(info)
  });
  const connecting = socket.connect({ttwid: 'cookie'});
  const ws = FakeWebSocket.last;
  ws.open();
  await connecting;
  ws.drop({code: 1006, reason: 'network_lost'});
  assert.equal(closes.length, 1, 'a dropped socket is reported once');
  assert.equal(closes[0].code, 1006);
  assert.equal(closes[0].wasOpen, true);
  assert.equal(socket.isOpen, false);
});

test('an idle socket is closed so the adapter can reconnect', async () => {
  FakeWebSocket.reset();
  const closes = [];
  const socket = new WebcastSocket({
    roomId: '123456789',
    WebSocketImpl: FakeWebSocket,
    idleTimeoutMs: 40,
    heartbeatIntervalMs: 10,
    onClose: (info) => closes.push(info)
  });
  const connecting = socket.connect({ttwid: 'cookie'});
  const ws = FakeWebSocket.last;
  ws.open();
  await connecting;
  await waitFor(() => closes.length === 1, 2000);
  assert.equal(closes[0].reason, 'idle_timeout');
  assert.equal(ws.closeCalls.at(-1).code, 4000);
});

test('every host is tried before the socket gives up', async () => {
  FakeWebSocket.reset();
  const socket = new WebcastSocket({
    roomId: '123456789',
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 50,
    hosts: ['wss://first.invalid/path/', 'wss://second.invalid/path/']
  });
  await assert.rejects(() => socket.connect({ttwid: 'cookie'}), (error) => {
    assert.equal(error.code, 'TIKTOK_SOCKET_FAILED');
    assert.equal(error.details.reason, 'all_hosts_failed');
    assert.equal(error.details.hosts.length, 2);
    return true;
  });
  assert.equal(FakeWebSocket.instances.length, 2, 'both hosts were attempted');
});

test('a missing device cookie refuses to open a socket', async () => {
  FakeWebSocket.reset();
  const socket = new WebcastSocket({roomId: '123456789', WebSocketImpl: FakeWebSocket});
  await assert.rejects(() => socket.connect({}), (error) => error.details.reason === 'ttwid_missing');
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('legacy browser artifacts are removed only when LiveMemory owns them', () => {
  const dir = tempDir();
  try {
    const profile = join(dir, 'browser', 'tiktok', 'account');
    mkdirSync(profile, {recursive: true});
    writeFileSync(join(dir, 'browser', 'tiktok', 'login-state.json'), '{"state":"logged_in"}');
    writeFileSync(join(profile, '.livememory-owned'), 'LiveMemory dedicated TikTok browser profile\n');
    writeFileSync(join(profile, 'Cookies'), 'placeholder');
    // A normal user profile next door must survive.
    const userProfile = join(dir, 'browser', 'chrome-user-profile');
    mkdirSync(userProfile, {recursive: true});
    writeFileSync(join(userProfile, 'Bookmarks'), 'keep');

    const before = inspectLegacyTikTokArtifacts(dir);
    assert.equal(before.present, true);
    assert.equal(before.profileOwned, true);
    assert.equal(before.hasOwnedArtifacts, true);

    const report = cleanupLegacyTikTokArtifacts(dir);
    assert.equal(report.ownedProfileRemoved, true);
    assert.equal(report.stateFileRemoved, true);
    assert.equal(existsSync(profile), false);
    assert.equal(existsSync(join(dir, 'browser', 'tiktok')), false);
    assert.equal(existsSync(join(userProfile, 'Bookmarks')), true, 'unrelated profile is untouched');

    // A second run is a no-op, not an error.
    const second = cleanupLegacyTikTokArtifacts(dir);
    assert.equal(second.removed.length, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a profile without the ownership marker is never deleted', () => {
  const dir = tempDir();
  try {
    const profile = join(dir, 'browser', 'tiktok', 'account');
    mkdirSync(profile, {recursive: true});
    writeFileSync(join(profile, 'Cookies'), 'someone else');
    const report = cleanupLegacyTikTokArtifacts(dir);
    assert.equal(report.ownedProfileRemoved, false);
    assert.equal(existsSync(profile), true);
    assert.equal(report.skipped[0].reason, 'marker_missing_or_unexpected');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('legacy cleanup without a data directory reports why it did nothing', () => {
  const report = cleanupLegacyTikTokArtifacts(null);
  assert.deepEqual(report.removed, []);
  assert.equal(report.skipped[0].reason, 'no_data_dir');
  assert.equal(inspectLegacyTikTokArtifacts(null).supported, false);
});

test('the ttwid store writes a 0600 file and never invents a value', async () => {
  const dir = tempDir();
  try {
    const store = createTtwidStore(dir);
    await store.write({ttwid: 'x'.repeat(40), fetchedAt: 1700000000000});
    const read = await store.read();
    assert.equal(read.ttwid.length, 40);
    assert.equal(read.fetchedAt, 1700000000000);
    assert.match(readFileSync(join(dir, 'tiktok', 'ttwid.json'), 'utf8'), /"ttwid"/);
    // A truncated or foreign file is ignored rather than trusted.
    writeFileSync(join(dir, 'tiktok', 'ttwid.json'), '{"ttwid":"short"}');
    assert.equal(await store.read(), null);
    assert.equal(createTtwidStore(null), null);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
