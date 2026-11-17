#!/usr/bin/env node
import {readFileSync, readdirSync, writeFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

/**
 * Kick G1 evidence analysis.
 *
 * Reads the untouched publications and the canonical drafts produced by
 * `scripts/kick-poc.mjs` and reports the identity / field / uniqueness evidence
 * the G1 gate asks for. It performs no network request and writes nothing into
 * the database.
 *
 *   node scripts/kick-g1-analyze.mjs --dir tests/.tmp/kick-g1-run
 */

function parseArgs(argv) {
  const args = {dir: 'tests/.tmp/kick-g1-run', out: null};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = String(argv[++i] ?? args.dir);
    else if (argv[i] === '--out') args.out = String(argv[++i] ?? '');
  }
  return args;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a truncated final line during a live capture is ignored */
    }
  }
  return out;
}

const isChat = (event) => event === 'App\\Events\\ChatMessageEvent' || event === 'App\\Events\\ChatMessageSentEvent';
const CHAT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function analyseRoom(dir, slug) {
  const raw = readJsonl(join(dir, slug, 'raw.jsonl'));
  const drafts = readJsonl(join(dir, slug, 'events.jsonl'));
  const chatRaw = raw
    .filter((entry) => isChat(entry.event))
    .map((entry) => (entry.data && typeof entry.data === 'object' && entry.data.data !== undefined ? entry.data.data : entry.data))
    .filter((data) => data && typeof data === 'object');

  const idsByName = new Map();
  const namesById = new Map();
  const messageIds = new Map();
  const emoteIds = new Map();
  const keys = new Map();
  const senderKeys = new Map();
  const timestampFormats = new Map();
  let withId = 0;
  let withName = 0;
  let withCreatedAt = 0;
  let withContent = 0;
  let withEmoteMarker = 0;
  let replies = 0;

  for (const data of chatRaw) {
    for (const key of Object.keys(data)) keys.set(key, (keys.get(key) ?? 0) + 1);
    for (const key of Object.keys(data.sender ?? {})) senderKeys.set(key, (senderKeys.get(key) ?? 0) + 1);
    const id = data.sender?.id === undefined || data.sender?.id === null ? null : String(data.sender.id);
    const name = typeof data.sender?.username === 'string' ? data.sender.username : null;
    if (id) withId += 1;
    if (name) withName += 1;
    if (typeof data.created_at === 'string') {
      withCreatedAt += 1;
      const shape = CHAT_TIMESTAMP.test(data.created_at) ? 'iso-with-offset' : 'other';
      timestampFormats.set(shape, (timestampFormats.get(shape) ?? 0) + 1);
    }
    if (typeof data.content === 'string') {
      withContent += 1;
      if (data.content.includes('[emote:')) {
        withEmoteMarker += 1;
        for (const match of data.content.matchAll(/\[emote:(\d+):([^\]\s]+)\]/g)) {
          emoteIds.set(`${match[1]}:${match[2]}`, (emoteIds.get(`${match[1]}:${match[2]}`) ?? 0) + 1);
        }
      }
    }
    if (data.type === 'reply') replies += 1;
    if (data.id) messageIds.set(String(data.id), (messageIds.get(String(data.id)) ?? 0) + 1);
    if (id && name) {
      if (!idsByName.has(name)) idsByName.set(name, new Set());
      idsByName.get(name).add(id);
      if (!namesById.has(id)) namesById.set(id, new Set());
      namesById.get(id).add(name);
    }
  }

  const duplicateIds = [...messageIds.entries()].filter(([, count]) => count > 1);
  return {
    slug,
    chatMessages: chatRaw.length,
    canonicalDrafts: drafts.length,
    payloadKeys: Object.fromEntries([...keys.entries()].sort((a, b) => b[1] - a[1])),
    senderKeys: Object.fromEntries(senderKeys),
    withSenderId: withId,
    withUsername: withName,
    withCreatedAt,
    withContent,
    withEmoteMarker,
    emoteOccurrences: [...emoteIds.values()].reduce((sum, count) => sum + count, 0),
    uniqueEmotes: emoteIds.size,
    replies,
    timestampFormats: Object.fromEntries(timestampFormats),
    uniqueSenders: namesById.size,
    uniqueNames: idsByName.size,
    namesWithSeveralIds: [...idsByName.entries()].filter(([, ids]) => ids.size > 1).length,
    idsWithSeveralNames: [...namesById.entries()].filter(([, names]) => names.size > 1).map(([id, names]) => ({id, names: [...names]})).slice(0, 10),
    duplicateMessageIds: duplicateIds.length,
    duplicateMessageIdSamples: duplicateIds.slice(0, 5).map(([id, count]) => ({id, count})),
    ids: [...namesById.keys()],
    names: [...idsByName.keys()]
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);
  const slugs = readdirSync(dir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'raw.jsonl')))
    .map((entry) => entry.name);
  const rooms = slugs.map((slug) => analyseRoom(dir, slug));

  const idsPerRoom = new Map();
  for (const room of rooms) {
    for (const id of room.ids) {
      if (!idsPerRoom.has(id)) idsPerRoom.set(id, new Map());
      idsPerRoom.get(id).set(room.slug, (idsPerRoom.get(id).get(room.slug) ?? 0) + 1);
    }
  }

  const report = {
    dir,
    generatedAt: new Date().toISOString(),
    rooms: rooms.map(({ids, names, ...rest}) => rest),
    crossRoom: {
      sharedSenderIds: [...idsPerRoom.entries()]
        .filter(([, perRoom]) => perRoom.size > 1)
        .map(([id, perRoom]) => ({id, rooms: Object.fromEntries(perRoom)}))
        .slice(0, 50),
      sharedSenderCount: [...idsPerRoom.values()].filter((perRoom) => perRoom.size > 1).length
    }
  };
  const outPath = args.out ? resolve(args.out) : join(dir, 'analysis.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const room of report.rooms) {
    console.log(`\n== ${room.slug} ==`);
    console.log(`chat=${room.chatMessages} drafts=${room.canonicalDrafts} senders=${room.uniqueSenders} names=${room.uniqueNames}`);
    console.log(`senderId=${room.withSenderId} username=${room.withUsername} createdAt=${room.withCreatedAt} content=${room.withContent}`);
    console.log(`emoteMarkers=${room.withEmoteMarker} emotes=${room.uniqueEmotes}/${room.emoteOccurrences} replies=${room.replies}`);
    console.log(`timestampFormats=${JSON.stringify(room.timestampFormats)} dupIds=${room.duplicateMessageIds} nameCollisions=${room.namesWithSeveralIds} renameCandidates=${room.idsWithSeveralNames.length}`);
    console.log(`payloadKeys=${Object.keys(room.payloadKeys).join(',')}`);
  }
  console.log(`\ncross-room shared sender ids: ${report.crossRoom.sharedSenderCount}`);
  console.log(`analysis: ${outPath}`);
}

main();
