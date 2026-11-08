import {spawnSync, spawn} from 'node:child_process';
import {cliMessages} from './cli-i18n.mjs';

/**
 * Windows console helpers.
 *
 * The console code page must be UTF-8, otherwise Chinese and Japanese text is
 * rendered as mojibake in the classic console host. `chcp 65001` changes the
 * code page of the shared console (a child process affects the parent console
 * state), which is the only reliable way without native bindings.
 */
export function enableUtf8Console({platform = process.platform, stdout = process.stdout} = {}) {
  if (platform !== 'win32') return {changed: false, reason: 'not-windows'};
  if (!stdout.isTTY) return {changed: false, reason: 'not-tty'};
  const result = spawnSync('cmd', ['/c', 'chcp 65001'], {stdio: 'ignore', windowsHide: true});
  if (result.error || result.status !== 0) {
    return {changed: false, reason: 'chcp-failed'};
  }
  return {changed: true};
}

const UNICODE_RULE = '─';
const ASCII_RULE = '-';

export function createConsole({locale = 'en', messages = null, stdout = process.stdout, stderr = process.stderr, unicode = true} = {}) {
  const text = messages ?? cliMessages(locale);
  const rule = unicode ? UNICODE_RULE : ASCII_RULE;
  const width = 64;
  const line = rule.repeat(width);
  const write = (value = '') => {
    stdout.write(`${value}\n`);
  };
  return {
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
      write(`  ${text.errorPrefix}: ${value}`);
    },
    error(value) {
      stderr.write(`  ${text.errorPrefix}: ${value}\n`);
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

/**
 * Open a URL with the operating system default browser. On Windows this is
 * `start` through cmd.exe: it honours the user's default browser instead of
 * forcing Chrome/Edge.
 */
export function openDefaultBrowser(url, {platform = process.platform} = {}) {
  try {
    let command;
    let args;
    if (platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (platform === 'darwin') {
      command = 'open';
      args = [url];
    } else {
      command = 'xdg-open';
      args = [url];
    }
    const child = spawn(command, args, {stdio: 'ignore', windowsHide: true, detached: true});
    child.on('error', () => {});
    child.unref();
    return {opened: true};
  } catch (error) {
    return {opened: false, error};
  }
}
