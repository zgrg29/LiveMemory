import test from 'node:test';
import assert from 'node:assert/strict';
import {parseYouTubeInput, extractVideoId} from '../../src/platforms/youtube/link.mjs';

const ID = 'dQw4w9WgXcQ';

test('every documented live/watch link form resolves to the same video id', () => {
  const forms = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=120s&list=PL123`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://www.youtube.com/live/${ID}`,
    `https://youtu.be/${ID}?si=tracking`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `www.youtube.com/live/${ID}`,
    ID
  ];
  for (const input of forms) {
    assert.equal(extractVideoId(input), ID, input);
  }
});

test('the parsed form is reported for diagnostics', () => {
  assert.equal(parseYouTubeInput(`https://www.youtube.com/live/${ID}`).form, 'live');
  assert.equal(parseYouTubeInput(`https://youtu.be/${ID}`).form, 'youtu.be');
  assert.equal(parseYouTubeInput(`https://www.youtube.com/watch?v=${ID}`).form, 'watch');
  assert.equal(parseYouTubeInput(ID).form, 'id');
  assert.equal(parseYouTubeInput(ID).normalizedUrl, `https://www.youtube.com/watch?v=${ID}`);
});

test('non-live or non-YouTube inputs are rejected', () => {
  const rejected = [
    '',
    '   ',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/channel/UC123',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/live/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=too-short',
    'javascript:alert(1)',
    'dQw4w9WgXc', // 10 characters
    'dQw4w9WgXcQQ' // 12 characters
  ];
  for (const input of rejected) {
    assert.equal(extractVideoId(input), null, `should reject: ${input}`);
    assert.throws(() => parseYouTubeInput(input), (error) => error.code === 'YOUTUBE_LINK_INVALID');
  }
});

test('a rejected link carries a translatable error key and an HTTP status', () => {
  try {
    parseYouTubeInput('https://example.com/');
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.messageKey, 'errors.youtubeLinkInvalid');
    assert.equal(error.httpStatus, 400);
  }
});
