import {spawnSync} from 'node:child_process';
import {cliMessages} from './cli-i18n.mjs';

export {openDefaultBrowser} from '../shared/open-browser.mjs';

/**
 * Windows console helpers.
 *
 * The console code page must be UTF-8, otherwise Chinese and Japanese text is
 * rendered as mojibake in the classic console host. `chcp 65001` changes the
 * code page of the shared console (a child process affects the parent console
 * state), which is the only reliable way without native bindings.
 *
 * Since P40 the launcher ships ten languages. When the host console cannot be
 * switched to UTF-8 (no TTY, `chcp` refused, redirected output) the launcher
 * renders its **English** ASCII message set and folds any non-ASCII value
 * (room titles, user names, paths) to `?`, so a terminal without the needed
 * glyphs can never fail the startup by failing to print.
 */
export function enableUtf8Console({platform = process.platform, stdout = process.stdout} = {}) {
  if (platform !== 'win32') return {changed: false, reason: 'not-windows'};
  if (!stdout.isTTY) return {changed: false, reason: 'not-tty'};
  try {
    const result = spawnSync('cmd', ['/c', 'chcp 65001'], {stdio: 'ignore', windowsHide: true});
    if (result.error || result.status !== 0) {
      return {changed: false, reason: 'chcp-failed'};
    }
    return {changed: true};
  } catch (error) {
    return {changed: false, reason: `chcp-error:${error?.code ?? 'unknown'}`};
  }
}

const UNICODE_RULE = '─';
const ASCII_RULE = '-';

/** Replace characters an ASCII-only console cannot show; never throws. */
export function asciiFold(value) {
  return String(value ?? '').replace(/[^\x20-\x7E\n\t]/g, '?');
}

export function createConsole({
  locale = 'en',
  messages = null,
  stdout = process.stdout,
  stderr = process.stderr,
  unicode = true,
  asciiOnly = false
} = {}) {
  // `asciiOnly` is only used when a real Windows console could not be switched
  // to UTF-8: there the selected language would render as mojibake, so the
  // launcher prints the English ASCII set and folds interpolated values.
  // Redirected/piped output keeps the selected language (the bytes are UTF-8).
  const ascii = Boolean(asciiOnly) && !messages;
  const text = messages ?? (ascii ? cliMessages('en') : cliMessages(locale));
  const finalize = (value) => (ascii ? asciiFold(value) : String(value ?? ''));
  const rule = unicode && !ascii ? UNICODE_RULE : ASCII_RULE;
  const width = 64;
  const line = rule.repeat(width);
  let broken = false;
  const emit = (stream, value) => {
    if (broken) return;
    try {
      stream.write(`${finalize(value)}\n`);
    } catch {
      // A closed or unusable console must never abort the launcher: stop writing
      // and keep running so recording and the web console still work.
      broken = true;
    }
  };
  const write = (value = '') => emit(stdout, value);
  return {
    asciiOnly: ascii,
    rule: line,
    banner({name, version, productLine}) {
      write('');
      write(`  ${name}`);
      write(`  ${productLine}`);
      write(`  v${version}`);
      write(`  ${line}`);
    },
    field(label, value) {
      write(`  ${label.padEnd(14)} ${value}`);
    },
    note(value) {
      write(`  ${value}`);
    },
    info(value) {
      write(`  ${value}`);
    },
    warn(value) {
      write(`  ${text.warningPrefix ?? text.errorPrefix}: ${value}`);
    },
    error(value) {
      emit(stderr, `  ${text.errorPrefix}: ${value}`);
    },
    blank() {
      write('');
    },
    footer() {
      write(`  ${line}`);
      write('');
    }
  };
}
