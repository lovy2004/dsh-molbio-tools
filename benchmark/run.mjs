/**
 * dsh-molbio-tools/benchmark/run.mjs
 *
 * The benchmark's command line: grade the suite offline, or run it against a
 * real model through `dsh --profile molbio-bench --json`.
 *
 *   node benchmark/run.mjs --offline            verify every expected value against the shipped tools
 *   node benchmark/run.mjs --model              run the suite through the headless profile
 *   node benchmark/run.mjs --task qpcr-primers  one task only
 *   node benchmark/run.mjs --list               print the suite and what each task tests
 *
 * The two modes answer different questions and BOTH are needed:
 *
 *  - `--offline` proves the SUITE is true (the values in `tasks.json` are what
 *    the tools actually return). It costs nothing and is the gate to run on
 *    every change.
 *  - `--model` measures the MODEL's use of the toolset. It costs tokens, so it
 *    is opt-in — and running it against a suite that has not passed `--offline`
 *    would attribute a stale expected value to the model.
 *
 * Reports are written as JSON (the full trace, for re-grading) and Markdown
 * (the summary, for a human and for the changelog).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { findHarnessRoot, harnessVersion, launcherCommand } from './harness.mjs';
import { PROFILE_NAME } from './profile.mjs';
import { changedFiles, resolveChanged } from './changed.mjs';
import { foldEvents, loadTasks, renderInstruction, scoreSuiteOffline, scoreTrace, tasksForTier } from './score.mjs';
import { makeWorkspace } from './tools.mjs';
import { FIXTURES } from './sequences.mjs';

/**
 * The workspace files a task's tools read but no `fixtures` entry declares.
 *
 * These are the files whose NAMES appear in an instruction, so the model is told
 * to open them — which means they have to exist in the run's working directory.
 * `verifications.mjs` seeds the same texts for the offline grader (through
 * `setupFor`), so the two paths see identical inputs.
 */
const FILE_FIXTURES = {
  'fasta-tools': { 'seqs.fa': FIXTURES.FASTA_TEXT, 'reads.fq': FIXTURES.FASTQ_TEXT },
  'sanger-verify': { 'read.seq': FIXTURES.SANGER_TEXT },
};

/** Where reports land. Gitignored: a report is a measurement, not a source. */
export const REPORT_DIR = resolve(import.meta.dirname, 'reports');

/** Longer than any task's own budget, so the runner's timeout is a backstop. */
const DEFAULT_TIMEOUT_MS = 420000;
const HARD_TIMEOUT_MS = 900000;

/**
 * Run one task through the headless profile.
 *
 * Three things about the spawn are load-bearing, and each was learned from a
 * run that produced meaningless data:
 *
 *  1. **No shell.** The `dsh` shim is a `.cmd` on Windows, and Node refuses to
 *     spawn a `.cmd` unless `shell: true` — but `shell: true` concatenates argv
 *     instead of escaping it, so a multi-line instruction arrived as its first
 *     WORD. Every task then failed for a reason that had nothing to do with the
 *     toolset. The launcher is therefore invoked as `node <bin.js>` with an
 *     argv ARRAY.
 *  2. **The instruction goes on stdin, not argv.** `dsh-headless` reads its task
 *     from stdin when no positional argument is given, which removes the
 *     argument from the command line entirely — no length limit, no quoting, and
 *     no dependence on how the platform joins arguments.
 *  3. **`--json` is parsed per line**, because the projection is NDJSON.
 *
 * `MOLBIO_AUTO_VIEW=0` is deliberate: the image tools would otherwise hand every
 * generated SVG to the desktop viewer, and a benchmark that opens a dozen
 * windows is not one anybody runs twice. The units under test (computation,
 * file writing, tool selection) are unaffected.
 *
 * @param {object} options
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, events: object[], timedOut: boolean, ms: number}>}
 */
export async function runTask(options) {
  const timeout = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS);
  const { entry, node } = options.launcher;
  const args = [entry, '--profile', options.profile ?? PROFILE_NAME, '--json'];
  const started = Date.now();
  const child = spawn(node, args, {
    cwd: options.cwd,
    windowsHide: true,
    env: { ...process.env, MOLBIO_AUTO_VIEW: '0' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // The launcher runs the app in-process, so a plain kill ends the tree on
    // every platform we run on; `taskkill` is the belt for the braces case.
    child.kill('SIGKILL');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    }
  }, timeout);

  // The task text is the whole of stdin. `dsh-headless` sends a piped task
  // verbatim (its trailing newline included) and rejects an empty pipe, so the
  // instruction is written as-is.
  child.stdin.on('error', () => {
    /* the child may exit before draining stdin; the exit code is the signal */
  });
  child.stdin.end(options.instruction);

  const code = await new Promise((settle) => {
    child.on('error', () => settle(null));
    child.on('close', (value) => settle(value));
  });
  clearTimeout(timer);

  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A non-JSON line on stdout is a launcher diagnostic that leaked; keep it
      // in stderr's neighbourhood for the report rather than dropping it.
      stderr += `${line}\n`;
    }
  }
  return { code, stdout, stderr, events, timedOut, ms: Date.now() - started };
}

// ── preflight ───────────────────────────────────────────────────────────────

/**
 * Prove the instruction actually reaches the model BEFORE spending a suite.
 *
 * This exists because of a measured failure, not a hypothetical one: the first
 * full run spawned the launcher with `shell: true` on Windows, which
 * concatenates argv instead of escaping it, so a multi-line instruction arrived
 * as its first word. Every task then failed for a reason that had nothing to do
 * with the toolset — and the give-away was only visible by reading the final
 * answers ("the sequences aren't in the conversation"). Fifteen model calls were
 * spent learning something a one-call check answers in ten seconds.
 *
 * The probe sends a two-line instruction whose second line carries a token that
 * cannot be guessed, and requires that token back verbatim.
 *
 * @param {{launcher: object, cwd: string, profile: string}} options
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function verifyInstructionDelivery(options) {
  const token = `DELIVERY-PROBE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const instruction = [
    'Reply with exactly the token that appears on the second line of this message, and nothing else.',
    '',
    `The token is ${token}.`,
  ].join('\n');
  const run = await runTask({ ...options, instruction, timeoutMs: 120000 });
  const trace = foldEvents(run.events);
  if (trace.final.includes(token)) return { ok: true, detail: `the model echoed ${token}` };
  const saw = trace.final.trim() === '' ? '(empty answer)' : trace.final.replace(/\s+/g, ' ').slice(0, 200);
  return {
    ok: false,
    detail:
      `the model never saw the instruction (expected ${token} back, got ${saw}). ` +
      'The runner is not delivering multi-line task text — fix that before reading any score.',
  };
}

/**
 * Re-grade recorded responses with the CURRENT task definitions.
 *
 * This is the tool that keeps this directory honest, and it exists because the
 * alternative is intolerable: fixing an assertion and finding out whether the fix
 * was right used to cost a full model run (~8M tokens, ~30 minutes). A report
 * carries every task's rendered tool text and final answer, which is exactly
 * what `scoreTrace` reads, so the whole suite can be re-scored offline.
 *
 * The distinction it makes visible: a run says "the model did X", replay says
 * "with today's assertions, X scores Y". When the two disagree, the assertion
 * changed, not the world.
 *
 * @param {{report: object, taskList: {tasks: object[]}, keep?: Set<string>}} options
 * @returns {{results: object[], before: object}}
 */
export function replayReport(options) {
  const { tasks } = options.taskList;
  const results = [];
  for (const recorded of options.report.results) {
    if (options.keep !== undefined && !options.keep.has(recorded.id)) continue;
    const task = tasks.find((entry) => entry.id === recorded.id);
    if (task === undefined) {
      results.push({ id: recorded.id, category: '(removed)', tier: '-', tools_ok: true, args_ok: true, answer_ok: true, passed: false, failures: [{ kind: 'tool', detail: 'this task no longer exists in the suite' }], toolCalls: recorded.toolCalls ?? [], evidence: {} });
      continue;
    }
    const trace = {
      final: recorded.answer ?? '',
      calls: (recorded.toolCalls ?? []).map((tool) => ({ tool, input: {} })),
      results: recorded.toolResults ?? [],
      errors: [],
      usage: recorded.usage ?? {},
      truncated: recorded.truncated === true,
      resultBytes: (recorded.toolResults ?? []).reduce((total, entry) => total + Buffer.byteLength(entry.result ?? '', 'utf8'), 0),
      resultsTruncated: recorded.evidence?.tool_evidence_truncated === true,
    };
    results.push(scoreTrace(task, trace));
  }
  return {
    results,
    before: { total: options.report.summary.total, passed: options.report.summary.passed },
  };
}

/** The most recent suite report, for a `--replay` with no explicit path. */
async function newestReport() {
  if (!existsSync(REPORT_DIR)) return undefined;
  const names = (await readdir(REPORT_DIR)).filter((name) => name.endsWith('-suite.json')).sort();
  return names.length === 0 ? undefined : join(REPORT_DIR, names[names.length - 1]);
}

// ── reporting ───────────────────────────────────────────────────────────────

/** A stable, legible timestamp for a report file name. */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * The Markdown summary a human reads.
 *
 * @param {object} report the JSON report.
 * @returns {string}
 */
export function renderMarkdown(report) {
  const lines = [];
  const { summary } = report;
  lines.push(`# molbio benchmark — ${report.startedAt}`);
  lines.push('');
  lines.push(`- harness: dsh ${report.harnessVersion} (${report.harnessRoot})`);
  lines.push(`- profile: \`${report.profile}\``);
  lines.push(`- tasks: ${summary.total} (${summary.passed} passed, ${summary.failed} failed)`);
  lines.push(`- tool selection: ${summary.toolsOk}/${summary.total} · tool arguments: ${summary.argsOk}/${summary.total} · final answer: ${summary.answerOk}/${summary.total}`);
  lines.push(`- tokens: ${summary.tokens.totalTokens.toLocaleString('en-US')} in ${summary.steps} step(s); wall clock ${(summary.ms / 1000).toFixed(0)} s`);
  lines.push('');
  lines.push('Pass rate here is a MEASUREMENT of one model on one day, not a product guarantee:');
  lines.push('the `tools_ok` / `args_ok` / `answer_ok` split is the part that localises a failure.');
  lines.push('');
  lines.push('| task | category | tools | args | answer | pass | tools called | ms |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of report.results) {
    const mark = (value) => (value ? '✅' : '❌');
    const calls = result.toolCalls.length === 0 ? '—' : result.toolCalls.map((name) => `\`${name.replace('molbio_', '')}\``).join(', ');
    lines.push(
      `| ${result.id} | ${result.category} | ${mark(result.tools_ok)} | ${mark(result.args_ok)} | ${mark(result.answer_ok)} | ${mark(result.passed)} | ${calls} | ${result.ms} |`,
    );
  }
  lines.push('');
  const failures = report.results.filter((result) => result.failures.length > 0);
  if (failures.length === 0) {
    lines.push('Every task passed.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('## Failures');
  lines.push('');
  for (const result of failures) {
    lines.push(`### ${result.id}`);
    lines.push('');
    for (const failure of result.failures) lines.push(`- **${failure.kind}** — ${failure.detail}`);
    lines.push('');
    if (result.answer.trim() !== '') {
      const answer = result.answer.length > 1200 ? `${result.answer.slice(0, 1200)}…` : result.answer;
      lines.push('<details><summary>final answer</summary>');
      lines.push('');
      lines.push('```');
      lines.push(answer.replace(/\s+/g, ' ').trim());
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Resolve a `--tools` / `--task` / `--changed` selection into the tasks to run.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The suite's whole point is that a tool's benchmark runs when THAT TOOL
 * changes, so the default unit of work should be "the tools I touched", not
 * "the whole catalog". Without a selector, the only way to test one tool was to
 * work out which task covers it and name that task — so in practice people (and
 * the author of this file) ran the full suite every time, which is the wrong
 * cost for a one-tool change.
 *
 * A name that matches nothing is a HARD ERROR rather than an empty run: the
 * likely causes are a typo or a tool that no task covers, and both should be
 * loud. (The second is also caught by `test/benchmark-coverage.mjs`.)
 *
 * `--changed` is the third form: derive the tools from the working tree via
 * `benchmark/changed.mjs`, whose design leans toward running MORE than
 * necessary. It composes with `--tools` by INTERSECTION — "of the tools I
 * changed, test these" — which can only ever run less, never mask a change.
 *
 * @param {{tasks: object[], tools?: string, task?: string, changed?: boolean, tier: string,
 *          files?: string[]|undefined}} options
 * @returns {{selected: object[], skipped: object[], tools: string[], mode: string, reason?: string}}
 */
export function selectTasks(options) {
  const { tasks } = options;

  if (options.task !== undefined && (options.tools !== undefined || options.changed === true)) {
    throw new Error('benchmark: --task cannot be combined with --tools or --changed');
  }

  if (options.task !== undefined) {
    const selected = tasks.filter((task) => task.id === options.task);
    if (selected.length === 0) {
      const near = tasks
        .map((task) => task.id)
        .filter((id) => id.includes(options.task) || options.task.includes(id));
      throw new Error(
        `benchmark: no task with id "${options.task}"${near.length > 0 ? ` — did you mean ${near.map((id) => `"${id}"`).join(' or ')}?` : ''}`,
      );
    }
    return { selected, skipped: tasks.filter((task) => !selected.includes(task)), tools: [], mode: 'task' };
  }

  if (options.changed === true) {
    const decision = resolveChanged({ tasks, files: options.files ?? changedFiles() });
    if (decision.mode === 'none') return { selected: [], skipped: tasks, tools: [], mode: 'none', reason: decision.reason };
    if (decision.mode === 'full') {
      // `--changed` alone falls back to the whole suite when it cannot narrow.
      // But `--changed --tools X` still narrows: the user has named the tools
      // they care about, and answering "everything" would ignore them.
      if (options.tools === undefined) {
        return { selected: tasks, skipped: [], tools: [], mode: 'full', reason: decision.reason };
      }
      const named = resolveToolNames(options.tools, tasks);
      const narrowed = tasks.filter((task) => task.covers.some((tool) => named.includes(tool)));
      return {
        selected: narrowed,
        skipped: tasks.filter((task) => !narrowed.includes(task)),
        tools: named,
        mode: 'tools',
        reason: `--changed could not narrow (${decision.reason}); --tools chose the tasks instead`,
      };
    }

    const affected = decision.tools;
    let selected = decision.tasks;
    let tools = affected;
    // `--tools` alongside `--changed` INTERSECTS, and `--tools` alone UNIONS.
    // The two operators are printed, because getting them confused is the
    // difference between testing what you changed and testing less than that.
    let operator = 'from --changed';
    if (options.tools !== undefined) {
      const wanted = resolveToolNames(options.tools, tasks);
      const keep = wanted.filter((tool) => affected.includes(tool));
      if (keep.length === 0) {
        throw new Error(
          `benchmark: --tools ${wanted.join(', ')} is disjoint from the tools the changed files affect\n` +
            `  affected: ${affected.join(', ')}\n` +
            '  Drop --tools to run all of them, or fix the tool names.',
        );
      }
      selected = selected.filter((task) => task.covers.some((tool) => keep.includes(tool)));
      tools = keep;
      operator = `intersected with --tools (affected ${affected.length})`;
    }
    return {
      selected,
      skipped: tasks.filter((task) => !selected.includes(task)),
      tools,
      mode: 'partial',
      operator,
      reason: `${decision.modules.length} module(s) affected: ${decision.modules.join(', ')}`,
    };
  }

  if (options.tools === undefined) {
    const selected = tasksForTier(tasks, options.tier);
    return { selected, skipped: tasks.filter((task) => !selected.includes(task)), tools: [], mode: 'tier' };
  }

  const tools = resolveToolNames(options.tools, tasks);
  const selected = tasks.filter((task) => task.covers.some((tool) => tools.includes(tool)));
  return { selected, skipped: tasks.filter((task) => !selected.includes(task)), tools, mode: 'tools' };
}

/**
 * Turn a `--tools` value into canonical tool names.
 *
 * Accepts `molbio_primer_tm`, `primer_tm`, comma/space separated lists, and `*`
 * globs — because the useful input is "the tools I just edited", copied from the
 * file or the changelog, and making the caller normalize that is friction with no
 * payoff.
 *
 * @param {string} value the raw flag value.
 * @param {object[]} tasks the suite, for the set of covered tools.
 * @returns {string[]} canonical tool names.
 */
function resolveToolNames(value, tasks) {
  const covered = new Set(tasks.flatMap((task) => task.covers));
  const wanted = value
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (wanted.length === 0) throw new Error('benchmark: --tools needs at least one name');

  const resolveOne = (pattern) => {
    const bare = pattern.startsWith('molbio_') ? pattern : `molbio_${pattern}`;
    if (!pattern.includes('*')) return covered.has(bare) ? [bare] : [];
    const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return [...covered].filter((tool) => expression.test(tool) || expression.test(tool.replace('molbio_', '')));
  };

  const tools = [];
  const unmatched = [];
  for (const pattern of wanted) {
    const found = resolveOne(pattern);
    if (found.length === 0) unmatched.push(pattern);
    else tools.push(...found);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `benchmark: no task covers ${unmatched.map((name) => `"${name}"`).join(', ')}\n` +
        '  Either the name is a typo, or the tool has no task (which\n' +
        '  `node test/benchmark-coverage.mjs` reports as a gap).\n' +
        '  `node benchmark/run.mjs --list --tier full` prints every task and the tools it covers.',
    );
  }
  return [...new Set(tools)].sort();
}
/**
 * One line describing how a selection was narrowed, for a run header.
 *
 * `--changed` prints its REASON (which modules were affected, or why it fell
 * back to everything) because the whole point of the flag is that its decisions
 * are auditable. A bare "49 tasks selected" would leave the reader unable to
 * tell a precise answer from a conservative one.
 */
function describeSelection(options, selection, tasks) {
  const parts = [];
  if (selection.tools.length > 0) {
    parts.push(`--tools ${selection.tools.length <= 6 ? selection.tools.join(', ') : `${selection.tools.length} tool(s)`}`);
  }
  if (options && options.task !== undefined) parts.push(`--task ${options.task}`);
  if (options && options.changed === true) parts.push('--changed');
  if (parts.length === 0) parts.push(`tier ${options ? options.tier : 'core'}`);
  const head = ` — ${parts.join(' ')}`;
  const notes = [];
  if (selection.operator !== undefined) notes.push(selection.operator);
  if (selection.reason !== undefined && selection.reason !== '') notes.push(selection.reason);
  return notes.length === 0 ? head : `${head} (${notes.join('; ')})`;
}

/** Parse the small flag set this CLI accepts, refusing anything else. */
function parseArgs(argv) {
  const options = {
    mode: undefined,
    task: undefined,
    tools: undefined,
    changed: false,
    tier: 'core',
    keep: false,
    skipPreflight: false,
    timeoutMs: undefined,
  };
  // Flags whose value is optional and only present when the next token is not
  // itself a flag. `--replay` is the reason: `--replay --task x` must read the
  // report path as absent rather than swallowing `--task`.
  const takeOptionalValue = (index) => {
    const next = argv[index + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--offline') options.mode = 'offline';
    else if (value === '--model') options.mode = 'model';
    else if (value === '--list') options.mode = 'list';
    else if (value === '--keep') options.keep = true;
    else if (value === '--skip-preflight') options.skipPreflight = true;
    else if (value === '--replay') {
      options.mode = 'replay';
      const path = takeOptionalValue(index);
      if (path !== undefined) {
        options.reportPath = path;
        index += 1;
      }
    } else if (value === '--task') options.task = argv[++index];
    else if (value === '--tools') options.tools = argv[++index];
    else if (value === '--changed') options.changed = true;
    else if (value === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (value === '--all' || value === '--tier') {
      // `--all` is the shorthand people reach for; `--tier full` is the explicit
      // form. Both mean "every task".
      if (value === '--all') options.tier = 'full';
      else {
        const tier = argv[++index];
        if (tier !== 'core' && tier !== 'full') throw new Error(`benchmark: --tier takes "core" or "full" (got "${String(tier)}")`);
        options.tier = tier;
      }
    } else if (value === '--help' || value === '-h') options.mode = 'help';
    else throw new Error(`benchmark: unknown option "${value}"`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { tasks } = await loadTasks();

  if (options.mode === 'help' || options.mode === undefined) {
    console.log(await readFile(join(import.meta.dirname, 'README.md'), 'utf8').catch(() => 'see benchmark/README.md'));
    if (options.mode === undefined) process.exit(2);
    return;
  }

  if (options.mode === 'list') {
    const selection = selectTasks({ tasks, tools: options.tools, task: options.task, changed: options.changed, tier: options.tier });
    for (const task of selection.selected) {
      console.log(`${task.id}  [${task.category}/${task.tier}]  covers: ${task.covers.join(', ')}`);
      console.log(`    ${renderInstruction(task).split('\n')[0].slice(0, 110)}`);
    }
    if (selection.mode === 'none') {
      console.log(`\nnothing to run — ${selection.reason}`);
      return;
    }
    const core = tasks.filter((task) => task.tier === 'core').length;
    console.log(`\n${selection.selected.length} of ${tasks.length} task(s) selected${describeSelection(options, selection, tasks)}`);
    console.log(`tiers: ${core} core, ${tasks.length - core} full-only · tools covered by the suite: ${new Set(tasks.flatMap((task) => task.covers)).size}`);
    return;
  }

  if (options.mode === 'offline') {
    const result = await scoreSuiteOffline({ only: options.task });
    for (const entry of result.tasks) {
      const status = entry.failures.length === 0 ? 'ok  ' : 'FAIL';
      console.log(`${status} ${entry.id} (${entry.checked} tool assertion(s))${entry.note === undefined ? '' : ` — ${entry.note}`}`);
      for (const failure of entry.failures) console.log(`       ${failure.detail}`);
    }
    if (result.network.length > 0) {
      console.log(`\nonline-only (no offline invocation, answer assertions only): ${result.network.join(', ')}`);
    }
    console.log(
      result.ok
        ? `\noffline suite OK: ${result.checked} task(s) checked against the shipped tools`
        : '\noffline suite FAILED',
    );
    process.exit(result.ok ? 0 : 1);
  }

  if (options.mode === 'replay') {
    const reportPath = options.reportPath ?? (await newestReport());
    if (reportPath === undefined) {
      console.error('benchmark: no report to replay — run `node benchmark/run.mjs --model` first, or pass --replay <report.json>');
      process.exit(2);
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (!Array.isArray(report.results?.[0]?.toolResults)) {
      console.error(
        `benchmark: ${reportPath} predates the recorded tool text, so assertions cannot be re-checked against it.\n` +
          'Reports written from this version on carry `toolResults`; re-run the tasks you care about once.',
      );
      process.exit(2);
    }
    // Same selector as a model run, so "replay what I just changed" is the same
    // command shape as "run what I just changed".
    const selection = selectTasks({ tasks, tools: options.tools, task: options.task, changed: options.changed, tier: options.tier });
    const replay = replayReport({
      report,
      taskList: { tasks },
      keep: selection.selected.length === tasks.length ? undefined : new Set(selection.selected.map((task) => task.id)),
    });
    console.log(`replaying ${reportPath}${describeSelection(options, selection, tasks)}`);
    console.log(`  recorded: ${replay.before.passed}/${replay.before.total} passed (whole run)`);
    let changed = 0;
    for (const result of replay.results) {
      const was = report.results.find((entry) => entry.id === result.id);
      const flipped = was !== undefined && was.passed !== result.passed;
      if (flipped) changed += 1;
      const status = result.failures.length === 0 ? 'PASS' : 'FAIL';
      const mark = flipped ? (result.passed ? '  <- now passes' : '  <- NOW FAILS') : '';
      console.log(`  ${status} ${result.id}${mark}`);
      for (const failure of result.failures) console.log(`        ${failure.detail}`);
    }
    const passed = replay.results.filter((result) => result.passed).length;
    console.log(`\n  now     : ${passed}/${replay.results.length} passed (${changed} changed)`);
    console.log('  Nothing here ran a model: this re-scores recorded responses with the current tasks.');
    process.exit(passed === replay.results.length ? 0 : 1);
  }

  // ── model mode ────────────────────────────────────────────────────────────
  const harnessRoot = findHarnessRoot(undefined);
  if (harnessRoot === undefined) {
    console.error('benchmark: could not locate an installed DSH harness');
    process.exit(2);
  }

  // The suite's expected values must be true before a model run can mean
  // anything: otherwise a failure would be attributed to the model.
  //
  // This checks the WHOLE suite even when one tool was selected, and on purpose:
  // it costs nothing, and a selection should never be the reason a stale
  // expectation goes unnoticed.
  const offline = await scoreSuiteOffline({});
  if (!offline.ok) {
    console.error('benchmark: the suite does not match the shipped tools — run `node benchmark/run.mjs --offline` and fix the expectations first');
    for (const entry of offline.tasks) for (const failure of entry.failures) console.error(`  ${entry.id}: ${failure.detail}`);
    process.exit(2);
  }

  const selection = selectTasks({ tasks, tools: options.tools, task: options.task, changed: options.changed, tier: options.tier });
  const selected = selection.selected;
  if (selection.mode === 'none') {
    // Not a failure: it is the answer. Printing it costs nothing and is the
    // whole reason `--changed` is usable as a default.
    console.error(`nothing to run — ${selection.reason}`);
    process.exit(0);
  }
  if (selected.length === 0) {
    console.error('benchmark: the selection matched no tasks');
    process.exit(2);
  }
  const core = tasks.filter((task) => task.tier === 'core').length;
  console.error(
    `selected ${selected.length} of ${tasks.length} task(s)${describeSelection(options, selection, tasks)}` +
      ` (skipping ${selection.skipped.length}; tiers: ${core} core, ${tasks.length - core} full-only)`,
  );

  const startedAt = new Date().toISOString();
  const launcher = await launcherCommand(harnessRoot);

  // Every task runs in its own scratch workspace so its file-writing tools drop
  // their SVGs and FASTAs there instead of into the package root.
  //
  // The first full-tier run did NOT do this, and the consequences were subtle in
  // two directions at once: `fasta-tools` named `seqs.fa` and `reads.fq` in its
  // instruction, found neither in the workspace, and correctly refused to guess
  // ("I can't complete this as asked — the two input files aren't in the
  // workspace") — scored as a model failure when the runner had simply never
  // created them. Meanwhile every plot landed in the repository root.
  const workspace = await makeWorkspace({ prefix: 'molbio-bench-' });

  // A suite run is only readable if the task text arrives intact; a one-call
  // probe is far cheaper than discovering it from fifteen confusing failures.
  if (!options.skipPreflight) {
    process.stderr.write('preflight: instruction delivery … ');
    const probe = await verifyInstructionDelivery({
      launcher,
      cwd: resolve(import.meta.dirname, '..'),
      profile: PROFILE_NAME,
    });
    process.stderr.write(`${probe.ok ? 'OK' : 'FAILED'}\n`);
    if (!probe.ok) {
      console.error(`benchmark: preflight FAILED — ${probe.detail}`);
      process.exit(2);
    }
  }

  const results = [];
  for (const [index, task] of selected.entries()) {
    const instruction = renderInstruction(task);
    const cwd = join(workspace.path, task.id);
    await mkdir(cwd, { recursive: true });
    // The task's own declared fixtures, then the shared fixture texts whose
    // names its instruction mentions (`seqs.fa`, `reads.fq`, `read.seq`).
    for (const [relative, source] of Object.entries(task.fixtures ?? {})) {
      await copyFile(resolve(import.meta.dirname, '..', source), join(cwd, relative));
    }
    for (const [relative, text] of Object.entries(FILE_FIXTURES[task.id] ?? {})) {
      await writeFile(join(cwd, relative), text, 'utf8');
    }
    process.stderr.write(`[${index + 1}/${selected.length}] ${task.id} … `);
    const run = await runTask({
      instruction,
      launcher,
      cwd,
      timeoutMs: options.timeoutMs ?? task.timeout_ms,
      profile: PROFILE_NAME,
    });
    const trace = foldEvents(run.events);
    const scored = scoreTrace(task, trace);
    results.push({
      ...scored,
      ms: run.ms,
      exitCode: run.code,
      timedOut: run.timedOut,
      truncated: trace.truncated,
      usage: trace.usage,
      answer: trace.final,
      // The RENDERED tool text, kept so an assertion can be fixed and
      // re-verified against the same run instead of spending another one.
      // `--keep` additionally stores the raw event stream.
      toolResults: trace.results.map((result) => ({ tool: result.tool, status: result.status, result: result.result })),
      stderr: run.stderr.trim(),
      events: options.keep ? run.events : undefined,
    });
    process.stderr.write(`${scored.passed ? 'PASS' : 'FAIL'} (${(run.ms / 1000).toFixed(0)} s)\n`);
  }

  const tokens = results.reduce(
    (total, result) => {
      for (const key of Object.keys(total)) total[key] += result.usage[key];
      return total;
    },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  );

  const report = {
    startedAt,
    harnessRoot,
    harnessVersion: await harnessVersion(harnessRoot),
    profile: PROFILE_NAME,
    model: 'the profile default (deepseek-flash unless the profile or session overrides it)',
    results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      toolsOk: results.filter((result) => result.tools_ok).length,
      argsOk: results.filter((result) => result.args_ok).length,
      answerOk: results.filter((result) => result.answer_ok).length,
      ms: results.reduce((total, result) => total + result.ms, 0),
      steps: results.reduce((total, result) => total + result.toolCalls.length, 0),
      tokens,
    },
  };

  await mkdir(REPORT_DIR, { recursive: true });
  const base = join(REPORT_DIR, `${stamp()}-${options.task ?? 'suite'}`);
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(`${base}.md`, renderMarkdown(report), 'utf8');

  console.log(renderMarkdown(report));
  console.log(`report: ${base}.json`);
  console.log(`report: ${base}.md`);
  process.exit(report.summary.failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  // A usage mistake (a typo in `--tools`, a task id that does not exist, two
  // mutually exclusive flags) is the operator's problem to read, not a stack
  // trace to decode: print the message and exit 2.
  try {
    await main();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  }
}
