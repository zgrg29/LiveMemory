import test from 'node:test';
import assert from 'node:assert/strict';
import {asciiFold, createConsole, enableUtf8Console} from '../../src/launcher/console.mjs';
import {CLI_LOCALES, cliMessages} from '../../src/launcher/cli-i18n.mjs';

/**
 * P40: the launcher console must never be the reason startup fails, and a
 * console that cannot show Unicode must not print mojibake.
 */

function capture({locale = 'en', unicode = true, asciiOnly = false, throwOnWrite = false} = {}) {
  const out = {text: ''};
  const stream = {
    write(chunk) {
      if (throwOnWrite) throw new Error('EPIPE');
      out.text += String(chunk);
      return true;
    }
  };
  const ui = createConsole({locale, stdout: stream, stderr: stream, unicode, asciiOnly});
  return {ui, out};
}

test('the chosen console language is printed as-is when the console supports it', () => {
  const {ui, out} = capture({locale: 'de'});
  ui.banner({name: 'LiveMemory', version: '0.15.0', productLine: cliMessages('de').productLine});
  assert.match(out.text, /LiveMemory wird gestartet|Gedächtnis|Livestream/);
  assert.equal(ui.asciiOnly, false);
  for (const locale of CLI_LOCALES) {
    const rendered = capture({locale});
    rendered.ui.info(cliMessages(locale).starting);
    assert.ok(rendered.out.text.trim().length > 0, locale);
    assert.equal(rendered.ui.asciiOnly, false, locale);
  }
});

test('a console without Unicode falls back to the English ASCII message set', () => {
  const {ui, out} = capture({locale: 'ko', unicode: false, asciiOnly: true});
  // The prefix comes from the console's own message set, so it proves which set
  // was chosen: Korean would print 경고, the ASCII fallback prints Warning.
  ui.warn('test');
  ui.error('boom');
  ui.field('데이터 폴더', 'D:/자료');
  assert.equal(ui.asciiOnly, true);
  const text = out.text;
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(text, /[^\x00-\x7F]/);
  assert.match(text, /Warning: test/);
  assert.match(text, /Error: boom/);
  assert.match(text, /\?\?\? \?\?\s+D:\/\?\?/);
  assert.equal(ui.rule, '-'.repeat(64));
});

test('asciiFold keeps ASCII readable and replaces unsupported characters', () => {
  assert.equal(asciiFold('Datenordner: D:/LiveMemory'), 'Datenordner: D:/LiveMemory');
  assert.equal(asciiFold('데이터 폴더'), '??? ??');
  assert.equal(asciiFold('C:/Users/Борис/LiveMemory'), 'C:/Users/?????/LiveMemory');
  assert.equal(asciiFold(null), '');
});

test('a broken console never aborts the program', () => {
  const {ui, out} = capture({locale: 'ja', throwOnWrite: true});
  // Every call swallows the write error; nothing is rethrown.
  ui.banner({name: 'LiveMemory', version: '0.15.0', productLine: 'x'});
  ui.info('起動しています…');
  ui.error('エラー');
  ui.footer();
  assert.equal(out.text, '');
});

test('enableUtf8Console is safe off Windows and without a TTY', () => {
  assert.deepEqual(enableUtf8Console({platform: 'linux', stdout: {isTTY: true}}), {changed: false, reason: 'not-windows'});
  assert.deepEqual(enableUtf8Console({platform: 'win32', stdout: {isTTY: false}}), {changed: false, reason: 'not-tty'});
});
