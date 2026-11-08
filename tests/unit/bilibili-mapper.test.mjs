import test from 'node:test';
import assert from 'node:assert/strict';
import {
  goldCoinsToMinor,
  mapBilibiliMessage,
  readDanmu,
  toOccurredAt
} from '../../src/platforms/bilibili/mapper.mjs';

const RECEIVED = 1_700_000_000_000;

function danmu({uid = 12345, name = 'Viewer', text = 'hello', ts = RECEIVED} = {}) {
  return {
    cmd: 'DANMU_MSG:4:0:2:2:2:0',
    data: {
      info: [
        [],
        text,
        [uid, name, 0, 0, 0, 0, 0, 0],
        [21, 'Medal', 'Anchor', 5050, 0, 0, 0],
        [12],
        [0],
        5050,
        0,
        '',
        {ts}
      ]
    }
  };
}

test('chat keeps the platform UID and nickname separately', () => {
  const mapped = mapBilibiliMessage({...danmu(), receivedAt: RECEIVED});
  assert.equal(mapped.kind, 'chat');
  assert.equal(mapped.draft.viewer_uid, '12345');
  assert.equal(mapped.draft.display_name, 'Viewer');
  assert.equal(mapped.draft.content, 'hello');
  assert.equal(mapped.draft.occurred_at, RECEIVED);
  assert.equal(mapped.draft.event_type, 'chat');
  assert.equal(mapped.draft.is_paid, false);
});

test('uid 0 is treated as missing so anonymous viewers are not merged', () => {
  const mapped = mapBilibiliMessage({...danmu({uid: 0, name: 'Visitor'}), receivedAt: RECEIVED});
  assert.equal(mapped.draft.viewer_uid, null);
  assert.equal(mapped.draft.display_name, 'Visitor');
  assert.equal(mapped.draft.identity_complete, false);
  assert.equal(mapped.draft.source_quality, 'unknown');
});

test('a masked nickname is kept as sent, never guessed', () => {
  const mapped = mapBilibiliMessage({...danmu({name: '电***'}), receivedAt: RECEIVED});
  assert.equal(mapped.draft.display_name, '电***');
  assert.equal(mapped.draft.viewer_uid, '12345');
});

test('a paid gift converts gold coins to fen (1000 coins = 1 yuan)', () => {
  const mapped = mapBilibiliMessage({
    cmd: 'SEND_GIFT',
    data: {uid: 7, uname: 'Giver', giftId: 31036, giftName: '小电视', num: 2, price: 100, total_coin: 200, coin_type: 'gold', tid: 'tid-1', timestamp: 1_700_000_000},
    receivedAt: RECEIVED
  });
  assert.equal(mapped.draft.amount_minor, 20);
  assert.equal(mapped.draft.unit_amount_minor, 10);
  assert.equal(mapped.draft.currency, 'CNY');
  assert.equal(mapped.draft.value_kind, 'actual');
  assert.equal(mapped.draft.gift_quantity, 2);
  assert.equal(mapped.draft.external_id, 'gift:tid-1');
  assert.equal(mapped.draft.is_paid, true);
});

test('a free (silver) gift never adds money', () => {
  const mapped = mapBilibiliMessage({
    cmd: 'SEND_GIFT',
    data: {uid: 7, uname: 'Free', giftId: 1, giftName: '小心心', num: 5, price: 0, total_coin: 0, coin_type: 'silver', tid: 'tid-2'},
    receivedAt: RECEIVED
  });
  assert.equal(mapped.draft.amount_minor, null);
  assert.equal(mapped.draft.is_paid, false);
  assert.equal(mapped.draft.gift_type, 'free');
  assert.equal(mapped.draft.value_kind, 'unknown');
});

test('an amount that cannot be expressed exactly in fen is marked as display value', () => {
  const mapped = mapBilibiliMessage({
    cmd: 'SEND_GIFT',
    data: {uid: 7, uname: 'Odd', giftId: 1, giftName: 'Odd', num: 1, price: 15, total_coin: 15, coin_type: 'gold', tid: 'tid-3'},
    receivedAt: RECEIVED
  });
  assert.equal(mapped.draft.amount_minor, 2);
  assert.equal(mapped.draft.value_kind, 'display');
});

test('super chat amounts are already in yuan', () => {
  const mapped = mapBilibiliMessage({
    cmd: 'SUPER_CHAT_MESSAGE',
    data: {id: 999, uid: 777, user_info: {uname: 'SCUser'}, message: 'nice', price: 50, start_time: 1_700_000_000},
    receivedAt: RECEIVED
  });
  assert.equal(mapped.kind, 'super_chat');
  assert.equal(mapped.draft.amount_minor, 5000);
  assert.equal(mapped.draft.currency, 'CNY');
  assert.equal(mapped.draft.value_kind, 'actual');
  assert.equal(mapped.draft.external_id, 'sc:999');
  assert.equal(mapped.draft.content, 'nice');
});

test('guard events are recorded but their unconfirmed price is not booked', () => {
  const mapped = mapBilibiliMessage({
    cmd: 'GUARD_BUY',
    data: {uid: 555, username: 'GuardUser', guard_level: 3, num: 1, price: 198000, start_time: 1_700_000_000, payflow_id: 'pf-1'},
    receivedAt: RECEIVED
  });
  assert.equal(mapped.kind, 'guard');
  assert.equal(mapped.draft.amount_minor, null);
  assert.equal(mapped.draft.value_kind, 'unknown');
  assert.equal(mapped.draft.is_paid, true);
  assert.equal(mapped.draft.gift_id, 'guard_3');
  assert.equal(mapped.draft.external_id, 'guard:pf-1');
  assert.equal(mapped.draft.source_quality, 'estimated');
});

test('a supplementary toast (source != 0) does not replay the purchase', () => {
  const mapped = mapBilibiliMessage({
    cmd: 'USER_TOAST_MSG',
    data: {uid: 555, username: 'GuardUser', guard_level: 3, num: 1, price: 198000, start_time: 1_700_000_000, source: 7},
    receivedAt: RECEIVED
  });
  assert.equal(mapped, null);
});

test('V2 guard toasts read the nested sender/pay structures', () => {
  const mapped = mapBilibiliMessage({
    cmd: 'USER_TOAST_MSG_V2',
    data: {
      sender_uinfo: {uid: 888, base: {name: 'NestedGuard'}},
      guard_info: {guard_level: 2, start_time: 1_700_000_000},
      pay_info: {num: 1, price: 100000, unit: 'gold'},
      option: {source: 0},
      payflow_id: 'pf-2'
    },
    receivedAt: RECEIVED
  });
  assert.equal(mapped.draft.viewer_uid, '888');
  assert.equal(mapped.draft.display_name, 'NestedGuard');
  assert.equal(mapped.draft.guard_level, 2);
});

test('unknown commands are ignored instead of producing partial events', () => {
  assert.equal(mapBilibiliMessage({cmd: 'INTERACT_WORD', data: {}, receivedAt: RECEIVED}), null);
  assert.equal(mapBilibiliMessage({cmd: 'SEND_GIFT', data: {num: 0}, receivedAt: RECEIVED}), null);
});

test('timestamps accept seconds and milliseconds', () => {
  assert.equal(toOccurredAt(1_700_000_000, 0), 1_700_000_000_000);
  assert.equal(toOccurredAt(1_700_000_000_123, 0), 1_700_000_000_123);
  assert.equal(toOccurredAt(0, 42), 42);
  assert.equal(toOccurredAt(null, 42), 42);
});

test('gold coin conversion is exact where the platform units divide evenly', () => {
  assert.deepEqual(goldCoinsToMinor(1000), {amountMinor: 100, exact: true});
  assert.deepEqual(goldCoinsToMinor(9900), {amountMinor: 990, exact: true});
  assert.deepEqual(goldCoinsToMinor(15), {amountMinor: 2, exact: false});
  assert.deepEqual(goldCoinsToMinor(null), {amountMinor: null, exact: false});
});

test('readDanmu falls back to the older user-array position', () => {
  const parsed = readDanmu([['legacy text'], [123, 'Legacy'], undefined, [], [], [], 0, 0, 0, {ts: RECEIVED}]);
  assert.equal(parsed.content, 'legacy text');
  assert.equal(parsed.uid, 123);
  assert.equal(parsed.name, 'Legacy');
});
