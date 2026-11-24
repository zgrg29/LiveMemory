import {mkdir, readFile, writeFile, readdir, copyFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_VERSION} from '../src/shared/app-info.mjs';
import {readGitCommit} from '../src/shared/build-info.mjs';
import {manifestLevel, setManifestLevel} from './pe-manifest.mjs';

/**
 * Build LiveMemory.exe with Node's Single Executable Application support.
 *
 * Why SEA: the app intentionally has no runtime dependencies, and SQLite is the
 * built-in node:sqlite module, so the official node.exe already contains every
 * runtime piece. No native modules are rebuilt on the user's machine.
 *
 * The visible console window is a product requirement, so the PE subsystem is
 * forced to CUI and the Authenticode certificate of node.exe is dropped before
 * the blob is injected.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Building LiveMemory.exe requires Windows x64 Node.js');
}

await mkdir('build', {recursive: true});
await mkdir('dist', {recursive: true});

// postject is a build-only tool; pin the archive checksum from the reference
// project so a compromised registry response cannot inject code into the build.
const archive = path.join('build', 'postject.tgz');
const POSTJECT_URL = 'https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz';
const POSTJECT_SHA256 = 'd1447b53e87d49ddaf7fb3350c870afafa72760eca47f6d5cce4cefd537e7d92';

let tarball;
try {
  tarball = await readFile(archive);
} catch {
  const response = await fetch(POSTJECT_URL);
  if (!response.ok) throw new Error(`postject download failed: ${response.status}`);
  tarball = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(tarball).digest('hex') !== POSTJECT_SHA256) {
  throw new Error('postject checksum mismatch — refusing to build');
}
await writeFile(archive, tarball);
// stdio must be inherited: the build environment forbids piped child process
// stdio, and tar needs no captured output here.
execFileSync('tar', ['-xf', archive, '-C', 'build'], {stdio: 'inherit'});

const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(file);
    else if (!entry.name.endsWith('.log')) files.push(file);
  }
}
await walk('src');
files.sort();

/**
 * These modules are the reliability fix. A build that does not contain them
 * must fail here instead of producing another "version looks right" EXE.
 */
const REQUIRED_MODULES = [
  'src/ai/api/runner.mjs',
  'src/ai/aggregate/hierarchy.mjs',
  'src/ai/providers/adapters.mjs',
  'src/ai/providers/session.mjs',
  'src/ai/batching/tokens.mjs',
  'src/ai/runtime/stream.mjs',
  'src/ai/runtime/attempt.mjs',
  'src/ai/runtime/scheduler.mjs',
  'src/ai/translation/service.mjs',
  'src/ai/translation/protocol.mjs',
  'src/ai/translation/fields.mjs',
  'src/server/auth.mjs',
  'src/server/backup/archive.mjs',
  'src/server/backup/create.mjs',
  'src/server/backup/inspect.mjs',
  'src/server/backup/journal.mjs',
  'src/server/backup/restore.mjs',
  'src/server/backup-jobs.mjs',
  'src/platforms/shared/credential-store.mjs',
  'src/platforms/twitch/adapter.mjs',
  'src/platforms/twitch/client.mjs',
  'src/platforms/twitch/irc.mjs',
  'src/platforms/twitch/link.mjs',
  'src/platforms/twitch/mapper.mjs',
  'src/platforms/twitch/service.mjs',
  'src/platforms/douyin/adapter.mjs',
  'src/platforms/douyin/browser-login.mjs',
  'src/platforms/douyin/client.mjs',
  'src/platforms/douyin/cookie-store.mjs',
  'src/platforms/douyin/link.mjs',
  'src/platforms/douyin/login.mjs',
  'src/platforms/douyin/messages.mjs',
  'src/platforms/douyin/protobuf.mjs',
  'src/platforms/douyin/service.mjs',
  'src/platforms/douyin/sign.mjs',
  'src/platforms/douyin/vendor/sign.js',
  'src/platforms/tiktok/client.mjs',
  'src/platforms/tiktok/errors.mjs',
  'src/platforms/tiktok/legacy-cleanup.mjs',
  'src/platforms/tiktok/link.mjs',
  'src/platforms/tiktok/local-adapter.mjs',
  'src/platforms/tiktok/messages.mjs',
  'src/platforms/tiktok/protobuf.mjs',
  'src/platforms/tiktok/service.mjs',
  'src/platforms/tiktok/state.mjs',
  'src/platforms/tiktok/webcast.mjs',
  'src/platforms/kick/adapter.mjs',
  'src/platforms/kick/errors.mjs',
  'src/platforms/kick/http.mjs',
  'src/platforms/kick/link.mjs',
  'src/platforms/kick/messages.mjs',
  'src/platforms/kick/service.mjs',
  'src/platforms/kick/transport.mjs',
  'src/platforms/kuaishou/adapter.mjs',
  'src/platforms/kuaishou/errors.mjs',
  'src/platforms/kuaishou/http.mjs',
  'src/platforms/kuaishou/link.mjs',
  'src/platforms/kuaishou/messages.mjs',
  'src/platforms/kuaishou/policy.mjs',
  'src/platforms/kuaishou/service.mjs',
  'src/platforms/kuaishou/status.mjs',
  'src/platforms/kuaishou/transport.mjs',
  'src/monitoring/detectors/kick.mjs',
  'src/monitoring/detectors/kuaishou.mjs',
  'src/monitoring/detectors/twitch.mjs',
  'src/monitoring/detectors/douyin.mjs',
  'src/monitoring/detectors/tiktok.mjs',
  'src/web/js/auth.js',
  'src/web/js/pages/help.js',
  'src/storage/repositories/ai-translations.mjs',
  'src/storage/repositories/ai-aggregate-nodes.mjs',
  'src/shared/build-info.mjs'
];
for (const required of REQUIRED_MODULES) {
  if (!files.includes(required)) throw new Error(`required module missing from build: ${required}`);
}

const fileHashes = {};
const bootstrapFile = 'scripts/sea-bootstrap.cjs';
const bootstrapData = await readFile(bootstrapFile);
const bootstrapHash = createHash('sha256')
  .update(bootstrapFile)
  .update(bootstrapData)
  .digest('hex');
const sourceHash = createHash('sha256');
for (const file of files) {
  const data = await readFile(file);
  fileHashes[file] = createHash('sha256').update(data).digest('hex');
  sourceHash.update(file).update(data);
}
sourceHash.update(bootstrapFile).update(bootstrapData);
const sourceDigest = sourceHash.digest('hex');
const assetHash = sourceDigest.slice(0, 20);
const commit = readGitCommit(root);
const shortCommit = commit ? commit.slice(0, 7) : null;
const builtAt = new Date().toISOString();
/**
 * The build identity is the content hash, not the commit prefix: a later docs
 * commit must not make an existing binary look like a different build. The Git
 * commit is still recorded separately for traceability.
 */
const buildId = sourceDigest.slice(0, 12);
const buildInfo = {
  version: APP_VERSION,
  commit,
  shortCommit,
  builtAt,
  sourceHash: sourceDigest,
  bootstrapHash,
  assetHash,
  buildId,
  node: process.versions.node,
  files: files.length + 1,
  requiredModules: REQUIRED_MODULES
};
await writeFile('build/build-info.json', `${JSON.stringify(buildInfo, null, 2)}\n`);
fileHashes['build-info.json'] = createHash('sha256')
  .update(await readFile('build/build-info.json'))
  .digest('hex');
files.push('build-info.json');

const assets = {};
for (const file of files) {
  if (file === 'build-info.json') continue;
  assets[file] = path.resolve(file);
}
const manifest = {
  version: APP_VERSION,
  hash: assetHash,
  files,
  fileHashes,
  build: {
    version: APP_VERSION,
    commit,
    shortCommit,
    builtAt,
    sourceHash: sourceDigest,
    bootstrapHash,
    assetHash,
    buildId,
    requiredModules: REQUIRED_MODULES
  }
};
await writeFile('build/manifest.json', JSON.stringify(manifest));
assets['manifest'] = path.resolve('build/manifest.json');
assets['build-info.json'] = path.resolve('build/build-info.json');

await writeFile('build/sea-config.json', JSON.stringify({
  main: 'scripts/sea-bootstrap.cjs',
  output: 'build/sea.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets
}));

execFileSync(process.execPath, ['--experimental-sea-config', 'build/sea-config.json'], {stdio: 'inherit'});

const binary = await readFile(process.execPath);

// A test-only build can be produced from the same sources with an asInvoker
// manifest, because Application Control refuses a binary that was re-patched
// after the build. The shipped EXE always stays requireAdministrator.
const asInvoker = process.argv.includes('--as-invoker');
// A versioned output can be built while the user's previous EXE is running.
const exe = process.env.LIVEMEMORY_BUILD_OUTPUT || (asInvoker ? 'dist/LiveMemory-asInvoker.exe' : 'dist/LiveMemory.exe');
await mkdir(path.dirname(exe), {recursive: true});
const manifestTarget = asInvoker ? 'asInvoker' : 'requireAdministrator';

// RC0-ADMIN-MANIFEST: the user explicitly chose to restore automatic UAC
// elevation because the packaged EXE failed on their PC during Bootstrap
// ("No writable application folder"). Windows itself presents the UAC prompt for
// a requireAdministrator image; the program does not bypass or disable UAC, and
// denying the prompt simply cancels the launch. Patch before and verify after
// postject injection so a build can never silently ship the wrong level.
setManifestLevel(binary, manifestTarget);
if (manifestLevel(binary) !== manifestTarget) {
  throw new Error(`failed to apply ${manifestTarget} manifest`);
}

// PE layout: DOS header -> PE header -> optional header.
const peOffset = binary.readUInt32LE(0x3c);
const optionalHeader = peOffset + 24;
const magic = binary.readUInt16LE(optionalHeader);
const dataDirectoryOffset = optionalHeader + (magic === 0x20b ? 112 : 96);
const subsystemOffset = optionalHeader + 68;
binary.writeUInt16LE(3, subsystemOffset); // IMAGE_SUBSYSTEM_WINDOWS_CUI

// Remove the certificate table entry and the attached signature before patching.
const certificateEntry = dataDirectoryOffset + 4 * 8;
const certificateOffset = binary.readUInt32LE(certificateEntry);
const certificateSize = binary.readUInt32LE(certificateEntry + 4);
binary.fill(0, certificateEntry, certificateEntry + 8);
const unsigned = certificateOffset && certificateOffset + certificateSize === binary.length
  ? binary.subarray(0, certificateOffset)
  : binary;
await writeFile(exe, unsigned);

const {inject} = createRequire(import.meta.url)('../build/package/dist/api.js');
await inject(exe, 'NODE_SEA_BLOB', await readFile('build/sea.blob'), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
});

await copyFile('LICENSE', 'dist/LICENSE');
await copyFile('README.md', 'dist/README.md');

const {size} = await stat(exe);
const exeBytes = await readFile(exe);
const sha256 = createHash('sha256').update(exeBytes).digest('hex');
/**
 * Prove the injected blob actually carries this build, not just that the build
 * script ran. The manifest and the required module names are plain strings in
 * the SEA asset table; both must be present in the final EXE.
 */
for (const needle of [
  buildId,
  'src/ai/batching/tokens.mjs',
  'src/ai/runtime/stream.mjs',
  'src/server/backup/restore.mjs',
  'src/platforms/douyin/vendor/sign.js',
  'src/platforms/douyin/adapter.mjs',
  'src/platforms/kick/adapter.mjs',
  'src/platforms/kick/service.mjs',
  'src/platforms/kick/transport.mjs',
  'src/platforms/kuaishou/adapter.mjs',
  'src/platforms/kuaishou/policy.mjs',
  'src/platforms/kuaishou/service.mjs',
  'src/platforms/kuaishou/transport.mjs',
  'src/monitoring/detectors/kick.mjs',
  'src/monitoring/detectors/kuaishou.mjs',
  'restore-journal.json'
]) {
  if (!exeBytes.includes(Buffer.from(needle, 'utf8'))) {
    throw new Error(`built EXE does not contain expected build marker: ${needle}`);
  }
}
if (manifestLevel(exeBytes) !== manifestTarget) {
  throw new Error(`final EXE manifest is not ${manifestTarget}`);
}
console.log(`Built ${exe}`);
console.log(`  size:    ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  sha256:  ${sha256}`);
console.log(`  buildId: ${buildId}`);
console.log(`  commit:  ${commit ?? 'unknown'}`);
console.log(`  builtAt: ${builtAt}`);
console.log(`  source:  ${sourceDigest}`);
console.log(`  assets:  ${files.length} files, asset hash ${assetHash}`);
console.log(`  modules: ${REQUIRED_MODULES.length} required reliability modules present`);
console.log(`  embedded build marker: verified`);
console.log(`  manifest: ${manifestLevel(exeBytes)}`);
