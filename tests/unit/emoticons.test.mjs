import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAiReadableContent,
  emoteKey,
  normalizeEmote,
  normalizeEmotes,
  parseEmotesJson,
  serializeEmotes
} from '../../src/shared/emoticons.mjs';
import {cleanText, graphemeCount, truncateText} from '../../src/shared/text.mjs';

const EMOJI_SAMPLES = [
  '今天太开心了😂❤️',
  '这个剧情让我哭了😭😭',
  '太强了👏👏👏',
  '家族一起看👨‍👩‍👧‍👦',
  '肤色测试👍🏽',
  '彩虹旗🏳️‍🌈',
  '火焰之心❤️‍🔥',
  '钥匙和锁🔐',
  '爱心与吻💏',
  '日本地图🗾'
];

test('Unicode emoji, variation selectors, skin tones and ZWJ sequences are preserved', () => {
  for (const sample of EMOJI_SAMPLES) {
    assert.equal(cleanText(sample, 4000), sample, `cleanText must keep ${sample}`);
    assert.equal(truncateText(sample, 4000), sample, `truncateText must keep ${sample}`);
    assert.ok(sample.isWellFormed(), `${sample} fixture must be well formed`);
  }
});

test('truncation never splits a surrogate pair or a ZWJ sequence', () => {
  const family = '👨‍👩‍👧‍👦';
  const long = `${'a'.repeat(3999)}${family}`;
  const cut = truncateText(long, 4000);
  assert.ok(cut.isWellFormed(), 'result must not contain lone surrogates');
  assert.equal(cut, 'a'.repeat(3999), 'the whole grapheme does not fit, so it is dropped');

  const repeated = family.repeat(500);
  const oneFamily = truncateText(repeated, 20);
  assert.equal(graphemeCount(oneFamily), 1);
  assert.equal(oneFamily, family);
  assert.ok(!oneFamily.endsWith('\u200D'));

  assert.equal(truncateText('abc', 2), 'ab');
  assert.equal(truncateText('abc', 0), '');
});

test('normalizeEmote keeps only the small metadata contract', () => {
  const emote = normalizeEmote({
    id: ' room_5050_96171 ',
    code: '[就这]',
    name: '就这',
    source: 'bilibili.info13',
    url: 'https://i0.hdslb.com/should-not-be-stored.png',
    width: 162
  });
  assert.deepEqual(emote, {
    id: 'room_5050_96171',
    code: '[就这]',
    name: '就这',
    source: 'bilibili.info13'
  });
  assert.equal(normalizeEmote({}), null);
  assert.equal(normalizeEmote(null), null);
});

test('normalizeEmotes de-duplicates and caps the metadata', () => {
  const list = normalizeEmotes([
    {id: 'e1', name: '猫猫鼓掌'},
    {id: 'e1', name: '重复'},
    {code: ':face-blue-smiling:', name: 'face-blue-smiling'},
    ...Array.from({length: 30}, (_, index) => ({id: `e${index + 2}`, name: `n${index}`}))
  ]);
  assert.equal(list.length, 20);
  assert.equal(list[0].id, 'e1');
  assert.equal(list[0].name, '猫猫鼓掌');
  assert.equal(list.filter((entry) => entry.id === 'e1').length, 1);
  assert.deepEqual(normalizeEmotes([]), null);
  assert.deepEqual(normalizeEmotes('not-an-array'), null);
});

test('AI-readable text keeps the original and only appends needed annotations', () => {
  assert.equal(
    buildAiReadableContent({
      content: '今天这个剧情太好笑了😂[猫猫鼓掌]',
      emotes: [{id: 'cat', code: '[猫猫鼓掌]', name: '猫猫鼓掌'}],
      locale: 'zh-CN'
    }),
    '今天这个剧情太好笑了😂[猫猫鼓掌]',
    'the platform text already contains the emote label'
  );
  assert.equal(
    buildAiReadableContent({
      content: '今天太有意思了',
      emotes: [{id: 'cat', name: '猫猫鼓掌'}],
      locale: 'zh-CN'
    }),
    '今天太有意思了[平台表情：猫猫鼓掌]'
  );
  assert.equal(
    buildAiReadableContent({
      content: '今天太有意思了',
      emotes: [{id: 'cat', name: '猫猫鼓掌'}],
      locale: 'en'
    }),
    '今天太有意思了[platform emote: 猫猫鼓掌]'
  );
  assert.equal(
    buildAiReadableContent({
      content: '今日は楽しい',
      emotes: [{id: 'cat', name: '猫猫鼓掌'}],
      locale: 'ja'
    }),
    '今日は楽しい[プラットフォーム絵文字：猫猫鼓掌]'
  );
});

test('unknown emote ids are marked unknown, never guessed as an emotion', () => {
  assert.equal(
    buildAiReadableContent({
      content: null,
      emotes: [{id: 'room_5050_96171'}],
      locale: 'zh-CN'
    }),
    '[未知平台表情：emote_id=room_5050_96171]'
  );
  assert.equal(
    buildAiReadableContent({
      content: 'hello',
      emotes: [{id: 'mystery_1'}],
      locale: 'en'
    }),
    'hello[unknown platform emote: emote_id=mystery_1]'
  );
});

test('bracketed user text without metadata is not classified as a platform emote', () => {
  assert.equal(
    buildAiReadableContent({content: '今天太有意思了[笑哭]', emotes: null, locale: 'zh-CN'}),
    '今天太有意思了[笑哭]'
  );
});

test('repeated identical emotes are annotated once', () => {
  const output = buildAiReadableContent({
    content: '太强了',
    emotes: [{id: 'a', name: '鼓掌'}, {id: 'a', name: '鼓掌'}, {id: 'b', name: '鼓掌'}],
    locale: 'zh-CN'
  });
  assert.equal(output, '太强了[平台表情：鼓掌]');
});

test('emote JSON helpers round-trip and reject malformed data', () => {
  const emotes = [{id: 'e1', name: '猫猫'}];
  const json = serializeEmotes(emotes);
  assert.deepEqual(parseEmotesJson(json), emotes);
  assert.deepEqual(parseEmotesJson(emotes), emotes);
  assert.equal(parseEmotesJson('{bad json'), null);
  assert.equal(parseEmotesJson(null), null);
  assert.equal(emoteKey('bilibili', {id: 'room_1'}), 'bilibili:id:room_1');
  assert.equal(emoteKey('youtube', {code: ':smile:'}), 'youtube:code::smile:');
});
