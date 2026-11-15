#!/usr/bin/env node
/**
 * Offline structural comparison of 5 / 10 / 20 viewer memory batches.
 *
 * It copies the source database to a temporary directory first, so the source is
 * never written. It creates no provider request: only package planning, token
 * estimates and ZIP byte sizes are measured.
 *
 * Usage:
 *   node scripts/memory-batch-structure.mjs --db <livememory.db> --session <ses_...> \
 *     --caps 5,10,20 [--out structure.json]
 */

import {copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {createViewerMemoryJob} from '../src/ai/export/split-jobs.mjs';
import {listSessionMessagesAsc} from '../src/storage/repositories/events.mjs';
import {readZipEntry} from '../src/shared/zip.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const source = arg('db');
const sessionId = arg('session');
if (!source || !sessionId) {
  process.stderr.write('usage: memory-batch-structure.mjs --db <file> --session <ses_...> [--caps 5,10,20]\n');
  process.exit(2);
}
const caps = String(arg('caps', '5,10,20')).split(',').map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
const root = mkdtempSync(join(tmpdir(), 'lm-memory-structure-'));
const dbFile = join(root, 'livememory.db');
copyFileSync(resolve(source), dbFile);
const exportsDir = join(root, 'exports');
const results = [];
let db = null;
try {
  db = openDatabase({file: dbFile});
  const messages = listSessionMessagesAsc(db, {sessionId, limit: 1000000});
  for (const cap of caps) {
    const created = await createViewerMemoryJob({
      db,
      sessionId,
      locale: 'zh-CN',
      exportsDir: join(exportsDir, `cap${cap}`),
      viewersPerBatch: cap,
      viewersPerBatchHard: cap,
      excerptCap: 600,
      now: Date.parse('2026-11-20T00:00:00.000Z')
    });
    const packages = created.packages.map((pkg) => {
      const file = join(exportsDir, `cap${cap}`, pkg.fileName);
      const manifest = JSON.parse(readZipEntry(readFileSync(file), 'manifest.json').toString('utf8'));
      const bytes = statSync(file).size;
      return {
        batchIndex: pkg.batchIndex,
        fileName: basename(pkg.fileName),
        viewers: pkg.viewerCount,
        messages: pkg.messageCount,
        bytes,
        outputBudget: manifest.batch_plan?.output_budget_tokens ?? null,
        estimatedOutput: manifest.batch_plan?.estimated_output_tokens ?? null,
        estimatedPrompt: manifest.batch_plan?.estimated_prompt_tokens ?? null
      };
    });
    results.push({
      cap,
      batches: created.job.batchTotal,
      viewers: created.job.memoryViewersTotal,
      messages: messages.length,
      inputBudgetTokens: created.job.inputBudgetTokens,
      contentBudgetTokens: created.job.contentBudgetTokens,
      overheadTokens: created.job.overheadTokens,
      oversizedViewerCount: created.job.oversizedViewerCount,
      outputOversizedViewerCount: created.job.outputOversizedViewerCount,
      totalBytes: packages.reduce((total, pkg) => total + pkg.bytes, 0),
      batchesDetail: packages
    });
  }
} finally {
  if (db) closeDatabase(db);
  rmSync(root, {recursive: true, force: true});
}

const out = arg('out');
if (out) writeFileSync(resolve(out), `${JSON.stringify({sessionId, messages: results[0]?.messages ?? 0, results}, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({sessionId, messages: results[0]?.messages ?? 0, results}, null, 2)}\n`);
