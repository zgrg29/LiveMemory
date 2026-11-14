import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

test('graceful server close removes runtime files, stops HTTP and keeps the database usable', async (t) => {
  const temp = createTempDir();
  const first = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  const runtimeFile = join(temp.dir, 'runtime', 'runtime.json');
  assert.equal(existsSync(runtimeFile), true);

  await first.close();
  assert.equal(existsSync(runtimeFile), false);
  await assert.rejects(() => fetch(`${first.url}api/health`, {signal: AbortSignal.timeout(800)}));

  const second = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await second.close();
    temp.cleanup();
  });
  const health = await (await fetch(`${second.url}api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(second.migration.to, 16);
});
