/**
 * Unicode-safe text helpers.
 *
 * Chat text may contain emoji with variation selectors, skin-tone modifiers and
 * ZWJ sequences (family/profession emoji). `String.prototype.slice` counts
 * UTF-16 code units, so a naive truncation can split a surrogate pair or cut a
 * ZWJ sequence in half and store a broken character. Every place that stores or
 * exports viewer text goes through this helper instead.
 */

let segmenter = null;

function getSegmenter() {
  if (segmenter) return segmenter;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
    return segmenter;
  }
  return null;
}

/**
 * Truncate to at most `max` UTF-16 code units without breaking a grapheme.
 * The first grapheme is always kept even if a single grapheme is longer than
 * `max` (so we never return an empty string for non-empty input).
 */
export function truncateText(value, max = 4000) {
  const text = value === null || value === undefined ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? Math.trunc(max) : 0;
  if (!text || text.length <= limit) return text;
  if (limit === 0) return '';

  const seg = getSegmenter();
  if (seg) {
    let output = '';
    let units = 0;
    let first = null;
    for (const part of seg.segment(text)) {
      const segment = part.segment;
      if (first === null) first = segment;
      if (units + segment.length > limit) break;
      output += segment;
      units += segment.length;
    }
    if (output) return output;
    return first ?? '';
  }

  // Fallback for runtimes without Intl.Segmenter: iterate by code point so a
  // surrogate pair is never split, then drop a dangling zero-width joiner.
  let output = '';
  for (const character of text) {
    if (output.length + character.length > limit) break;
    output += character;
  }
  while (output.endsWith('\u200D')) output = output.slice(0, -1);
  return output || [...text][0] || '';
}

/**
 * Remove NUL bytes (SQLite text cannot hold them safely), trim surrounding
 * whitespace, and truncate without breaking emoji. Returns null for empty text.
 */
export function cleanText(value, max = 4000) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\u0000/g, '').trim();
  if (!text) return null;
  return truncateText(text, max);
}

/** Number of user-perceived characters; used by tests and diagnostics. */
export function graphemeCount(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return 0;
  const seg = getSegmenter();
  if (seg) {
    let count = 0;
    for (const _ of seg.segment(text)) count += 1;
    return count;
  }
  return [...text].length;
}
