/*
 * Windows SEA bootstrap.
 *
 * The single executable embeds the application sources as assets. On first run
 * (and after each version change) they are extracted into the user data folder,
 * because ES modules and the web console are loaded from disk. The database,
 * settings, logs and exports live beside that extraction folder — never next to
 * the executable, which may be read-only.
 */
const {getAsset} = require('node:sea');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');

(async () => {
  const manifest = JSON.parse(getAsset('manifest', 'utf8'));
  const home = process.env.LIVE_MEMORY_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || os.homedir(), 'LiveMemory');

  const extractTo = async (appRoot) => {
    for (const file of manifest.files) {
      const target = path.join(appRoot, file);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, Buffer.from(getAsset(file)));
    }
  };

  // Prefer the user data folder so everything stays together, but fall back to
  // the per-user temp folder when that location is read-only. The launcher then
  // reports an unwritable data folder with a localized message instead of a
  // raw filesystem error from the bootstrap.
  let appRoot = path.join(home, 'app', manifest.hash);
  try {
    await extractTo(appRoot);
  } catch {
    appRoot = path.join(os.tmpdir(), 'LiveMemory-app', manifest.hash);
    await extractTo(appRoot);
  }
  process.env.LIVE_MEMORY_DATA_DIR = home;
  const launcher = await import(pathToFileURL(path.join(appRoot, 'src/launcher/launcher.mjs')).href);
  const code = await launcher.runLauncher({argv: process.argv.slice(1)});
  process.exitCode = code;
})().catch((error) => {
  process.stderr.write('LiveMemory failed to start.\n');
  process.stderr.write(`${(error && error.stack) || error}\n`);
  process.exitCode = 1;
});
