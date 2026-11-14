#!/usr/bin/env node
/**
 * Print the per-section byte attribution recorded by
 * `scripts/ai-efficiency-baseline.mjs`, or compare two runs.
 *
 * Usage:
 *   node scripts/ai-efficiency-report.mjs <baseline.json> [scenario...]
 *   node scripts/ai-efficiency-report.mjs --compare <before.json> <after.json>
 */
import {readFileSync} from 'node:fs';

function load(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function pct(before, after) {
  if (!before) return 'n/a';
  return `${(((after - before) / before) * 100).toFixed(1)}%`;
}

function sum(results, pick) {
  return results.reduce((total, entry) => total + (entry.report ? pick(entry.report) : 0), 0);
}

if (process.argv[2] === '--compare') {
  const before = load(process.argv[3]);
  const after = load(process.argv[4]);
  const beforeByName = new Map(before.results.map((entry) => [entry.name, entry]));
  process.stdout.write('| 场景 | 请求 前→后 | 输入 Token 前→后 | 输出 Token 前→后 | 总 Token 前→后 | 变化 | 每百观众 Token 前→后 | 覆盖 前→后 | 事实 前→后 |\n');
  process.stdout.write('| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n');
  for (const entry of after.results) {
    const prior = beforeByName.get(entry.name);
    if (!prior?.report || !entry.report) continue;
    const a = prior.report;
    const b = entry.report;
    process.stdout.write(`| ${entry.name} | ${a.requests} → ${b.requests} | ${a.simulatedInputTokens} → ${b.simulatedInputTokens} | ${a.simulatedOutputTokens} → ${b.simulatedOutputTokens} | ${a.simulatedTotalTokens} → ${b.simulatedTotalTokens} | ${pct(a.simulatedTotalTokens, b.simulatedTotalTokens)} | ${a.tokensPer100Viewers ?? '-'} → ${b.tokensPer100Viewers ?? '-'} | ${a.viewersCovered ?? '-'}/${a.viewersTotal ?? '-'} → ${b.viewersCovered ?? '-'}/${b.viewersTotal ?? '-'} | ${a.facts} → ${b.facts} |\n`);
  }
  const beforeResults = before.results.filter((entry) => entry.report);
  const afterResults = after.results.filter((entry) => entry.report);
  const metrics = [
    ['总请求数', (r) => r.requests],
    ['输入 Token（模拟）', (r) => r.simulatedInputTokens],
    ['输出 Token（模拟）', (r) => r.simulatedOutputTokens],
    ['总 Token（模拟）', (r) => r.simulatedTotalTokens],
    ['重试/补答 Token', (r) => r.retryTokens],
    ['请求字节', (r) => r.requestBytes],
    ['观众覆盖', (r) => r.viewersCovered ?? 0],
    ['有效事实', (r) => r.facts]
  ];
  process.stdout.write('\n| 汇总指标（14 个场景合计） | 优化前 | 优化后 | 变化 |\n| --- | --- | --- | --- |\n');
  for (const [label, pick] of metrics) {
    const a = sum(beforeResults, pick);
    const b = sum(afterResults, pick);
    process.stdout.write(`| ${label} | ${a} | ${b} | ${pct(a, b)} |\n`);
  }
  process.exit(0);
}

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node scripts/ai-efficiency-report.mjs <baseline.json> [scenario]\n');
  process.stderr.write('       node scripts/ai-efficiency-report.mjs --compare <before.json> <after.json>\n');
  process.exit(2);
}
const only = process.argv.slice(3);
const data = JSON.parse(readFileSync(file, 'utf8'));
for (const entry of data.results) {
  if (only.length > 0 && !only.some((token) => entry.name === token || entry.name.startsWith(`${token}-`))) continue;
  process.stdout.write(`\n=== ${entry.name} — ${entry.description}\n`);
  process.stdout.write(`status=${entry.status} requests=${entry.report?.requests ?? '-'} `
    + `fixedShare=${entry.report ? (entry.report.fixedShare * 100).toFixed(1) + '%' : '-'}\n`);
  if (!entry.report) {
    process.stdout.write(`${entry.error}\n`);
    continue;
  }
  const r = entry.report;
  process.stdout.write(`bytes: total=${r.requestBytes} fixed=${r.fixedBytes} content=${r.contentBytes}\n`);
  process.stdout.write(`stages: ${JSON.stringify(r.requestsByStage)}\n`);
  const rows = Object.entries(r.blockTotals)
    .sort((left, right) => right[1] - left[1]);
  const perRequest = Math.max(1, r.requests);
  for (const [name, bytes] of rows) {
    process.stdout.write(`  ${(bytes / 1024).toFixed(1).padStart(8)} KiB  avg/req ${(bytes / perRequest / 1024).toFixed(1).padStart(7)} KiB  ${name}\n`);
  }
}
