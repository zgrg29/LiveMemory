#!/usr/bin/env node
import {mkdirSync, writeFileSync, appendFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {KickAdapter} from '../src/platforms/kick/adapter.mjs';
import {KickHttp} from '../src/platforms/kick/http.mjs';
import {parseKickInput} from '../src/platforms/kick/link.mjs';
import {parseKickEmotes} from '../src/platforms/kick/messages.mjs';

/**
 * Kick G1 proof-of-capture.
 *
 * Opens real, public, live Kick channels over the anonymous Centrifugo
 * transport, writes every untouched publication and every canonical draft to
 * an isolated evidence directory, forces one transport drop, and prints a
 * summary with the measured field-completeness rates.
 *
 * It never writes to the LiveMemory database and never touches user data. It
 * is a research tool, not a supported capture path.
 *
 *   node scripts/kick-poc.mjs --rooms https://kick.com/odablock,gmhikaru \
 *     --minutes 15 --drop-at 240 --out tests/.tmp/kick-g1
 */

const DEFAULTS = Object.freeze({
  minutes: 10,
  dropAt: 0,
  out: 'tests/.tmp/kick-g1',
  discoveryLimit: 2
});

function parseArgs(argv) {
  const args = {...DEFAULTS, rooms: null, dropRoom: null, jsonOut: null};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    switch (token) {
      case '--rooms': args.rooms = String(next() ?? '').split(',').map((entry) => entry.trim()).filter(Boolean); break;
      case '--minutes': args.minutes = Number(next()); break;
      case '--drop-at': args.dropAt = Number(next()); break;
      case '--drop-room': args.dropRoom = String(next() ?? ''); break;
      case '--out': args.out = String(next() ?? DEFAULTS.out); break;
      case '--json': args.jsonOut = String(next() ?? ''); break;
      case '--discover': args.discoveryLimit = Number(next()); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/kick-poc.mjs --rooms <url|slug,...> [--minutes N] [--drop-at S] [--drop-room slug] [--out DIR] [--json FILE]');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!Number.isFinite(args.minutes) || args.minutes <= 0) throw new Error('--minutes must be a positive number');
  if (!Number.isFinite(args.dropAt) || args.dropAt < 0) throw new Error('--drop-at must be >= 0');
  return args;
}

function nowIso(ms) {
  return new Date(ms).toISOString();
}

function pct(part, total) {
  if (!total) return null;
  return Math.round((part / total) * 10000) / 100;
}

async function discoverLiveRooms(limit) {
  const http = new KickHttp({timeoutMs: 20000});
  try {
    const response = await http.requestJson('https://web.kick.com/api/v1/livestreams/featured?language=en');
    if (response.status !== 200) throw new Error(`featured list status ${response.status}`);
    const streams = response.data?.data?.livestreams ?? [];
    return streams
      .filter((entry) => entry?.channel?.slug)
      .sort((a, b) => (b.viewer_count ?? 0) - (a.viewer_count ?? 0))
      .slice(0, limit)
      .map((entry) => ({slug: entry.channel.slug, viewers: entry.viewer_count ?? null, chatroomId: entry.chatroom_id ?? null}));
  } finally {
    await http.close();
  }
}

class RoomRecorder {
  constructor({slug, channel, dir, startedAt}) {
    this.slug = slug;
    this.channel = channel;
    this.dir = dir;
    this.startedAt = startedAt;
    this.chats = 0;
    this.events = [];
    this.raw = 0;
    this.stableIds = new Map();
    this.names = new Set();
    this.messageIds = new Map();
    this.otherEvents = new Map();
    this.assumedUtc = 0;
    this.noMessageId = 0;
    this.noStableId = 0;
    this.noTimestamp = 0;
    this.emoteMessages = 0;
    this.replies = 0;
    this.transitions = [];
    this.rawPath = join(dir, 'raw.jsonl');
    this.eventsPath = join(dir, 'events.jsonl');
    mkdirSync(dir, {recursive: true});
    writeFileSync(this.rawPath, '');
    writeFileSync(this.eventsPath, '');
  }

  onRaw(publication) {
    this.raw += 1;
    appendFileSync(this.rawPath, `${JSON.stringify({at: new Date().toISOString(), ...publication})}\n`);
    if (publication.event !== 'App\\Events\\ChatMessageEvent' && publication.event !== 'App\\Events\\ChatMessageSentEvent') {
      this.otherEvents.set(publication.event, (this.otherEvents.get(publication.event) ?? 0) + 1);
    }
  }

  onEvent(draft) {
    this.chats += 1;
    this.events.push(draft);
    appendFileSync(this.eventsPath, `${JSON.stringify(draft)}\n`);
    const uid = draft.viewer_uid;
    if (uid) this.stableIds.set(String(uid), (this.stableIds.get(String(uid)) ?? 0) + 1);
    if (draft.display_name) this.names.add(draft.display_name);
    if (draft.external_id) this.messageIds.set(draft.external_id, (this.messageIds.get(draft.external_id) ?? 0) + 1);
    if (!draft.external_id) this.noMessageId += 1;
    if (!uid) this.noStableId += 1;
    if (!draft._kick?.timestampSource || draft._kick.timestampSource !== 'created_at') this.noTimestamp += 1;
    if (draft._kick?.assumedUtc) this.assumedUtc += 1;
    if (draft.emotes) this.emoteMessages += 1;
    if (draft._kick?.messageType === 'reply') this.replies += 1;
    // Structural check on the raw marker parser, independent of the mapper.
    if (typeof draft.content === 'string' && draft.content.includes('[emote:') && !parseKickEmotes(draft.content)) {
      this.emoteParseFailures = (this.emoteParseFailures ?? 0) + 1;
    }
  }

  summary(adapter, endedAt) {
    const duplicateIds = [...this.messageIds.entries()].filter(([, count]) => count > 1);
    const topSenders = [...this.stableIds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const crossRoom = this.events.filter((event) => String(event._kick?.chatroomId ?? '') !== String(this.channel.chatroomId)).length;
    return {
      slug: this.slug,
      channelId: this.channel.channelId,
      chatroomId: this.channel.chatroomId,
      live: this.channel.isLive,
      startedAt: nowIso(this.startedAt),
      endedAt: nowIso(endedAt),
      durationSec: Math.round((endedAt - this.startedAt) / 1000),
      publications: this.raw,
      chats: this.chats,
      chatsPerMinute: this.chats > 0 ? Math.round((this.chats / Math.max(1, (endedAt - this.startedAt) / 60000)) * 10) / 10 : 0,
      uniqueStableIds: this.stableIds.size,
      uniqueNames: this.names.size,
      topSenders: topSenders.map(([id, count]) => ({id, messages: count})),
      completeness: {
        stableIdPct: pct(this.chats - this.noStableId, this.chats),
        messageIdPct: pct(this.chats - this.noMessageId, this.chats),
        createdAtPct: pct(this.chats - this.noTimestamp, this.chats),
        assumedUtcCount: this.assumedUtc,
        emoteMessagePct: pct(this.emoteMessages, this.chats),
        replyPct: pct(this.replies, this.chats)
      },
      duplicateMessageIds: duplicateIds.length,
      duplicateMessageIdSamples: duplicateIds.slice(0, 5).map(([id, count]) => ({id, count})),
      emoteParseFailures: this.emoteParseFailures ?? 0,
      crossRoomEvents: crossRoom,
      nonChatEventNames: Object.fromEntries(this.otherEvents),
      reconnects: adapter.snapshot().counters.reconnects,
      gaps: adapter.snapshot().gaps,
      stateTransitions: this.transitions.slice(-20)
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  mkdirSync(outDir, {recursive: true});

  let rooms = args.rooms ?? [];
  if (rooms.length === 0) {
    const discovered = await discoverLiveRooms(args.discoveryLimit);
    rooms = discovered.map((entry) => entry.slug);
    console.log(`[discover] ${discovered.map((entry) => `${entry.slug}(${entry.viewers ?? '?'})`).join(', ')}`);
  }
  if (rooms.length === 0) throw new Error('no rooms: pass --rooms or use --discover');

  const parsed = rooms.map((entry) => parseKickInput(entry));
  console.log(`[rooms] ${parsed.map((entry) => `${entry.slug} <- ${entry.input}`).join(' | ')}`);

  const startedAt = Date.now();
  const recorders = [];
  const adapters = [];
  const startFailures = [];
  const dropState = {room: null, requestedAt: null, recoveredAt: null};

  for (const room of parsed) {
    const adapter = new KickAdapter({slug: room.slug, logger: null, options: {connectTimeoutMs: 20000}});
    const recorder = new RoomRecorder({
      slug: room.slug,
      channel: {channelId: null, chatroomId: null, isLive: null},
      dir: join(outDir, room.slug),
      startedAt
    });
    adapter.onStateChange = (change) => {
      recorder.transitions.push({at: nowIso(Date.now()), state: change.state, detail: change.detail ?? null});
      console.log(`[state] ${room.slug} ${change.state} ${JSON.stringify(change.detail ?? {})}`);
    };
    try {
      await adapter.start({
        onEvent: (draft) => recorder.onEvent(draft),
        onRawPublication: (publication) => recorder.onRaw(publication),
        onEnd: (info) => console.log(`[end] ${room.slug} ${JSON.stringify(info)}`)
      });
    } catch (error) {
      // One offline/refused room must not destroy evidence from the others; the
      // failure is reported and makes the run fail its criteria.
      startFailures.push({slug: room.slug, code: error?.code ?? null, message: error?.message ?? null});
      console.log(`[start-failed] ${room.slug} ${error?.code ?? ''} ${error?.message ?? ''}`);
      await adapter.stop({reason: 'start_failed'}).catch(() => {});
      continue;
    }
    recorder.channel = adapter.channel;
    recorders.push(recorder);
    adapters.push(adapter);
    console.log(`[live] ${room.slug} channel=${adapter.channel.channelId} chatroom=${adapter.channel.chatroomId}`);
  }
  if (adapters.length === 0) {
    throw new Error(`no room connected: ${JSON.stringify(startFailures)}`);
  }

  const totalMs = args.minutes * 60000;
  const dropDelayMs = args.dropAt > 0 ? args.dropAt * 1000 : null;
  let dropTimer = null;
  if (dropDelayMs !== null) {
    dropTimer = setTimeout(() => {
      const target = args.dropRoom
        ? adapters.find((entry) => entry.channel?.slug === args.dropRoom) ?? adapters[0]
        : adapters[0];
      dropState.room = target.channel?.slug ?? null;
      dropState.requestedAt = nowIso(Date.now());
      const dropped = target.debugDropConnection();
      console.log(`[drop] forced transport drop on ${dropState.room} (accepted=${dropped})`);
    }, dropDelayMs);
    dropTimer.unref?.();
  }

  const watch = setInterval(() => {
    if (!dropState.room || dropState.recoveredAt) return;
    const adapter = adapters.find((entry) => entry.channel?.slug === dropState.room);
    if (adapter && adapter.snapshot().state === 'connected' && adapter.snapshot().counters.reconnects > 0) {
      dropState.recoveredAt = nowIso(Date.now());
      console.log(`[recovered] ${dropState.room} after ${Date.now() - new Date(dropState.requestedAt).getTime()}ms; gap=${adapter.snapshot().lastGap}ms`);
    }
  }, 1000);
  watch.unref?.();

  const shutdown = async (signal) => {
    console.log(`[stop] signal=${signal}`);
    clearInterval(watch);
    if (dropTimer) clearTimeout(dropTimer);
    await finish();
  };

  let finished = false;
  async function finish() {
    if (finished) return;
    finished = true;
    const endedAt = Date.now();
    for (const adapter of adapters) {
      const snapshot = await adapter.stop();
      console.log(`[stopped] ${adapter.channel?.slug} state=${snapshot.state} socketOpen=${Boolean(snapshot.socket && !snapshot.socket.closedAt)}`);
    }
    const summaries = recorders.map((recorder, index) => recorder.summary(adapters[index], endedAt));
    const totalChats = summaries.reduce((sum, entry) => sum + entry.chats, 0);
    const isolation = summaries.every((entry) => entry.crossRoomEvents === 0);
    const allConnected = adapters.every((adapter) => adapter.snapshot().state === 'stopped');
    const result = {
      tool: 'kick-poc',
      version: 1,
      generatedAt: nowIso(endedAt),
      durationSec: Math.round((endedAt - startedAt) / 1000),
      rooms: summaries,
      startFailures,
      totals: {requestedRooms: parsed.length, connectedRooms: summaries.length, chats: totalChats, isolationOk: isolation, allStopped: allConnected},
      dropTest: {
        room: dropState.room,
        requestedAt: dropState.requestedAt,
        recoveredAt: dropState.recoveredAt,
        recovered: Boolean(dropState.recoveredAt)
      },
      criteria: {
        allRoomsStarted: startFailures.length === 0,
        atLeastOneRoom: summaries.length >= 1,
        twoRooms: summaries.length >= 2,
        realChatPerRoom: summaries.length > 0 && summaries.every((entry) => entry.chats > 0),
        noCrossRoom: isolation,
        stopClean: allConnected,
        dropRecovered: dropState.requestedAt ? Boolean(dropState.recoveredAt) : null
      }
    };
    const summaryPath = args.jsonOut ? resolve(args.jsonOut) : join(outDir, 'summary.json');
    writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log('\n=== summary ===');
    for (const room of summaries) {
      console.log(`${room.slug}: chats=${room.chats} (${room.chatsPerMinute}/min) names=${room.uniqueNames} stableIds=${room.uniqueStableIds} ` +
        `id=${room.completeness.stableIdPct}% msgId=${room.completeness.messageIdPct}% createdAt=${room.completeness.createdAtPct}% ` +
        `emote=${room.completeness.emoteMessagePct}% replies=${room.completeness.replyPct}% dupIds=${room.duplicateMessageIds} reconnects=${room.reconnects}`);
      if (Object.keys(room.nonChatEventNames).length) console.log(`  non-chat events: ${JSON.stringify(room.nonChatEventNames)}`);
    }
    console.log(`dropTest: ${JSON.stringify(result.dropTest)}`);
    if (startFailures.length) console.log(`startFailures: ${JSON.stringify(startFailures)}`);
    console.log(`criteria: ${JSON.stringify(result.criteria)}`);
    console.log(`evidence: ${outDir}`);
    console.log(`summary: ${summaryPath}`);
    const ok = result.criteria.allRoomsStarted && result.criteria.atLeastOneRoom && result.criteria.realChatPerRoom
      && result.criteria.noCrossRoom && result.criteria.stopClean;
    process.exit(ok ? 0 : 1);
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error('[fatal]', error?.message ?? error);
      process.exit(2);
    });
  });

  setTimeout(() => {
    shutdown('timer').catch((error) => {
      console.error('[fatal]', error?.message ?? error);
      process.exit(2);
    });
  }, totalMs).unref?.();
}

main().catch((error) => {
  console.error('[fatal]', error?.code ?? '', error?.message ?? error);
  process.exit(2);
});
