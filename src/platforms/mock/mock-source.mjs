import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {EVENT_TYPES} from '../../shared/events.mjs';

/**
 * Simulated live source.
 *
 * Purpose: prove the recording/aggregation pipeline end to end without any
 * platform credentials, and let the user explore the console immediately after
 * install. Events produced here are always tagged source_quality="mock" and the
 * UI labels the session as simulated — they are never presented as real data.
 */

const VIEWERS = [
  {uid: 'mock_1001', name: '星野つき', weight: 9},
  {uid: 'mock_1002', name: '夜航星', weight: 8},
  {uid: 'mock_1003', name: 'Yuki_Noise', weight: 7},
  {uid: 'mock_1004', name: 'かえで', weight: 6},
  {uid: 'mock_1005', name: '柏木凛', weight: 6},
  {uid: 'mock_1006', name: 'orange_soda', weight: 5},
  {uid: 'mock_1007', name: '夏目レイ', weight: 5},
  {uid: 'mock_1008', name: '一只小海豹', weight: 4},
  {uid: 'mock_1009', name: 'haru', weight: 4},
  {uid: 'mock_1010', name: '深海鱼缸', weight: 4},
  {uid: 'mock_1011', name: 'Mika', weight: 3},
  {uid: 'mock_1012', name: '竹取物语', weight: 3},
  {uid: 'mock_1013', name: 'sora_0421', weight: 3},
  {uid: 'mock_1014', name: '柠檬汽水', weight: 3},
  {uid: 'mock_1015', name: '東雲しおり', weight: 3},
  {uid: 'mock_1016', name: 'quiet_watcher', weight: 2},
  {uid: 'mock_1017', name: '听风的人', weight: 2},
  {uid: 'mock_1018', name: 'ナナシ', weight: 2},
  {uid: 'mock_1019', name: 'Lumen', weight: 2},
  {uid: 'mock_1020', name: '半糖去冰', weight: 2},
  {uid: 'mock_1021', name: 'Kite', weight: 1},
  {uid: 'mock_1022', name: '晚八点见', weight: 1},
  {uid: 'mock_1023', name: 'みかん箱', weight: 1},
  {uid: 'mock_1024', name: 'pixel_fox', weight: 1}
];

const TOPICS = [
  {
    id: 'game',
    messages: [
      '这关的 BOSS 是不是有点太肉了',
      '刚才那个闪避好帅',
      '这个游戏我也想玩，叫什么名字？',
      'BGM 好听，是哪个曲子的？',
      'このステージ難しすぎない？',
      'ナイスプレイ！',
      'that boss phase was insane',
      '第一次看直播，画面好清晰',
      '主播今天状态不错啊',
      '这个配装思路学到了',
      '这个剧情让我哭了😭😭',
      '太强了👏👏👏'
    ]
  },
  {
    id: 'music',
    messages: [
      '这首歌好适合深夜听',
      '能再唱一遍副歌吗',
      '声线好温柔',
      'この曲好きです',
      '歌枠うれしい',
      'the chorus gave me chills',
      '耳机党狂喜',
      '刚才高音稳得离谱',
      '这份歌单可以分享吗',
      '唱到这段的时候有点想哭',
      '今天太开心了😂❤️'
    ]
  },
  {
    id: 'chat',
    messages: [
      '晚上好呀',
      '今天加班到很晚，刚好赶上',
      'こんばんは！',
      '初見です、よろしく',
      'hi from Brazil, love the stream',
      '晚饭吃了吗',
      '这个背景音乐是新的吗',
      '明天还播吗',
      '周末有联动吗',
      '辛苦了，记得喝水',
      '今天也来了🙌'
    ]
  },
  {
    id: 'food',
    messages: [
      '今天晚饭吃的什么',
      '这个零食看起来好好吃',
      '深夜放毒行为',
      'ラーメン食べたい',
      '我在吃泡面，羡慕',
      'the food segment is my favourite',
      '原来这种做法也可以',
      '下次试试看',
      '好饿，突然',
      '求个食谱'
    ]
  },
  {
    id: 'support',
    messages: [
      '一直支持你',
      '今天也来打卡了',
      '応援しています！',
      '新衣服好好看',
      '背景是自己画的吗',
      '这条弹幕来自第五次观看',
      'always here for the streams',
      '记得早点休息',
      '每次看你直播都很放松',
      '谢谢你的陪伴'
    ]
  }
];

const GIFTS = [
  {id: 'gift_lollipop', name: '棒棒糖', unitMinor: 100, weight: 26, paid: true},
  {id: 'gift_heart', name: '小心心', unitMinor: 10, weight: 22, paid: true},
  {id: 'gift_flower', name: '小花花', unitMinor: 50, weight: 16, paid: true},
  {id: 'gift_call', name: '打call', unitMinor: 500, weight: 10, paid: true},
  {id: 'gift_rocket', name: '火箭', unitMinor: 10000, weight: 3, paid: true},
  {id: 'gift_free_biscuit', name: '辣条', unitMinor: 0, weight: 18, paid: false}
];

const SUPER_CHATS = [
  {text: '第一次发 SC，希望能被念到名字！', unitMinor: 3000},
  {text: '応援しています、無理しないでね', unitMinor: 5000},
  {text: 'thank you for the late night stream', unitMinor: 2000},
  {text: '刚才那一段真的很好笑，求切片', unitMinor: 1000}
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockLiveSource extends PlatformAdapter {
  constructor({sessionId, roomTitle = '模拟直播', seed = Date.now(), now = () => Date.now()} = {}) {
    super({id: 'mock', platform: 'mock', label: 'Simulation', capabilities: ['chat', 'gift', 'super_chat', 'guard']});
    this.sessionId = sessionId;
    this.roomTitle = roomTitle;
    this.random = mulberry32(seed);
    this.now = now;
    this.counter = 0;
    this.tickCount = 0;
    this.timer = null;
    this.topic = TOPICS[0];
    this.onEvent = null;
    this.lastDelivered = null;
  }

  #pick(list) {
    const total = list.reduce((sum, item) => sum + (item.weight ?? 1), 0);
    let roll = this.random() * total;
    for (const item of list) {
      roll -= item.weight ?? 1;
      if (roll <= 0) return item;
    }
    return list[list.length - 1];
  }

  #nextExternalId() {
    this.counter += 1;
    return `mock-${this.sessionId}-${this.counter}`;
  }

  #baseEvent(occurredAt) {
    return {
      session_id: this.sessionId,
      platform: 'mock',
      external_id: this.#nextExternalId(),
      occurred_at: occurredAt,
      received_at: this.now(),
      source_quality: 'mock'
    };
  }

  /** Produce the next event batch and hand it to the ingest callback. */
  tick(batchSize = null) {
    if (!this.onEvent) return [];
    this.tickCount += 1;
    if (this.tickCount % 45 === 0) {
      this.topic = TOPICS[Math.floor(this.random() * TOPICS.length)];
    }
    const now = this.now();
    const batch = [];
    const size = batchSize ?? (this.random() < 0.18 ? 2 : 1);
    for (let index = 0; index < size; index += 1) {
      const occurredAt = now - Math.floor(this.random() * 400);
      batch.push(this.#compose(occurredAt));
    }

    // Occasionally re-deliver a previous event exactly as a flaky transport
    // would: the ingest pipeline must ignore it instead of double counting.
    if (this.lastDelivered && this.random() < 0.03) {
      batch.push({...this.lastDelivered});
    }
    this.lastDelivered = batch[batch.length - 1] ?? null;
    for (const event of batch) this.onEvent(event);
    return batch;
  }

  #compose(occurredAt) {
    const viewer = this.#pick(VIEWERS);
    const roll = this.random();
    const base = this.#baseEvent(occurredAt);
    const identity = {viewer_uid: viewer.uid, display_name: viewer.name};

    if (roll < 0.035) {
      const gift = this.#pick(GIFTS);
      const quantity = this.random() < 0.15 ? 1 + Math.floor(this.random() * 5) : 1;
      return {
        ...base,
        ...identity,
        event_type: EVENT_TYPES.GIFT,
        gift_id: gift.id,
        gift_name: gift.name,
        gift_type: gift.paid ? 'paid' : 'free',
        gift_quantity: quantity,
        unit_amount_minor: gift.paid ? gift.unitMinor : 0,
        amount_minor: gift.paid ? gift.unitMinor * quantity : 0,
        currency: 'CNY',
        value_kind: gift.paid ? 'actual' : 'unknown',
        is_paid: gift.paid
      };
    }
    if (roll < 0.045) {
      const superChat = SUPER_CHATS[Math.floor(this.random() * SUPER_CHATS.length)];
      return {
        ...base,
        ...identity,
        event_type: EVENT_TYPES.SUPER_CHAT,
        content: superChat.text,
        unit_amount_minor: superChat.unitMinor,
        amount_minor: superChat.unitMinor,
        currency: 'CNY',
        value_kind: 'actual',
        is_paid: true
      };
    }
    if (roll < 0.05) {
      return {
        ...base,
        ...identity,
        event_type: EVENT_TYPES.GUARD,
        gift_id: 'guard_captain',
        gift_name: '舰长',
        gift_type: 'paid',
        gift_quantity: 1,
        unit_amount_minor: 13800,
        amount_minor: 13800,
        currency: 'CNY',
        value_kind: 'actual',
        is_paid: true
      };
    }
    // Emoji / platform-emote samples. The first keeps the platform text label
    // and adds its metadata; the second has no text at all and exercises the
    // UI/AI fallback for an emote-only message.
    const emoteRoll = this.random();
    if (emoteRoll < 0.06) {
      return {
        ...base,
        ...identity,
        event_type: EVENT_TYPES.CHAT,
        content: '今天这个剧情太好笑了😂[猫猫鼓掌]',
        emotes: [{id: 'mock_cat_clap', code: '[猫猫鼓掌]', name: '猫猫鼓掌', source: 'mock'}]
      };
    }
    if (emoteRoll < 0.08) {
      return {
        ...base,
        ...identity,
        event_type: EVENT_TYPES.CHAT,
        content: null,
        emotes: [{id: 'mock_emote_wave', name: '挥手', source: 'mock'}]
      };
    }
    return {
      ...base,
      ...identity,
      event_type: EVENT_TYPES.CHAT,
      content: this.topic.messages[Math.floor(this.random() * this.topic.messages.length)]
    };
  }

  async start({onEvent, onStateChange, intervalMs = 750} = {}) {
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.setState(CONNECTION_STATE.CONNECTED, {simulated: true});
    if (this.timer) clearInterval(this.timer);
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.tick(), intervalMs);
      this.timer.unref?.();
    }
    return this.snapshot();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onEvent = null;
    this.setState(CONNECTION_STATE.STOPPED);
  }
}

/** Personas are exported so tests and fixtures can reuse the same identities. */
export const MOCK_VIEWERS = Object.freeze(VIEWERS.map((viewer) => ({...viewer})));
export const MOCK_TOPICS = Object.freeze(TOPICS.map((topic) => topic.id));
