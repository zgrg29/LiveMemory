/**
 * Human-annotated synthetic long-term-memory corpus (RC0-MEMORY-QUALITY).
 *
 * The corpus is intentionally *not* generated from the gold answers: the
 * messages are written first, then annotated. Gold annotations live only in this
 * file and are never added to an analysis package. The integration test asserts
 * that no gold statement/alias appears in any prompt file.
 *
 * Coverage (required by the task):
 *   1. explicit long-term interests
 *   2. explicit occupation / study
 *   3. explicit future plans
 *   4. explicit long-term preferences
 *   5. temporary emotions                      -> not saved
 *   6. jokes / irony                           -> not saved
 *   7. denial of a previous statement          -> old fact superseded/outdated
 *   8. update of an old fact                   -> supersedes
 *   9. several viewers discussing one topic    -> viewer isolation
 *  10. one viewer across sessions              -> stable identity + history
 *  11. zh / ja / en mixed chat                 -> tri-lingual output
 *  12. high-frequency and low-frequency viewers
 *  13. many meaningless short messages
 *  14. ambiguous identity / nickname change    -> stable id, no name merge
 *  15. sensitive / speculative / no-value info -> not saved
 */

const BROADCASTER_ID = 'youtube:UC_GQ_BROADCASTER';

function viewerId(key) {
  return `youtube:UC_GQ_${key}`;
}

const S1 = Date.parse('2026-11-01T10:00:00.000Z');
const S2 = Date.parse('2026-11-08T10:00:00.000Z');
const S3 = Date.parse('2026-11-15T10:00:00.000Z');

const RAW_SESSIONS = [
  {
    key: 's1',
    id: 'ses_gq_s1',
    startedAt: S1,
    title: 'GQ synthetic session 1',
    messages: [
      {key: 's1.m01', viewer: 'haru', name: 'Haru', content: '最近ギターを始めたばかりで、コードが押さえられない'},
      {key: 's1.m02', viewer: 'mika', name: 'ミカ', content: '看護師として働いています。今日は疲れすぎた'},
      {key: 's1.m03', viewer: 'ken', name: 'Ken', content: 'I work as a chef at a small restaurant'},
      {key: 's1.m04', viewer: 'lin', name: '小林', content: '我是高中生，明年要高考'},
      {key: 's1.m05', viewer: 'aoi', name: 'あおい', content: '大阪に住んでいます。辛い食べ物が好き'},
      {key: 's1.m06', viewer: 'yuki', name: 'ユキ', content: '趣味は絵を描くことです'},
      {key: 's1.m07', viewer: 'sora', name: 'Sora', content: 'I play guitar every day'},
      {key: 's1.m08', viewer: 'multi', name: '贝斯手', content: '我弹贝斯，最近在练slap'},
      {key: 's1.m09', viewer: 'nick_a', name: 'Alex', content: "I'm learning Japanese, still a beginner"},
      {key: 's1.m10', viewer: 'nick_b', name: 'Alex', content: 'I work in finance in Singapore'},
      {key: 's1.m11', viewer: 'rin', name: 'Rin', content: '我养了一只橘猫'},
      {key: 's1.m12', viewer: 'tomo', name: 'トモ', content: '来年、日本一周旅行をしたい'},
      {key: 's1.m13', viewer: 'kai', name: 'Kai', content: 'I love spicy food and I hate waking up early'},
      {key: 's1.m14', viewer: 'mei', name: 'Mei', content: '明年去英国读研，现在在准备雅思'},
      {key: 's1.m15', viewer: 'haru', name: 'Haru', content: '来年の春に日本へ旅行したい'},
      {key: 's1.m16', viewer: 'mika', name: 'ミカ', content: '夜勤が多いです'},
      {key: 's1.m17', viewer: 'ken', name: 'Ken', content: 'I hate horror games, they scare me'},
      {key: 's1.m18', viewer: 'lin', name: '小林', content: '最近在玩RPG，特别喜欢剧情'},
      {key: 's1.m19', viewer: 'aoi', name: 'あおい', content: '私は大阪の女王です👑'},
      {key: 's1.m20', viewer: 'sora', name: 'Sora', content: 'I prefer acoustic guitar over electric'},
      {key: 's1.m21', viewer: 'nick_a', name: 'Alex', content: 'I practice Japanese every night'},
      {key: 's1.m22', viewer: 'spam', name: 'ww', content: 'wwww'},
      {key: 's1.m23', viewer: 'spam', name: 'ww', content: '草'},
      {key: 's1.m24', viewer: 'spam', name: 'ww', content: '888'},
      {key: 's1.m25', viewer: 'spam', name: 'ww', content: '😂😂😂'},
      {key: 's1.m26', viewer: 'rin', name: 'Rin', content: '最近在学做菜，老是失败'},
      {key: 's1.m27', viewer: 'giftonly', name: 'Gifter', type: 'gift', content: ''},
      {key: 's1.m28', viewer: 'haru', name: 'Haru', content: '大学院でコンピュータサイエンスを勉強している'},
      {key: 's1.m29', viewer: 'haru', name: 'Haru', content: '猫がキーボードを踏む'},
      {key: 's1.m30', viewer: 'ken', name: 'Ken', content: "I'm a millionaire, trust me 😂"},
      {key: 's1.m31', viewer: 'ken', name: 'Ken', content: 'My friend is a doctor in London'},
      {key: 's1.m32', viewer: 'lin', name: '小林', content: '今天好累，先睡了'},
      {key: 's1.m33', viewer: 'mei', name: 'Mei', content: '今天面试好紧张'},
      {key: 's1.m34', viewer: 'tomo', name: 'トモ', content: '今日は雨で憂鬱'},
      {key: 's1.m35', viewer: 'spam', name: 'ww', content: '666'},
      {key: 's1.m36', viewer: 'spam', name: 'ww', content: 'www'},
      {key: 's1.m37', viewer: 'spam', name: 'ww', content: 'きた'},
      {key: 's1.m38', viewer: 'spam', name: 'ww', content: '8888'}
    ]
  },
  {
    key: 's2',
    id: 'ses_gq_s2',
    startedAt: S2,
    title: 'GQ synthetic session 2',
    messages: [
      {key: 's2.m01', viewer: 'haru', name: 'はる', content: '実は日本旅行、夏休みに変更した'},
      {key: 's2.m02', viewer: 'mika', name: 'ミカ', content: '来年、認定看護師の試験を受ける予定'},
      {key: 's2.m03', viewer: 'ken', name: 'Ken', content: "I changed jobs, now I'm a pastry chef"},
      {key: 's2.m04', viewer: 'lin', name: '小林', content: '为了买Switch 2，我在攒钱'},
      {key: 's2.m05', viewer: 'aoi', name: 'あおい', content: 'この前「大阪に住んでいる」と言ったけど、冗談でした。実は名古屋です'},
      {key: 's2.m06', viewer: 'yuki', name: 'ユキ', content: '来年、美術専門学校に進学したい'},
      {key: 's2.m07', viewer: 'sora', name: 'Sora', content: "I'm a professional guitarist, actually"},
      {key: 's2.m08', viewer: 'nick_a', name: 'A.', content: 'I passed JLPT N2 last week!'},
      {key: 's2.m09', viewer: 'nick_b', name: 'Alex', content: 'My job is boring but stable'},
      {key: 's2.m10', viewer: 'rin', name: 'Rin', content: '医生说我可能有抑郁症'},
      {key: 's2.m11', viewer: 'haru', name: 'はる', content: '大学院の課題が多くて大変'},
      {key: 's2.m12', viewer: 'mika', name: 'ミカ', content: '夜勤が減って昼勤になった'},
      {key: 's2.m13', viewer: 'ken', name: 'Ken', content: 'I still hate horror games'},
      {key: 's2.m14', viewer: 'lin', name: '小林', content: '高考复习好难'},
      {key: 's2.m15', viewer: 'rin', name: 'Rin', content: '我住在上海市XX路123号，电话13800000000'},
      {key: 's2.m16', viewer: 'spam', name: 'ww', content: '草草草'},
      {key: 's2.m17', viewer: 'spam', name: 'ww', content: '888'},
      {key: 's2.m18', viewer: 'spam', name: 'ww', content: '🎉🎉'},
      {key: 's2.m19', viewer: 'mei', name: 'Mei', content: '拿到英国学校的offer了'},
      {key: 's2.m20', viewer: 'kai', name: 'Kai', content: "I'm the CEO of a big company"},
      {key: 's2.m21', viewer: 'tomo', name: 'トモ', content: 'guess my age'}
    ]
  },
  {
    key: 's3',
    id: 'ses_gq_s3',
    startedAt: S3,
    title: 'GQ synthetic session 3',
    messages: [
      {key: 's3.m01', viewer: 'haru', name: 'Haru🎸', content: 'ギターで一曲弾けるようになった'},
      {key: 's3.m02', viewer: 'mika', name: 'ミカ', content: '認定看護師の試験、申し込んだ'},
      {key: 's3.m03', viewer: 'aoi', name: 'あおい', content: '名古屋の味噌煮込みうどんが好き'},
      {key: 's3.m04', viewer: 'lin', name: '小林', content: '我可能有点社恐，不太敢说话'},
      {key: 's3.m05', viewer: 'nick_a', name: 'A.', content: 'I am studying for JLPT N1 now'},
      {key: 's3.m06', viewer: 'yuki', name: 'ユキ', content: '絵の具を買いました'},
      {key: 's3.m07', viewer: 'rin', name: 'Rin', content: '今天也在练习做菜'},
      {key: 's3.m08', viewer: 'sora', name: 'Sora', content: 'Still playing guitar, mostly fingerstyle'},
      {key: 's3.m09', viewer: 'mei', name: 'Mei', content: '英国读研的事，机票已经买好了'},
      {key: 's3.m10', viewer: 'spam', name: 'ww', content: '8888'},
      {key: 's3.m11', viewer: 'spam', name: 'ww', content: 'wwww'}
    ]
  }
];

function assignSequence(sessions) {
  return sessions.map((session) => {
    const messages = session.messages.map((message, index) => ({
      ...message,
      seq: index + 1,
      at: session.startedAt + (index + 1) * 1000,
      eventKey: `${session.id}#${index + 1}`
    }));
    return {...session, messages};
  });
}

export const GQ_SESSIONS = assignSequence(RAW_SESSIONS);

export const GQ_BROADCASTER = Object.freeze({
  id: BROADCASTER_ID,
  platform: 'youtube',
  platformUid: 'UC_GQ_BROADCASTER',
  displayName: 'GQ Synthetic Broadcaster'
});

const MESSAGE_INDEX = new Map();
for (const session of GQ_SESSIONS) {
  for (const message of session.messages) MESSAGE_INDEX.set(message.key, {...message, sessionKey: session.key, sessionId: session.id});
}

function evidenceOf(keys) {
  return keys.map((key) => {
    const message = MESSAGE_INDEX.get(key);
    if (!message) throw new Error(`gold corpus: unknown message ${key}`);
    return {
      messageKey: key,
      sessionKey: message.sessionKey,
      seq: message.seq,
      eventKey: message.eventKey,
      content: message.content
    };
  });
}

/**
 * Current and superseded gold facts.
 *
 * `status: 'superseded'` facts are not counted in recall; they exist so the
 * report can show whether an update/denial was handled. `supersedes` links the
 * chain for human review.
 */
const RAW_GOLD_FACTS = [
  // 1/2/3/4: interests, study, plans, preferences
  {
    id: 'f-haru-guitar',
    viewer: 'haru',
    category: 'interest',
    importance: 'medium',
    statement: '正在学吉他',
    aliases: ['吉他', 'ギター', '练吉他', 'guitar'],
    evidence: ['s1.m01', 's3.m01']
  },
  {
    id: 'f-haru-cs',
    viewer: 'haru',
    category: 'identity',
    importance: 'high',
    statement: '在研究生院学习计算机科学',
    aliases: ['计算机科学', '大学院', 'コンピュータサイエンス', 'computer science'],
    evidence: ['s1.m28', 's2.m11']
  },
  {
    id: 'f-haru-trip-spring',
    viewer: 'haru',
    category: 'life_event',
    importance: 'high',
    statement: '计划明年春天去日本旅行',
    aliases: ['日本旅行', '来年の春', '旅行'],
    evidence: ['s1.m15'],
    status: 'superseded',
    supersedes: null,
    supersededBy: 'f-haru-trip-summer'
  },
  {
    id: 'f-haru-trip-summer',
    viewer: 'haru',
    category: 'life_event',
    importance: 'high',
    statement: '日本旅行改到明年夏天',
    aliases: ['夏休み', '夏天', '旅行'],
    evidence: ['s2.m01'],
    supersedes: 'f-haru-trip-spring'
  },
  {
    id: 'f-haru-cat',
    viewer: 'haru',
    category: 'identity',
    importance: 'medium',
    statement: '养猫',
    aliases: ['猫', 'cat'],
    evidence: ['s1.m29']
  },
  // occupation / study / future plan / update
  {
    id: 'f-mika-nurse',
    viewer: 'mika',
    category: 'identity',
    importance: 'high',
    statement: '职业是护士',
    aliases: ['护士', '看護師', 'nurse'],
    evidence: ['s1.m02']
  },
  {
    id: 'f-mika-night-shift',
    viewer: 'mika',
    category: 'identity',
    importance: 'medium',
    statement: '经常上夜班',
    aliases: ['夜勤', '夜班', 'night shift'],
    evidence: ['s1.m16'],
    status: 'superseded',
    supersededBy: 'f-mika-day-shift'
  },
  {
    id: 'f-mika-day-shift',
    viewer: 'mika',
    category: 'identity',
    importance: 'medium',
    statement: '现在改上白班',
    aliases: ['昼勤', '白班', 'day shift'],
    evidence: ['s2.m12'],
    supersedes: 'f-mika-night-shift'
  },
  {
    id: 'f-mika-exam',
    viewer: 'mika',
    category: 'life_event',
    importance: 'high',
    statement: '计划明年考认定护士',
    aliases: ['認定看護師', '考试', 'certification'],
    evidence: ['s2.m02', 's3.m02']
  },
  // chef -> pastry chef, dislike
  {
    id: 'f-ken-chef',
    viewer: 'ken',
    category: 'identity',
    importance: 'high',
    statement: '职业是厨师',
    aliases: ['chef', '厨师', '料理人'],
    evidence: ['s1.m03'],
    status: 'superseded',
    supersededBy: 'f-ken-pastry'
  },
  {
    id: 'f-ken-pastry',
    viewer: 'ken',
    category: 'identity',
    importance: 'high',
    statement: '现在是糕点师',
    aliases: ['pastry chef', '糕点师', 'パティシエ'],
    evidence: ['s2.m03'],
    supersedes: 'f-ken-chef'
  },
  {
    id: 'f-ken-horror',
    viewer: 'ken',
    category: 'dislike',
    importance: 'medium',
    statement: '讨厌恐怖游戏',
    aliases: ['horror', '恐怖游戏', 'ホラー'],
    evidence: ['s1.m17', 's2.m13']
  },
  // student + RPG + future plan
  {
    id: 'f-lin-student',
    viewer: 'lin',
    category: 'identity',
    importance: 'high',
    statement: '高中生，准备高考',
    aliases: ['高中生', '高考', '学生'],
    evidence: ['s1.m04', 's2.m14']
  },
  {
    id: 'f-lin-rpg',
    viewer: 'lin',
    category: 'interest',
    importance: 'medium',
    statement: '喜欢玩RPG',
    aliases: ['RPG', '角色扮演', '游戏'],
    evidence: ['s1.m18']
  },
  {
    id: 'f-lin-switch',
    viewer: 'lin',
    category: 'life_event',
    importance: 'medium',
    statement: '在为买Switch 2攒钱',
    aliases: ['Switch', '攒钱', '存钱'],
    evidence: ['s2.m04']
  },
  // denial chain
  {
    id: 'f-aoi-osaka',
    viewer: 'aoi',
    category: 'identity',
    importance: 'high',
    statement: '住在大阪',
    aliases: ['大阪', 'Osaka'],
    evidence: ['s1.m05'],
    status: 'superseded',
    supersededBy: 'f-aoi-nagoya'
  },
  {
    id: 'f-aoi-nagoya',
    viewer: 'aoi',
    category: 'identity',
    importance: 'high',
    statement: '其实住在名古屋（否认此前大阪的说法）',
    aliases: ['名古屋', 'Nagoya', '冗談'],
    evidence: ['s2.m05'],
    supersedes: 'f-aoi-osaka'
  },
  {
    id: 'f-aoi-spicy',
    viewer: 'aoi',
    category: 'preference',
    importance: 'medium',
    statement: '喜欢辣的食物',
    aliases: ['辛い', '辣', 'spicy'],
    evidence: ['s1.m05']
  },
  {
    id: 'f-aoi-udon',
    viewer: 'aoi',
    category: 'preference',
    importance: 'low',
    statement: '喜欢名古屋味噌煮込み乌冬',
    aliases: ['味噌煮込み', 'うどん', '乌冬'],
    evidence: ['s3.m03']
  },
  // drawing / art school
  {
    id: 'f-yuki-drawing',
    viewer: 'yuki',
    category: 'interest',
    importance: 'medium',
    statement: '兴趣是画画',
    aliases: ['絵', '画画', 'drawing'],
    evidence: ['s1.m06', 's3.m06']
  },
  {
    id: 'f-yuki-art-school',
    viewer: 'yuki',
    category: 'life_event',
    importance: 'high',
    statement: '计划明年进美术专门学校',
    aliases: ['美術専門学校', '美术', 'art school'],
    evidence: ['s2.m06']
  },
  // guitar shared topic, different viewers
  {
    id: 'f-sora-guitar',
    viewer: 'sora',
    category: 'interest',
    importance: 'medium',
    statement: '每天弹吉他',
    aliases: ['guitar', '吉他', 'ギター'],
    evidence: ['s1.m07', 's3.m08']
  },
  {
    id: 'f-sora-acoustic',
    viewer: 'sora',
    category: 'preference',
    importance: 'medium',
    statement: '更喜欢原声吉他',
    aliases: ['acoustic', '原声', '木吉他'],
    evidence: ['s1.m20']
  },
  {
    id: 'f-multi-bass',
    viewer: 'multi',
    category: 'interest',
    importance: 'medium',
    statement: '弹贝斯，在练slap',
    aliases: ['贝斯', 'bass', 'slap'],
    evidence: ['s1.m08']
  },
  // nickname change + same nickname different viewer
  {
    id: 'f-nick-a-japanese',
    viewer: 'nick_a',
    category: 'interest',
    importance: 'high',
    statement: '在学日语',
    aliases: ['日语', 'Japanese', '日本語'],
    evidence: ['s1.m09'],
    status: 'superseded',
    supersededBy: 'f-nick-a-n2'
  },
  {
    id: 'f-nick-a-n2',
    viewer: 'nick_a',
    category: 'life_event',
    importance: 'high',
    statement: '通过了JLPT N2',
    aliases: ['N2', 'JLPT'],
    evidence: ['s2.m08'],
    supersedes: 'f-nick-a-japanese'
  },
  {
    id: 'f-nick-a-n1',
    viewer: 'nick_a',
    category: 'life_event',
    importance: 'medium',
    statement: '正在准备JLPT N1',
    aliases: ['N1', 'JLPT'],
    evidence: ['s3.m05']
  },
  {
    id: 'f-nick-b-finance',
    viewer: 'nick_b',
    category: 'identity',
    importance: 'medium',
    statement: '在新加坡做金融工作',
    aliases: ['finance', '金融', 'Singapore'],
    evidence: ['s1.m10', 's2.m09']
  },
  // cat/cooking + sensitive negatives
  {
    id: 'f-rin-cat',
    viewer: 'rin',
    category: 'identity',
    importance: 'medium',
    statement: '养了一只橘猫',
    aliases: ['橘猫', '猫', 'cat'],
    evidence: ['s1.m11']
  },
  {
    id: 'f-rin-cooking',
    viewer: 'rin',
    category: 'interest',
    importance: 'medium',
    statement: '在学做菜',
    aliases: ['做菜', '料理', 'cooking'],
    evidence: ['s1.m26', 's3.m07']
  },
  // travel plan
  {
    id: 'f-tomo-trip',
    viewer: 'tomo',
    category: 'life_event',
    importance: 'high',
    statement: '计划明年日本一周旅行',
    aliases: ['日本一周', '旅行', 'trip'],
    evidence: ['s1.m12']
  },
  // preferences
  {
    id: 'f-kai-spicy',
    viewer: 'kai',
    category: 'preference',
    importance: 'medium',
    statement: '喜欢辣的食物',
    aliases: ['spicy', '辣'],
    evidence: ['s1.m13']
  },
  {
    id: 'f-kai-morning',
    viewer: 'kai',
    category: 'preference',
    importance: 'low',
    statement: '不喜欢早起（可能只是一次抱怨）',
    aliases: ['waking up early', '早起'],
    evidence: ['s1.m13'],
    // A single negative complaint can be a mood rather than a durable dislike.
    // It is deliberately kept out of the strict denominator and listed as an
    // ambiguity instead of being counted as automatically correct.
    shouldPersist: 'ambiguous',
    ambiguous: true
  },
  // study abroad plan -> offer
  {
    id: 'f-mei-uk-plan',
    viewer: 'mei',
    category: 'life_event',
    importance: 'high',
    statement: '计划明年去英国读研',
    aliases: ['英国', '读研', 'UK'],
    evidence: ['s1.m14'],
    status: 'superseded',
    supersededBy: 'f-mei-uk-offer'
  },
  {
    id: 'f-mei-uk-offer',
    viewer: 'mei',
    category: 'life_event',
    importance: 'high',
    statement: '已拿到英国学校offer，机票已买',
    aliases: ['offer', '机票', '英国'],
    evidence: ['s2.m19', 's3.m09'],
    supersedes: 'f-mei-uk-plan'
  },
  {
    id: 'f-mei-ielts',
    viewer: 'mei',
    category: 'interest',
    importance: 'medium',
    statement: '在准备雅思',
    aliases: ['雅思', 'IELTS'],
    evidence: ['s1.m14']
  }
];

const RAW_NEGATIVES = [
  {id: 'n-mika-tired', key: 's1.m02', viewer: 'mika', category: 'temporary', reason: 'One-day exhaustion, not a durable fact.'},
  {id: 'n-lin-tired', key: 's1.m32', viewer: 'lin', category: 'temporary', reason: 'One-day tiredness.'},
  {id: 'n-ken-joke', key: 's1.m30', viewer: 'ken', category: 'joke', reason: 'Irony ("millionaire, trust me 😂").'},
  {id: 'n-ken-friend', key: 's1.m31', viewer: 'ken', category: 'third_party', reason: 'A friend is not the viewer.'},
  {id: 'n-aoi-joke', key: 's1.m19', viewer: 'aoi', category: 'joke', reason: 'Role-play joke ("queen of Osaka").'},
  {id: 'n-sora-joke', key: 's2.m07', viewer: 'sora', category: 'joke', reason: 'Irony ("professional guitarist, actually").'},
  {id: 'n-rin-health', key: 's2.m10', viewer: 'rin', category: 'sensitive_speculation', reason: 'Health speculation must not be stored as a long-term fact.'},
  {id: 'n-rin-address', key: 's2.m15', viewer: 'rin', category: 'sensitive_pii', reason: 'Address and phone number are sensitive personal data.'},
  {id: 'n-mei-interview', key: 's1.m33', viewer: 'mei', category: 'temporary', reason: 'One-day interview nerves.'},
  {id: 'n-tomo-mood', key: 's1.m34', viewer: 'tomo', category: 'temporary', reason: 'Weather mood.'},
  {id: 'n-kai-ceo', key: 's2.m20', viewer: 'kai', category: 'joke', reason: 'Obvious role-play joke.'},
  {id: 'n-tomo-age', key: 's2.m21', viewer: 'tomo', category: 'no_long_term_value', reason: 'Asking others to guess an age is not a stated age.'},
  {id: 'n-lin-social', key: 's3.m04', viewer: 'lin', category: 'speculation', reason: 'Self-speculation ("maybe I am a bit social-anxious") is not a confirmed fact.'},
  {id: 'n-spam-1', key: 's1.m22', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-2', key: 's1.m23', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-3', key: 's1.m24', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-4', key: 's1.m25', viewer: 'spam', category: 'meaningless', reason: 'Emoji spam.'},
  {id: 'n-spam-5', key: 's1.m35', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-6', key: 's1.m36', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-7', key: 's1.m37', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-8', key: 's1.m38', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-9', key: 's2.m16', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-10', key: 's2.m17', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-11', key: 's2.m18', viewer: 'spam', category: 'meaningless', reason: 'Emoji spam.'},
  {id: 'n-spam-12', key: 's3.m10', viewer: 'spam', category: 'meaningless', reason: 'Spam.'},
  {id: 'n-spam-13', key: 's3.m11', viewer: 'spam', category: 'meaningless', reason: 'Spam.'}
];

function publicViewerKey(key) {
  return viewerId(key);
}

export const GQ_GOLD_FACTS = RAW_GOLD_FACTS.map((fact) => ({
  id: fact.id,
  viewerKey: publicViewerKey(fact.viewer),
  statement: fact.statement,
  aliases: fact.aliases,
  category: fact.category,
  importance: fact.importance,
  shouldPersist: fact.shouldPersist ?? true,
  ambiguous: fact.ambiguous === true,
  status: fact.status ?? 'current',
  supersedes: fact.supersedes ?? null,
  supersededBy: fact.supersededBy ?? null,
  evidence: evidenceOf(fact.evidence)
}));

export const GQ_NEGATIVES = RAW_NEGATIVES.map((negative) => {
  const message = MESSAGE_INDEX.get(negative.key);
  return {
    id: negative.id,
    viewerKey: publicViewerKey(negative.viewer),
    category: negative.category,
    reason: negative.reason,
    sessionKey: message.sessionKey,
    sessionId: message.sessionId,
    seq: message.seq,
    eventKey: message.eventKey,
    content: message.content
  };
});

export const GQ_VIEWERS = [...new Set(GQ_SESSIONS.flatMap((session) => session.messages.map((message) => message.viewer)))]
  .map((key) => ({key, viewerId: publicViewerKey(key)}));

/** Identity checks: one stable id across nickname changes, no same-name merge. */
export const GQ_IDENTITY_CHECKS = Object.freeze({
  renamed: {
    viewerKey: publicViewerKey('haru'),
    names: ['Haru', 'はる', 'Haru🎸'],
    sessions: ['s1', 's2', 's3']
  },
  sameNameDifferentViewer: {
    name: 'Alex',
    viewerKeys: [publicViewerKey('nick_a'), publicViewerKey('nick_b')],
    sessions: ['s1', 's2']
  }
});

/** Vendored copy of the viewer-level message list, used by the seeder. */
export function buildGoldCorpusMessages() {
  return GQ_SESSIONS.map((session) => ({
    key: session.key,
    id: session.id,
    title: session.title,
    startedAt: session.startedAt,
    messages: session.messages.map((message) => ({
      ...message,
      viewerId: publicViewerKey(message.viewer)
    }))
  }));
}

export function goldStats() {
  const current = GQ_GOLD_FACTS.filter((fact) => fact.status !== 'superseded');
  return {
    viewers: GQ_VIEWERS.length,
    sessions: GQ_SESSIONS.length,
    messages: GQ_SESSIONS.reduce((total, session) => total + session.messages.length, 0),
    currentFacts: current.length,
    supersededFacts: GQ_GOLD_FACTS.length - current.length,
    importantFacts: current.filter((fact) => fact.importance === 'high').length,
    ambiguousFacts: current.filter((fact) => fact.shouldPersist === 'ambiguous').length,
    negatives: GQ_NEGATIVES.length
  };
}
