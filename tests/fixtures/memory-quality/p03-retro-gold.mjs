/**
 * Retrospective gold annotations for the synthetic P0-3 corpus.
 *
 * The P0-3 paid A/B used a fixed 16-phrase cycle, repeated per viewer. The
 * messages are synthetic and public in `scripts/ai-paid-acceptance.mjs`; the
 * *annotations* below were written for this quality audit and are never part of
 * a model prompt. They are deliberately conservative:
 *
 *   - only durable personal facts are `shouldPersist: true`;
 *   - one-day events, jokes, praise of the streamer and pure questions are
 *     either `false` (must not be saved) or `'ambiguous'` (listed separately,
 *     never counted as automatically correct);
 *   - the same phrase is annotated once and then expanded per viewer.
 *
 * This lets an archived real-provider run be re-scored offline without another
 * paid request. It is a *retrospective* annotation of a repetitive synthetic
 * corpus, not a claim that it represents real chat.
 */

export const P03_PHRASE_COUNT = 16;

const PHRASE_TEXT = {
  'zh-CN': [
    '吉他练了一个月，还是按不紧弦',
    '今天下班好晚，只能补录播',
    '猫又踩键盘了',
    '这周的作业终于交完了',
    '在东京留学，时差有点难受',
    '推荐一下适合新手的键盘',
    '第一次看直播，氛围很好',
    '刚搬到大阪，还在找好吃的拉面',
    '最近在学做菜，失败了三次',
    '这首歌的副歌太好听了',
    '明天要早起，先睡了',
    '有没有人一起打游戏',
    '工作压力大，听直播放松',
    '今天生日，来许个愿',
    '画画卡在配色上',
    '这期节目的剪辑好厉害'
  ],
  ja: [
    'ギターを始めて一ヶ月、まだコードが押さえられない',
    '今日は残業で配信をリアルタイムで見られなかった',
    '猫がまたキーボードを踏んだ',
    '今週の課題をやっと出せた',
    '東京に留学中で、時差がつらい',
    '初心者向けのキーボードを教えてほしい',
    '初めて見ました、雰囲気がいいですね',
    '大阪に引っ越したばかりで、美味しいラーメンを探しています',
    '最近料理を練習中、三回失敗した',
    'この曲のサビが本当に好き',
    '明日は早起きなのでもう寝ます',
    '一緒にゲームする人いますか',
    '仕事が大変で、配信を聞いて落ち着いています',
    '今日誕生日なので願い事をします',
    '絵の色選びで止まっている',
    '今回の編集すごく上手'
  ],
  en: [
    'I started learning guitar last month',
    'Could not watch live today because of work',
    'My cat stepped on the keyboard again',
    'Finally submitted this week assignment',
    'Studying in Tokyo, the time zone is rough',
    'Any beginner keyboard recommendations?',
    'First time here, great atmosphere',
    'Just moved to Osaka, looking for good ramen',
    'Learning to cook, failed three times',
    'The chorus of this song is amazing',
    'Need to wake up early tomorrow, good night',
    'Anyone want to play games together?',
    'Work is stressful, the stream helps me relax',
    'It is my birthday today, making a wish',
    'Stuck on color choices for my drawing',
    'The editing this time is really good'
  ]
};

/**
 * One annotation per phrase. `gold` entries may contain more than one fact when
 * one message states two independent durable things (phrase 7: moved + ramen).
 */
export const P03_PHRASE_ANNOTATION = Object.freeze([
  {
    index: 0,
    text: PHRASE_TEXT,
    gold: [{
      key: 'guitar',
      category: 'interest',
      importance: 'medium',
      statement: {zh: '正在学吉他', ja: 'ギターを始めた'},
      aliases: {zh: ['吉他', '练吉他', '学吉他'], ja: ['ギター', 'コード']}
    }]
  },
  {
    index: 1,
    text: PHRASE_TEXT,
    negative: {
      category: 'temporary',
      reason: 'One-day late shift. Employment could be inferred, but the message itself is a temporary event and must not become a schedule fact.'
    }
  },
  {
    index: 2,
    text: PHRASE_TEXT,
    gold: [{
      key: 'cat',
      category: 'identity',
      importance: 'medium',
      statement: {zh: '养猫', ja: '猫を飼っている'},
      aliases: {zh: ['猫', '养猫'], ja: ['猫', '飼って']}
    }]
  },
  {
    index: 3,
    text: PHRASE_TEXT,
    gold: [{
      key: 'student',
      category: 'identity',
      importance: 'medium',
      statement: {zh: '学生（有作业）', ja: '学生（課題がある）'},
      aliases: {zh: ['作业', '学业', '学生'], ja: ['課題', '学生', '宿題']}
    }]
  },
  {
    index: 4,
    text: PHRASE_TEXT,
    gold: [{
      key: 'tokyo-study',
      category: 'identity',
      importance: 'high',
      statement: {zh: '在东京留学', ja: '東京に留学中'},
      aliases: {zh: ['东京留学', '留学'], ja: ['東京', '留学']}
    }]
  },
  {
    index: 5,
    text: PHRASE_TEXT,
    ambiguous: {
      key: 'keyboard-question',
      category: 'interest',
      statement: {zh: '询问适合新手的键盘（兴趣不明确）', ja: '初心者向けキーボードを質問（興味は不明確）'},
      aliases: {zh: ['键盘', '新手键盘'], ja: ['キーボード']},
      reason: 'A request for recommendations is not the viewer explicitly stating a long-term interest; it can be read either way.'
    }
  },
  {
    index: 6,
    text: PHRASE_TEXT,
    gold: [{
      key: 'first-time',
      category: 'community',
      importance: 'low',
      statement: {zh: '第一次看这个直播', ja: '初めてこの配信を見た'},
      aliases: {zh: ['第一次看', '首次观看', '初看'], ja: ['初めて', '初視聴']}
    }]
  },
  {
    index: 7,
    text: PHRASE_TEXT,
    gold: [
      {
        key: 'moved-osaka',
        category: 'life_event',
        importance: 'high',
        statement: {zh: '刚搬到大阪', ja: '大阪に引っ越したばかり'},
        aliases: {zh: ['搬到大阪', '搬家', '大阪'], ja: ['大阪', '引っ越し']}
      },
      {
        key: 'ramen',
        category: 'preference',
        importance: 'medium',
        statement: {zh: '喜欢拉面', ja: 'ラーメンが好き'},
        aliases: {zh: ['拉面'], ja: ['ラーメン']}
      }
    ]
  },
  {
    index: 8,
    text: PHRASE_TEXT,
    gold: [{
      key: 'cooking',
      category: 'interest',
      importance: 'medium',
      statement: {zh: '正在学做菜', ja: '料理を練習している'},
      aliases: {zh: ['做菜', '学做菜', '料理'], ja: ['料理', '自炊']}
    }]
  },
  {
    index: 9,
    text: PHRASE_TEXT,
    negative: {
      category: 'transient',
      reason: 'Praise for one song is a momentary reaction, not a durable personal preference.'
    }
  },
  {
    index: 10,
    text: PHRASE_TEXT,
    negative: {
      category: 'temporary',
      reason: 'A one-day plan ("wake up early tomorrow") has no long-term value.'
    }
  },
  {
    index: 11,
    text: PHRASE_TEXT,
    gold: [{
      key: 'games',
      category: 'interest',
      importance: 'medium',
      statement: {zh: '打游戏', ja: 'ゲームをする'},
      aliases: {zh: ['游戏', '打游戏'], ja: ['ゲーム']}
    }]
  },
  {
    index: 12,
    text: PHRASE_TEXT,
    gold: [{
      key: 'relax-with-stream',
      category: 'preference',
      importance: 'medium',
      statement: {zh: '听直播放松', ja: '配信を聞いて落ち着く'},
      aliases: {zh: ['放松', '听直播'], ja: ['落ち着', 'リラックス']}
    }]
  },
  {
    index: 13,
    text: PHRASE_TEXT,
    ambiguous: {
      key: 'birthday',
      category: 'life_event',
      statement: {zh: '今天生日（未提供日期）', ja: '今日誕生日（日付なし）'},
      aliases: {zh: ['生日'], ja: ['誕生日']},
      reason: 'A one-day birthday greeting can be a durable date or a passing event; the message does not state a date, so it is listed separately.'
    }
  },
  {
    index: 14,
    text: PHRASE_TEXT,
    gold: [{
      key: 'drawing',
      category: 'interest',
      importance: 'medium',
      statement: {zh: '画画', ja: '絵を描く'},
      aliases: {zh: ['画画', '配色'], ja: ['絵', '色選び']}
    }]
  },
  {
    index: 15,
    text: PHRASE_TEXT,
    negative: {
      category: 'not_viewer_fact',
      reason: 'Praise for the streamer\'s editing is not a fact about the viewer.'
    }
  }
]);

/** Viewer index -> phrase indices, exactly as the P0-3 seed cycles messages. */
export function phrasesForViewer(viewerIndex, {viewerCount = 25, messageCount = 200} = {}) {
  const indices = [];
  const seen = new Set();
  for (let index = viewerIndex; index < messageCount; index += viewerCount) {
    const phrase = index % P03_PHRASE_COUNT;
    if (!seen.has(phrase)) {
      seen.add(phrase);
      indices.push(phrase);
    }
  }
  return indices;
}

/**
 * Expand the phrase annotations to a full viewer-level gold set.
 *
 * @param {object} options
 * @param {string} options.sessionKey stable session id
 * @param {string} options.viewerPrefix stable viewer id prefix (without index)
 * @param {string} options.locale zh-CN | ja | en
 * @param {number} options.viewerCount
 * @param {number} options.messageCount
 */
export function buildP03Gold({
  sessionKey = 'ses_p03_ab',
  viewerPrefix = 'youtube:UC_P03_ses_p03_ab_',
  locale = 'zh-CN',
  viewerCount = 25,
  messageCount = 200
} = {}) {
  const lang = locale === 'ja' ? 'ja' : (locale === 'en' ? 'en' : 'zh');
  const goldFacts = [];
  const negatives = [];
  const viewers = [];
  for (let viewerIndex = 0; viewerIndex < viewerCount; viewerIndex += 1) {
    const viewerKey = `${viewerPrefix}${viewerIndex}`;
    const phrases = phrasesForViewer(viewerIndex, {viewerCount, messageCount});
    const messages = [];
    for (let index = viewerIndex; index < messageCount; index += viewerCount) {
      messages.push({
        seq: index + 1,
        phrase: index % P03_PHRASE_COUNT,
        eventKey: `${sessionKey}#${index + 1}`,
        content: PHRASE_TEXT[locale]?.[index % P03_PHRASE_COUNT] ?? PHRASE_TEXT.en[index % P03_PHRASE_COUNT]
      });
    }
    viewers.push({viewerKey, phrases, messages});
    for (const phraseIndex of phrases) {
      const annotation = P03_PHRASE_ANNOTATION[phraseIndex];
      const source = annotation.gold
        ? annotation.gold
        : (annotation.ambiguous ? [annotation.ambiguous] : []);
      for (const item of source) {
        const evidence = messages.filter((message) => message.phrase === phraseIndex);
        goldFacts.push({
          id: `${viewerKey}|${item.key}`,
          viewerKey,
          statement: item.statement?.[lang] ?? item.statement?.zh ?? item.key,
          aliases: item.aliases?.[lang] ?? item.aliases?.zh ?? [],
          category: item.category,
          importance: item.importance ?? 'medium',
          shouldPersist: annotation.ambiguous ? 'ambiguous' : true,
          ambiguous: Boolean(annotation.ambiguous),
          status: 'current',
          evidence: evidence.map((message) => ({
            sessionKey,
            seq: message.seq,
            eventKey: message.eventKey
          }))
        });
      }
      if (annotation.negative) {
        for (const message of messages.filter((entry) => entry.phrase === phraseIndex)) {
          negatives.push({
            id: `${viewerKey}|negative|${phraseIndex}`,
            viewerKey,
            sessionKey,
            seq: message.seq,
            eventKey: message.eventKey,
            content: message.content,
            reason: annotation.negative.reason,
            category: annotation.negative.category
          });
        }
      }
    }
  }
  return {sessionKey, locale, viewerCount, messageCount, goldFacts, negatives, viewers};
}
