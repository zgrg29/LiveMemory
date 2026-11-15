import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {AppError} from '../shared/errors.mjs';

/**
 * Windows-native folder picker and Explorer integration.
 *
 * A browser cannot hand a local HTTP app an arbitrary absolute folder. The
 * console therefore asks this local service, which shows the standard Windows
 * FolderBrowserDialog in a separate PowerShell process.
 *
 * Important: the child is started with `stdio: 'ignore'` and returns its result
 * through a temporary UTF-8 file, never through a captured stdout pipe. Pipe
 * capture makes `child_process` fail with `spawn EPERM` in restricted Windows
 * environments (and was the cause of the broken Browse button). No user input
 * is interpolated into a command line and no shell (`cmd /c`) is used.
 */

function encode(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

/** Build the fixed PowerShell script. Exposed for unit tests. */
export function buildPickerScript({resultFile, initialDir = ''}) {
  const out = encode(resultFile);
  const initial = encode(initialDir);
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    `$out=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${out}'))`,
    `$initial=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${initial}'))`,
    'try {',
    '  [System.Windows.Forms.Application]::EnableVisualStyles()',
    '  $dialog=New-Object System.Windows.Forms.FolderBrowserDialog',
    '  $dialog.Description="Select a LiveMemory data folder"',
    '  $dialog.ShowNewFolderButton=$true',
    '  if ($initial -and (Test-Path -LiteralPath $initial)) { $dialog.SelectedPath=$initial }',
    '  $owner=New-Object System.Windows.Forms.Form',
    '  $owner.Text="LiveMemory"',
    '  $owner.ShowInTaskbar=$false',
    '  $owner.TopMost=$true',
    '  $owner.Opacity=0',
    '  $owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::None',
    '  $owner.Size=New-Object System.Drawing.Size(1,1)',
    '  $owner.StartPosition=[System.Windows.Forms.FormStartPosition]::CenterScreen',
    '  $owner.Show()',
    '  $result=$dialog.ShowDialog($owner)',
    '  $owner.Close()',
    '  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {',
    '    [IO.File]::WriteAllText($out, $dialog.SelectedPath, (New-Object Text.UTF8Encoding($false)))',
    '  }',
    '} catch {',
    '  try { [IO.File]::WriteAllText($out, ("ERROR:" + $_.Exception.Message), (New-Object Text.UTF8Encoding($false))) } catch {}',
    '  exit 1',
    '}',
    'exit 0'
  ].join('\n');
}

/**
 * Windows-native Save/Open file dialog for portable backups.
 *
 * The fixed dialog type is chosen in Node; every user-controlled value is
 * base64-encoded. The script never interpolates a path into a command line.
 */
export function buildFilePickerScript({
  resultFile,
  initialDir = '',
  defaultName = '',
  mode = 'open',
  filter = 'LiveMemory backup (*.livememory)|*.livememory|All files (*.*)|*.*'
}) {
  const out = encode(resultFile);
  const initial = encode(initialDir);
  const name = encode(defaultName);
  const filterText = encode(filter);
  const dialogType = mode === 'save' ? 'SaveFileDialog' : 'OpenFileDialog';
  const lines = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    `$out=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${out}'))`,
    `$initial=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${initial}'))`,
    `$defaultName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${name}'))`,
    `$filter=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${filterText}'))`,
    'try {',
    '  [System.Windows.Forms.Application]::EnableVisualStyles()',
    `  $dialog=New-Object System.Windows.Forms.${dialogType}`,
    '  $dialog.Title="LiveMemory"',
    '  $dialog.Filter=$filter',
    '  $dialog.RestoreDirectory=$true',
    mode === 'save'
      ? '  $dialog.DefaultExt="livememory"'
      : '  $dialog.CheckFileExists=$true',
    mode === 'save'
      ? '  $dialog.AddExtension=$true'
      : '  $dialog.Multiselect=$false',
    '  if ($defaultName) { $dialog.FileName=$defaultName }',
    '  if ($initial -and (Test-Path -LiteralPath $initial)) { $dialog.InitialDirectory=$initial }',
    '  $owner=New-Object System.Windows.Forms.Form',
    '  $owner.Text="LiveMemory"',
    '  $owner.ShowInTaskbar=$false',
    '  $owner.TopMost=$true',
    '  $owner.Opacity=0',
    '  $owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::None',
    '  $owner.Size=New-Object System.Drawing.Size(1,1)',
    '  $owner.StartPosition=[System.Windows.Forms.FormStartPosition]::CenterScreen',
    '  $owner.Show()',
    '  $result=$dialog.ShowDialog($owner)',
    '  $owner.Close()',
    '  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {',
    '    [IO.File]::WriteAllText($out, $dialog.FileName, (New-Object Text.UTF8Encoding($false)))',
    '  }',
    '} catch {',
    '  try { [IO.File]::WriteAllText($out, ("ERROR:" + $_.Exception.Message), (New-Object Text.UTF8Encoding($false))) } catch {}',
    '  exit 1',
    '}',
    'exit 0'
  ];
  return lines.join('\n');
}

function powershellCandidates({env = process.env, platform = process.platform} = {}) {
  if (platform !== 'win32') return [];
  const list = [];
  const root = env.SystemRoot || env.windir;
  if (root) list.push(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  list.push('powershell.exe', 'pwsh.exe');
  return [...new Set(list)];
}

function runProcess(executable, args, {spawnImpl, timeoutMs}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnImpl(executable, args, {
        stdio: 'ignore',
        windowsHide: true,
        detached: false
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        /* already gone */
      }
      finish(reject, Object.assign(new Error('picker timeout'), {code: 'PICKER_TIMEOUT'}));
    }, Math.max(1000, Number(timeoutMs) || 180000));
    timer.unref?.();
    const onError = (error) => finish(reject, error);
    const onExit = (code) => finish(resolvePromise, {code});
    if (typeof child.once === 'function') {
      child.once('error', onError);
      child.once('exit', onExit);
    } else {
      child.on('error', onError);
      child.on('exit', onExit);
    }
  });
}

/**
 * Show the Windows folder picker. Returns an absolute path, or null when the
 * user cancelled. A cancelled dialog is not an error.
 */
export async function pickFolder({
  platform = process.platform,
  timeoutMs = 180000,
  spawnImpl = spawn,
  workDir = null,
  initialDir = '',
  logger = null,
  env = process.env
} = {}) {
  if (platform !== 'win32') {
    throw new AppError('PICKER_UNSUPPORTED', {messageKey: 'errors.pickerUnsupported', httpStatus: 501});
  }
  let resultFile;
  let work = workDir;
  try {
    if (!work) work = join(tmpdir(), 'livememory-picker');
    mkdirSync(work, {recursive: true});
    resultFile = join(work, `picker-${process.pid}-${Date.now()}-${randomUUID()}.txt`);
  } catch (error) {
    throw new AppError('PICKER_FAILED', {
      messageKey: 'errors.pickerFailed',
      details: {code: error?.code ?? 'work-dir'},
      cause: error,
      httpStatus: 500
    });
  }

  const script = buildPickerScript({resultFile, initialDir});
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const candidates = powershellCandidates({env, platform});
  let lastError = null;

  try {
    for (const executable of candidates) {
      try {
        const outcome = await runProcess(executable, [
          '-NoProfile',
          '-STA',
          '-EncodedCommand',
          encoded
        ], {spawnImpl, timeoutMs});
        if (outcome.code !== 0 && !existsSync(resultFile)) {
          throw Object.assign(new Error(`picker exited with ${outcome.code}`), {code: 'PICKER_EXIT'});
        }
        if (!existsSync(resultFile)) return null;
        const text = readFileSync(resultFile, 'utf8').replace(/\r/g, '').trim();
        if (!text) return null;
        if (text.startsWith('ERROR:')) {
          throw Object.assign(new Error(text.slice('ERROR:'.length).slice(0, 500)), {code: 'PICKER_SCRIPT'});
        }
        if (!isAbsolute(text) || text.includes('\u0000')) {
          throw Object.assign(new Error('picker returned a non-absolute path'), {code: 'PICKER_PATH'});
        }
        return resolve(text);
      } catch (error) {
        lastError = error;
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
    throw lastError ?? Object.assign(new Error('no PowerShell found'), {code: 'ENOENT'});
  } catch (error) {
    if (error?.code === 'PICKER_TIMEOUT') {
      throw new AppError('PICKER_TIMEOUT', {messageKey: 'errors.pickerTimeout', httpStatus: 408});
    }
    logger?.warn({
      event: 'storage.picker.failed',
      code: String(error?.code ?? 'unknown'),
      message: String(error?.message ?? '').slice(0, 300)
    });
    throw new AppError('PICKER_FAILED', {
      messageKey: 'errors.pickerFailed',
      details: {
        code: String(error?.code ?? 'unknown'),
        message: String(error?.message ?? '').slice(0, 300)
      },
      cause: error,
      httpStatus: 500
    });
  } finally {
    if (resultFile) {
      try {
        rmSync(resultFile, {force: true});
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Show a native Save/Open file dialog. Returns an absolute path, or null when
 * the user cancelled. Callers must treat a null result as "do nothing".
 */
export async function pickFile({
  mode = 'open',
  platform = process.platform,
  timeoutMs = 180000,
  spawnImpl = spawn,
  workDir = null,
  initialDir = '',
  defaultName = '',
  filter = null,
  logger = null,
  env = process.env
} = {}) {
  if (platform !== 'win32') {
    throw new AppError('PICKER_UNSUPPORTED', {messageKey: 'errors.pickerUnsupported', httpStatus: 501});
  }
  if (!['open', 'save'].includes(mode)) {
    throw new AppError('PICKER_FAILED', {messageKey: 'errors.pickerFailed', httpStatus: 400});
  }
  let resultFile;
  let work = workDir;
  try {
    if (!work) work = join(tmpdir(), 'livememory-picker');
    mkdirSync(work, {recursive: true});
    resultFile = join(work, `picker-${process.pid}-${Date.now()}-${randomUUID()}.txt`);
  } catch (error) {
    throw new AppError('PICKER_FAILED', {
      messageKey: 'errors.pickerFailed',
      details: {code: error?.code ?? 'work-dir'},
      cause: error,
      httpStatus: 500
    });
  }

  const script = buildFilePickerScript({
    resultFile,
    initialDir,
    defaultName,
    mode,
    ...(filter ? {filter} : {})
  });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const candidates = powershellCandidates({env, platform});
  let lastError = null;

  try {
    for (const executable of candidates) {
      try {
        const outcome = await runProcess(executable, ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
          spawnImpl,
          timeoutMs
        });
        if (outcome.code !== 0 && !existsSync(resultFile)) {
          throw Object.assign(new Error(`picker exited with ${outcome.code}`), {code: 'PICKER_EXIT'});
        }
        if (!existsSync(resultFile)) return null;
        const text = readFileSync(resultFile, 'utf8').replace(/\r/g, '').trim();
        if (!text) return null;
        if (text.startsWith('ERROR:')) {
          throw Object.assign(new Error(text.slice('ERROR:'.length).slice(0, 500)), {code: 'PICKER_SCRIPT'});
        }
        if (!isAbsolute(text) || text.includes('\u0000')) {
          throw Object.assign(new Error('picker returned a non-absolute path'), {code: 'PICKER_PATH'});
        }
        return resolve(text);
      } catch (error) {
        lastError = error;
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
    throw lastError ?? Object.assign(new Error('no PowerShell found'), {code: 'ENOENT'});
  } catch (error) {
    if (error?.code === 'PICKER_TIMEOUT') {
      throw new AppError('PICKER_TIMEOUT', {messageKey: 'errors.pickerTimeout', httpStatus: 408});
    }
    logger?.warn({
      event: 'backup.picker.failed',
      code: String(error?.code ?? 'unknown'),
      message: String(error?.message ?? '').slice(0, 300)
    });
    throw new AppError('PICKER_FAILED', {
      messageKey: 'errors.pickerFailed',
      details: {
        code: String(error?.code ?? 'unknown'),
        message: String(error?.message ?? '').slice(0, 300)
      },
      cause: error,
      httpStatus: 500
    });
  } finally {
    if (resultFile) {
      try {
        rmSync(resultFile, {force: true});
      } catch {
        /* best effort */
      }
    }
  }
}

/** Open one of LiveMemory's own folders in Explorer. */
export async function openFolder(folder, {
  platform = process.platform,
  runner = null,
  spawnDetached = null
} = {}) {
  const target = resolve(String(folder ?? ''));
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new AppError('FOLDER_NOT_FOUND', {messageKey: 'errors.folderNotFound', httpStatus: 404});
  }
  if (platform === 'win32') {
    if (spawnDetached) {
      spawnDetached('explorer.exe', [target]);
      return {opened: true};
    }
    // `explorer.exe` normally detaches immediately; use spawn with ignored stdio
    // so this does not depend on captured pipes either.
    try {
      const child = spawn('explorer.exe', [target], {stdio: 'ignore', windowsHide: false, detached: true});
      child.unref?.();
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new AppError('FOLDER_OPEN_FAILED', {
          messageKey: 'errors.folderOpenFailed',
          details: {code: error.code},
          httpStatus: 500
        });
      }
    }
    return {opened: true};
  }
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [target], {stdio: 'ignore', detached: true});
    child.unref?.();
  } catch (error) {
    throw new AppError('FOLDER_OPEN_FAILED', {
      messageKey: 'errors.folderOpenFailed',
      details: {code: error?.code ?? 'unknown'},
      cause: error,
      httpStatus: 500
    });
  }
  return {opened: true};
}

export const __internal = {buildPickerScript, powershellCandidates};
