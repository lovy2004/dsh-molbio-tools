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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { findHarnessRoot, harnessVersion, launcherCommand } from './harness.mjs';
import { PROFILE_NAME } from './profile.mjs';
import { foldEvents, loadTasks, renderInstruction, scoreSuiteOffline, scoreTrace } from './score.mjs';

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

/** Parse the small flag set this CLI accepts, refusing anything else. */
function parseArgs(argv) {
  const options = { mode: undefined, task: undefined, keep: false, skipPreflight: false, timeoutMs: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--offline') options.mode = 'offline';
    else if (value === '--model') options.mode = 'model';
    else if (value === '--list') options.mode = 'list';
    else if (value === '--keep') options.keep = true;
    else if (value === '--skip-preflight') options.skipPreflight = true;
    else if (value === '--task') options.task = argv[++index];
    else if (value === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (value === '--help' || value === '-h') options.mode = 'help';
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
    for (const task of tasks) {
      console.log(`${task.id}  [${task.category}]  ${task.expect_tools?.join(',') ?? 'no tools expected'}`);
      console.log(`    ${renderInstruction(task).split('\n')[0].slice(0, 110)}`);
    }
    console.log(`\n${tasks.length} task(s)`);
    return;
  }

  if (options.mode === 'offline') {
    const result = await scoreSuiteOffline({ only: options.task });
    for (const entry of result.tasks) {
      const status = entry.failures.length === 0 ? 'ok  ' : 'FAIL';
      console.log(`${status} ${entry.id} (${entry.checked} tool assertion(s))`);
      for (const failure of entry.failures) console.log(`       ${failure.detail}`);
    }
    console.log(result.ok ? `\noffline suite OK: ${result.checked} task(s) verified against the shipped tools` : '\noffline suite FAILED');
    process.exit(result.ok ? 0 : 1);
  }

  // ── model mode ────────────────────────────────────────────────────────────
  const harnessRoot = findHarnessRoot(undefined);
  if (harnessRoot === undefined) {
    console.error('benchmark: could not locate an installed DSH harness');
    process.exit(2);
  }

  // The suite's expected values must be true before a model run can mean
  // anything: otherwise a failure would be attributed to the model.
  const offline = await scoreSuiteOffline({ only: options.task });
  if (!offline.ok) {
    console.error('benchmark: the suite does not match the shipped tools — run `node benchmark/run.mjs --offline` and fix the expectations first');
    for (const entry of offline.tasks) for (const failure of entry.failures) console.error(`  ${entry.id}: ${failure.detail}`);
    process.exit(2);
  }

  const selected = options.task === undefined ? tasks : tasks.filter((task) => task.id === options.task);
  if (selected.length === 0) {
    console.error(`benchmark: no task with id "${String(options.task)}"`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const launcher = await launcherCommand(harnessRoot);

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
    process.stderr.write(`[${index + 1}/${selected.length}] ${task.id} … `);
    const run = await runTask({
      instruction,
      launcher,
      cwd: resolve(import.meta.dirname, '..'),
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

if (import.meta.main) await main();
