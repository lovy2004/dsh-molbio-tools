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
node benchmark/run.mjs --replay      # re-grade the last run's responses with today's tasks (free)
node benchmark/run.mjs --model       # run the core tier against the real model
node benchmark/run.mjs --model --tier full   # every task
```

`--offline` **proves the suite is true**: every `where: "tool"` expectation is
checked against what the shipped tool actually returns for this task's inputs.
It needs no model, takes a few hundred milliseconds, and is part of `npm test`.

`--model` spawns `dsh --profile molbio-bench` once per task and grades the event
stream. It costs tokens, so it is opt-in.

**`--model` refuses to run while `--offline` fails.** A stale expected value
would otherwise be reported as a model failure — the most misleading outcome a
benchmark can produce.

### Tiers: what to run after a change

| tier | tasks | tools | when |
|---|---|---|---|
| `core` (default) | 14 | 14 | one representative per capability area |
| `full` | 49 | **57/57** | a shared-code change, or before a release |

The tiers exist because the whole-catalog run costs an order of magnitude more
than the core one, and the right default depends on what changed. The rule that
ties a change to a tier — **a feature change must add or update its task and
re-run; an unchanged feature needs no re-run** — is in
[docs/workflow.md](../docs/workflow.md) section 2, with the full change→tier
table.

Two guards make "someone forgot" fail loudly instead of quietly:

- `test/benchmark-coverage.mjs` asserts **57/57 registered tools are covered by
  at least one task**. Adding a tool without a task is a red build. It also
  asserts the fixtures' premises (the Golden Gate backbone is BsaI-free, the
  mutagenesis template still admits a primer pair) and that core is a broad
  sample rather than a smoke test.
- `test/benchmark-score.mjs` replays frozen real responses and proves the scorer
  can still fail.

### Layout

```
benchmark/
├── README.md          this file
├── tasks/             the suite: one JSON file per domain, concatenated in name order
├── verifications.mjs  the INPUTS that reproduce each task's `where: "tool"` expectations
├── sequences.mjs      the named DNA (`{seq:…}` placeholders) + the PRNG
├── fixtures.mjs       synthetic constructs, vectors and workspace files
├── tools.mjs          load the plugin and run one tool offline, in memory
├── score.mjs          the task loader, the trace fold, and the offline grader
├── run.mjs            the CLI: --offline / --replay / --model / --list
├── profile.mjs        derive the headless profile from the preset
├── _probe.mjs         record ground truth (original suite)
├── _probe-all.mjs     record ground truth (the rest of the catalog)
└── _freeze-trace.mjs  freeze a run's responses into the scorer's regression fixture
```

A task's expected text lives in `tasks/`; the input that produces it lives in
`verifications.mjs`. Keeping them in separate files is what makes `--offline` a
real check: if the two disagree, the assertion fails rather than quietly
asserting whatever the tool happened to emit.

### Reports

A run writes `benchmark/reports/<stamp>-<suite|task>.json` (the full result —
including each task's **rendered tool text**, so the run can be re-scored without
re-running it — and, with `--keep`, the raw event stream) and the same name with
`.md` (the summary). Reports are gitignored: a report measures one model on one
day, not a source artifact.

### `--replay`: fixing an assertion must not cost a model run

```bash
node benchmark/run.mjs --replay                      # newest suite report
node benchmark/run.mjs --replay <report.json> [--task <id>]
```

Every report carries what `scoreTrace` reads — the rendered tool text and the
final answer — so the recorded responses can be re-graded against the CURRENT
task definitions, offline and for free. That is how the assertions in this
directory were fixed after the first full-tier run lost 14 tasks to grading
mistakes: each fix was verified against the same run rather than a new one.

The distinction it makes visible: a run says *"the model did X"*; replay says
*"with today's assertions, X scores Y"*. When the two disagree, the assertion
changed, not the world.

Replay needs a report written by this version or later (older ones have no
recorded tool text, and it says so instead of silently scoring empty text).

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

1. Add the entry to `benchmark/tasks/<domain>.json` — it needs `tier`, `covers`,
   and at least one assertion, all of which `loadTasks()` enforces.
2. Add the input that produces the expected tool output to `invocationsFor()` in
   `benchmark/verifications.mjs`.
3. `node benchmark/run.mjs --offline` — it must pass **before** any model run.
   It checks the tool's **rendered** text, which is the only text a live trace
   ever carries. **A failure here is the assertion's fault, not the model's.**
4. `node test/benchmark-coverage.mjs` — it will tell you if a tool lost its
   coverage or a category lost its core representative.
5. If a new assertion fails a correct-looking answer, do not assume the model is
   wrong: read the response and decide whether you graded **phrasing** or
   **content**. Fix the assertion if it was phrasing, then re-freeze the fixture
   (`node benchmark/_freeze-trace.mjs <report.json>`) so the fix is guarded.

Ground truth is **measured, never recalled**: run `node benchmark/_probe.mjs`
(the original suite) or `node benchmark/_probe-all.mjs` (the rest of the
catalog) and copy what the tool actually rendered. An expected value typed from
memory grades the author, not the model.

### The one design rule worth quoting

**Pin what the request fixes, not what the implementation happens to return for
one set of arguments.** Four separate false failures in the first full-tier run
came from breaking it — a pinned codon-optimizer length that changes when the
model also honours the `avoid_enzymes` request, a pinned TaqMan candidate count
that depends on the model's windows, a pinned `source: msa` label where the model
legitimately pre-aligned, and a pinned primer role for a tool whose roles are
reversed. See "Findings" above.

### The scorer is under test too

`test/benchmark-score.mjs` re-verifies every frozen real response against its
task, and proves the scorer can still fail (tool attribution by `callId`,
truncation reporting, no-tool-call selection failure). Run it whenever you touch
`score.mjs` or an assertion: a broken scorer produces numbers that look like
measurements.

---

## Findings the benchmark has already produced

These are recorded rather than scored, because each one is a question about the
plugin or the harness, not about the model. The first is a **measured plugin
defect**.

### `molbio_design_primers` prints the forward/reverse roles reversed

**Confirmed by direct inspection, not by reading a model's claim.**

```
tool F: ATTACTCCTGCTCTTCCCATAC   201-222   <- equals top-strand 201-222
tool R: CACTACTCCTCTGTACGCAC     105-124   <- equals rc(top-strand 105-124)
amplicon: 105-222 (118 bp)
```

`F` binds at 201-222 and `R` binds at 105-124, so **F is downstream of R** — the
pair as printed cannot amplify, because the two primers extend away from each
other. `molbio_pcr_simulate` agrees: fed the pair as printed it reports
`1 forward site(s), 1 reverse site(s), 0 product(s)`.

The right pair does exist inside that output: the molecule it calls `R` (taken as
the reverse complement) is the real forward primer at 105-124, and the one it
calls `F` is the real reverse primer. Hand-built from the amplicon span — `F =
top(105-124)`, `R = rc(top(201-222))` — the same simulator reports `specific — 1
product(s) of 118 bp`.

So this is a **labelling/orientation defect in the returned pair**, not a scoring
or fixture problem. A model noticed the inconsistency and said so ("the designer
returned these two molecules with F/R reversed and both printed as the wrong
strand, and the pair as printed does not amplify"); it is confirmed here against
`pcr.mjs`.

**Status: recorded, not fixed.** The fix belongs in the primer designer's
orientation handling and needs its own regression test (a designed pair must
simulate to exactly one product when passed as printed). Until then
`qpcr-primers` deliberately does **not** assert which role a model assigns, only
the two molecules and the amplicon size — see the note in `tasks/01-core.json`.

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

### A Unicode minus made three correct answers look wrong

`/−3\.3/` cannot match `slope −3.30` written with U+2212, and the first full-tier
run lost `qpcr-efficiency`, `hydropathy` and part of `conservation` to exactly
that — all three answered correctly. `normalize()` now folds the Unicode minus
and the several dash characters models use onto ASCII `-`.

### The runner never created the files a task named

`fasta-tools` told the model to read `seqs.fa` and `reads.fq`, and the runner had
never put them in the working directory. The model correctly refused to guess
("I can't complete this as asked — the two input files aren't in the workspace")
and was scored as a failure for it. Every task now runs in its own scratch
workspace seeded with its declared `fixtures` plus the shared fixture texts, so
this class of "the benchmark's own setup was missing" failure is gone. (It also
stops every plot from landing in the repository root.)

### `molbio_extract_region`: the model could not find the parameter

Measured across full-tier runs: the model called `molbio_extract_region` and some
of those calls came back

```
Error: provide either `vector` (a sequence) or `vector_path` (a .dna/.gb file)
```

It usually recovered — reconstructing the region with `molbio_align` and
`molbio_gc_content` — and answered correctly. But the capability was reached by
hand more than once, and this is the only tool in the suite where a model failed
to find an input: the parameter is named `vector`, its description reads "a
sequence", and the task hands over a raw sequence. On other runs the same model
found it first try, so it is a coin flip, which is exactly what a confusing
parameter name produces.

Worth a documentation fix on the tool (accept `sequence` as an alias, or make the
description name the literal parameter). The task keeps its assertion so an
improvement shows up as a flip; see `tasks/04-cloning.json`.

### A model may legitimately choose parameters the task did not pin

Learned the hard way, and now designed around rather than scored:

- `codon-optimize` asks for the EcoRI-avoidance pass, and a model that passes
  `avoid_enzymes` changes both the length and the GC of the result. The task now
  pins the *shape* of the answer and the avoidance claim, not the numbers from
  one parameter choice.
- `taqman-assay`'s candidate count and probe Tm margin depend on the windows the
  model picks; only the top amplicon, the probe, and the *existence* of a
  reported margin are pinned.
- `conservation` reports `source: msa` or `source: alignment` depending on
  whether the model pre-aligned its input. Both are correct, so only the
  `3 sequences × 10 columns` fact is pinned.

The rule this produced: **pin what the request fixes, not what the
implementation happens to return for one set of arguments.**

---

## What this benchmark does NOT measure

- **One model, one day.** The number is a measurement, not a product guarantee;
  it is not a leaderboard and should not be quoted as one.
- **Run-to-run variance is real and is not averaged away.** Two measured
  examples. On the original 15-task suite, `gel-preview` came back as
  "3111 bp + 51 bp" in one run and "a single ~3.1 kb band, with the 51 bp
  fragment below detection" in another — both correct, different phrasing, and
  the assertion was widened rather than the model's rounding being scored. And on
  the full suite, re-grading the SAME recorded run after fixing the assertions
  moved it from 41/49 to 47/49; the two that still fail are a task where the
  model produced **no final answer at all** and one where it never found
  `extract_region`'s parameter. A single run is a sample; a claim about a change
  needs repeated runs, which this runner does not do.
- **The Web/preset path.** The run goes through a reconstructed headless profile,
  so a bug that exists only in preset mounting is `preset-health.mjs`'s job.
- **The browser panel.** Nothing here loads a client bundle.
- **Tool correctness.** That is `smoke.mjs`; a wrong answer here with `tools_ok`
  and `args_ok` both true is a *reporting* finding, not a tool bug.
- **Multimodal hand-off.** `attach_image` is exercised as an argument at most; no
  assertion inspects a decoded PNG (that is `svgpng.mjs` and `contract.mjs`).
- **Most of the toolset is now covered, but shallowly.** 49 tasks touch all 57
  tools; most tools appear in exactly one task, and several appearances are a
  single argument check rather than a full workflow. Breadth is asserted by
  `test/benchmark-coverage.mjs`; depth is not, and cannot be.
