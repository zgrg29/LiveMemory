import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server/index.mjs';
import {
  createSession,
  endSession,
  setSessionArchived
} from '../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../src/storage/repositories/broadcasters.mjs';

/**
 * Development-only fixture for the history management / search console.
 *
 * Seeds several ended broadcasts (including archived ones), two identities that
 * share a nickname on different platforms, one shared long-term viewer and one
 * running simulated broadcast for the stop flow. All data is clearly simulated;
 * nothing contacts a platform.
 *
 *   node scripts/demo-history.mjs [--port 48360] [--seconds 0]
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const port = Number(argValue('--port', 48360));
const seconds = Number(argValue('--seconds', 0));
const root = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));
const dataDir = join(root, `demo-history-${Date.now()}`);
const HOUR = 3600 * 1000;
const now = Date.now();

const server = await startServer({dataDir, port, systemLocale: 'en'});
const db = server.db;
const manager = server.sessionManager;

function addBroadcaster(platform, uid, name) {
  const id = `${platform}:${uid}`;
  upsertBroadcaster(db, {
    id,
    platform,
    platformUid: uid,
    displayName: name,
    identity: 'verified',
    seenAt: now,
    now
  });
  return id;
}

const alpha = addBroadcaster('youtube', 'UC_DEMO_ALPHA', 'Demo Alpha 主播');
const anchor = addBroadcaster('bilibili', '920001', '主播甲');
const charlie = addBroadcaster('youtube', 'UC_DEMO_CHARLIE', 'Demo Charlie');

function seedSession({
  platform,
  roomId,
  title,
  broadcasterName,
  broadcasterId,
  startedAt,
  messages,
  amount = null
}) {
  const session = createSession(db, {
    platform,
    platformRoomId: roomId,
    roomTitle: title,
    broadcasterName,
    broadcasterId,
    broadcasterIdentity: 'verified',
    storageMode: 'compact',
    sourceQuality: 'mock',
    simulated: true,
    startedAt,
    now: startedAt
  });
  let offset = 0;
  for (const message of messages) {
    offset += 1000;
    manager.ingest.record({
      session_id: session.id,
      platform,
      event_type: message.amount ? 'super_chat' : 'chat',
      viewer_uid: message.uid,
      display_name: message.name,
      occurred_at: startedAt + offset,
      content: message.content,
      ...(message.amount
        ? {
          amount_minor: message.amount,
          currency: platform === 'youtube' ? 'HKD' : 'CNY',
          value_kind: 'actual',
          is_paid: true
        }
        : {}),
      external_id: `demo-${session.id}-${offset}`,
      source_quality: 'mock'
    });
  }
  endSession(db, session.id, {
    status: 'ended',
    endedAt: startedAt + offset + 60_000,
    reason: 'adapter_end'
  });
  return session;
}

const minecraft = seedSession({
  platform: 'youtube',
  roomId: 'demo-history-alpha',
  title: 'Minecraft 深夜杂谈 🎮',
  broadcasterName: 'Demo Alpha 主播',
  broadcasterId: alpha,
  startedAt: now - 40 * HOUR,
  messages: [
    {uid: 'UC_SHARED_VIEWER', name: '小王', content: 'こんにちは hello 你好'},
    {uid: 'UC_SHARED_VIEWER', name: '小王', content: '这个 BGM 真好听'},
    {uid: 'UC_LONG_TERM', name: '老观众', content: '又来了'},
    {uid: 'UC_LONG_TERM', name: '老观众', content: '今天也很稳', amount: 3000}
  ]
});

const bili = seedSession({
  platform: 'bilibili',
  roomId: '920001',
  title: '日本語の雑談配信',
  broadcasterName: '主播甲',
  broadcasterId: anchor,
  startedAt: now - 30 * HOUR,
  messages: [
    {uid: '920002', name: '小王', content: '同じ名前の別IDです'},
    {uid: '920003', name: '老观众', content: '跨主播也来了'},
    {uid: '920003', name: '老观众', content: '加油！'}
  ]
});

const english = seedSession({
  platform: 'youtube',
  roomId: 'demo-history-english',
  title: 'English Talk Show — late night edition',
  broadcasterName: 'Demo Charlie',
  broadcasterId: charlie,
  startedAt: now - 20 * HOUR,
  messages: [
    {uid: 'UC_LONG_TERM', name: '老观众', content: 'third channel'},
    {uid: 'UC_EN_ONLY', name: 'Only English', content: 'hello'}
  ]
});

const archiveMe = seedSession({
  platform: 'youtube',
  roomId: 'demo-history-archive',
  title: 'Archive Me 归档测试',
  broadcasterName: 'Demo Alpha 主播',
  broadcasterId: alpha,
  startedAt: now - 10 * HOUR,
  messages: [
    {uid: 'UC_ARCHIVE_VIEWER', name: '归档观众', content: 'archive me'}
  ]
});
setSessionArchived(db, archiveMe.id, true, {now: now - 9 * HOUR});

const deleteMe = seedSession({
  platform: 'bilibili',
  roomId: '920099',
  title: 'Delete Me 永久删除测试',
  broadcasterName: '主播甲',
  broadcasterId: anchor,
  startedAt: now - 5 * HOUR,
  messages: [
    {uid: '920099', name: '临时观众', content: 'delete me'}
  ]
});

const other = seedSession({
  platform: 'youtube',
  roomId: 'demo-history-bulk',
  title: 'Bulk history row for pagination',
  broadcasterName: 'Demo Charlie',
  broadcasterId: charlie,
  startedAt: now - 2 * HOUR,
  messages: [
    {uid: 'UC_BULK', name: 'Bulk', content: 'row'}
  ]
});

const live = await manager.startSimulation({
  title: 'Stop Me 正在进行的模拟直播',
  intervalMs: 1600
});

console.log(JSON.stringify({
  url: server.url,
  dataDir,
  sessions: {
    minecraft: minecraft.id,
    bilibili: bili.id,
    english: english.id,
    archived: archiveMe.id,
    deletable: deleteMe.id,
    other: other.id,
    live: live.session.id
  }
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
