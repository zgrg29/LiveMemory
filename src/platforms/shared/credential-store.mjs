import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EncryptedJsonStore} from './secret-store.mjs';

/**
 * Provider credential backends.
 *
 * The historical `ai-keys.json` store is a self-managed AES-256-GCM file. It
 * needs a writable `secrets/` folder and a per-install key file whose ACL is
 * maintained by `icacls`. A Windows account/profile change, an inherited ACL
 * problem, a locked file, or an `icacls` principal that cannot be resolved can
 * make a save fail even though the rest of the data folder is writable.
 *
 * The primary backend is therefore Windows Credential Manager:
 *
 * - each API key is one generic credential (or a small set of chunks when the
 *   key is longer than the 2560-byte Win32 blob limit);
 * - the vault is protected by Windows DPAPI under the current user SID;
 * - the target name contains only a random credential reference, never the
 *   provider name or the key;
 * - no key is written to `config/*.json`, logs, backups or ZIP files.
 *
 * Node has no built-in FFI, so the CredWrite/CredRead/CredDelete calls are made
 * through an embedded Windows PowerShell script that compiles a fixed C#
 * P/Invoke shim with Add-Type. The key is sent on stdin, never in argv, an
 * environment variable, or a temporary plaintext file. The script is fixed; it
 * receives only target names, operations and base64 values.
 *
 * If Windows Credential Manager is unavailable (PowerShell disabled by policy,
 * ConstrainedLanguage mode, no logon session, or a non-Windows runtime), saves
 * fail with a classified error. There is deliberately no plaintext fallback.
 */

const TARGET_PREFIX = 'LiveMemory/ai-provider/v1/';
const REFERENCE_PATTERN = /^aicred_[0-9a-f]{32}$/;
const MAGIC_SINGLE = 1;
const MAGIC_CHUNKED = 2;
// CRED_MAX_CREDENTIAL_BLOB_SIZE is 5 * 512 = 2560 bytes. Leave headroom for
// the one-byte envelope and a small JSON marker.
const MAX_BLOB_BYTES = 2400;
const MAX_VALUE_BYTES = 8192;
const MAX_CHUNKS = 16;
const CREDENTIAL_PERSIST_LOCAL_MACHINE = 2;
const DEFAULT_TIMEOUT_MS = 30000;

export class CredentialBackendError extends Error {
  constructor(code, {win32 = null, cause = null, path = null, backend = null} = {}) {
    super(code);
    this.name = 'CredentialBackendError';
    this.code = code;
    if (win32 !== null && win32 !== undefined) this.win32 = Number(win32);
    if (cause) this.cause = cause;
    if (path) this.path = path;
    if (backend) this.backend = backend;
  }
}

function backendError(code, options = {}) {
  return new CredentialBackendError(code, options);
}

function decodeBase64(value) {
  if (typeof value !== 'string') throw new Error('not base64');
  return Buffer.from(value, 'base64');
}

/**
 * Legacy encrypted-file backend. It keeps the existing behaviour for tests,
 * non-Windows development and the platform cookie stores: a corrupt file is
 * never overwritten, and a failed write is reported with a classified error.
 */
export class FileCredentialBackend {
  constructor({
    dir,
    fileName = 'ai-keys.json',
    keyFileName = 'ai-keys.key',
    fs = {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync},
    strictKey = true
  }) {
    if (!dir) throw new Error('FileCredentialBackend: dir is required');
    this.dir = dir;
    this.fileName = fileName;
    this.keyFileName = keyFileName;
    this.fs = fs;
    this.strictKey = strictKey;
    this.file = join(dir, fileName);
    this.keyFile = join(dir, keyFileName);
  }

  #store() {
    return new EncryptedJsonStore({
      dir: this.dir,
      fileName: this.fileName,
      keyFileName: this.keyFileName,
      fs: this.fs,
      strictKey: this.strictKey
    });
  }

  #load() {
    return this.#store().loadDetailed();
  }

  #throwIfUnreadable(loaded) {
    if (!loaded?.error || loaded.error === 'CREDENTIAL_STORE_MISSING') return;
    throw backendError(loaded.error, {path: this.file, backend: 'encrypted-file'});
  }

  read(reference) {
    const loaded = this.#load();
    if (loaded.error === 'CREDENTIAL_STORE_MISSING') return null;
    this.#throwIfUnreadable(loaded);
    const value = loaded.data?.secrets?.[reference]?.apiKey;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  readMany(references) {
    const loaded = this.#load();
    const result = new Map();
    if (loaded.error === 'CREDENTIAL_STORE_MISSING') {
      for (const reference of references) result.set(reference, null);
      return result;
    }
    this.#throwIfUnreadable(loaded);
    const data = loaded.data?.secrets ?? {};
    for (const reference of references) {
      const value = data[reference]?.apiKey;
      result.set(reference, typeof value === 'string' && value.length > 0 ? value : null);
    }
    return result;
  }

  write(reference, value) {
    const loaded = this.#load();
    this.#throwIfUnreadable(loaded);
    const data = loaded.data?.secrets && typeof loaded.data.secrets === 'object'
      ? {...loaded.data.secrets}
      : {};
    data[reference] = {apiKey: value, updatedAt: new Date().toISOString()};
    this.#store().save({secrets: data});
  }

  remove(reference) {
    const loaded = this.#load();
    if (loaded.error === 'CREDENTIAL_STORE_MISSING') return;
    this.#throwIfUnreadable(loaded);
    const data = loaded.data?.secrets;
    if (!data || typeof data !== 'object' || !data[reference]) return;
    delete data[reference];
    this.#store().save({secrets: data});
  }

  clear() {
    try {
      this.fs.rmSync(this.file, {force: true});
    } catch {
      /* the factory reset also removes the whole secrets directory */
    }
  }

  status() {
    const loaded = this.#load();
    const error = loaded?.error && loaded.error !== 'CREDENTIAL_STORE_MISSING'
      ? loaded.error
      : null;
    return {
      backend: 'encrypted-file',
      available: error === null,
      error,
      path: this.file
    };
  }
}

/**
 * One-shot PowerShell bridge.
 *
 * `spawnSync` is used because ProviderConfigStore is synchronous and a key read
 * must be available immediately to the AI runtime. Successful reads are cached
 * by WindowsCredentialStore, so the process start cost is paid at most once per
 * credential. Writes are infrequent.
 */
export class PowerShellCredentialBridge {
  constructor({
    spawnSyncImpl = spawnSync,
    platform = process.platform,
    powershellPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    // Add-Type uses the process temp directory for its compiler artifacts. A
    // low-integrity or otherwise restricted token may have no write access to
    // the user's default %TEMP%; the application passes its own cache folder,
    // which the same process already proved writable.
    tempDir = null
  } = {}) {
    this.spawnSync = spawnSyncImpl;
    this.platform = platform;
    this.powershellPath = powershellPath ?? defaultPowerShellPath(env);
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.tempDir = tempDir;
  }

  read(targets) {
    const response = this.invoke({op: 'read', targets});
    const values = new Map();
    const raw = response?.values && typeof response.values === 'object' ? response.values : {};
    for (const target of targets) {
      const encoded = raw[target];
      if (typeof encoded === 'string') values.set(target, decodeBase64(encoded));
    }
    return values;
  }

  write(target, credentials, {persist = CREDENTIAL_PERSIST_LOCAL_MACHINE} = {}) {
    this.invoke({op: 'write', target, credentials, persist});
    return true;
  }

  delete(targets) {
    this.invoke({op: 'delete', targets});
    return true;
  }

  invoke(request) {
    if (this.platform !== 'win32') {
      throw backendError('CREDENTIAL_BACKEND_UNSUPPORTED', {backend: 'windows-credential-manager'});
    }
    if (!this.powershellPath || !existsSync(this.powershellPath)) {
      const error = backendError('CREDENTIAL_BACKEND_UNAVAILABLE', {
        backend: 'windows-credential-manager',
        cause: new Error('powershell.exe not found')
      });
      error.spawnCode = 'POWERSHELL_MISSING';
      throw error;
    }
    let input;
    try {
      input = JSON.stringify(request);
    } catch {
      throw backendError('CREDENTIAL_BACKEND_INVALID_REQUEST', {backend: 'windows-credential-manager'});
    }
    if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) {
      throw backendError('CREDENTIAL_BACKEND_INVALID_REQUEST', {backend: 'windows-credential-manager'});
    }
    const command = encodePowerShellCommand(POWERSHELL_SCRIPT);
    if (this.tempDir) {
      try {
        mkdirSync(this.tempDir, {recursive: true});
      } catch {
        /* the fixed script will report its own classified failure */
      }
    }
    const result = this.spawnSync(this.powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      command
    ], {
      input,
      encoding: 'utf8',
      timeout: this.timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: safePowerShellEnv(this.env, this.tempDir)
    });

    if (result?.error) {
      const code = result.error.code === 'ETIMEDOUT'
        ? 'CREDENTIAL_BACKEND_TIMEOUT'
        : 'CREDENTIAL_BACKEND_UNAVAILABLE';
      const error = backendError(code, {backend: 'windows-credential-manager', cause: result.error});
      error.spawnCode = result.error.code ?? 'SPAWN_FAILED';
      throw error;
    }
    const stdout = String(result?.stdout ?? '').trim();
    if (!stdout) {
      const error = backendError('CREDENTIAL_BACKEND_INVALID_RESPONSE', {
        backend: 'windows-credential-manager',
        cause: new Error(`exit ${result?.status ?? 'null'}`)
      });
      error.spawnCode = `EMPTY_OUTPUT_${result?.status ?? 'null'}`;
      throw error;
    }
    let response;
    try {
      response = JSON.parse(stdout);
    } catch {
      throw backendError('CREDENTIAL_BACKEND_INVALID_RESPONSE', {backend: 'windows-credential-manager'});
    }
    if (response?.ok === true) return response;
    throw classifyScriptFailure(response, request.op);
  }
}

function classifyScriptFailure(response, op) {
  const named = String(response?.error ?? '');
  if (named === 'ADD_TYPE_FAILED') {
    const error = backendError('CREDENTIAL_BACKEND_UNAVAILABLE', {
      backend: 'windows-credential-manager',
      win32: response?.win32 ?? null,
      cause: new Error('Add-Type failed')
    });
    error.scriptError = String(response?.message ?? '').slice(0, 500);
    return error;
  }
  if (named === 'EMPTY_INPUT' || named === 'BAD_OPERATION') {
    return backendError('CREDENTIAL_BACKEND_INVALID_REQUEST', {backend: 'windows-credential-manager'});
  }
  const win32 = Number(response?.win32 ?? 0);
  const mapped = classifyWin32(win32);
  if (mapped) return backendError(mapped, {backend: 'windows-credential-manager', win32});
  return backendError(op === 'write' || op === 'delete'
    ? 'CREDENTIAL_BACKEND_WRITE_FAILED'
    : 'CREDENTIAL_BACKEND_READ_FAILED', {
    backend: 'windows-credential-manager',
    win32: Number.isFinite(win32) ? win32 : null
  });
}

function classifyWin32(code) {
  switch (Number(code)) {
    case 5: // ERROR_ACCESS_DENIED
    case 1314: // ERROR_PRIVILEGE_NOT_HELD
    case 2202: // ERROR_BAD_USERNAME / restricted account
      return 'CREDENTIAL_BACKEND_ACCESS_DENIED';
    case 1312: // ERROR_NO_SUCH_LOGON_SESSION
    case 1317: // ERROR_USER_EXISTS (ambiguous logon state)
    case 1326: // ERROR_LOGON_FAILURE
    case 1722: // RPC_S_SERVER_UNAVAILABLE
    case 1723: // RPC_S_CALL_FAILED
      return 'CREDENTIAL_BACKEND_UNAVAILABLE';
    case 87: // ERROR_INVALID_PARAMETER
      return 'CREDENTIAL_BACKEND_INVALID_REQUEST';
    case 1315: // error used by the fixed script for a read-back mismatch
      return 'CREDENTIAL_BACKEND_VERIFY_FAILED';
    default:
      return null;
  }
}

/**
 * Windows Credential Manager credential backend.
 *
 * Credential targets are stable across data-directory moves because they are
 * derived from the random `credentialReference` already stored in the provider
 * config, not from the data folder. The target contains no provider name and no
 * secret. Windows itself scopes the vault to the current user SID; LiveMemory
 * never attempts to read another account's vault.
 */
export class WindowsCredentialStore {
  constructor({
    bridge = null,
    platform = process.platform,
    targetPrefix = TARGET_PREFIX,
    now = Date.now,
    tempDir = null
  } = {}) {
    this.bridge = bridge ?? new PowerShellCredentialBridge({platform, tempDir});
    this.platform = platform;
    this.targetPrefix = targetPrefix;
    this.now = now;
    this.cache = new Map();
    this.meta = new Map();
    this.state = {
      backend: 'windows-credential-manager',
      available: null,
      error: null,
      win32: null
    };
  }

  #assertReference(reference) {
    if (!REFERENCE_PATTERN.test(String(reference ?? ''))) {
      throw backendError('CREDENTIAL_BACKEND_INVALID_REFERENCE', {
        backend: 'windows-credential-manager'
      });
    }
  }

  target(reference) {
    this.#assertReference(reference);
    return `${this.targetPrefix}${reference}`;
  }

  #markSuccess() {
    this.state.available = true;
    this.state.error = null;
    this.state.win32 = null;
  }

  #markFailure(error) {
    this.state.available = false;
    this.state.error = error?.code ?? 'CREDENTIAL_BACKEND_UNAVAILABLE';
    this.state.win32 = error?.win32 ?? null;
    throw error;
  }

  #decode(reference, marker) {
    if (!marker || marker.length === 0) return null;
    if (marker[0] === MAGIC_SINGLE) {
      const value = marker.subarray(1).toString('utf8');
      this.meta.delete(reference);
      return value.length > 0 ? value : null;
    }
    if (marker[0] !== MAGIC_CHUNKED) {
      throw backendError('CREDENTIAL_BACKEND_CORRUPT', {
        backend: 'windows-credential-manager'
      });
    }
    let meta;
    try {
      meta = JSON.parse(marker.subarray(1).toString('utf8'));
    } catch {
      throw backendError('CREDENTIAL_BACKEND_CORRUPT', {
        backend: 'windows-credential-manager'
      });
    }
    if (meta?.v !== 1 || typeof meta.gen !== 'string' || !/^[0-9a-f]{12}$/.test(meta.gen)
      || !Number.isInteger(meta.parts) || meta.parts < 2 || meta.parts > MAX_CHUNKS) {
      throw backendError('CREDENTIAL_BACKEND_CORRUPT', {
        backend: 'windows-credential-manager'
      });
    }
    return {gen: meta.gen, parts: meta.parts};
  }

  #readTargets(references) {
    const uncached = references.filter((reference) => !this.cache.has(reference));
    if (uncached.length === 0) {
      return new Map(references.map((reference) => [reference, this.cache.get(reference)]));
    }
    const targets = uncached.map((reference) => this.target(reference));
    let markers;
    try {
      markers = this.bridge.read(targets);
      this.#markSuccess();
    } catch (error) {
      this.#markFailure(error);
    }

    const chunkRequests = [];
    const decoded = new Map();
    for (const reference of uncached) {
      const target = this.target(reference);
      const marker = markers.get(target) ?? null;
      const value = this.#decode(reference, marker);
      if (value && typeof value === 'object') {
        const chunkTargets = [];
        for (let index = 1; index <= value.parts; index += 1) {
          chunkTargets.push(`${target}#${value.gen}#${index}`);
        }
        chunkRequests.push({reference, target, value, chunkTargets});
        decoded.set(reference, null);
      } else {
        decoded.set(reference, value);
      }
    }

    if (chunkRequests.length > 0) {
      const all = chunkRequests.flatMap((entry) => entry.chunkTargets);
      let chunks;
      try {
        chunks = this.bridge.read(all);
        this.#markSuccess();
      } catch (error) {
        this.#markFailure(error);
      }
      for (const entry of chunkRequests) {
        const buffers = entry.chunkTargets.map((target) => chunks.get(target));
        if (buffers.some((buffer) => !buffer)) {
          throw backendError('CREDENTIAL_BACKEND_CORRUPT', {
            backend: 'windows-credential-manager'
          });
        }
        decoded.set(entry.reference, Buffer.concat(buffers).toString('utf8'));
      }
    }

    for (const reference of uncached) {
      this.cache.set(reference, decoded.get(reference) ?? null);
    }
    return new Map(references.map((reference) => [reference, this.cache.get(reference)]));
  }

  read(reference) {
    this.#assertReference(reference);
    if (this.cache.has(reference)) return this.cache.get(reference);
    return this.#readTargets([reference]).get(reference) ?? null;
  }

  readMany(references) {
    const unique = [...new Set(references.filter(Boolean))];
    for (const reference of unique) this.#assertReference(reference);
    return this.#readTargets(unique);
  }

  write(reference, value) {
    this.#assertReference(reference);
    const text = String(value ?? '');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length === 0) {
      throw backendError('CREDENTIAL_BACKEND_INVALID_REQUEST', {
        backend: 'windows-credential-manager'
      });
    }
    if (bytes.length > MAX_VALUE_BYTES) {
      throw backendError('CREDENTIAL_VALUE_TOO_LARGE', {
        backend: 'windows-credential-manager'
      });
    }
    const target = this.target(reference);
    const credentials = [];
    if (bytes.length + 1 <= MAX_BLOB_BYTES) {
      credentials.push({
        target,
        value: Buffer.concat([Buffer.from([MAGIC_SINGLE]), bytes]).toString('base64')
      });
      this.meta.delete(reference);
    } else {
      const parts = Math.ceil(bytes.length / MAX_BLOB_BYTES);
      if (parts > MAX_CHUNKS) {
        throw backendError('CREDENTIAL_VALUE_TOO_LARGE', {
          backend: 'windows-credential-manager'
        });
      }
      const gen = randomGeneration();
      for (let index = 0; index < parts; index += 1) {
        credentials.push({
          target: `${target}#${gen}#${index + 1}`,
          value: bytes.subarray(index * MAX_BLOB_BYTES, (index + 1) * MAX_BLOB_BYTES).toString('base64')
        });
      }
      credentials.push({
        target,
        value: Buffer.concat([
          Buffer.from([MAGIC_CHUNKED]),
          Buffer.from(JSON.stringify({v: 1, gen, parts}), 'utf8')
        ]).toString('base64')
      });
      this.meta.set(reference, {gen, parts});
    }

    try {
      this.bridge.write(target, credentials, {persist: CREDENTIAL_PERSIST_LOCAL_MACHINE});
      this.#markSuccess();
    } catch (error) {
      this.#markFailure(error);
    }
    this.cache.set(reference, text);
    return true;
  }

  remove(reference) {
    this.#assertReference(reference);
    try {
      this.bridge.delete([this.target(reference)]);
      this.#markSuccess();
    } catch (error) {
      this.#markFailure(error);
    }
    this.cache.set(reference, null);
    this.meta.delete(reference);
    return true;
  }

  /** Remove several credentials in one vault call without failing the reset. */
  clear(references) {
    const valid = [...new Set(references.filter((reference) => REFERENCE_PATTERN.test(String(reference ?? ''))))];
    if (valid.length === 0) return {removed: 0, failures: []};
    try {
      this.bridge.delete(valid.map((reference) => this.target(reference)));
      this.#markSuccess();
    } catch (error) {
      this.state.available = false;
      this.state.error = error?.code ?? 'CREDENTIAL_BACKEND_UNAVAILABLE';
      this.state.win32 = error?.win32 ?? null;
      return {
        removed: 0,
        failures: valid.map((reference) => ({
          reference,
          code: error?.code ?? 'CREDENTIAL_BACKEND_UNAVAILABLE'
        }))
      };
    }
    for (const reference of valid) {
      this.cache.set(reference, null);
      this.meta.delete(reference);
    }
    return {removed: valid.length, failures: []};
  }

  status() {
    return {...this.state};
  }
}

function randomGeneration() {
  // 12 hex characters keep the target short and the marker small.
  return randomBytes(6).toString('hex');
}

function defaultPowerShellPath(env) {
  const root = env?.SystemRoot || env?.WINDIR || 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function safePowerShellEnv(env, tempDir = null) {
  const root = env?.SystemRoot || env?.WINDIR || 'C:\\Windows';
  const temp = tempDir || env?.TEMP || env?.TMP || join(root, 'Temp');
  return {
    SystemRoot: root,
    WINDIR: root,
    TEMP: temp,
    TMP: temp,
    PATH: `${join(root, 'System32')};${root}`,
    PSModulePath: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: env?.USERPROFILE || ''
  };
}

export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * Fixed script. It contains no secret and no user-controlled code. Values are
 * received as base64 on stdin; results are base64 on stdout. All output is a
 * single JSON object; progress/CLIXML noise is suppressed.
 */
export const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Write-Result([hashtable]$value) {
  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 8))
}
$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) {
  Write-Result @{ ok = $false; error = 'EMPTY_INPUT' }
  exit 4
}
$csharp = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class LiveMemoryCredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);

  private const uint CRED_TYPE_GENERIC = 1;

  public static byte[] Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, CRED_TYPE_GENERIC, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      int size = (int)credential.CredentialBlobSize;
      byte[] data = new byte[size];
      if (size > 0) Marshal.Copy(credential.CredentialBlob, data, 0, size);
      return data;
    } finally {
      CredFree(pointer);
    }
  }

  public static void Write(string target, byte[] value, int persist) {
    if (value == null) value = new byte[0];
    IntPtr blob = Marshal.AllocHGlobal(value.Length == 0 ? 1 : value.Length);
    try {
      if (value.Length > 0) Marshal.Copy(value, 0, blob, value.Length);
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = CRED_TYPE_GENERIC;
      credential.TargetName = target;
      credential.CredentialBlobSize = (uint)value.Length;
      credential.CredentialBlob = blob;
      credential.Persist = (uint)persist;
      credential.UserName = "LiveMemory";
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.FreeHGlobal(blob);
    }
  }

  public static void Delete(string target) {
    if (!CredDelete(target, CRED_TYPE_GENERIC, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != 1168) throw new Win32Exception(error);
    }
  }
}
'@
try {
  Add-Type -TypeDefinition $csharp -Language CSharp -ErrorAction Stop
} catch {
  Write-Result @{ ok = $false; error = 'ADD_TYPE_FAILED'; message = [string]$_.Exception.Message }
  exit 3
}
try {
  $request = $raw | ConvertFrom-Json
  switch ([string]$request.op) {
    'read' {
      $values = @{}
      foreach ($target in @($request.targets)) {
        if ($null -eq $target) { continue }
        $bytes = [LiveMemoryCredentialNative]::Read([string]$target)
        if ($null -ne $bytes) { $values[[string]$target] = [Convert]::ToBase64String($bytes) }
      }
      Write-Result @{ ok = $true; values = $values }
    }
    'write' {
      $base = [string]$request.target
      $oldChunks = @()
      $old = [LiveMemoryCredentialNative]::Read($base)
      if ($null -ne $old -and $old.Length -ge 2 -and $old[0] -eq 2) {
        $meta = [Text.Encoding]::UTF8.GetString($old, 1, $old.Length - 1) | ConvertFrom-Json
        if ($meta.gen -and $meta.parts) {
          for ($i = 1; $i -le [int]$meta.parts; $i++) {
            $oldChunks += ("$base#{0}#{1}" -f [string]$meta.gen, $i)
          }
        }
      }
      foreach ($entry in @($request.credentials)) {
        $target = [string]$entry.target
        $bytes = [Convert]::FromBase64String([string]$entry.value)
        if ($bytes.Length -gt 2400) { throw [System.ComponentModel.Win32Exception]::new(87) }
        [LiveMemoryCredentialNative]::Write($target, $bytes, [int]$request.persist)
      }
      $newTargets = @{}
      foreach ($entry in @($request.credentials)) {
        $target = [string]$entry.target
        $newTargets[$target] = $true
        $check = [LiveMemoryCredentialNative]::Read($target)
        $expected = [Convert]::FromBase64String([string]$entry.value)
        if ($null -eq $check -or [Convert]::ToBase64String($check) -ne [Convert]::ToBase64String($expected)) {
          throw [System.ComponentModel.Win32Exception]::new(1315)
        }
      }
      foreach ($target in $oldChunks) {
        if (-not $newTargets.ContainsKey([string]$target)) {
          try { [LiveMemoryCredentialNative]::Delete([string]$target) } catch { }
        }
      }
      Write-Result @{ ok = $true; written = @($request.credentials).Count }
    }
    'delete' {
      foreach ($base in @($request.targets)) {
        if ($null -eq $base) { continue }
        $base = [string]$base
        $old = [LiveMemoryCredentialNative]::Read($base)
        if ($null -ne $old -and $old.Length -ge 2 -and $old[0] -eq 2) {
          $meta = [Text.Encoding]::UTF8.GetString($old, 1, $old.Length - 1) | ConvertFrom-Json
          if ($meta.gen -and $meta.parts) {
            for ($i = 1; $i -le [int]$meta.parts; $i++) {
              $chunk = ("$base#{0}#{1}" -f [string]$meta.gen, $i)
              try { [LiveMemoryCredentialNative]::Delete($chunk) } catch { }
            }
          }
        }
        [LiveMemoryCredentialNative]::Delete($base)
      }
      Write-Result @{ ok = $true }
    }
    default {
      Write-Result @{ ok = $false; error = 'BAD_OPERATION' }
      exit 4
    }
  }
} catch {
  $win32 = 0
  if ($_.Exception -is [System.ComponentModel.Win32Exception]) {
    $win32 = [int]$_.Exception.NativeErrorCode
  }
  Write-Result @{ ok = $false; error = 'OPERATION_FAILED'; win32 = $win32 }
  exit 2
}
`;

export const __internal = {
  TARGET_PREFIX,
  REFERENCE_PATTERN,
  MAGIC_SINGLE,
  MAGIC_CHUNKED,
  MAX_BLOB_BYTES,
  MAX_VALUE_BYTES,
  MAX_CHUNKS,
  CREDENTIAL_PERSIST_LOCAL_MACHINE,
  classifyWin32,
  defaultPowerShellPath,
  safePowerShellEnv
};
