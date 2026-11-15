import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server/index.mjs';

/**
 * Development-only fixture for the tabbed live console.
 *
 * It starts the real server and three simulated recordings (two YouTube
 * channels and one Bilibili room) so the multi-tab layout, switching, search and
 * scrolling can be inspected without contacting a platform. Events are marked as
 * simulated and never presented as real live data.
 *
 *   node scripts/demo-multi-recording.mjs [--port 48350] [--seconds 0]
 *
 * This script is not part of the product build and is never loaded by the EXE.
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const port = Number(argValue('--port', 48350));
const seconds = Number(argValue('--seconds', 0));
const root = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));
const dataDir = join(root, `demo-multi-${Date.now()}`);

const VIEWERS = [
  ['demo_alpha', 'Alpha 观众'],
  ['demo_bravo', 'Bravo'],
  ['demo_charlie', 'チャーリー'],
  ['demo_delta', 'Delta'],
  ['demo_echo', '回声'],
  ['demo_foxtrot', 'Foxtrot'],
  ['demo_golf', 'Golf'],
  ['demo_hotel', 'Hotel'],
  ['demo_india', 'India'],
  ['demo_juliet', 'Juliet'],
  ['demo_kilo', 'Kilo'],
  ['demo_lima', 'Lima']
];

const MESSAGES = [
  '这段真不错',
  'ナイス！',
  'love this part',
  '哈哈哈哈😂',
  'BGM 叫什么',
  '初見です',
  'so relaxing',
  '再来一首'
];

let globalCounter = 0;

class DemoTicker {
  constructor({platform, broadcasterName, roomTitle, hotness = 120}) {
    this.platform = platform;
    this.broadcasterName = broadcasterName;
    this.roomTitle = roomTitle;
    this.hotness = hotness;
    this.timer = null;
    this.onEvent = null;
    this.onStateChange = null;
    this.sent = 0;
    this.turn = 0;
  }

  async start({onEvent, onStateChange}) {
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    onStateChange?.({state: 'connected', detail: {demo: true, viewers: this.hotness}});
    this.timer = setInterval(() => this.#tick(), 700);
    this.timer.unref?.();
  }

  #tick() {
    this.turn += 1;
    const [uid, name] = VIEWERS[(this.turn + (this.platform === 'youtube' ? 4 : 0)) % VIEWERS.length];
    globalCounter += 1;
    const base = {
      platform: this.platform,
      external_id: `demo-${this.platform}-${globalCounter}`,
      occurred_at: Date.now(),
      viewer_uid: uid,
      display_name: name,
      source_quality: 'mock'
    };
    if (this.turn % 11 === 0) {
      this.onEvent?.({
        ...base,
        event_type: 'super_chat',
        content: '応援しています！',
        unit_amount_minor: 2000,
        amount_minor: 2000,
        currency: this.platform === 'youtube' ? 'HKD' : 'CNY',
        value_kind: 'actual',
        is_paid: true
      });
      return;
    }
    if (this.turn % 17 === 0) {
      this.onEvent?.({
        ...base,
        event_type: 'gift',
        gift_id: 'demo_gift',
        gift_name: '小心心',
        gift_type: 'paid',
        gift_quantity: 1,
        unit_amount_minor: 100,
        amount_minor: 100,
        currency: this.platform === 'youtube' ? 'HKD' : 'CNY',
        value_kind: 'actual',
        is_paid: true
      });
      return;
    }
    this.onEvent?.({
      ...base,
      event_type: 'chat',
      content: MESSAGES[this.turn % MESSAGES.length]
    });
    this.sent += 1;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      id: `demo-${this.platform}`,
      platform: this.platform,
      state: this.timer ? 'connected' : 'stopped',
      detail: {demo: true, viewers: this.hotness, messagesSeen: this.sent}
    };
  }
}

const server = await startServer({auth: false, dataDir, port, systemLocale: 'en'});
const manager = server.sessionManager;

async function start(definition) {
  const adapter = new DemoTicker(definition);
  const result = await manager.startPlatform({
    platform: definition.platform,
    platformRoomId: definition.roomId,
    roomTitle: definition.roomTitle,
    broadcasterName: definition.broadcasterName,
    broadcasterUid: definition.broadcasterUid,
    sourceQuality: 'mock',
    simulated: true,
    createAdapter: () => adapter,
    meta: {demo: true}
  });
  if (!result.started) throw new Error(`demo recording did not start: ${result.reason}`);
  return result.session.id;
}

await start({
  platform: 'youtube',
  roomId: 'demo-video-alpha',
  roomTitle: 'Demo YouTube live — Alpha',
  broadcasterUid: 'UC_DEMO_ALPHA',
  broadcasterName: 'Demo Alpha',
  hotness: 1280
});
await start({
  platform: 'bilibili',
  roomId: '900001',
  roomTitle: 'Demo Bilibili live — Bravo',
  broadcasterUid: '910001',
  broadcasterName: 'Demo Bravo',
  hotness: 8600
});
await start({
  platform: 'youtube',
  roomId: 'demo-video-charlie',
  roomTitle: 'Demo YouTube live — Charlie',
  broadcasterUid: 'UC_DEMO_CHARLIE',
  broadcasterName: 'Demo Charlie',
  hotness: 342
});

// Seed enough viewers for the Top 100 container to be exercised immediately.
// The rows are simulated and labelled as such by the demo session metadata.
for (const recording of manager.listRecordings()) {
  const platform = recording.platform;
  manager.ingest.record({
    session_id: recording.sessionId,
    platform,
    event_type: 'chat',
    viewer_uid: 'demo_top_viewer',
    display_name: 'Top Viewer',
    occurred_at: Date.now() - 1000,
    content: '一直支持你',
    external_id: `seed-${recording.sessionId}-top`,
    source_quality: 'mock'
  });
  for (let index = 0; index < 124; index += 1) {
    manager.ingest.record({
      session_id: recording.sessionId,
      platform,
      event_type: 'chat',
      viewer_uid: `seed_${index}`,
      display_name: `观众 ${String(index + 1).padStart(3, '0')}`,
      occurred_at: Date.now() - 2000 - index * 100,
      content: MESSAGES[index % MESSAGES.length],
      external_id: `seed-${recording.sessionId}-${index}`,
      source_quality: 'mock'
    });
  }
}

console.log(JSON.stringify({
  url: server.url,
  dataDir,
  sessions: manager.listRecordings().map((recording) => ({
    id: recording.sessionId,
    platform: recording.platform,
    broadcasterName: recording.broadcasterName,
    state: recording.connection
  }))
}, null, 2));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  try {
    rmSync(dataDir, {recursive: true, force: true});
  } catch {
    /* best effort */
  }
  process.exit(0);
}
process.on('SIGINT', () => { close().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { close().catch(() => process.exit(1)); });
if (seconds > 0) setTimeout(() => { close().catch(() => process.exit(1)); }, seconds * 1000);
