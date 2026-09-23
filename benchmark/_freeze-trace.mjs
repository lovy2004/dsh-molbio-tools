/**
 * dsh-molbio-tools/benchmark/_freeze-trace.mjs
 *
 * Freeze one real run's responses into `test/fixtures/benchmark-traces.json`.
 *
 * A run's `report.json` already carries every task's final answer and tool
 * calls, so the scorer's regression material can be regenerated from any run
 * without re-spending API budget:
 *
 *     node benchmark/_freeze-trace.mjs benchmark/reports/<stamp>-suite.json
 *
 * Run this only when you WANT to move the golden fixture forward (for example
 * after deliberately changing a task). Test failures point here when a recorded
 * response stops satisfying its task.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: node benchmark/_freeze-trace.mjs <report.json>');
  process.exit(2);
}

const report = JSON.parse(await readFile(resolve(source), 'utf8'));
if (!Array.isArray(report.results) || report.results.length === 0) {
  console.error(`${source}: no results in this report`);
  process.exit(1);
}

const out = {
  $comment:
    'Real responses from one benchmark run, frozen so the scorer can be regression-tested without spending API budget. See test/benchmark-score.mjs for why each defect these cover was invisible to synthetic traces.',
  run: {
    recorded_at: report.startedAt,
    harness_version: report.harnessVersion,
    profile: report.profile,
    model: report.model,
    summary: { total: report.summary.total, passed: report.summary.passed },
    responses: report.results.map((result) => ({
      id: result.id,
      tool_calls: result.toolCalls,
      answer: result.answer,
    })),
  },
};

const target = resolve(import.meta.dirname, '..', 'test', 'fixtures', 'benchmark-traces.json');
await writeFile(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`froze ${out.run.responses.length} response(s) into ${target}`);
