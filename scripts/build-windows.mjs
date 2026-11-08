import {mkdir, readFile, writeFile, readdir, copyFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_VERSION} from '../src/shared/app-info.mjs';

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

const hash = createHash('sha256');
const assets = {};
for (const file of files) {
  hash.update(file).update(await readFile(file));
  assets[file] = path.resolve(file);
}
const manifest = {
  version: APP_VERSION,
  hash: hash.digest('hex').slice(0, 20),
  files
};
await writeFile('build/manifest.json', JSON.stringify(manifest));
assets['manifest'] = path.resolve('build/manifest.json');

await writeFile('build/sea-config.json', JSON.stringify({
  main: 'scripts/sea-bootstrap.cjs',
  output: 'build/sea.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets
}));

execFileSync(process.execPath, ['--experimental-sea-config', 'build/sea-config.json'], {stdio: 'inherit'});

const exe = 'dist/LiveMemory.exe';
const binary = await readFile(process.execPath);

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
const sha256 = createHash('sha256').update(await readFile(exe)).digest('hex');
console.log(`Built ${exe}`);
console.log(`  size:   ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  sha256: ${sha256}`);
console.log(`  assets: ${files.length} files, hash ${manifest.hash}`);
