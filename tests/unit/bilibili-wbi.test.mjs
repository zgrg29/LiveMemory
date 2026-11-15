import test from 'node:test';
import assert from 'node:assert/strict';
import {extractWbiKey, mixinKey, signParams, signWithNav} from '../../src/platforms/bilibili/wbi.mjs';

const IMG = '7cd084941338484aae1ad9425b84077c';
const SUB = '4932caff0ff746eab6f01bf08b70ac45';

test('the public WBI test vector produces the documented signature', () => {
  const key = mixinKey(IMG, SUB);
  const query = signParams({foo: '114', bar: '514', zab: 1919810}, key, {now: 1702204169 * 1000});
  assert.equal(query, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

test('WBI keys are the bare filenames of the nav images', () => {
  assert.equal(extractWbiKey(`https://i0.hdslb.com/bfs/wbi/${IMG}.png`), IMG);
  assert.equal(extractWbiKey(`https://i0.hdslb.com/bfs/wbi/${SUB}.png`), SUB);
  assert.equal(extractWbiKey('https://i0.hdslb.com/bfs/wbi/not-a-key.png'), null);
  assert.equal(extractWbiKey(null), null);
});

test('the mixin key is 32 characters and permutation based', () => {
  const key = mixinKey(IMG, SUB);
  assert.equal(key.length, 32);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.notEqual(key, `${IMG}${SUB}`.slice(0, 32));
});

test('signWithNav reads the keys from a nav payload', () => {
  const nav = {wbi_img: {img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png`}};
  const signed = signWithNav({id: 5050, type: 0}, nav, {now: 1702204169 * 1000});
  assert.match(signed, /^id=5050&type=0&wts=1702204169&w_rid=[0-9a-f]{32}$/);
});

test('parameters are sorted and risky characters are stripped', () => {
  const key = mixinKey(IMG, SUB);
  const query = signParams({b: "a!b (c)*d'e", a: 'x y'}, key, {now: 1702204169 * 1000});
  assert.match(query, /^a=x%20y&b=ab%20cde&wts=1702204169&w_rid=[0-9a-f]{32}$/);
});
