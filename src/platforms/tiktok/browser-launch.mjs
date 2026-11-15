import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Small, dependency-free Chromium launcher shared by the TikTok browser relay
 * and the TikTok login flow.
 *
 * The first TikTok build used a direct `child_process.spawn` on Windows. The
 * Douyin investigation proved that an elevated Node SEA process can spawn
 * Chrome, receive exit code 0, and still get no DevTools port (while a window
 * may already be open). Starting exactly one browser through PowerShell's
 * `Start-Process` avoids the duplicated-window failure mode.
 *
 * Ownership rules:
 *   - only a profile carrying the LiveMemory marker is ever reused or removed;
 *   - the profile path is unique to LiveMemory;
 *   - cleanup matches Chromium processes by that exact profile path, never by
 *     image name alone, so the user's daily browser windows are untouched.
 */

export const BROWSER_MARKER = '.livememory-owned';
export const BROWSER_MARKER_TEXT = 'LiveMemory dedicated TikTok browser profile\n';
export const BROWSER_DIR_NAME = 'account';

export function tiktokBrowserProfileDir(dataDir) {
  return join(String(dataDir), 'browser', 'tiktok', BROWSER_DIR_NAME);
}

export function findBrowserExecutables({platform = process.platform, env = process.env, fileExists = existsSync} = {}) {
  const candidates = [];
  const add = (path) => {
    if (path) candidates.push(path);
  };
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
    const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'];
    const localAppData = env.LOCALAPPDATA;
    add(programFiles ? join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : null);
    add(programFilesX86 ? join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') : null);
    add(localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null);
    add(programFiles ? join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null);
    add(programFilesX86 ? join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null);
    add(localAppData ? join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null);
  } else if (platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    add('/usr/bin/google-chrome');
    add('/usr/bin/microsoft-edge');
    add('/usr/bin/chromium');
  }
  const found = [];
  for (const candidate of candidates) {
    try {
      if (fileExists(candidate) && !found.includes(candidate)) found.push(candidate);
    } catch {
      /* ignore */
    }
  }
  return found;
}

export function findBrowserExecutable(options = {}) {
  return findBrowserExecutables(options)[0] ?? null;
}

export function buildBrowserArgs({profileDir, startUrl, liveUrl = null}) {
  const url = startUrl ?? liveUrl;
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-mode',
    '--window-size=1280,900',
    ...(url ? [url] : [])
  ];
}

export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const port = Number(lines[0]);
  const wsPath = String(lines[1] ?? '').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!wsPath.startsWith('/devtools/browser/')) return null;
  return {port, wsPath};
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function ensureOwnedProfile(profileDir) {
  mkdirSync(profileDir, {recursive: true});
  const marker = join(profileDir, BROWSER_MARKER);
  if (existsSync(marker)) {
    if (readFileSync(marker, 'utf8') !== BROWSER_MARKER_TEXT) {
      throw Object.assign(new Error('profile not owned'), {reason: 'profile_not_owned'});
    }
    return;
  }
  const entries = readdirSync(profileDir).filter((name) => name !== BROWSER_MARKER);
  if (entries.length > 0) {
    throw Object.assign(new Error('profile not owned'), {reason: 'profile_not_owned'});
  }
  writeFileSync(marker, BROWSER_MARKER_TEXT, {mode: 0o600});
}

export function readPidFile(profileDir) {
  try {
    const pid = Number(readFileSync(join(profileDir, 'browser.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function findExistingBrowser({profileDir, fetchImpl = globalThis.fetch, timeoutMs = 3000} = {}) {
  try {
    const portFile = join(profileDir, 'DevToolsActivePort');
    if (!existsSync(portFile)) return null;
    const parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
    if (!parsed) return null;
    const response = await fetchImpl(`http://127.0.0.1:${parsed.port}/json/version`, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout?.(timeoutMs)
    });
    if (!response.ok) return null;
    const version = await response.json();
    if (!version?.webSocketDebuggerUrl) return null;
    return {port: parsed.port, wsPath: parsed.wsPath, pid: readPidFile(profileDir)};
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kill a process tree that this module itself just started. */
function killOwnedPidTree(pid, spawnSyncImpl = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
  try {
    spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(portFile, timeoutMs, isExited = () => false) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(portFile)) {
      try {
        const parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
        if (parsed) return parsed;
      } catch {
        /* retry */
      }
    }
    if (isExited()) return null;
    await sleep(200);
  }
  return null;
}

/**
 * Launch exactly one Chromium process for the dedicated profile.
 * On Windows the only path is PowerShell `Start-Process`; the direct spawn
 * fallback is kept for non-Windows development.
 */
export async function launchBrowser({
  profileDir,
  args,
  browserPath,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  env = process.env,
  timeoutMs = 30000,
  logger = null
} = {}) {
  ensureOwnedProfile(profileDir);
  const portFile = join(profileDir, 'DevToolsActivePort');
  const pidFile = join(profileDir, 'browser.pid');
  const existing = await findExistingBrowser({profileDir, fetchImpl});
  if (existing) {
    logger?.info({event: 'tiktok.browser.reuse', port: existing.port, pid: existing.pid});
    return {kind: 'reuse', port: existing.port, wsPath: existing.wsPath, pid: existing.pid};
  }
  try {
    rmSync(portFile, {force: true});
  } catch {
    /* ignore */
  }

  const exitState = {exited: false, code: null, signal: null};
  if (platform === 'win32') {
    const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    const encodedPidFile = Buffer.from(pidFile, 'utf8').toString('base64');
    const encodedErrorFile = Buffer.from(join(profileDir, 'browser-launch-error.txt'), 'utf8').toString('base64');
    const exe = Buffer.from(browserPath, 'utf8').toString('base64');
    const script = [
      "$ErrorActionPreference='Stop'",
      `$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${exe}'))`,
      `$browserArgs=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
      `$pidFile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPidFile}'))`,
      `$errorFile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedErrorFile}'))`,
      'try {',
      '  $p=Start-Process -FilePath $exe -ArgumentList $browserArgs -PassThru',
      '  Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ascii',
      '} catch {',
      '  try { Set-Content -LiteralPath $errorFile -Value ("ERROR:" + $_.Exception.Message) -Encoding utf8 } catch {}',
      '  exit 1',
      '}'
    ].join('; ');
    const powershell = env.SystemRoot
      ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const child = spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true
    });
    logger?.info({event: 'tiktok.browser.powershell.spawned', pid: child?.pid ?? null});
    child?.on?.('error', (error) => {
      logger?.warn({event: 'tiktok.browser.powershell.error', code: error?.code ?? 'unknown'});
    });
    child?.on?.('exit', (code) => {
      logger?.info({event: 'tiktok.browser.powershell.exit', code});
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      timer.unref?.();
      child?.on?.('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child?.on?.('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const pid = readPidFile(profileDir);
    const info = await waitForPort(portFile, timeoutMs, () => exitState.exited);
    if (!info?.port) {
      // The process may already have opened a window but never exposed CDP.
      // Kill only the PID we just started before the caller tries the next
      // installed browser, so fallback cannot leave two windows behind.
      killOwnedPidTree(pid);
      try {
        rmSync(portFile, {force: true});
        rmSync(pidFile, {force: true});
      } catch {
        /* ignore */
      }
      throw Object.assign(new Error('browser did not start'), {
        reason: 'browser_did_not_start',
        details: {pid, portFileExists: existsSync(portFile)}
      });
    }
    logger?.info({event: 'tiktok.browser.launch', kind: 'powershell', port: info.port, pid});
    return {kind: 'powershell', port: info.port, wsPath: info.wsPath, pid};
  }

  const child = spawnImpl(browserPath, args, {stdio: 'ignore'});
  const pid = child?.pid ?? null;
  if (pid) {
    try {
      writeFileSync(pidFile, String(pid), {mode: 0o600});
    } catch {
      /* best effort */
    }
  }
  child?.on?.('exit', (code, signal) => {
    exitState.exited = true;
    exitState.code = code;
    exitState.signal = signal;
  });
  const info = await waitForPort(portFile, timeoutMs, () => exitState.exited);
  if (!info?.port) {
    killOwnedPidTree(pid);
    throw Object.assign(new Error('browser did not start'), {reason: 'browser_did_not_start'});
  }
  logger?.info({event: 'tiktok.browser.launch', kind: 'spawn', port: info.port, pid});
  return {kind: 'spawn', port: info.port, wsPath: info.wsPath, pid};
}

/**
 * Close only Chromium processes whose command line contains this exact
 * LiveMemory profile path. Never matches the user's daily profile.
 */
export async function terminateOwnedBrowsers({
  profileDir,
  spawnImpl = spawn,
  platform = process.platform,
  env = process.env
} = {}) {
  if (platform !== 'win32' || !profileDir) return false;
  const encodedProfile = Buffer.from(profileDir, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$lmProfile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedProfile}'))`,
    "$targets=Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -and $_.CommandLine.Contains($lmProfile) }",
    'foreach ($t in $targets) { Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('; ');
  const powershell = env.SystemRoot
    ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const child = spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true
  });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    timer.unref?.();
    child?.on?.('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child?.on?.('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const pid = readPidFile(profileDir);
  if (pid) killOwnedPidTree(pid);
  try {
    rmSync(join(profileDir, 'DevToolsActivePort'), {force: true});
    rmSync(join(profileDir, 'browser.pid'), {force: true});
  } catch {
    /* ignore */
  }
  return true;
}

export const __internal = {waitForPort, sleep};
