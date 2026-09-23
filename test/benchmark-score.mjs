/**
 * dsh-molbio-tools/test/benchmark-score.mjs
 *
 * Guard the benchmark's SCORER with recorded real responses.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * A benchmark's scorer is a program, and a broken scorer produces numbers that
 * look like measurements. This one had three defects in its first version, all
 * of which were found only by reading a full model run's output:
 *
 *  1. **Grading the wrong text.** `where: "tool"` assertions were checked
 *     offline against the tool's raw JSON output, but a live trace only carries
 *     the RENDERED result. The offline half therefore validated a format that
 *     never exists at runtime — a green check over a property that could not
 *     hold. (`scoreSuiteOffline` now renders; `--offline` covers it.)
 *  2. **`tool_result` mis-attribution.** Results were matched to calls by
 *     arrival order rather than `callId`, so a result whose call was not in the
 *     window was blamed on whichever call came last. (`foldEvents` now keys on
 *     `callId`.)
 *  3. **Assertions that failed correct answers.** Six of them: a literal
 *     `GAATTC` where the model legitimately writes `G^AATTC`; a demand for "2
 *     bands" where the model correctly distinguished 2 fragments from the single
 *     band a 1 kb ladder resolves; a demand for a literal `?` when the headless
 *     composition has no question answerer and the model is told to ask in
 *     prose; and a `mismatch @seq1 81 / …` pattern that depended on line-break
 *     positions.
 *
 * The regression material is the real responses from a real run, frozen in
 * `test/fixtures/benchmark-traces.json`. They are committed on purpose: the bugs
 * above are invisible to synthetic traces (they are properties of how a MODEL
 * phrases things), and a re-run costs API budget, so the evidence has to
 * outlive the run that produced it.
 *
 * This suite does NOT call a model. It re-verifies that every recorded response
 * still satisfies the task it came from, and it proves the scorer can FAIL.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { foldEvents, loadTasks, scoreTrace } from '../benchmark/score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const TRACES = join(here, 'fixtures', 'benchmark-traces.json');

const { tasks } = await loadTasks();
const byId = new Map(tasks.map((task) => [task.id, task]));
const recorded = JSON.parse(await readFile(TRACES, 'utf8'));
const run = recorded.run;

assert.ok(Array.isArray(run?.responses) && run.responses.length >= 8, 'benchmark-traces.json must carry a real run');

// ── (1) every recorded response still satisfies its own task ────────────────
//
// Only the ANSWER assertions can be re-verified from a frozen response: the
// fixture records the final text and the tool NAMES, but not each tool result's
// rendered text (that would bloat it, and `--offline` already verifies the tool
// half against the real tools). So the tool text is deliberately absent here,
// and the scorer is told to check the answer half by dropping the `tool`
// assertions for this pass.

let checked = 0;
const regressions = [];
for (const response of run.responses) {
  const task = byId.get(response.id);
  assert.ok(task, `fixtures/benchmark-traces.json names an unknown task "${response.id}"`);
  assert.ok(Array.isArray(response.tool_calls), `${response.id}: the fixture must list the tool calls the run made`);
  for (const tool of task.expect_tools ?? []) {
    if (!response.tool_calls.includes(tool)) {
      assert.fail(`fixtures/benchmark-traces.json response "${response.id}" did not call ${tool} — the fixture and the task disagree`);
    }
  }
  for (const tool of task.expect_absent ?? []) {
    assert.ok(
      !response.tool_calls.includes(tool),
      `fixtures/benchmark-traces.json response "${response.id}" called ${tool}, which the task forbids`,
    );
  }
  const trace = foldEvents([
    ...response.tool_calls.map((tool, index) => ({ type: 'tool_call', callId: `c${index}`, tool, input: {} })),
    { type: 'final', text: response.answer },
  ]);
  const scored = scoreTrace({ ...task, assertions: task.assertions.filter((a) => a.where === 'answer') }, trace);
  checked += 1;
  if (!scored.answer_ok) {
    for (const failure of scored.failures) regressions.push(`${response.id}: ${failure.detail}`);
  }
  assert.equal(scored.tools_ok, true, `${response.id}: the recorded tool calls must satisfy the task's selection rules`);
}

assert.deepEqual(
  regressions,
  [],
  'a recorded real response no longer satisfies its task — an assertion regressed to grading phrasing instead of content',
);

// ── (2) `tool_result` is attributed by callId, not by arrival order ─────────

{
  const trace = foldEvents([
    { type: 'tool_call', callId: 'a', tool: 'molbio_first', input: {} },
    { type: 'tool_call', callId: 'b', tool: 'molbio_second', input: {} },
    // Deliberately out of order, and with an id that was never announced.
    { type: 'tool_result', callId: 'b', status: 'completed', result: 'second result' },
    { type: 'tool_result', callId: 'a', status: 'completed', result: 'first result' },
    { type: 'tool_result', callId: 'ghost', status: 'completed', result: 'orphan' },
  ]);
  assert.deepEqual(
    trace.results.map((result) => [result.tool, result.result]),
    [
      ['molbio_second', 'second result'],
      ['molbio_first', 'first result'],
      ['(unattributed)', 'orphan'],
    ],
    'results must follow callId, and an unannounced callId must be reported as unattributed rather than blamed on a neighbour',
  );
}

// ── (3) truncation is REPORTED, and marked as suspect evidence ──────────────

{
  const task = {
    id: 'truncation-probe',
    assertions: [{ where: 'tool', pattern: 'a needle that was pruned away' }],
    expect_tools: ['molbio_x'],
  };
  const trace = foldEvents([
    { type: 'tool_call', callId: 'c', tool: 'molbio_x', input: {} },
    { type: 'tool_result', callId: 'c', status: 'completed', result: 'truncated text', truncated: true },
    { type: 'final', text: 'an answer' },
  ]);
  const scored = scoreTrace(task, trace);
  assert.equal(scored.evidence.tool_evidence_truncated, true, 'a truncated tool result must be reported as such');
  const failure = scored.failures.find((entry) => entry.kind === 'args');
  assert.ok(failure, 'the assertion must still fail');
  assert.equal(failure.suspectTruncation, true, 'a tool assertion that failed under truncation must be flagged as suspect evidence, not as a model defect');
}

// ── (4) the golden fixture is not passing by accident ──────────────────────

{
  const task = byId.get(run.responses[0].id);
  const trace = foldEvents([{ type: 'final', text: run.responses[0].answer }]);
  // The same answer with the tool call REMOVED must fail on selection.
  if ((task.expect_tools ?? []).length > 0) {
    const scored = scoreTrace(task, trace);
    assert.equal(scored.tools_ok, false, 'a trace with no tool call must fail tool selection');
  }
  // And an assertion the response cannot satisfy must fail.
  const impossible = scoreTrace(
    { ...task, assertions: [...task.assertions, { where: 'answer', pattern: 'ZZZ-never-present-ZZZ' }] },
    trace,
  );
  assert.equal(impossible.answer_ok, false, 'the scorer must be able to fail a recorded response');
}

console.log(`benchmark-score checks passed: ${checked} recorded response(s) re-verified, tool attribution and truncation reporting covered`);
