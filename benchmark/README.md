# benchmark — does the toolset actually get used?

Every other suite in this repository is **offline and deterministic**. `smoke.mjs`
proves each tool computes the right value, `svgpng.mjs` proves the picture is
right, `contract.mjs` proves the plugin honours DSH's contracts. None of them can
answer the question this directory exists for:

> A model is given a biology request in plain language. Does it reach for the
> right tool, fill the arguments correctly, and report the answer?

That question needs a real model and a real session, so it is measured here
rather than asserted in `test/`.

---

## Why this exists (the gap it fills)

The plugin's value is not "the tools are correct" — `smoke.mjs` already covers
that — it is **whether a model can find and drive them**. A tool with a perfect
implementation and a description nobody can act on is worthless in practice, and
no offline suite can see that. The failure modes are distinct and worth naming:

| failure | what it looks like | what it means |
|---|---|---|
| tool selection | the model never calls the tool that answers the request | the catalog or its descriptions are not actionable |
| arguments | the tool runs, but its own result does not carry the expected value | the model mis-read the parameters |
| reporting | the tool result is right, the final prose is not | a summary/truncation problem, not a tool problem |

The scorer keeps those three verdicts **separate** (`tools_ok` / `args_ok` /
`answer_ok`) because "it failed" is not actionable and each one points somewhere
different.

---

## Two modes, and why both are required

```bash
node benchmark/run.mjs --offline     # verify every expected value against the shipped tools
node benchmark/run.mjs --model       # run the suite against the real model
```

`--offline` **proves the suite is true**: every `where: "tool"` expectation is
checked against what the shipped tool actually returns for this task's inputs.
It needs no model, takes a few hundred milliseconds, and is part of `npm test`.

`--model` spawns `dsh --profile molbio-bench --json` once per task and grades the
event stream. It costs tokens, so it is opt-in.

**`--model` refuses to run while `--offline` fails.** A stale expected value
would otherwise be reported as a model failure — the most misleading outcome a
benchmark can produce.

### Reports

A run writes `benchmark/reports/<stamp>-<suite|task>.json` (the full result,
including per-task usage and — with `--keep` — the raw event stream, so a run can
be re-graded without re-running it) and the same name with `.md` (the summary).
Reports are gitignored: a report measures one model on one day, not a source
artifact.

---

## The headless profile (`benchmark/profile.mjs`)

The model-facing way to get the 57 tools is the **Molecular Biology Lab** agent
preset. The benchmark cannot use it, and the reason is structural rather than
configurational — `dsh-headless/lib/index.js` refuses an adoption whose session
records a preset:

```
session "…" runs under agent preset "molbio-lab", which the one-shot runner does not compose
```

Presets are an agent-plane feature the Web surface composes; the one-shot runner
drives `agents.create()` directly and never joins one. So the tools must be
mounted as **host rows**, which is the one shape this package otherwise refuses
to ship (`cordis.patch.yml` is deliberately an empty list).

`benchmark/profile.mjs` therefore generates a dedicated profile
(`$DSH_HOME/profiles/molbio-bench`) whose patch layer is **derived** from
`preset/molbio-lab/agent.cordis.yml`:

```bash
node benchmark/profile.mjs           # write/refresh the profile
node benchmark/profile.mjs --check   # fail if it is stale
node benchmark/profile.mjs --reset   # rebuild from scratch
```

Nothing about the reconstruction is trusted:

- `test/benchmark-profile.mjs` compares every mounted row against the preset
  field for field, and fails on any preset row that is neither mounted nor named
  in `SKIPPED_ROWS` with a reason. Adding a tool row upstream without touching
  this benchmark turns that test red.
- Every exemption in `SKIPPED_ROWS` must still exist in the preset, so a stale
  exemption cannot rot the guard into a rubber stamp.
- `benchmark/run.mjs --offline` proves the expectations still match the tools.

### Two measured facts worth knowing

1. **`dsh plugin add` cannot install this profile.** A `pnpm install` inside a
   profile fails because the shipped `@deepseek-ai/dsh-web-app` manifest names
   packages that were never published (`@deepseek-ai/dsh-client-ui-question`,
   `@deepseek-ai/dsh-storage`, …), producing `ERR_PNPM_FETCH_404`. The generator
   writes the profile manifest and links this checkout by directory junction
   instead, which needs no registry at all.
2. **`MOLBIO_AUTO_VIEW=0` is set for every run.** Without it each plotting tool
   hands its SVG to the desktop viewer, and a benchmark that opens a dozen
   windows is not one anybody runs twice. Computation, file writing, and tool
   selection are unaffected.

---

## Anatomy of a task

Tasks live in `tasks.json`. A task is a **natural-language request** — never a
tool name — plus the assertions that grade it:

```jsonc
{
  "id": "double-digest-buffer",
  "category": "restriction",
  "instruction": "I want to cut pUC118.dna … Do these two enzymes share a reaction buffer, and what fragment sizes should I see on the gel?",
  "timeout_ms": 240000,
  "expect_tools": ["molbio_double_digest"],   // tool SELECTION
  "assertions": [
    { "where": "tool",   "pattern": "\"combined_fragments\":[^\\]]*3111", "note": "…" },  // ARGUMENTS
    { "where": "answer", "pattern": "3111" }                                              // REPORTING
  ]
}
```

- `expect_tools` — tools that must be called (selection).
- `forbid_tools` — tools that must not be called for this request (e.g. the
  primer designer must not answer a TaqMan request).
- `expect_absent` — the restraint check: an underspecified or non-bioinformatics
  request must not be met with a tool call at all.
- `fixtures` — files seeded into the run's working directory.
- `where: "tool"` assertions read the **rendered tool result** — the exact text
  the model itself read, which is what the live run's `tool_result.result`
  carries; `where: "answer"` assertions read the **final prose**.

  Both halves of that sentence were paid for. The first draft asserted on the
  tool's raw output JSON (`"gc_percent": 50`), which passed `--offline` — because
  the offline grader was stringifying the value — while the LIVE run could never
  match it, because the only thing a trace carries is the rendered
  `GC content: 50%`. The offline half was validating a format that does not exist
  at runtime. `--offline` now checks the **rendered** projection, so a
  format mismatch fails in milliseconds instead of silently capping every score.

`{seq:name}` and `{template:400:7}` placeholders are expanded by
`benchmark/sequences.mjs` before the instruction is sent. Deriving the alignment
read from its reference is the point: the "exactly one mismatch at position 81"
claim is then a property of code, so the instruction and the expectation cannot
disagree.

### Delivery preflight

`--model` spends one cheap call before the suite to prove the task text reaches
the model. That check exists because of a measured failure: the first full run
spawned the launcher with `shell: true` on Windows, which **concatenates** argv
instead of escaping it, so every multi-line instruction arrived as its **first
word**. All fifteen tasks failed for a reason unrelated to the toolset, and the
only visible symptom was models saying "the sequences aren't in the
conversation". The runner now invokes the launcher's JS entry with an argv array
and sends the instruction on **stdin** (which `dsh-headless` accepts), and the
preflight fails the run loudly if a probe token does not come back verbatim.

### Adding a task

1. Add the entry to `tasks.json`.
2. Add the input that produces the expected tool output to
   `offlineInvocations()` in `benchmark/score.mjs` (and to `ASSERTION_TOOL` if
   the task uses a tool assertion).
3. `node benchmark/run.mjs --offline` — it must pass **before** any model run.
   It checks the tool's **rendered** text, which is the only text a live trace
   ever carries.
4. If the task needs a plugin-private fact the Web preset happens to supply,
   extend `SKIPPED_ROWS` in `benchmark/profile.mjs` with the reason.
5. If a new assertion fails a correct-looking answer, do not assume the model is
   wrong: read the response, decide whether you graded **phrasing** or
   **content**, fix the assertion if it was phrasing, and add the response to
   `test/fixtures/benchmark-traces.json` (via
   `node benchmark/_freeze-trace.mjs <report.json>`) so the fix is guarded.

Ground truth is **measured, never recalled**: run `node benchmark/_probe.mjs` and
copy what the tool actually returned. An expected value typed from memory grades
the author, not the model.

### The scorer is under test too

`test/benchmark-score.mjs` re-verifies every frozen real response against its
task, and proves the scorer can still fail (tool attribution by `callId`,
truncation reporting, no-tool-call selection failure). Run it whenever you touch
`score.mjs` or an assertion: a broken scorer produces numbers that look like
measurements.

---

## Findings the benchmark has already produced

These are recorded rather than scored, because each one is a question about the
plugin or the harness, not about the model.

### The methylation reference table disagrees with NEB on BamHI

`molbio_methylation_check` has `in_table: true` with `status: "impaired"`,
`impaired_by: ["dam"]` for BamHI, because BamHI's `GGATCC` contains the Dam
target `GATC`. A model asked about a failing BamHI digest ran the tool, then
checked NEB over the web and reported the opposite: NEB lists BamHI as
**insensitive** to dam, dcm and CpG methylation.

The task deliberately does not assert agreement either way (see the note in
`tasks.json`). What this exposes is a plugin-data question worth verifying
against REBASE before the next release: does the hand-transcribed table
over-report Dam sensitivity for BamHI (and, by extension, for the other enzymes
whose sites merely *contain* `GATC`)? The tool's own output already warns that
methylation sensitivity "is a hand-transcribed quick reference".

### Tool-result truncation can hide evidence from a grader

The headless JSON projection caps every string at 8 KiB. In the methylation task
the model made ~20 calls, and the `molbio_methylation_check` result fell out of
the captured window — so a `where: "tool"` assertion on its text failed while the
model had, in fact, read it correctly. `foldEvents` now reports
`resultBytes`/`resultsTruncated`, `scoreTrace` marks such a failure
`suspectTruncation`, and the report carries it as `evidence`. A tool assertion
that fails on a truncated trace is **not** evidence about the model.

---

## What this benchmark does NOT measure

- **One model, one day.** The number is a measurement, not a product guarantee;
  it is not a leaderboard and should not be quoted as one.
- **Run-to-run variance is real and is not averaged away.** One measured example:
  the `gel-preview` answer came back as `3111 bp + 51 bp` in one run and as
  "a single ~3.1 kb band, with the 51 bp fragment below detection" in another —
  both correct, different phrasing. The assertion was widened to accept both
  rather than the model's rounding being scored. A single run is a sample; a
  claim about a change needs repeated runs, which this runner does not do.
- **The Web/preset path.** The run goes through a reconstructed headless profile,
  so a bug that exists only in preset mounting is `preset-health.mjs`'s job.
- **The browser panel.** Nothing here loads a client bundle.
- **Tool correctness.** That is `smoke.mjs`; a wrong answer here with `tools_ok`
  and `args_ok` both true is a *reporting* finding, not a tool bug.
- **Multimodal hand-off.** `attach_image` is exercised as an argument at most; no
  assertion inspects a decoded PNG (that is `svgpng.mjs` and `contract.mjs`).
- **Most of the toolset.** 15 tasks cover 12 of the 57 tools. The remaining 45
  (Sanger verification, TaqMan, multiplex, Golden Gate, CRISPR, MSA, phylogeny,
  the literature/protocol library, …) have no task yet; their correctness is
  covered by `smoke.mjs`, but their *usability* is not measured.
