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
 *
 * ── amending a subset (`--replace`) ─────────────────────────────────────────
 *
 * Re-recording the one or two entries a fix invalidated used to mean freezing a
 * whole new run and discarding every other recording. `--replace` takes just
 * those responses from the new report and keeps the rest, and records where each
 * amended response came from in `run.amendments` — explicit provenance beats a
 * fixture that pretends to be a single run:
 *
 *     node benchmark/_freeze-trace.mjs benchmark/reports/<stamp>-suite.json \
 *       --replace methylation-block,qpcr-primers
 *
 * The replacement is a REAL recording from the named run, never a hand edit: the
 * original ids, order and every untouched response survive.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: node benchmark/_freeze-trace.mjs <report.json> [--replace id[,id…]]');
  process.exit(2);
}

const replaceAt = process.argv.indexOf('--replace');
const replaceIds = replaceAt === -1
  ? undefined
  : (process.argv[replaceAt + 1] ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '');
if (replaceAt !== -1 && (replaceIds === undefined || replaceIds.length === 0)) {
  console.error('--replace needs a comma-separated list of task ids');
  process.exit(2);
}

const report = JSON.parse(await readFile(resolve(source), 'utf8'));
if (!Array.isArray(report.results) || report.results.length === 0) {
  console.error(`${source}: no results in this report`);
  process.exit(1);
}

const responses = report.results.map((result) => ({
  id: result.id,
  tool_calls: result.toolCalls,
  answer: result.answer,
}));

const target = resolve(import.meta.dirname, '..', 'test', 'fixtures', 'benchmark-traces.json');

/** The whole-fixture shape: one run, every response from it. */
function wholeRun() {
  return {
    $comment:
      'Real responses from one benchmark run, frozen so the scorer can be regression-tested without spending API budget. See test/benchmark-score.mjs for why each defect these cover was invisible to synthetic traces.',
    run: {
      recorded_at: report.startedAt,
      harness_version: report.harnessVersion,
      profile: report.profile,
      model: report.model,
      summary: { total: report.summary.total, passed: report.summary.passed },
      responses,
    },
  };
}

/** The amended shape: keep the fixture, swap the named entries, say so. */
async function amendedRun() {
  const existing = JSON.parse(await readFile(target, 'utf8'));
  const byId = new Map(existing.run.responses.map((response) => [response.id, response]));
  // Replacing the same id twice must not pile up amendment entries or repeat
  // the provenance sentence: this command is re-run whenever a report is rebuilt.
  const amendments = (existing.run.amendments ?? []).filter((entry) => !replaceIds.includes(entry.id));
  for (const id of replaceIds) {
    const fresh = responses.find((response) => response.id === id);
    if (fresh === undefined) {
      console.error(`--replace: the report has no result for "${id}" — nothing was written`);
      process.exit(1);
    }
    if (!byId.has(id)) console.log(`  note: "${id}" was not in the fixture; appending it`);
    byId.set(id, fresh);
    amendments.push({
      id,
      recorded_at: report.startedAt,
      harness_version: report.harnessVersion,
      model: report.model,
    });
  }

  const ordered = existing.run.responses.map((response) => byId.get(response.id));
  for (const id of replaceIds) {
    if (!existing.run.responses.some((response) => response.id === id)) ordered.push(byId.get(id));
  }

  return {
    $comment: existing.$comment.includes('run.amendments names each one')
      ? existing.$comment
      : `${existing.$comment} Some responses were re-recorded later; run.amendments names each one and the run it came from, and every other response is unchanged. A replaced entry loses any suspension marker it carried, because the replacement is a fresh recording.`,
    run: {
      ...existing.run,
      amendments,
      responses: ordered,
    },
  };
}

const out = replaceIds === undefined ? wholeRun() : await amendedRun();
await writeFile(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(
  replaceIds === undefined
    ? `froze ${out.run.responses.length} response(s) into ${target}`
    : `amended ${replaceIds.length} response(s) (${replaceIds.join(', ')}) in ${target}; ${out.run.responses.length} total`,
);
