import {spawn} from 'node:child_process';

/**
 * Open a URL with the operating system default browser.
 *
 * On Windows this goes through `cmd /c start` so the user's configured default
 * browser is honoured instead of forcing Chrome/Edge. The child is detached and
 * its stdio is ignored: a missing browser must never crash the application, and
 * the caller reports whether the request could be issued.
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

/** Only these hosts may be opened by the local server on the user's behalf. */
export const OPENABLE_HOSTS = Object.freeze([
  'account.bilibili.com',
  'passport.bilibili.com',
  'passport.biligame.com',
  'live.bilibili.com',
  'www.bilibili.com'
]);

export function isAllowedExternalUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return false;
    return OPENABLE_HOSTS.includes(url.hostname.toLowerCase()) || url.hostname.endsWith('.bilibili.com');
  } catch {
    return false;
  }
}
