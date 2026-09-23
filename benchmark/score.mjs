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
 * ── The offline half ───────────────────────────────────────────────────────
 *
 * `scoreSuiteOffline()` grades the SUITE itself, with no model involved:
 * every `where: "tool"` assertion is checked against the value the shipped tool
 * returns for this task's inputs. An assertion that is stale, mis-scoped, or
 * simply wrong therefore fails in a few hundred milliseconds instead of after
 * an expensive model run — and a suite that cannot fail on the shipped tools
 * cannot be trusted to grade a model.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadTools, seedFixtures } from './tools.mjs';
import { expandInstruction, NAMED_SEQUENCES } from './sequences.mjs';

/** The package root, from this module's own location. */
export const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Read and validate the task suite.
 *
 * Validation is strict and fails loudly: a task with no assertions would
 * otherwise pass silently and inflate a pass rate.
 *
 * @param {string} [path] tasks.json location.
 * @returns {Promise<{tasks: object[], path: string}>}
 */
export async function loadTasks(path = join(REPO_ROOT, 'benchmark', 'tasks.json')) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  const tasks = document.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`${path}: no tasks`);
  const seen = new Set();
  for (const task of tasks) {
    if (typeof task.id !== 'string' || task.id === '') throw new Error(`${path}: a task has no id`);
    if (seen.has(task.id)) throw new Error(`${path}: duplicate task id "${task.id}"`);
    seen.add(task.id);
    if (typeof task.instruction !== 'string' || task.instruction.trim() === '') {
      throw new Error(`${path}: task "${task.id}" has no instruction`);
    }
    if (!Array.isArray(task.assertions) || task.assertions.length === 0) {
      throw new Error(`${path}: task "${task.id}" has no assertions — it could not fail`);
    }
    for (const assertion of task.assertions) {
      if (assertion.where !== 'answer' && assertion.where !== 'tool') {
        throw new Error(`${path}: task "${task.id}" has an assertion with where="${String(assertion.where)}"`);
      }
      if (typeof assertion.pattern !== 'string' || assertion.pattern === '') {
        throw new Error(`${path}: task "${task.id}" has an assertion with no pattern`);
      }
      try {
        new RegExp(assertion.pattern, 'i');
      } catch (error) {
        throw new Error(`${path}: task "${task.id}" has an invalid regex ${JSON.stringify(assertion.pattern)}: ${String(error)}`);
      }
    }
    for (const key of ['expect_tools', 'forbid_tools', 'expect_absent']) {
      if (task[key] !== undefined && !Array.isArray(task[key])) {
        throw new Error(`${path}: task "${task.id}" has a non-array ${key}`);
      }
    }
  }
  return { tasks, path };
}

/**
 * Wrap a single `where: "tool"` assertion into the tool call that satisfies it.
 *
 * The suite writes assertions as regexes against the observed text, which keeps
 * authoring cheap, but the requirement is usually about ONE tool's result. A
 * small table keeps the assertion text and the required call in agreement
 * instead of relying on the author to remember both.
 */
export const ASSERTION_TOOL = {
  orientation: 'molbio_reverse_complement',
  'qpcr-primers': 'molbio_design_primers',
  'plasmid-single-cutter': 'molbio_unique_cutters',
  'double-digest-buffer': 'molbio_double_digest',
  'methylation-block': 'molbio_methylation_check',
  'qpcr-ddct': 'molbio_qpcr_analysis',
  'align-mismatch': 'molbio_align',
  'gc-cpg-islands': 'molbio_gc_composition',
  'fastq-qc': 'molbio_fastq_qc',
  'translate-orf': 'molbio_translate',
  'enzyme-catalog': 'molbio_enzyme_lookup',
};

/**
 * The arguments the offline grader runs to satisfy a task's `tool` assertions.
 *
 * This is the bridge that makes the offline half possible: the task carries the
 * EXPECTED text, and this table carries the INPUT that must produce it. Both
 * are needed, and keeping the input here (rather than inferring it) is what
 * turns "the expected value is stale" into a failing check with a legible diff.
 *
 * The argument names differ per tool and were read off the tool schemas, not
 * guessed: `molbio_unique_cutters` takes `vector` (a sequence) or
 * `vector_path`, while the digest tools accept a literal `sequence`.
 *
 * @param {object} task a suite entry.
 * @param {{sequence?: string}} [fixture] the parsed pUC118 sequence, when the task uses it.
 * @returns {Array<{tool: string, args: object}>}
 */
export function offlineInvocations(task, fixture = {}) {
  const plasmid = () => {
    if (fixture.sequence === undefined) {
      throw new Error(`benchmark: task ${task.id} needs the pUC118 fixture, which was not loaded`);
    }
    return fixture.sequence;
  };
  const templates = {
    orientation: () => [{ tool: 'molbio_reverse_complement', args: { sequence: 'ATGCGTACGTTAGCCTAGGCAT' } }],
    'qpcr-primers': () => [
      { tool: 'molbio_design_primers', args: { template: NAMED_SEQUENCES.qpcr_template, amplicon_min: 80, amplicon_max: 150, tm_min: 58, tm_max: 62, max_results: 1 } },
    ],
    'plasmid-single-cutter': () => [{ tool: 'molbio_unique_cutters', args: { vector: plasmid() } }],
    'double-digest-buffer': () => [{ tool: 'molbio_double_digest', args: { sequence: plasmid(), first: 'EcoRI', second: 'HindIII', circular: true } }],
    'methylation-block': () => [{ tool: 'molbio_methylation_check', args: { sequence: plasmid(), enzymes: ['BamHI', 'KpnI'], circular: true } }],
    'qpcr-ddct': () => [
      {
        tool: 'molbio_qpcr_analysis',
        args: {
          target_treated: [22.1, 22.3, 22.0],
          target_control: [25.0, 25.2, 24.9],
          reference_treated: [18.0, 18.1, 18.0],
          reference_control: [18.2, 18.1, 18.3],
        },
      },
    ],
    'align-mismatch': () => [
      // `sequence1` is the READ on purpose: the resolver is free to pick either
      // argument order (the tool reports identity symmetrically), and the task's
      // tool assertion accepts both. Running the reference first here would mean
      // `--offline` only ever exercises one of the two orders the scorer allows.
      { tool: 'molbio_align', args: { sequence1: NAMED_SEQUENCES.align_read, sequence2: NAMED_SEQUENCES.align_reference } },
    ],
    'gc-cpg-islands': () => [
      { tool: 'molbio_gc_composition', args: { sequence: NAMED_SEQUENCES.puc118_cpg_region, criteria: 'gardiner', min_length: 200, gc_threshold: 50, cpg_oe_threshold: 0.6 } },
    ],
    'fastq-qc': () => [{ tool: 'molbio_fastq_qc', args: { fastq: FASTQ_FIXTURE } }],
    'translate-orf': () => [
      { tool: 'molbio_translate', args: { sequence: 'GGGATGGCTGCTGCTGCTGCTGCTGCTGCTGCTTAACCC', frames: '1', min_orf_aa: 5 } },
    ],
    'enzyme-catalog': () => [{ tool: 'molbio_enzyme_lookup', args: { enzymes: ['BsaI', 'EcoRI'] } }],
  };
  const build = templates[task.id];
  return build === undefined ? [] : build();
}

/** The FASTQ the `fastq-qc` task pastes into its instruction. */
export const FASTQ_FIXTURE = [
  '@r1',
  'ACGTACGTACGTACGTACGT',
  '+',
  'IIIIIIIIIIIIIIIIIIII',
  '@r2',
  'TTTTTTTTTTTTTTTTTTTT',
  '+',
  '!!!!!!!!!!!!!!!!!!!!',
  '@r3',
  'GGGGCCCCAAAATTTTGGGG',
  '+',
  'IIIIIHHHHH#####IIIII',
].join('\n');

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

/** Whitespace-collapsed text, the form every regex is matched against. */
export function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ');
}

/**
 * Grade a trace against a task.
 *
 * @param {object} task a suite entry.
 * @param {object} trace the result of {@link foldEvents}.
 * @returns {{id: string, category: string, tools_ok: boolean, args_ok: boolean, answer_ok: boolean, passed: boolean, failures: object[], toolCalls: string[], evidence: object}}
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
 * grader stringified the raw JSON, so an assertion like
 * `"gc_percent": 50` passed offline while the live run, which only ever sees the
 * rendered `GC content: 50%`, could never match it. The offline half was
 * therefore validating a format that does not exist at runtime, and it hid the
 * difference behind a green check.
 *
 * @param {{only?: string, workspace?: string}} [options]
 * @returns {Promise<{ok: boolean, checked: number, tasks: object[]}>}
 */
export async function scoreSuiteOffline(options = {}) {
  const { tasks, path } = await loadTasks();
  const workspaceRoot = options.workspace ?? resolve(REPO_ROOT, 'benchmark', '.offline-workspace');
  const harness = loadTools({ workspaceRoot });
  await seedFixtures(harness.memFs, { 'pUC118.dna': join(REPO_ROOT, 'test', 'fixtures', 'pUC118.dna') });
  // Parsed once: the digest tasks take a literal sequence, and reading it from
  // the same fixture the file-based tools use keeps the two paths identical.
  const fixture = await harness.run('molbio_parse_snapgene', { path: join(workspaceRoot, 'pUC118.dna') });

  const report = [];
  for (const task of tasks) {
    if (options.only !== undefined && options.only !== task.id) continue;
    const toolAssertions = task.assertions.filter((assertion) => assertion.where === 'tool');
    if (toolAssertions.length === 0) {
      report.push({ id: task.id, checked: 0, failures: [], note: 'answer-only task: nothing to verify offline' });
      continue;
    }
    const invocations = offlineInvocations(task, fixture);
    if (invocations.length === 0) {
      report.push({
        id: task.id,
        checked: 0,
        failures: [{ detail: `task ${task.id} asserts on a tool result but has no offline invocation — add one to offlineInvocations()` }],
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
  return { ok: failed.length === 0, checked: report.length, tasks: report, path };
}

/** Expand a task's placeholders into the instruction the model receives. */
export function renderInstruction(task) {
  return expandInstruction(task.instruction);
}
