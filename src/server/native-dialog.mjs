import {execFile} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {AppError} from '../shared/errors.mjs';

/**
 * Windows-native folder picker and Explorer integration.
 *
 * A browser cannot hand a local HTTP app an arbitrary absolute folder. The
 * console therefore asks this local service, which shows the standard Windows
 * FolderBrowserDialog in a separate PowerShell process. No user input is ever
 * interpolated into a command line and no shell (`cmd /c`) is used.
 */

const PICK_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = "Select a LiveMemory data folder"',
  '$dialog.ShowNewFolderButton = $true',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  [Console]::Out.Write($dialog.SelectedPath)',
  '}'
].join('\n');

export async function pickFolder({
  platform = process.platform,
  timeoutMs = 180000,
  runner = execFile
} = {}) {
  if (platform !== 'win32') {
    throw new AppError('PICKER_UNSUPPORTED', {messageKey: 'errors.pickerUnsupported', httpStatus: 501});
  }
  let stdout;
  try {
    const result = await runner('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-WindowStyle',
      'Hidden',
      '-Command',
      PICK_SCRIPT
    ], {timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8'});
    stdout = result?.stdout ?? '';
  } catch (error) {
    if (error?.killed || error?.signal) {
      throw new AppError('PICKER_TIMEOUT', {messageKey: 'errors.pickerTimeout', httpStatus: 408});
    }
    throw new AppError('PICKER_FAILED', {
      messageKey: 'errors.pickerFailed',
      details: {code: error?.code ?? 'unknown'},
      cause: error,
      httpStatus: 500
    });
  }
  const selected = String(stdout ?? '').replace(/\r/g, '').trim();
  if (!selected) return null;
  if (!isAbsolute(selected) || selected.includes('\u0000')) {
    throw new AppError('PICKER_FAILED', {messageKey: 'errors.pickerFailed', httpStatus: 500});
  }
  return resolve(selected);
}

/** Open one of LiveMemory's own folders in Explorer. */
export async function openFolder(folder, {
  platform = process.platform,
  runner = execFile,
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
    try {
      await runner('explorer.exe', [target], {timeout: 5000, windowsHide: false});
    } catch (error) {
      // explorer.exe often returns a non-zero exit code even when it opened the
      // window; only report a real spawn failure.
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
    await runner(command, [target], {timeout: 5000});
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

export const __internal = {PICK_SCRIPT};
