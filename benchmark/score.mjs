/**
 * dsh-molbio-tools/benchmark/score.mjs
 *
 * Grade one run of one task, and grade the SUITE offline.
 *
 * ── Why the score is split into three verdicts ──────────────────────────────
 *
 * "The model got it wrong" is not actionable. This toolset can fail in three
 * independent ways, so each is reported separately:
 *
 *   tools_ok   the model never called the tool that answers the request
 *              (a tool-SELECTION failure — the description, the catalog, or the
 *              model's reading of it)
 *   args_ok    the tool ran and its own result did not carry the expected value
 *              (an ARGUMENT failure — the model passed the wrong sequence,
 *              window, enzyme list, …)
 *   answer_ok  the tool result was right but the final prose did not state it
 *              (a REPORTING failure — usually a truncated or sloppy summary)
 *
 * A run that fails `tools_ok` but passes `answer_ok` is a real and important
 * outcome: the model knew the biology well enough to answer without the tool.
 * That is why the verdicts are not collapsed.
 *
 * ── The offline half ────────────────────────────────────────────────────────
 *
 * `scoreSuiteOffline()` grades the SUITE itself, with no model involved: every
 * `where: "tool"` assertion is checked against what the shipped tool RENDERS for
 * this task's inputs (`benchmark/verifications.mjs` supplies those inputs). An
 * assertion that is stale, mis-scoped, or simply wrong therefore fails in a few
 * hundred milliseconds instead of after an expensive model run — and a suite
 * that cannot fail on the shipped tools cannot be trusted to grade a model.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadTools, seedFixtures, seedText } from './tools.mjs';
import { FIXTURES, expandInstruction } from './sequences.mjs';
import { NETWORK_TASKS, invocationsFor, setupFor, usePlasmid, useWorkspaceRoot } from './verifications.mjs';

/** The package root, from this module's own location. */
export const REPO_ROOT = resolve(import.meta.dirname, '..');

// ── the task suite ──────────────────────────────────────────────────────────

/**
 * Read and validate the task suite.
 *
 * Tasks live in `benchmark/tasks/*.json`, one file per domain, concatenated in
 * FILE NAME order. The split is about reviewability, not mechanism: a single
 * file covering all 57 tools ran past 60 KB and became unreviewable, and a
 * reviewer of a biology benchmark should be able to open the primer file and see
 * only primer tasks.
 *
 * Validation is strict and fails loudly. A task with no assertions would pass
 * silently and inflate a pass rate; a task with no `covers` would leave its tool
 * invisible to the coverage guard; a task with no `tier` would be ambiguous about
 * whether `npm run bench` runs it.
 *
 * @param {string} [dir] the tasks directory.
 * @returns {Promise<{tasks: object[], dir: string, files: string[]}>}
 */
export async function loadTasks(dir = join(REPO_ROOT, 'benchmark', 'tasks')) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`${dir}: no task files`);
  const tasks = [];
  const seen = new Set();
  for (const file of files) {
    const document = JSON.parse(await readFile(join(dir, file), 'utf8'));
    const entries = document.tasks;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${file}: no tasks`);
    for (const task of entries) {
      if (typeof task.id !== 'string' || task.id === '') throw new Error(`${file}: a task has no id`);
      if (seen.has(task.id)) throw new Error(`${file}: duplicate task id "${task.id}"`);
      seen.add(task.id);
      if (typeof task.instruction !== 'string' || task.instruction.trim() === '') {
        throw new Error(`${file}: task "${task.id}" has no instruction`);
      }
      if (!Array.isArray(task.assertions) || task.assertions.length === 0) {
        throw new Error(`${file}: task "${task.id}" has no assertions — it could not fail`);
      }
      if (task.tier !== 'core' && task.tier !== 'full') {
        throw new Error(`${file}: task "${task.id}" must declare tier "core" or "full"`);
      }
      if (!Array.isArray(task.covers)) {
        throw new Error(`${file}: task "${task.id}" must declare a \`covers\` array (empty when the task requires no tool)`);
      }
      if (task.covers.length === 0 && (task.expect_tools ?? []).length > 0) {
        throw new Error(`${file}: task "${task.id}" requires tools but covers none`);
      }
      for (const tool of task.covers) {
        if (typeof tool !== 'string' || !tool.startsWith('molbio_')) {
          throw new Error(`${file}: task "${task.id}" lists an unrecognised \`covers\` entry "${String(tool)}"`);
        }
      }
      for (const assertion of task.assertions) {
        if (assertion.where !== 'answer' && assertion.where !== 'tool') {
          throw new Error(`${file}: task "${task.id}" has an assertion with where="${String(assertion.where)}"`);
        }
        if (typeof assertion.pattern !== 'string' || assertion.pattern === '') {
          throw new Error(`${file}: task "${task.id}" has an assertion with no pattern`);
        }
        try {
          new RegExp(assertion.pattern, 'i');
        } catch (error) {
          throw new Error(`${file}: task "${task.id}" has an invalid regex ${JSON.stringify(assertion.pattern)}: ${String(error)}`);
        }
      }
      for (const key of ['expect_tools', 'forbid_tools', 'expect_absent']) {
        if (task[key] !== undefined && !Array.isArray(task[key])) {
          throw new Error(`${file}: task "${task.id}" has a non-array ${key}`);
        }
      }
    }
    tasks.push(...entries);
  }
  return { tasks, dir, files };
}

/**
 * The tasks a tier runs.
 *
 * `core` is a small always-run subset with one representative per capability
 * area; `full` is every task. The tiers exist because the cost differs by an
 * order of magnitude and the right default depends on what changed — see
 * docs/workflow.md for the rule that ties a change to a tier.
 */
export function tasksForTier(tasks, tier) {
  return tier === 'full' ? tasks : tasks.filter((task) => task.tier === 'core');
}

// ── trace handling ──────────────────────────────────────────────────────────

/**
 * Fold a `--json` event stream into the shape the scorer reads.
 *
 * ── Two properties of the stream this function has to respect ───────────────
 *
 * The stream is a PROJECTION, not the session log, and two of its documented
 * limits have already produced wrong scores:
 *
 *  1. **Call association is by `callId`, not by order.** `tool_result` carries
 *     `callId`; `tool_call` carries the tool name. A result whose call was not
 *     observed in this window (or whose text was pruned) used to be attributed
 *     to whichever call came last — which silently mislabelled results.
 *  2. **Every string is capped at 8 KiB**, with a `truncated` flag. A model that
 *     runs extra calls (the methylation task spent twenty calls on web research)
 *     can push an earlier tool result out of the captured text entirely, so an
 *     assertion on that text fails even though the model read it correctly and
 *     answered correctly. `resultBytes` and `resultsTruncated` are reported so a
 *     reader can tell "the model got it wrong" from "the trace no longer holds
 *     the evidence".
 *
 * @param {object[]} events parsed NDJSON events.
 * @returns {{final: string, calls: {tool: string, input: unknown}[], results: {tool: string, status: string, result: string}[], errors: string[], usage: object, truncated: boolean, resultBytes: number, resultsTruncated: boolean}}
 */
export function foldEvents(events) {
  const calls = [];
  const results = [];
  const toolByCallId = new Map();
  const errors = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  let final = '';
  let truncated = false;
  let resultsTruncated = false;
  let resultBytes = 0;

  for (const event of events) {
    switch (event?.type) {
      case 'tool_call':
        calls.push({ tool: event.tool, input: event.input });
        if (typeof event.callId === 'string') toolByCallId.set(event.callId, event.tool);
        break;
      case 'tool_result': {
        const text = typeof event.result === 'string' ? event.result : '';
        resultBytes += Buffer.byteLength(text, 'utf8');
        if (event.truncated === true) {
          truncated = true;
          resultsTruncated = true;
        }
        results.push({ tool: toolByCallId.get(event.callId) ?? '(unattributed)', status: event.status, result: text });
        break;
      }
      case 'final':
        final = typeof event.text === 'string' ? event.text : '';
        if (event.truncated === true) truncated = true;
        break;
      case 'status':
        if (event.phase === 'step_end' && event.usage !== undefined) {
          for (const key of Object.keys(usage)) usage[key] += Number(event.usage[key] ?? 0);
        }
        break;
      case 'error':
        errors.push(String(event.message ?? event.code ?? 'error'));
        break;
      default:
        if (event?.truncated === true) truncated = true;
        break;
    }
  }
  return { final, calls, results, errors, usage, truncated, resultBytes, resultsTruncated };
}

/**
 * Whitespace-collapsed text, the form every regex is matched against.
 *
 * ASCII `-` is ALSO substituted for the Unicode minus sign (U+2212) and the
 * several dash characters models reach for when writing a negative number.
 *
 * This is not cosmetic. A final answer saying "slope −3.30" is exactly as
 * correct as "slope -3.3", but `/-3\.3/` cannot match U+2212 — and the first
 * full-tier run lost THREE tasks to that alone (`qpcr-efficiency`, `hydropathy`,
 * and `conservation`'s column identity), each of which the model had answered
 * correctly. Normalizing here rather than in every pattern means a negative
 * number can be written in a task assertion the obvious way.
 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\u2212\u2010-\u2015\uFE63\uFF0D]/g, '-');
}

/**
 * Grade a trace against a task.
 *
 * @param {object} task a suite entry.
 * @param {object} trace the result of {@link foldEvents}.
 * @returns {{id: string, category: string, tier: string, tools_ok: boolean, args_ok: boolean, answer_ok: boolean, passed: boolean, failures: object[], toolCalls: string[], evidence: object}}
 */
export function scoreTrace(task, trace) {
  const called = trace.calls.map((call) => call.tool);
  const toolText = normalize(trace.results.map((result) => result.result).join('\n'));
  const answerText = normalize(trace.final);

  const expected = task.expect_tools ?? [];
  const missing = expected.filter((tool) => !called.includes(tool));
  const forbidden = (task.forbid_tools ?? []).filter((tool) => called.includes(tool));

  const failures = [];
  if (missing.length > 0) failures.push({ kind: 'tool', detail: `never called: ${missing.join(', ')}` });
  if (forbidden.length > 0) failures.push({ kind: 'tool', detail: `called but should not be: ${forbidden.join(', ')}` });

  // A restraint task names tools that must NOT appear.
  const unwelcome = (task.expect_absent ?? []).filter((tool) => called.includes(tool));
  if (unwelcome.length > 0) failures.push({ kind: 'tool', detail: `called a tool this request does not need: ${unwelcome.join(', ')}` });

  if (trace.errors.length > 0) failures.push({ kind: 'tool', detail: `run errors: ${trace.errors.join('; ')}` });
  if (trace.final.trim() === '') failures.push({ kind: 'answer', detail: 'the run produced no final answer' });

  let argsOk = true;
  let answerOk = true;
  for (const assertion of task.assertions) {
    const haystack = assertion.where === 'tool' ? toolText : answerText;
    if (new RegExp(assertion.pattern, 'i').test(haystack)) continue;
    const failure = {
      kind: assertion.where === 'tool' ? 'args' : 'answer',
      detail: `${assertion.where} did not match /${assertion.pattern}/${assertion.note === undefined ? '' : ` (${assertion.note})`}`,
      // A `tool` assertion that fails while the trace was truncated is NOT
      // evidence about the model: the text it read may simply have been pruned
      // out of the projection. Flagging it here is what stops the next reader
      // from recording a truncation artifact as a model defect.
      suspectTruncation: assertion.where === 'tool' && trace.resultsTruncated === true,
    };
    failures.push(failure);
    if (failure.kind === 'args') argsOk = false;
    else answerOk = false;
  }

  const toolsOk = failures.every((failure) => failure.kind !== 'tool');
  return {
    id: task.id,
    category: task.category ?? 'uncategorised',
    tier: task.tier ?? 'full',
    tools_ok: toolsOk,
    args_ok: argsOk,
    answer_ok: answerOk,
    passed: toolsOk && argsOk && answerOk,
    failures,
    toolCalls: called,
    evidence: {
      tool_result_bytes: trace.resultBytes ?? 0,
      truncated: trace.truncated === true,
      tool_evidence_truncated: trace.resultsTruncated === true,
      tool_results: trace.results.length,
    },
  };
}

// ── offline grading of the SUITE ────────────────────────────────────────────

/**
 * Run every task's `where: "tool"` assertions against the shipped tools.
 *
 * The haystack is the tool's **rendered** text — the same projection the model
 * reads and the same one the live scorer sees in `tool_result.result` — not the
 * raw output value. That distinction is not cosmetic: the first version of this
 * grader stringified the raw JSON, so an assertion like `"gc_percent": 50`
 * passed offline while the live run, which only ever sees the rendered
 * `GC content: 50%`, could never match it. The offline half was therefore
 * validating a format that does not exist at runtime, and it hid the difference
 * behind a green check.
 *
 * The invocation for each task comes from `benchmark/verifications.mjs`, so a
 * task's expected text and the input that produces it live in one place.
 *
 * @param {{only?: string, workspace?: string}} [options]
 * @returns {Promise<{ok: boolean, checked: number, tasks: object[], network: string[]}>}
 */
export async function scoreSuiteOffline(options = {}) {
  const { tasks, dir } = await loadTasks();
  const workspaceRoot = options.workspace ?? resolve(REPO_ROOT, 'benchmark', '.offline-workspace');
  const harness = loadTools({ workspaceRoot });
  await seedFixtures(harness.memFs, { 'pUC118.dna': join(REPO_ROOT, 'test', 'fixtures', 'pUC118.dna') });
  // The path-taking tools resolve against the session workspace, and the tasks
  // that read a whole `.dna` file rely on the same fixture the file-based tools
  // use — so the two paths cannot drift apart.
  const plasmid = await harness.run('molbio_parse_snapgene', { path: join(workspaceRoot, 'pUC118.dna') });
  useWorkspaceRoot(workspaceRoot);
  usePlasmid(plasmid);
  // Every fixture file the file-reading tools need, seeded once.
  seedText(harness.memFs, 'seqs.fa', FIXTURES.FASTA_TEXT);
  seedText(harness.memFs, 'reads.fq', FIXTURES.FASTQ_TEXT);
  seedText(harness.memFs, 'read.seq', FIXTURES.SANGER_TEXT);

  const report = [];
  const network = [];
  for (const task of tasks) {
    if (options.only !== undefined && options.only !== task.id) continue;
    for (const [relative, text] of Object.entries(setupFor(task))) seedText(harness.memFs, relative, text);

    const toolAssertions = task.assertions.filter((assertion) => assertion.where === 'tool');
    if (toolAssertions.length === 0) {
      report.push({ id: task.id, checked: 0, failures: [], note: 'answer-only task: nothing to verify offline' });
      continue;
    }
    if (NETWORK_TASKS.has(task.id)) {
      // Live-API tools have no recorded value to pin. A task in this set must
      // therefore assert ONLY on the answer, or the offline gate would claim to
      // have verified something it never ran.
      report.push({
        id: task.id,
        checked: 0,
        failures: [
          {
            detail: `task ${task.id} is listed in NETWORK_TASKS but still carries ${toolAssertions.length} \`where: "tool"\` assertion(s) — a live-API result cannot be pinned`,
          },
        ],
      });
      network.push(task.id);
      continue;
    }
    const invocations = invocationsFor(task);
    if (invocations === undefined) {
      report.push({
        id: task.id,
        checked: 0,
        failures: [
          {
            detail: `task ${task.id} asserts on a tool result but benchmark/verifications.mjs declares no invocation for it — add one, or list the task in NETWORK_TASKS`,
          },
        ],
      });
      continue;
    }
    const observed = [];
    const failures = [];
    for (const invocation of invocations) {
      try {
        const value = await harness.run(invocation.tool, invocation.args);
        observed.push(normalize(harness.render(invocation.tool, invocation.args, value)));
      } catch (error) {
        failures.push({ detail: `${invocation.tool} threw: ${String(error)}` });
      }
    }
    const haystack = normalize(observed.join('\n'));
    for (const assertion of toolAssertions) {
      if (!new RegExp(assertion.pattern, 'i').test(haystack)) {
        failures.push({
          detail: `/${assertion.pattern}/ ${assertion.note === undefined ? '' : `(${assertion.note}) `}does not match the RENDERED tool result: ${haystack.slice(0, 300)}`,
        });
      }
    }
    report.push({ id: task.id, checked: toolAssertions.length, failures });
  }

  const failed = report.filter((entry) => entry.failures.length > 0);
  return { ok: failed.length === 0, checked: report.length, tasks: report, dir, network };
}

/** Expand a task's placeholders into the instruction the model receives. */
export function renderInstruction(task) {
  return expandInstruction(task.instruction);
}
