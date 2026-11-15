import {BilibiliApi} from '../src/platforms/bilibili/api.mjs';
import {BilibiliLiveAdapter} from '../src/platforms/bilibili/adapter.mjs';
import {createHash} from 'node:crypto';

/**
 * Manual real-room verification for the Bilibili adapter.
 *
 *   node scripts/probe-bilibili.mjs [roomId] [seconds]
 *
 * It connects anonymously, prints which commands arrived and whether the
 * identity / money fields are present, and never prints message bodies or
 * cookies. Use it to re-check the field mapping after Bilibili changes its
 * payloads, then update docs/PLATFORM_INTEGRATIONS.md.
 */

const roomArg = Number(process.argv[2] ?? 7734200);
const seconds = Number(process.argv[3] ?? 25);

function shorten(value, max = 24) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function maskName(name) {
  const value = String(name ?? '');
  if (!value) return '(empty)';
  if (/\*{2,}/.test(value)) return `masked(${value.replace(/[^*]/g, 'x')})`;
  return `${value.slice(0, 1)}${'*'.repeat(Math.max(0, Math.min(6, value.length - 1)))}`;
}

function describeInfo(info) {
  if (!Array.isArray(info)) return 'info is not an array';
  return `info.length=${info.length}; ` + info.slice(0, 10).map((entry, index) => {
    if (index === 1 && typeof entry === 'string') return `[1]=string(${entry.length} chars, hidden)`;
    if (Array.isArray(entry)) return `[${index}]=array(${entry.length})`;
    if (entry && typeof entry === 'object') return `[${index}]=object{${Object.keys(entry).slice(0, 6).join(',')}}`;
    return `[${index}]=${typeof entry}`;
  }).join(' ');
}

async function main() {
  const api = new BilibiliApi({});
  const room = await api.roomInit(roomArg);
  const info = await api.roomInfo(room.roomId).catch(() => null);
  console.log(`room input ${roomArg} -> real room ${room.roomId} (short ${room.shortId ?? '-'}) live_status=${room.liveStatus}`);
  if (info) console.log(`title=${JSON.stringify(shorten(info.title, 40))} area=${info.parentAreaName}/${info.areaName} online=${info.online} anchor=${maskName(info.anchorName)}`);
  if (room.liveStatus !== 1) console.log('WARNING: the room is not live; few or no events will arrive. Pick another room id.');

  const stats = {
    commands: new Map(),
    mapped: new Map(),
    chat: 0,
    chatWithUid: 0,
    chatWithName: 0,
    maskedNames: 0,
    gift: 0,
    giftWithUid: 0,
    giftMoney: 0,
    freeGift: 0,
    sc: 0,
    guard: 0
  };
  const samples = {danmuInfo: null, chat: null, gift: null, sc: null, guard: null};

  const adapter = new BilibiliLiveAdapter({
    roomId: room.roomId,
    logger: {
      info: (record) => {
        if (record.event?.startsWith('bilibili.connect')) console.log(`[adapter] ${record.event} ${JSON.stringify(record)}`);
      },
      warn: (record) => console.log(`[adapter:warn] ${JSON.stringify(record)}`),
      debug: (record) => {
        if (record.event === 'bilibili.unhandled') stats.commands.set(`debug:${record.cmd}`, (stats.commands.get(`debug:${record.cmd}`) ?? 0) + 1);
      }
    }
  });

  // Raw capture: wrap onEvent to inspect drafts, and hook the socket message
  // stream separately for command statistics.
  const originalHandle = adapter['#handleData'];
  void originalHandle;

  adapter.onEvent = () => {};
  const startedAt = Date.now();
  adapter.onStateChange = (status) => {
    console.log(`[status] ${status.state} ${status.detail ? JSON.stringify(status.detail) : ''}`);
  };

  await adapter.start({
    onEvent: (draft) => {
      const kind = draft.event_type;
      stats.mapped.set(kind, (stats.mapped.get(kind) ?? 0) + 1);
      if (kind === 'chat') {
        stats.chat += 1;
        if (draft.viewer_uid) stats.chatWithUid += 1;
        if (draft.display_name) stats.chatWithName += 1;
        if (/\*{2,}/.test(String(draft.display_name ?? ''))) stats.maskedNames += 1;
        if (!samples.chat) samples.chat = {uid: draft.viewer_uid, name: maskName(draft.display_name), occurredAt: draft.occurred_at, quality: draft.source_quality};
      } else if (kind === 'gift') {
        stats.gift += 1;
        if (draft.viewer_uid) stats.giftWithUid += 1;
        if (draft.amount_minor !== null) stats.giftMoney += 1;
        if (draft.is_paid === false) stats.freeGift += 1;
        if (!samples.gift) {
          samples.gift = {
            uid: draft.viewer_uid,
            name: maskName(draft.display_name),
            giftName: draft.gift_name,
            quantity: draft.gift_quantity,
            amountMinor: draft.amount_minor,
            currency: draft.currency,
            valueKind: draft.value_kind,
            paid: draft.is_paid,
            coinType: draft.raw_coin_type
          };
        }
      } else if (kind === 'super_chat') {
        stats.sc += 1;
        if (!samples.sc) samples.sc = {uid: draft.viewer_uid, name: maskName(draft.display_name), amountMinor: draft.amount_minor, currency: draft.currency, valueKind: draft.value_kind};
      } else if (kind === 'guard') {
        stats.guard += 1;
        if (!samples.guard) samples.guard = {uid: draft.viewer_uid, name: maskName(draft.display_name), level: draft.guard_level, quantity: draft.gift_quantity, amountMinor: draft.amount_minor, valueKind: draft.value_kind};
      }
    }
  });

  console.log(`connected in ${Date.now() - startedAt} ms, collecting ${seconds}s…`);
  console.log('[status]', JSON.stringify(adapter.snapshot().detail));

  // Command statistics need a lower-level hook: wrap the socket send/receive by
  // re-reading the packets in a message listener registered on the same socket.
  const socket = adapter.ws;
  if (socket) {
    socket.addEventListener('message', async (event) => {
      try {
        const {decodePackets} = await import('../src/platforms/bilibili/protocol.mjs');
        const {normalizeCommand} = await import('../src/platforms/bilibili/protocol.mjs');
        const raw = event.data;
        const buffer = typeof raw === 'string'
          ? null
          : (raw instanceof ArrayBuffer ? Buffer.from(raw) : (ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.from(await raw.arrayBuffer())));
        if (!buffer) return;
        for (const packet of decodePackets(buffer)) {
          if (packet.op !== 5 || !packet.json) continue;
          const entries = Array.isArray(packet.json) ? packet.json : [packet.json];
          for (const entry of entries) {
            const cmd = normalizeCommand(entry?.cmd);
            if (!cmd) continue;
            stats.commands.set(cmd, (stats.commands.get(cmd) ?? 0) + 1);
            if (cmd === 'DANMU_MSG' && !samples.danmuInfo) {
              const info = entry.data?.info;
              samples.danmuInfo = {
                dataKeys: Object.keys(entry.data ?? {}).slice(0, 10),
                infoIsArray: Array.isArray(info),
                info: describeInfo(info),
                info2: Array.isArray(info?.[2]) ? {uid: info[2][0], uname: maskName(info[2][1])} : null,
                info1: typeof info?.[1] === 'string' ? `string(${info[1].length} chars)` : (Array.isArray(info?.[1]) ? `array(${info[1].length})` : typeof info?.[1]),
                info7GuardLevel: info?.[7] ?? null,
                info9: info?.[9] ? Object.keys(info[9]) : null,
                info9ts: info?.[9]?.ts ?? null
              };
            }
            if (cmd === 'SEND_GIFT' && !samples.giftRaw) {
              const d = entry.data ?? {};
              samples.giftRaw = {
                keys: Object.keys(d).slice(0, 30),
                uid: d.uid ?? null,
                uname: maskName(d.uname),
                num: d.num,
                price: d.price,
                total_coin: d.total_coin,
                coin_type: d.coin_type,
                giftId: d.giftId,
                timestamp: d.timestamp
              };
            }
            if (cmd === 'SEND_GIFT_V2' && !samples.giftV2Raw) {
              const d = entry.data ?? {};
              samples.giftV2Raw = {keys: Object.keys(d).slice(0, 20), pbLength: typeof d.pb === 'string' ? d.pb.length : null};
            }
            if (cmd === 'SUPER_CHAT_MESSAGE' && !samples.scRaw) {
              const d = entry.data ?? {};
              samples.scRaw = {id: d.id, price: d.price, hasUserInfo: Boolean(d.user_info), uid: d.uid ?? d.user_info?.uid, uname: maskName(d.user_info?.uname), start_time: d.start_time, time: d.time};
            }
            if ((cmd === 'GUARD_BUY' || cmd === 'USER_TOAST_MSG' || cmd === 'USER_TOAST_MSG_V2') && !samples.guardRaw) {
              samples.guardRaw = {cmd, keys: Object.keys(entry.data ?? {}).slice(0, 24), level: entry.data?.guard_level ?? entry.data?.guard_info?.guard_level, price: entry.data?.price ?? entry.data?.pay_info?.price};
            }
          }
        }
      } catch (error) {
        /* the production adapter already logs decode failures */
      }
    });
  }

  await new Promise((done) => setTimeout(done, seconds * 1000));
  await adapter.stop();

  console.log('\n=== commands received ===');
  console.log([...stats.commands.entries()].sort((a, b) => b[1] - a[1]).map(([cmd, count]) => `${cmd}=${count}`).join('\n') || '(none)');
  console.log('\n=== mapped events ===');
  console.log([...stats.mapped.entries()].map(([kind, count]) => `${kind}=${count}`).join(' ') || '(none)');
  console.log('\n=== identity ===');
  console.log(`chat=${stats.chat} withUid=${stats.chatWithUid} withName=${stats.chatWithName} masked=${stats.maskedNames}`);
  console.log(`gift=${stats.gift} withUid=${stats.giftWithUid} withMoney=${stats.giftMoney} free=${stats.freeGift} sc=${stats.sc} guard=${stats.guard}`);
  console.log('\n=== samples (content hidden) ===');
  console.log(JSON.stringify(samples, null, 2));
  console.log('\nsha256 of room id (for the log):', createHash('sha256').update(String(room.roomId)).digest('hex').slice(0, 12));
}

main().catch((error) => {
  console.error('probe failed:', error?.code ?? error?.name, error?.message ?? error);
  process.exitCode = 1;
});
