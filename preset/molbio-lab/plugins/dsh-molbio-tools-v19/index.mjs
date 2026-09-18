/**
 * dsh-molbio-tools/index.mjs
 *
 * DeepSeek Harness Cordis plugin: molecular-biology computation tools for the
 * model. Zero runtime dependencies — the only import is the sibling lib.mjs —
 * so the package is a pair of files that travel with an agent preset and can
 * be referenced by a relative plugin row (see README.md).
 *
 * Every tool is pure computation: deterministic, no network, no filesystem.
 * The plugin publishes no service, so the preset row needs no isolate realm.
 */

import {
  MolbioInputError,
  DNA_BASES,
  GENETIC_CODES,
  ENZYME_NAMES,
  analyzeQpcr,
  baseCounts,
  complement,
  digest,
  dimerPotential,
  dimerThermo,
  enzymeCatalog,
  endGcCount5,
  endStability5,
  findHairpins,
  findRepeats,
  findRuns,
  hairpinThermo,
  labMath,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfAnyScore,
  selfComplementarity,
  selfEndScore,
  translateFrames,
} from './lib.mjs';
import { designIntronPrimers, designPrimers } from './design.mjs';
import { parseGenBank } from './genbank.mjs';
import { renderPlasmidMap } from './plasmid.mjs';
import { parseSnapGeneBytes } from './snapgene.mjs';
import {
  designClonePrimers,
  designMutagenesisPrimers,
  simulateClone,
  simulateGoldenGate,
  uniqueCutters,
} from './cloning.mjs';
import { readTraceFromBytes, verifySanger } from './sanger.mjs';
import { CODON_HOSTS, codonOptimize, peptideDigest, proteinProperties } from './protein.mjs';
import { linearFit, renderBarChart, renderGel, renderScatterChart } from './plot.mjs';
import { entryStats, parseFasta, parseFastq, toFasta } from './seqio.mjs';
import { addExperiment, addProtocol, loadRecords, recordPath, saveRecords, updateProtocol } from './records.mjs';
import { toBibtex } from './papers.mjs';
import { parseXml } from './snapgene.mjs';
import { smithWaterman } from './align.mjs';
import { conservationAnalysis, normalizeAlignedRow, normalizeMsaSequence, pairwiseIdentities, progressiveAlign } from './msa.mjs';
import { columnComposition, renderSequenceLogo } from './logo.mjs';
import { CRISPR_LIMITS, DEFAULT_PAM, designGrnas } from './crispr.mjs';
import { PROBE_DEFAULTS, designTaqmanProbes, resolveProbeOptions } from './taqman.mjs';
import { MULTIPLEX_DEFAULTS, checkMultiplex } from './multiplex.mjs';
import {
  HYDROPATHY_DEFAULTS,
  hydropathyProfile,
  helicalWheel,
  renderHelicalWheel,
  renderHydropathyPlot,
} from './protein-structure.mjs';
import {
  analyzeMethylation,
  planDoubleDigest,
  resolveEnzymeSelection,
} from './methylation.mjs';
import {
  addPapers,
  libraryPath,
  loadLibrary,
  pmidFromUrl,
  removePaper,
  saveLibrary,
  updatePaper,
  workspaceFilePath,
  writeWorkspaceFile,
} from './papers.mjs';
import { openDefaultViewer } from './view.mjs';
import { renderSvgToPng } from './svgpng.mjs';
import { fastqQcReport, renderFastqQcReport } from './fastq-qc.mjs';
import { CODON_FREQUENCIES, codonUsageAnalysis } from './codon.mjs';
import {
  DISTANCE_MODELS,
  LAYOUTS,
  TREE_METHODS,
  applySupport,
  bootstrapSupport,
  consensusTree,
  distanceMatrix,
  neighbourJoiningTree,
  renderTreeSvg,
  toNewick,
  upgmaTree,
} from './phylo.mjs';
import { PCR_DEFAULTS, pcrGel, simulatePcr } from './pcr.mjs';
import { COMPOSITION_DEFAULTS, gcComposition, renderCompositionSvg } from './composition.mjs';

export const name = 'dsh-molbio-tools';
export const inject = ['tools', 'systemPrompt'];

/**
 * Generic argument validation against a raw JSON-Schema parameter object.
 * This plugin registers RAW tool definitions (it is zero-dependency and cannot
 * import defineTool), so it mirrors defineTool's execute-time argument
 * validation itself: required presence, per-property types, enums, and nested
 * object/array shapes.
 */
function validateArgsAgainstSchema(schema, args, label = '') {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new MolbioInputError('tool arguments must be an object');
  }
  if (schema.type !== 'object') return;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const violations = [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) violations.push(`missing required argument "${key}"`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) violations.push(`unknown argument "${key}"`);
    }
  }
  if (violations.length > 0) throw new MolbioInputError(`invalid arguments: ${violations.join('; ')}`);
  const check = (node, value, key) => {
    const type = node.type;
    if (type === undefined) return;
    if (type === 'string' && typeof value !== 'string') throw new MolbioInputError(`invalid argument "${key}": expected a string`);
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new MolbioInputError(`invalid argument "${key}": expected a finite number`);
    if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) throw new MolbioInputError(`invalid argument "${key}": expected an integer`);
    if (type === 'boolean' && typeof value !== 'boolean') throw new MolbioInputError(`invalid argument "${key}": expected a boolean`);
    if (type === 'array' && !Array.isArray(value)) throw new MolbioInputError(`invalid argument "${key}": expected an array`);
    if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new MolbioInputError(`invalid argument "${key}": expected an object`);
    if (type === 'string' && node.enum !== undefined && !node.enum.includes(value)) throw new MolbioInputError(`invalid argument "${key}": must be one of ${node.enum.join(', ')}`);
    if (type === 'object' && node.properties !== undefined) {
      for (const childKey of node.required ?? []) {
        if (value[childKey] === undefined || value[childKey] === null) throw new MolbioInputError(`invalid argument "${key}.${childKey}": missing`);
      }
      for (const [childKey, child] of Object.entries(node.properties)) {
        if (value[childKey] !== undefined) check(child, value[childKey], `${key}.${childKey}`);
      }
    }
    if (type === 'array' && node.items !== undefined) {
      for (let i = 0; i < value.length; i++) check(node.items, value[i], `${key}[${i}]`);
    }
  };
  for (const [key, value] of Object.entries(args)) {
    const node = properties[key];
    if (node !== undefined && value !== undefined) check(node, value, key);
  }
}

/**
 * Build one registry-ready raw tool definition.
 * `safe` declares concurrency safety: true for pure/read-only tools, false for
 * tools that write files (the registry may run safe tools in parallel), or a
 * function of the arguments for tools that write only conditionally.
 *
 * `presentationMeta(args, value)` is optional and is forwarded verbatim onto
 * `output`: the tool layer calls it for a ROOT call and records the value, which
 * is how a tool hands the Web Client structured data for a custom
 * `tool.call.toolview` card (`block.meta` in the browser).
 *
 * A value carrying an `image` attachment (see `withAttachedImage`) renders an
 * extra `image` content block beside the text, which is how the picture reaches
 * the model — the same mechanism the harness's own `read_image` tool uses.
 */
function define({ name: toolName, description, parameters, outputSchema, render, presentationMeta, execute, safe = true }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render(_args, value) {
        const blocks = [{ type: 'text', text: render(value) }];
        const image = imageBlockFor(value);
        if (image !== undefined) blocks.push(image);
        return blocks;
      },
      ...presentationMeta === undefined ? {} : { presentationMeta },
    },
    async execute(args, exec) {
      validateArgsAgainstSchema(parameters, args);
      return execute(args, exec);
    },
    isConcurrencySafe: typeof safe === 'function' ? safe : () => safe,
  };
}

/**
 * Turn a tool value's `image` field back into the `image` content block the
 * harness expects. Validated rather than trusted: the value has been through
 * JSON, so a malformed or half-written attachment degrades to text instead of
 * failing the call.
 */
function imageBlockFor(value) {
  const image = value?.image;
  if (image === null || typeof image !== 'object') return undefined;
  const { attachment_id: attachmentId, media_type: mediaType, bytes, width, height, name } = image;
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined;
  if (typeof mediaType !== 'string' || !Number.isInteger(bytes) || !Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  return {
    type: 'image',
    attachment: {
      attachmentId,
      mediaType,
      bytes,
      width,
      height,
      ...typeof name === 'string' && name !== '' ? { name } : {},
    },
  };
}

/** Human/model-facing note for a picture attached to (or missing from) a result. */
function imageNote(value) {
  if (value?.image !== undefined) return ' The rendered PNG is attached to this result, so you can look at the picture directly.';
  if (typeof value?.image_note === 'string' && value.image_note !== '') return ` (attach_image was requested but no image was attached: ${value.image_note})`;
  return '';
}

// ── opt-in image attachment (v18) ───────────────────────────────────────────

/**
 * Shared parameter for the opt-in picture hand-off. The workspace cannot hold
 * the PNG: the harness filesystem seam is text-only by contract (`dsh-fs`
 * refuses binary with FS_NOT_TEXT, and its mutations write UTF-8 strings), so
 * the picture travels the one binary-safe path the harness does expose —
 * `ctx.attachments.saveImage()` plus an `image` content block on the result.
 */
const ATTACH_IMAGE_PARAM = {
  attach_image: {
    type: 'boolean',
    description: 'Also hand the picture to yourself as an attached image so you can look at it (default false). Needs an image-capable route; otherwise the result stays text-only and says why in image_note.',
  },
};

/** Output fragment for the attached picture (see ATTACH_IMAGE_PARAM). */
const ATTACHED_IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachment_id', 'media_type', 'bytes', 'width', 'height'],
  properties: {
    attachment_id: { type: 'string' },
    media_type: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
};

/**
 * Rasterize `svg` and commit it as a durable image attachment, for the tools
 * that drew a picture. Returns `{ image }` / `{ image_note }` to merge into the
 * tool result, or `undefined` when the caller did not ask for the picture.
 *
 * Never throws and never fails a call: the SVG is already written by the time
 * this runs, so a missing attachment service, a text-only route, a rasterizer
 * that cannot render this document or a refusing store all degrade to a
 * text-only result that names the reason. This mirrors the delegation the
 * harness's own `read_image` performs (resolve the route's model, require
 * `image` in `inputModalities`) rather than inventing a parallel rule.
 */
async function withAttachedImage(ctx, exec, args, svg, name) {
  if (args.attach_image !== true) return undefined;
  const attachments = ctx.get('attachments');
  if (attachments === undefined) return { image_note: 'this composition mounts no attachment service' };
  let provider;
  let model;
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config;
    provider = routed?.provider ?? exec?.agent?.options?.provider;
    model = routed?.model ?? exec?.agent?.options?.model;
  } catch {
    return { image_note: 'the current model route could not be resolved' };
  }
  const llm = ctx.get('llm');
  if (llm === undefined || provider === undefined || model === undefined) {
    return { image_note: 'the current model route could not be resolved' };
  }
  try {
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    if (info?.inputModalities === undefined || !info.inputModalities.includes('image')) {
      return { image_note: `model "${model}" does not declare image input` };
    }
  } catch {
    return { image_note: `the routing model "${model}" could not be inspected` };
  }
  let raster;
  try {
    raster = renderSvgToPng(svg);
  } catch (error) {
    return { image_note: `the rasterizer could not render this SVG: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const ref = await attachments.saveImage({ data: raster.data, mediaType: 'image/png', name: `${name}.png` });
    return {
      image: {
        attachment_id: ref.attachmentId,
        media_type: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...typeof ref.name === 'string' && ref.name !== '' ? { name: ref.name } : {},
      },
    };
  } catch (error) {
    return { image_note: `the attachment store refused the image: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Spread one attachment outcome into a tool result. */
function mergeAttachedImage(result, attached) {
  return attached === undefined ? result : { ...result, ...attached };
}

// NOTE: in raw JSON Schema the `required` keyword is an ARRAY on the object
// level (see each tool's parameters.required), never `required: true` inside a
// property schema.
function requiredString(description) {
  return { type: 'string', description };
}
function optionalNumber(description) {
  return { type: 'number', description };
}

// ── shared output fragments ─────────────────────────────────────────────────

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['base', 'count', 'start'],
  properties: {
    base: { type: 'string' },
    count: { type: 'integer' },
    start: { type: 'integer' },
  },
};

const REPEAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['motif', 'count', 'start'],
  properties: {
    motif: { type: 'string' },
    count: { type: 'integer' },
    start: { type: 'integer' },
  },
};

const HAIRPIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'stem', 'loop', 'pairs', 'score'],
  properties: {
    start: { type: 'integer' },
    stem: { type: 'integer' },
    loop: { type: 'integer' },
    pairs: { type: 'integer' },
    score: { type: 'integer' },
  },
};

const PRIMER_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['length', 'gc_percent', 'runs', 'repeats', 'self_complement_score', 'self_consecutive', 'self_3prime_pairs', 'hairpins'],
  properties: {
    length: { type: 'integer' },
    gc_percent: { type: 'number' },
    runs: { type: 'array', items: RUN_SCHEMA },
    repeats: { type: 'array', items: REPEAT_SCHEMA },
    self_complement_score: { type: 'integer' },
    self_consecutive: { type: 'integer' },
    self_3prime_pairs: { type: 'integer' },
    hairpins: { type: 'array', items: HAIRPIN_SCHEMA },
    self_any_score: { type: 'number', description: 'Primer3-style self-complementarity alignment score (match +1/mismatch -1/gap -0.25; threshold 8.0).' },
    self_end_score: { type: 'number', description: 'Primer3-style 3\'-anchored self-complementarity score (threshold 3.0).' },
    hairpin_tm: { type: 'number', description: 'Melting temperature of the most stable hairpin (°C, 0 = none; Primer3 threshold 47).' },
    end_stability_kcal: { type: 'number', description: 'ΔG(37 °C) of the last five 3\' bases in kcal/mol (more negative = more stable; Primer3 limit 9.0).' },
    end_gc_count: { type: 'integer', description: 'G/C bases among the last five 3\' bases.' },
  },
};

// ── tools ───────────────────────────────────────────────────────────────────

const reverseComplementTool = define({
  name: 'molbio_reverse_complement',
  description: 'Compute the complement and reverse complement of a DNA/RNA sequence (IUPAC codes supported; whitespace and digits are ignored). The reverse complement of the bottom strand is the top strand — use it to convert between strand conventions or to orient an insert.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('DNA or RNA sequence (IUPAC: A C G T U R Y S W K M B D H V N).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['original', 'complement', 'reverse_complement', 'length', 'gc_percent'],
    properties: {
      original: { type: 'string' },
      complement: { type: 'string' },
      reverse_complement: { type: 'string' },
      length: { type: 'integer' },
      gc_percent: { type: 'number' },
    },
  },
  render(value) {
    return [
      `original (${value.length} bp): ${value.original}`,
      `complement:            ${value.complement}`,
      `reverse complement:    ${value.reverse_complement}`,
      `GC content: ${value.gc_percent}%`,
    ].join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    const rev = reverseComplement(seq);
    const { gc, at } = baseCounts(seq);
    const gcPercent = gc + at === 0 ? 0 : Math.round((gc / (gc + at)) * 10000) / 100;
    return {
      original: seq,
      complement: complement(seq),
      reverse_complement: rev,
      length: seq.length,
      gc_percent: gcPercent,
    };
  },
});

const gcTool = define({
  name: 'molbio_gc_content',
  description: 'Compute overall GC content of a sequence and, optionally, per-window GC percentages for non-overlapping windows. Useful for checking amplicons, probes, and sequencing-library inserts.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('DNA/RNA sequence (IUPAC).'),
      window: { type: 'integer', description: 'Optional window size in bp (10–100000) for per-window GC percentages; omit for overall GC only.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['length', 'gc_count', 'at_count', 'ambiguous_count', 'gc_percent', 'gc_percent_excluding_ambiguous', 'windows'],
    properties: {
      length: { type: 'integer' },
      gc_count: { type: 'integer' },
      at_count: { type: 'integer' },
      ambiguous_count: { type: 'integer' },
      gc_percent: { type: 'number' },
      gc_percent_excluding_ambiguous: { type: 'number' },
      windows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end', 'gc_percent'],
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
            gc_percent: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `length: ${value.length} bp`,
      `GC: ${value.gc_count}  AT: ${value.at_count}  ambiguous: ${value.ambiguous_count}`,
      `GC content: ${value.gc_percent}% (${value.gc_percent_excluding_ambiguous}% excluding ambiguous bases)`,
    ];
    if (value.windows.length > 0) {
      lines.push('per-window GC:');
      for (const w of value.windows) lines.push(`  ${w.start}-${w.end}: ${w.gc_percent}%`);
    }
    return lines.join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    const { gc, at, n } = baseCounts(seq);
    const windows = [];
    const window = args.window;
    if (window !== undefined) {
      if (!Number.isInteger(window) || window < 10 || window > 100000) {
        throw new MolbioInputError('window must be an integer between 10 and 100000');
      }
      for (let start = 0; start < seq.length; start += window) {
        const end = Math.min(start + window, seq.length);
        const slice = seq.slice(start, end);
        const counts = baseCounts(slice);
        const unambiguous = counts.gc + counts.at;
        windows.push({
          start: start + 1,
          end,
          gc_percent: unambiguous === 0 ? 0 : Math.round((counts.gc / unambiguous) * 10000) / 100,
        });
      }
    }
    const unambiguous = gc + at;
    return {
      length: seq.length,
      gc_count: gc,
      at_count: at,
      ambiguous_count: n,
      gc_percent: seq.length === 0 ? 0 : Math.round((gc / seq.length) * 10000) / 100,
      gc_percent_excluding_ambiguous: unambiguous === 0 ? 0 : Math.round((gc / unambiguous) * 10000) / 100,
      windows,
    };
  },
});

const translateTool = define({
  name: 'molbio_translate',
  description: 'Translate a DNA/RNA sequence in one or more frames and report open reading frames. Choose frames 1/2/3 (forward), -1/-2/-3 (reverse), or all six. Stop codons appear as "*"; with min_orf_aa > 0 the tool also lists ORFs of at least that many amino acids.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Coding DNA/RNA sequence (IUPAC).'),
      frames: { type: 'string', enum: ['1', '2', '3', '-1', '-2', '-3', 'all'], description: 'Frame(s) to translate; default "all".' },
      code: { type: 'string', enum: GENETIC_CODES, description: 'Genetic code; default "standard".' },
      min_orf_aa: { type: 'integer', description: 'Minimum ORF length in amino acids to report (default 30; 0 disables ORF listing).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['frames', 'orfs'],
    properties: {
      frames: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['frame', 'protein', 'length', 'stops', 'first_stop'],
          properties: {
            frame: { type: 'string' },
            protein: { type: 'string' },
            length: { type: 'integer' },
            stops: { type: 'integer' },
            first_stop: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
      },
      orfs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['frame', 'start', 'end', 'length_aa', 'sequence'],
          properties: {
            frame: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            length_aa: { type: 'integer' },
            sequence: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [];
    for (const f of value.frames) {
      const first = f.first_stop === null ? 'no stop' : `first stop at template position ${f.first_stop + 1}`;
      lines.push(`frame ${f.frame} (${f.length} aa, ${f.stops} stop(s), ${first}):`);
      lines.push(`  ${f.protein}`);
    }
    if (value.orfs.length > 0) {
      lines.push(`ORFs (>= min_orf_aa):`);
      for (const orf of value.orfs) {
        lines.push(`  frame ${orf.frame}, bases ${orf.start + 1}-${orf.end + 1}, ${orf.length_aa} aa: ${orf.sequence}`);
      }
    }
    return lines.join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    const frames = args.frames ?? 'all';
    const validFrames = ['1', '2', '3', '-1', '-2', '-3', 'all'];
    if (!validFrames.includes(frames)) throw new MolbioInputError(`frames must be one of ${validFrames.join(', ')}`);
    const code = args.code ?? 'standard';
    if (!GENETIC_CODES.includes(code)) throw new MolbioInputError(`code must be one of ${GENETIC_CODES.join(', ')}`);
    let minOrf = args.min_orf_aa ?? 30;
    if (!Number.isInteger(minOrf) || minOrf < 0) throw new MolbioInputError('min_orf_aa must be a non-negative integer');
    if (minOrf > 100000) minOrf = 100000;
    const { results, orfs } = translateFrames(seq, frames, code, minOrf);
    return { frames: results, orfs };
  },
});

const restrictionTool = define({
  name: 'molbio_restriction_sites',
  description: 'Find restriction enzyme recognition sites in a sequence and compute the expected digestion fragments (linear or circular). Pass the enzyme names you care about, or ["common"] to scan every enzyme in the built-in table. Cut positions use the standard cut notation of each site (e.g. EcoRI G^AATTC).',
  parameters: {
    type: 'object',
    required: ['sequence', 'enzymes'],
    properties: {
      sequence: requiredString('DNA sequence to digest (IUPAC; ambiguous bases in the sequence are treated as no-match).'),
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzyme names, or ["common"] for all built-in enzymes.' },
      circular: { type: 'boolean', description: 'True for circular DNA (plasmids): fragments wrap around the origin. Default false (linear).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['circular', 'enzymes'],
    properties: {
      circular: { type: 'boolean' },
      enzymes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'site', 'matches', 'cut_positions', 'fragments'],
          properties: {
            name: { type: 'string' },
            site: { type: 'string' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end', 'sequence'],
                properties: {
                  start: { type: 'integer' },
                  end: { type: 'integer' },
                  sequence: { type: 'string' },
                },
              },
            },
            cut_positions: { type: 'array', items: { type: 'integer' } },
            fragments: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [`digest of ${value.circular ? 'circular' : 'linear'} DNA:`];
    for (const enzyme of value.enzymes) {
      lines.push(`- ${enzyme.name} (${enzyme.site}):`);
      if (enzyme.matches.length === 0) {
        lines.push('    no sites; uncut: 1 fragment');
      } else {
        for (const m of enzyme.matches) lines.push(`    site at ${m.start + 1}-${m.end + 1} (${m.sequence}), cut at ${m.start + 1 + enzyme.site.indexOf('^')}`);
        lines.push(`    ${enzyme.fragments.length} fragment(s): ${enzyme.fragments.join(', ')} bp`);
      }
    }
    return lines.join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    let enzymes = args.enzymes;
    if (!Array.isArray(enzymes) || enzymes.length === 0) throw new MolbioInputError('enzymes must be a non-empty array of enzyme names');
    if (enzymes.length === 1 && enzymes[0] === 'common') enzymes = ENZYME_NAMES;
    const circular = args.circular === true;
    const results = digest(seq, enzymes, circular);
    return { circular, enzymes: results };
  },
});

// ── enzyme catalog lookup (v13) ─────────────────────────────────────────────

const ENZYME_CUT_EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'orientation', 'cut_position'],
  properties: {
    start: { type: 'integer', description: '1-based start of the recognition site on the top strand.' },
    orientation: { type: 'string', enum: ['forward', 'reverse'], description: 'forward = the recognition sequence itself; reverse = its reverse complement (the enzyme binds the bottom strand).' },
    cut_position: { type: 'integer', description: '1-based top-strand cut position.' },
  },
};

const ENZYME_LOOKUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'site', 'recognition', 'iis', 'cut_offset', 'palindromic'],
  properties: {
    name: { type: 'string' },
    site: { type: 'string', description: 'Recognition site with the cut marked (type IIS uses the standard (N/N) notation).' },
    recognition: { type: 'string', description: 'Recognition sequence (IUPAC; without the cut mark).' },
    iis: { type: 'boolean', description: 'True for type IIS enzymes (cut outside the recognition site).' },
    cut_offset: { type: 'integer', description: 'Top-strand cut offset from the site start (0-based).' },
    palindromic: { type: 'boolean', description: 'Whether the recognition sequence equals its reverse complement.' },
    bottom_cut: { type: 'integer', description: 'Type IIS only: bottom-strand cut offset from the site END.' },
    overhang_length: { type: 'integer', description: 'Type IIS only: 5\' overhang length in bases.' },
    cuts: { type: 'integer', description: 'Cut events found in the given sequence (present only with `sequence`).' },
    cut_events: { type: 'array', items: ENZYME_CUT_EVENT_SCHEMA },
    fragments: { type: 'array', items: { type: 'integer' }, description: 'Fragment sizes in bp from the cut positions (present only with `sequence`).' },
  },
};

const enzymeLookupTool = define({
  name: 'molbio_enzyme_lookup',
  description: 'Look up restriction enzymes in the built-in table (90+ entries including type IIS): recognition site, cut geometry, overhang length, and — when a sequence is given — every cut event with fragment sizes. Both strand orientations are reported: a type IIS enzyme such as BsaI also cuts at REVERSE-COMPLEMENTED recognition sites (e.g. GAGACC on the top strand), which molbio_restriction_sites does not report. Use this to check whether an enzyme cuts an insert/vector before cloning.',
  parameters: {
    type: 'object',
    properties: {
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzyme names to look up; omit (or pass ["common"]) for the whole table, sorted.' },
      sequence: { type: 'string', description: 'Optional sequence (IUPAC) to count cuts and compute fragment sizes on.' },
      circular: { type: 'boolean', description: 'Treat the sequence as circular for the fragment math (default false).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['enzymes', 'total'],
    properties: {
      total: { type: 'integer' },
      sequence_length: { type: 'integer' },
      circular: { type: 'boolean' },
      enzymes: { type: 'array', items: ENZYME_LOOKUP_SCHEMA },
    },
  },
  render(value) {
    const lines = [`${value.total} enzyme(s)${value.sequence_length !== undefined ? ` checked against a ${value.sequence_length} bp ${value.circular ? 'circular' : 'linear'} sequence` : ''}:`];
    for (const entry of value.enzymes) {
      const geometry = entry.iis
        ? `type IIS ${entry.site}, cut ${entry.cut_offset}/${entry.bottom_cut}, ${entry.overhang_length} bp 5' overhang`
        : `cut ${entry.site}`;
      lines.push(`  ${entry.name}: ${geometry}${entry.cuts !== undefined ? ` — ${entry.cuts} cut(s) in the sequence` : ''}`);
      if (entry.cut_events !== undefined && entry.cut_events.length > 0) {
        lines.push(`    cuts: ${entry.cut_events.map((cut) => `bp ${cut.cut_position} (${cut.orientation})`).join(', ')}; fragments: ${entry.fragments.join('+')} bp`);
      }
    }
    return lines.join('\n');
  },
  execute(args) {
    const names = args.enzymes !== undefined && args.enzymes.length > 0 && !(args.enzymes.length === 1 && args.enzymes[0] === 'common')
      ? args.enzymes
      : ENZYME_NAMES;
    const sequence = args.sequence !== undefined && args.sequence !== '' ? normalizeSequence(args.sequence) : undefined;
    const circular = args.circular === true;
    return {
      total: names.length,
      ...(sequence !== undefined ? { sequence_length: sequence.length, circular } : {}),
      enzymes: names.map((name) => enzymeCatalog(name, sequence, circular)),
    };
  },
});

const primerTmTool = define({
  name: 'molbio_primer_tm',
  description: 'Estimate primer melting temperature with the SantaLucia (1998) nearest-neighbour model, salt-corrected for monovalent cations and magnesium (von Ahsen 2001). Defaults: 50 mM Na+, 0 mM Mg2+, 0.8 mM dNTP, 500 nM primer. Treat the result as a design estimate (rounded to 0.01 °C), not a replacement for an instrument calibration.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Primer sequence (5\'→3\', IUPAC; ≥4 bases).'),
      na_mm: optionalNumber('Monovalent cation concentration in mM (default 50).'),
      mg_mm: optionalNumber('Magnesium concentration in mM (default 0).'),
      dntp_mm: optionalNumber('Total dNTP concentration in mM (default 0.8; only affects the Mg equivalence term when Mg > dNTP).'),
      primer_nm: optionalNumber('Primer concentration in nM (default 500).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['tm_celsius', 'length', 'gc_percent', 'na_equivalent_mm'],
    properties: {
      tm_celsius: { type: 'number' },
      length: { type: 'integer' },
      gc_percent: { type: 'number' },
      na_equivalent_mm: { type: 'number' },
    },
  },
  render(value) {
    return `Tm ≈ ${value.tm_celsius} °C (${value.length} bp, GC ${value.gc_percent}%, Na+ equivalent ${value.na_equivalent_mm} mM) — SantaLucia 1998 NN estimate, salt-corrected.`;
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence, 'primer sequence');
    const { tm_celsius, na_equivalent_mm } = primerTm(seq, {
      naMm: args.na_mm ?? 50,
      mgMm: args.mg_mm ?? 0,
      dntpMm: args.dntp_mm ?? 0.8,
      primerNm: args.primer_nm ?? 500,
    });
    const { gc, at } = baseCounts(seq);
    const unambiguous = gc + at;
    return {
      tm_celsius,
      length: seq.length,
      gc_percent: unambiguous === 0 ? 0 : Math.round((gc / unambiguous) * 10000) / 100,
      na_equivalent_mm,
    };
  },
});

function primerReport(seq) {
  const { gc, at } = baseCounts(seq);
  const unambiguous = gc + at;
  const sc = selfComplementarity(seq);
  const hairpinTm = hairpinThermo(seq, 200e-9)[0]?.tm ?? 0;
  return {
    length: seq.length,
    gc_percent: unambiguous === 0 ? 0 : Math.round((gc / unambiguous) * 10000) / 100,
    runs: findRuns(seq),
    repeats: findRepeats(seq),
    self_complement_score: sc.bestScore,
    self_consecutive: sc.bestConsecutive,
    self_3prime_pairs: sc.threePrimePairs,
    hairpins: findHairpins(seq),
    self_any_score: Math.round(selfAnyScore(seq) * 100) / 100,
    self_end_score: Math.round(selfEndScore(seq) * 100) / 100,
    hairpin_tm: hairpinTm,
    end_stability_kcal: endStability5(seq),
    end_gc_count: endGcCount5(seq),
  };
}

const primerCheckTool = define({
  name: 'molbio_primer_check',
  description: 'Screen one primer (or a primer pair) for PCR design red flags: mononucleotide runs, short tandem repeats, self-complementarity (3\' end weighted), hairpins, and — for a pair — dimer potential via complementary alignment of the two primers. v12 adds Primer3-style thermodynamic metrics: self_any_score/self_end_score (alignment scores, thresholds 8.0/3.0), hairpin_tm (°C, threshold 47), end stability/end GC of the last five 3\' bases, and for pairs dimer_tm/dimer_end_tm (°C, thresholds 47). Interpret scores relatively: higher 3\'-weighted scores are riskier.',
  parameters: {
    type: 'object',
    required: ['primer1'],
    properties: {
      primer1: requiredString('First primer sequence (5\'→3\').'),
      primer2: { type: 'string', description: 'Optional second primer (5\'→3\') for dimer analysis.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['primer1'],
    properties: {
      primer1: PRIMER_REPORT_SCHEMA,
      primer2: PRIMER_REPORT_SCHEMA,
      pair: {
        type: 'object',
        additionalProperties: false,
        required: ['score', 'max_consecutive', 'three_prime_pairs'],
        properties: {
          score: { type: 'integer' },
          max_consecutive: { type: 'integer' },
          three_prime_pairs: { type: 'integer' },
          dimer_tm: { type: 'number', description: 'Melting temperature of the most stable primer dimer (°C; Primer3 threshold 47).' },
          dimer_end_tm: { type: 'number', description: 'Dimer Tm when a 3\' end participates (°C; Primer3 threshold 47).' },
        },
      },
    },
  },
  render(value) {
    const lines = [];
    const fmt = (label, report) => {
      lines.push(`${label}: ${report.length} bp, GC ${report.gc_percent}%`);
      if (report.runs.length > 0) lines.push(`  runs: ${report.runs.map((r) => `${r.base}x${r.count}@${r.start}`).join(', ')}`);
      if (report.repeats.length > 0) lines.push(`  repeats: ${report.repeats.map((r) => `(${r.motif})x${r.count}@${r.start}`).join(', ')}`);
      lines.push(`  self-complementarity: score ${report.self_complement_score}, max consecutive ${report.self_consecutive}, 3\' pairs ${report.self_3prime_pairs}/6`);
      lines.push(`  Primer3-style: self-any ${report.self_any_score} (≤8), self-end ${report.self_end_score} (≤3), hairpin Tm ${report.hairpin_tm} °C (≤47), 3'-end ΔG ${report.end_stability_kcal} kcal/mol (≥ -9), 3'-end GC ${report.end_gc_count}/5`);
      if (report.hairpins.length > 0) lines.push(`  hairpins: ${report.hairpins.map((h) => `stem ${h.stem}/loop ${h.loop}@${h.start} (score ${h.score})`).join(', ')}`);
    };
    fmt('primer1', value.primer1);
    if (value.primer2 !== undefined) fmt('primer2', value.primer2);
    if (value.pair !== undefined) {
      lines.push(`pair (dimer): score ${value.pair.score}, max consecutive ${value.pair.max_consecutive}, 3\' pairs ${value.pair.three_prime_pairs}/6`);
      lines.push(`pair Primer3-style: dimer Tm ${value.pair.dimer_tm} °C (≤47), 3'-end dimer Tm ${value.pair.dimer_end_tm} °C (≤47)`);
    }
    return lines.join('\n');
  },
  execute(args) {
    const p1 = normalizeSequence(args.primer1, 'primer1');
    const out = { primer1: primerReport(p1) };
    if (args.primer2 !== undefined && args.primer2 !== null) {
      const p2 = normalizeSequence(args.primer2, 'primer2');
      out.primer2 = primerReport(p2);
      const d = dimerPotential(p1, p2);
      const dt = dimerThermo(p1, p2, 200e-9);
      out.pair = { score: d.score, max_consecutive: d.maxConsecutive, three_prime_pairs: d.threePrimePairs, dimer_tm: dt.any_tm, dimer_end_tm: dt.end_tm };
    }
    return out;
  },
});

const qpcrTool = define({
  name: 'molbio_qpcr_analysis',
  description: 'Analyse qPCR Ct values with the ΔΔCt method: means and SDs per group, ΔCt, ΔΔCt, and fold change (efficiency^-ΔΔCt). Pass four lists: target Ct in treated and control samples, and reference (housekeeping) Ct in the same samples. Ct values must be positive numbers.',
  parameters: {
    type: 'object',
    required: ['target_treated', 'target_control', 'reference_treated', 'reference_control'],
    properties: {
      target_treated: { type: 'array', items: { type: 'number' }, description: 'Ct values of the target gene in treated samples.' },
      target_control: { type: 'array', items: { type: 'number' }, description: 'Ct values of the target gene in control samples.' },
      reference_treated: { type: 'array', items: { type: 'number' }, description: 'Ct values of the reference gene in treated samples.' },
      reference_control: { type: 'array', items: { type: 'number' }, description: 'Ct values of the reference gene in control samples.' },
      efficiency: optionalNumber('Amplification efficiency as the per-cycle factor (1.5–2.5); default 2.0 (perfect 100% doubling).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'target_treated_mean', 'target_treated_sd', 'target_control_mean', 'target_control_sd',
      'reference_treated_mean', 'reference_treated_sd', 'reference_control_mean', 'reference_control_sd',
      'delta_ct_treated', 'delta_ct_control', 'delta_delta_ct', 'fold_change',
    ],
    properties: {
      target_treated_mean: { type: 'number' },
      target_treated_sd: { type: 'number' },
      target_control_mean: { type: 'number' },
      target_control_sd: { type: 'number' },
      reference_treated_mean: { type: 'number' },
      reference_treated_sd: { type: 'number' },
      reference_control_mean: { type: 'number' },
      reference_control_sd: { type: 'number' },
      delta_ct_treated: { type: 'number' },
      delta_ct_control: { type: 'number' },
      delta_delta_ct: { type: 'number' },
      fold_change: { type: 'number' },
    },
  },
  render(value) {
    return [
      `ΔCt treated  = ${value.delta_ct_treated} (target ${value.target_treated_mean} ± ${value.target_treated_sd} − reference ${value.reference_treated_mean} ± ${value.reference_treated_sd})`,
      `ΔCt control  = ${value.delta_ct_control} (target ${value.target_control_mean} ± ${value.target_control_sd} − reference ${value.reference_control_mean} ± ${value.reference_control_sd})`,
      `ΔΔCt = ${value.delta_delta_ct}`,
      `fold change (efficiency^-ΔΔCt) = ${value.fold_change}`,
    ].join('\n');
  },
  execute(args) {
    const efficiency = args.efficiency ?? 2.0;
    if (typeof efficiency !== 'number' || efficiency < 1.5 || efficiency > 2.5) {
      throw new MolbioInputError('efficiency must be a per-cycle factor between 1.5 and 2.5 (2.0 = perfect doubling)');
    }
    return analyzeQpcr({
      targetTreated: args.target_treated,
      targetControl: args.target_control,
      referenceTreated: args.reference_treated,
      referenceControl: args.reference_control,
      efficiency,
    });
  },
});

const labMathTool = define({
  name: 'molbio_lab_math',
  description: 'Everyday bench calculations. dilution: give exactly 3 of {c1, v1, c2, v2} and the fourth is solved (C1·V1 = C2·V2). molarity: mass_mg, mw_g_per_mol, volume_ml → mM. copy_number: mass_ng and length_bp → template copies.',
  parameters: {
    type: 'object',
    required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['dilution', 'molarity', 'copy_number'], description: 'Which calculation to run.' },
      c1: optionalNumber('Starting concentration (dilution).'),
      v1: optionalNumber('Starting volume (dilution).'),
      c2: optionalNumber('Final concentration (dilution).'),
      v2: optionalNumber('Final volume (dilution).'),
      mass_mg: optionalNumber('Solute mass in mg (molarity).'),
      mw_g_per_mol: optionalNumber('Molecular weight in g/mol (molarity).'),
      volume_ml: optionalNumber('Final volume in mL (molarity).'),
      mass_ng: optionalNumber('DNA mass in ng (copy_number).'),
      length_bp: optionalNumber('DNA length in bp (copy_number).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'result', 'unit', 'detail'],
    properties: {
      operation: { type: 'string' },
      result: { type: 'number' },
      unit: { type: 'string' },
      detail: { type: 'string' },
    },
  },
  render(value) {
    return `${value.operation}: result = ${value.result} ${value.unit} (${value.detail})`;
  },
  execute(args) {
    return { operation: args.operation, ...labMath(args.operation, args) };
  },
});

// ── primer design ───────────────────────────────────────────────────────────

const MISMATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'template_base', 'primer_base', 'template_position', 'distance_from_3prime'],
  properties: {
    position: { type: 'integer', description: '1-based position of the mismatch in the primer (5\'→3\').' },
    template_base: { type: 'string', description: 'The base a perfectly matching primer would carry at this position (forward primers: the template base; reverse primers: its complement).' },
    primer_base: { type: 'string', description: 'The base the reported primer actually carries (' + '"primer_base !== template_base"' + ' marks a real mismatch).' },
    template_position: { type: 'integer', description: '1-based position on the template (forward strand) where the primer binds.' },
    distance_from_3prime: { type: 'integer', description: 'Number of bases between this mismatch and the primer 3\' end (0 = terminal base).' },
  },
};

const MISPRIMING_SITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'strand', 'matches'],
  properties: {
    position: { type: 'integer', description: '1-based position on the template where the 3\' tail can anneal.' },
    strand: { type: 'string', enum: ['top', 'bottom'], description: 'The template strand the primer would bind at this site.' },
    matches: { type: 'integer', description: 'Complementary bases between the 3\' tail and this site.' },
  },
};

const PRIMER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'start', 'end', 'length', 'tm', 'gc_percent'],
  properties: {
    sequence: { type: 'string' },
    start: { type: 'integer' },
    end: { type: 'integer' },
    length: { type: 'integer' },
    tm: { type: 'number' },
    gc_percent: { type: 'number' },
    self_any: { type: 'number', description: 'Primer3-style self-complementarity alignment score (v12).' },
    self_end: { type: 'number', description: 'Primer3-style 3\'-anchored self-complementarity score (v12).' },
    hairpin_tm: { type: 'number', description: 'Melting temperature of the most stable hairpin (°C, 0 = none; v12).' },
    end_stability_kcal: { type: 'number', description: 'ΔG(37 °C) of the last five 3\' bases in kcal/mol (v12).' },
    end_gc_count: { type: 'integer', description: 'G/C bases among the last five 3\' bases (v12).' },
    mismatch_count: { type: 'integer', description: 'Number of primer-template mismatches this primer carries (0 = exact match; v12).' },
    mismatches: { type: 'array', items: MISMATCH_SCHEMA },
    mispriming_count: { type: 'integer', description: 'Extra template sites where the 3\' tail can anneal (v12 mispriming check).' },
    mispriming_sites: { type: 'array', items: MISPRIMING_SITE_SCHEMA },
    target_distance: { type: 'integer', description: 'v13: bp between the primer 3\' end and target_position (present only when target_position is given).' },
  },
};

const designPrimersTool = define({
  name: 'molbio_design_primers',
  description: 'Design PCR primer pairs on a template sequence. Scans for forward and reverse primers that satisfy Tm (SantaLucia 1998 NN; defaults 50 mM Na+, 1.5 mM Mg2+, 200 nM primer — adjustable via na_mm/mg_mm/dntp_mm/primer_nm), GC content, length, GC clamp (0-3 consecutive G/C at the 3\' end), mononucleotide-run, end-stability and Primer3-style structural constraints — self-complementarity (local alignment score, match +1/mismatch -1/gap -0.25), hairpin folding Tm and primer-dimer Tm (default 47 °C each, from the same NN parameters) — then ranks pairs inside the amplicon window (lower penalty is better). v12: pass max_mismatches > 0 to also allow primers with a few positional mismatches (never on the 3\'-terminal base, avoided in the 3\'-terminal critical zone by default; each is reported and penalized); pass check_mispriming: true to reject/penalize primers whose 3\' tail anneals at extra template sites. v13: pass target_position to prefer pairs whose nearer 3\' end lands close to that template position (SNP / site-directed design).',
  parameters: {
    type: 'object',
    required: ['template'],
    properties: {
      template: requiredString('Template sequence to design primers on (IUPAC).'),
      region_start: { type: 'integer', description: '1-based start of the region the amplicon must lie in (default 1).' },
      region_end: { type: 'integer', description: '1-based end of the region (default template end).' },
      primer_len_min: { type: 'integer', description: 'Minimum primer length (default 18).' },
      primer_len_max: { type: 'integer', description: 'Maximum primer length (default 28, max 40).' },
      tm_min: { type: 'number', description: 'Minimum primer Tm °C (default 55).' },
      tm_max: { type: 'number', description: 'Maximum primer Tm °C (default 65).' },
      gc_min: { type: 'number', description: 'Minimum primer GC% (default 40).' },
      gc_max: { type: 'number', description: 'Maximum primer GC% (default 60).' },
      amplicon_min: { type: 'integer', description: 'Minimum amplicon length bp (default 80).' },
      amplicon_max: { type: 'integer', description: 'Maximum amplicon length bp (default 1000).' },
      gc_clamp: { type: 'integer', description: 'Consecutive G/C bases required at the primer 3\' end (0-3, default 1). Replaces require_gc_clamp.' },
      require_gc_clamp: { type: 'boolean', description: 'Deprecated alias for gc_clamp: true = 1, false = 0. gc_clamp wins when both are given.' },
      max_run: { type: 'integer', description: 'Maximum allowed run of identical bases (default 3).' },
      max_self_any: { type: 'number', description: 'Maximum self-complementarity alignment score (match +1/mismatch -1/gap -0.25; default 8, the Primer3 default).' },
      max_self_end: { type: 'number', description: 'Maximum 3\'-anchored self-complementarity score (default 3, the Primer3 default).' },
      max_hairpin_tm: { type: 'number', description: 'Maximum hairpin folding Tm in °C (default 47, the Primer3 default).' },
      max_dimer_tm: { type: 'number', description: 'Maximum primer-dimer duplex Tm in °C (default 47, the Primer3 default).' },
      max_dimer_end_tm: { type: 'number', description: 'Maximum dimer Tm when a 3\' end participates in °C (default 47, the Primer3 default).' },
      max_end_stability: { type: 'number', description: 'Maximum |ΔG(37 °C)| of the last five 3\' bases in kcal/mol (default 9.0, the Primer3 default).' },
      max_end_gc: { type: 'integer', description: 'Maximum G/C bases allowed in the last five 3\' bases (default 5, the Primer3 default).' },
      max_tm_delta: { type: 'number', description: 'Maximum |Tm(forward) - Tm(reverse)| in °C (default 3).' },
      max_mismatches: { type: 'integer', description: 'Maximum primer-template mismatches the designer may introduce (0-5, default 0 = exact match required). Only used when no exact primer passes the constraints in a window; mismatches are never placed on the 3\'-terminal base.' },
      max_3prime_mismatches: { type: 'integer', description: 'Maximum mismatches tolerated inside the 3\'-terminal critical zone (mismatch_3prime_zone bases before the terminal base); default 0 (none).' },
      mismatch_3prime_zone: { type: 'integer', description: 'Length of the 3\'-terminal critical zone in bases (1-10, default 5); mismatches inside it require max_3prime_mismatches > 0.' },
      check_mispriming: { type: 'boolean', description: 'Check that the 3\' tail of each primer has no extra annealing sites on the template (either strand); default false. Extra sites are reported and penalized, and pairs beyond mispriming_max_sites are rejected.' },
      mispriming_3prime_bases: { type: 'integer', description: 'Length of the 3\' tail checked for non-specific annealing (6-10, default 8).' },
      mispriming_max_mismatches: { type: 'integer', description: 'Mismatches tolerated between the 3\' tail and a site for it to count as annealing (0-2, default 1); the terminal base must always pair.' },
      mispriming_max_sites: { type: 'integer', description: 'Maximum extra annealing sites allowed per primer (0-20, default 1); pairs with more are rejected.' },
      max_results: { type: 'integer', description: 'Maximum pairs to return (default 5).' },
      na_mm: { type: 'number', description: 'v13: monovalent cation concentration in mM for the Tm model (default 50; von Ahsen 2001 magnesium equivalence).' },
      mg_mm: { type: 'number', description: 'v13: Mg2+ concentration in mM (default 1.5).' },
      dntp_mm: { type: 'number', description: 'v13: dNTP concentration in mM (default 0.8).' },
      primer_nm: { type: 'number', description: 'v13: primer concentration in nM (default 200).' },
      target_position: { type: 'integer', description: 'v13: 1-based template position the primer 3\' ends should land near (SNP / site-directed design); pairs are ranked by the distance of the nearer 3\' end.' },
      target_penalty: { type: 'number', description: 'v13: ranking penalty per bp of 3\'-end-to-target distance (default 0.5).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['pairs', 'conditions'],
    properties: {
      conditions: {
        type: 'object',
        additionalProperties: false,
        required: ['na_mm', 'mg_mm', 'dntp_mm', 'primer_nm'],
        properties: {
          na_mm: { type: 'number', description: 'Monovalent cations used by the Tm model, mM.' },
          mg_mm: { type: 'number', description: 'Mg2+ used by the Tm model, mM.' },
          dntp_mm: { type: 'number', description: 'dNTP used by the Tm model, mM.' },
          primer_nm: { type: 'number', description: 'Primer concentration used by the Tm model, nM.' },
        },
      },
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['forward', 'reverse', 'amplicon', 'penalty'],
          properties: {
            forward: PRIMER_SCHEMA,
            reverse: PRIMER_SCHEMA,
            amplicon: {
              type: 'object',
              additionalProperties: false,
              required: ['start', 'end', 'length'],
              properties: {
                start: { type: 'integer' },
                end: { type: 'integer' },
                length: { type: 'integer' },
              },
            },
            target_distance: { type: 'integer', description: 'v13: bp between the nearer primer 3\' end and target_position (present only when target_position is given).' },
            penalty: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    if (value.pairs.length === 0) {
      return 'no primer pair satisfied all constraints — relax Tm/GC/amplicon windows or disable the GC clamp and retry.';
    }
    const lines = [
      `Tm model conditions: ${value.conditions.na_mm} mM Na+ / ${value.conditions.mg_mm} mM Mg2+ / ${value.conditions.dntp_mm} mM dNTP / ${value.conditions.primer_nm} nM primer (SantaLucia 1998 NN — an estimate).`,
      `${value.pairs.length} candidate primer pair(s), best first:`,
    ];
    const mismatchLine = (label, primer) => {
      if (primer.mismatch_count > 0) {
        const details = primer.mismatches
          .map((m) => `5'-pos ${m.position} ${m.template_base}→${m.primer_base} (template bp ${m.template_position}, ${m.distance_from_3prime} bp from 3')`)
          .join('; ');
        lines.push(`  ${label} carries ${primer.mismatch_count} mismatch(es) vs template: ${details}`);
      }
    };
    const misprimingLine = (label, primer) => {
      if (primer.mispriming_count > 0) {
        const details = primer.mispriming_sites
          .map((s) => `bp ${s.position} (${s.strand} strand, ${s.matches} matches)`)
          .join('; ');
        lines.push(`  ${label} 3' tail anneals at ${primer.mispriming_count} extra site(s): ${details}`);
      }
    };
    for (const [index, pair] of value.pairs.entries()) {
      lines.push(`#${index + 1} amplicon ${pair.amplicon.start}-${pair.amplicon.end} (${pair.amplicon.length} bp)${pair.target_distance !== undefined ? `, nearer 3' end ${pair.target_distance} bp from target_position` : ''}, penalty ${pair.penalty}`);
      lines.push(`  F ${pair.forward.sequence}  (${pair.forward.start}-${pair.forward.end}, Tm ${pair.forward.tm} °C, GC ${pair.forward.gc_percent}%, self ${pair.forward.self_any}/${pair.forward.self_end}, hairpin ${pair.forward.hairpin_tm} °C)`);
      lines.push(`  R ${pair.reverse.sequence}  (${pair.reverse.start}-${pair.reverse.end}, Tm ${pair.reverse.tm} °C, GC ${pair.reverse.gc_percent}%, self ${pair.reverse.self_any}/${pair.reverse.self_end}, hairpin ${pair.reverse.hairpin_tm} °C)`);
      mismatchLine('F', pair.forward);
      mismatchLine('R', pair.reverse);
      misprimingLine('F', pair.forward);
      misprimingLine('R', pair.reverse);
    }
    return lines.join('\n');
  },
  execute(args) {
    const { pairs, opts } = designPrimers(args.template, {
      regionStart: args.region_start,
      regionEnd: args.region_end,
      lenMin: args.primer_len_min,
      lenMax: args.primer_len_max,
      tmMin: args.tm_min,
      tmMax: args.tm_max,
      gcMin: args.gc_min,
      gcMax: args.gc_max,
      ampliconMin: args.amplicon_min,
      ampliconMax: args.amplicon_max,
      gcClamp: args.gc_clamp ?? (args.require_gc_clamp === true ? 1 : args.require_gc_clamp === false ? 0 : undefined),
      maxRun: args.max_run,
      maxSelfAny: args.max_self_any,
      maxSelfEnd: args.max_self_end,
      maxHairpinTm: args.max_hairpin_tm,
      maxDimerTm: args.max_dimer_tm,
      maxDimerEndTm: args.max_dimer_end_tm,
      maxEndStability: args.max_end_stability,
      maxEndGc: args.max_end_gc,
      maxTmDelta: args.max_tm_delta,
      maxMismatches: args.max_mismatches,
      max3PrimeMismatches: args.max_3prime_mismatches,
      mismatch3PrimeZone: args.mismatch_3prime_zone,
      checkMispriming: args.check_mispriming,
      mispriming3PrimeBases: args.mispriming_3prime_bases,
      misprimingMaxMismatches: args.mispriming_max_mismatches,
      misprimingMaxSites: args.mispriming_max_sites,
      maxResults: args.max_results,
      naMm: args.na_mm,
      mgMm: args.mg_mm,
      dntpMm: args.dntp_mm,
      primerNm: args.primer_nm,
      targetPosition: args.target_position,
      targetPenalty: args.target_penalty,
    });
    return {
      pairs,
      conditions: {
        na_mm: opts.naMm,
        mg_mm: opts.mgMm,
        dntp_mm: opts.dntpMm,
        primer_nm: opts.primerNm,
      },
    };
  },
});

// ── v17: TaqMan probe design and multiplex compatibility ────────────────────

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'start', 'end', 'length', 'orientation', 'tm', 'gc_percent', 'five_prime_g', 'three_prime_g', 'self_any', 'self_end', 'hairpin_tm', 'repeats', 'runs', 'distance_from_primer_3prime', 'penalty', 'notes'],
  properties: {
    sequence: { type: 'string', description: 'Probe sequence 5\'→3\' as it should be ordered (reverse-oriented probes are reported reverse-complemented).' },
    start: { type: 'integer', description: '1-based top-strand start of the probe binding site on the template.' },
    end: { type: 'integer', description: '1-based top-strand end of the probe binding site.' },
    length: { type: 'integer' },
    orientation: { type: 'string', enum: ['forward', 'reverse'], description: 'forward = read on the top strand (the preferred orientation, same direction as the forward primer); reverse = the probe is read on the bottom strand.' },
    tm: { type: 'number', description: 'NN Tm in °C (SantaLucia 1998 with the primer engine\'s salt and concentration correction) — an estimate.' },
    gc_percent: { type: 'number' },
    tm_delta_vs_primer: { type: 'number', description: 'Probe Tm minus the hotter primer Tm, °C; the design target is a positive margin (default ≥ 5).' },
    five_prime_g: { type: 'boolean', description: 'A 5\' terminal G quenches the reporter before cleavage; such probes are filtered out unless nothing else exists.' },
    three_prime_g: { type: 'boolean', description: 'A 3\' terminal G lets a short probe extend without cleavage; filtered out unless allow_3prime_g is set.' },
    self_any: { type: 'number' },
    self_end: { type: 'number' },
    hairpin_tm: { type: 'number' },
    dimer_tm_vs_forward: { type: 'number', description: 'Most stable duplex Tm between the probe and the forward primer, °C.' },
    dimer_tm_vs_reverse: { type: 'number', description: 'Most stable duplex Tm between the probe and the reverse primer, °C.' },
    repeats: { type: 'integer' },
    runs: { type: 'array', items: RUN_SCHEMA },
    distance_from_primer_3prime: { type: 'integer', description: 'Bases between the probe\'s near end and the 3\' end of the primer it follows in the amplicon (the primer base itself is not counted).' },
    midpoint_offset: { type: 'number', description: 'Signed distance of the probe midpoint from the amplicon centre, bp.' },
    penalty: { type: 'number', description: 'Ranking penalty (lower is better); the components are all visible in the other fields.' },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

const CONDITIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['na_mm', 'mg_mm', 'dntp_mm', 'primer_nm'],
  properties: {
    na_mm: { type: 'number', description: 'Monovalent cations used by the Tm model, mM.' },
    mg_mm: { type: 'number', description: 'Mg2+ used by the Tm model, mM.' },
    dntp_mm: { type: 'number', description: 'dNTP used by the Tm model, mM.' },
    primer_nm: { type: 'number', description: 'Primer concentration used by the Tm model, nM.' },
  },
};

const taqmanTool = define({
  name: 'molbio_design_taqman',
  description: 'Design a TaqMan (5\'-nuclease, hydrolysis probe) assay: it runs the standard primer-pair designer first (qPCR-sized amplicons, 70-200 bp by default), then places a probe inside the amplicon between the primers and applies the probe rules — no 5\' terminal G (it quenches the reporter), probe Tm at least min_tm_delta °C above the hotter primer, no mononucleotide run or repeat, bounded self-complementarity, and a check that the probe does not dimerize with either primer. Each assay reports the primer pair, the probe (sequence to order, position, orientation, Tm margin) and a transparent ranking penalty. Probe and primer Tm are the same SantaLucia-1998 nearest-neighbour estimates the other molbio tools use; they are design heuristics, not an efficiency prediction.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Template sequence to design the assay on (IUPAC).'),
      probe_len_min: { type: 'integer', description: 'Minimum probe length (default 18).' },
      probe_len_max: { type: 'integer', description: 'Maximum probe length (default 27, max 40).' },
      probe_tm_min: { type: 'number', description: 'Minimum probe Tm °C (default 58).' },
      probe_tm_max: { type: 'number', description: 'Maximum probe Tm °C (default 72).' },
      probe_gc_min: { type: 'number', description: 'Minimum probe GC% (default 40).' },
      probe_gc_max: { type: 'number', description: 'Maximum probe GC% (default 65).' },
      min_tm_delta: { type: 'number', description: 'Required probe Tm margin above the hotter primer, °C (default 5). When nothing clears it, the best available probe is reported with a note.' },
      probe_max_run: { type: 'integer', description: 'Maximum mononucleotide run allowed in the probe (2-8, default 4).' },
      probe_max_self_any: { type: 'number', description: 'Maximum Primer3-style self-complementarity score for the probe (default 8).' },
      probe_min_distance_from_primer: { type: 'integer', description: 'Bases the probe keeps clear of each primer binding site (0-12, default 1).' },
      allow_3prime_g: { type: 'boolean', description: 'Allow a 3\' terminal G in the probe (default false: such a probe can extend without cleavage).' },
      max_probes_per_amplicon: { type: 'integer', description: 'Probe candidates reported per amplicon (1-10, default 3).' },
      max_amplicons: { type: 'integer', description: 'Amplicons reported (1-50, default 5).' },
      primer_options: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional primer-engine overrides (amplicon_min/amplicon_max/tm_min/tm_max/gc_min/gc_max/region_start/region_end/na_mm/mg_mm/dntp_mm/primer_nm/...): the assay designer defaults to 70-200 bp amplicons, which is what a hydrolysis-probe assay needs.',
        properties: {
          amplicon_min: { type: 'integer' },
          amplicon_max: { type: 'integer' },
          tm_min: { type: 'number' },
          tm_max: { type: 'number' },
          gc_min: { type: 'number' },
          gc_max: { type: 'number' },
          region_start: { type: 'integer' },
          region_end: { type: 'integer' },
          na_mm: { type: 'number' },
          mg_mm: { type: 'number' },
          dntp_mm: { type: 'number' },
          primer_nm: { type: 'number' },
        },
      },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['assays', 'conditions', 'probe_options', 'notes'],
    properties: {
      conditions: CONDITIONS_SCHEMA,
      assays: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['forward', 'reverse', 'amplicon', 'probe', 'pair_penalty', 'assay_penalty'],
          properties: {
            forward: PRIMER_SCHEMA,
            reverse: PRIMER_SCHEMA,
            amplicon: {
              type: 'object',
              additionalProperties: false,
              required: ['start', 'end', 'length'],
              properties: { start: { type: 'integer' }, end: { type: 'integer' }, length: { type: 'integer' } },
            },
            probe: PROBE_SCHEMA,
            pair_penalty: { type: 'number', description: 'Penalty the primer engine gave this pair.' },
            assay_penalty: { type: 'number', description: 'Combined pair + probe penalty used to rank assays (lower is better).' },
          },
        },
      },
      probe_options: {
        type: 'object',
        additionalProperties: false,
        required: ['length', 'tm', 'gc', 'min_tm_delta_vs_primer'],
        properties: {
          length: { type: 'array', items: { type: 'integer' } },
          tm: { type: 'array', items: { type: 'number' } },
          gc: { type: 'array', items: { type: 'number' } },
          min_tm_delta_vs_primer: { type: 'number' },
        },
      },
      primer_options: {
        type: 'object',
        additionalProperties: false,
        required: ['region', 'amplicon', 'tm', 'gc'],
        description: 'The primer-engine windows this assay design actually used.',
        properties: {
          region: { type: 'array', items: { type: 'integer' } },
          amplicon: { type: 'array', items: { type: 'integer' } },
          tm: { type: 'array', items: { type: 'number' } },
          gc: { type: 'array', items: { type: 'number' } },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    if (value.assays.length === 0) {
      return ['no TaqMan assay satisfied the constraints.', ...value.notes, 'Relax the probe Tm/GC/length windows or the primer amplicon window and retry.'].join('\n');
    }
    const lines = [
      `Tm model conditions: ${value.conditions.na_mm} mM Na+ / ${value.conditions.mg_mm} mM Mg2+ / ${value.conditions.dntp_mm} mM dNTP / ${value.conditions.primer_nm} nM primer (SantaLucia 1998 NN — an estimate).`,
      `${value.assays.length} TaqMan assay candidate(s), best first:`,
    ];
    for (const [index, assay] of value.assays.entries()) {
      const probe = assay.probe;
      lines.push(`#${index + 1} amplicon ${assay.amplicon.start}-${assay.amplicon.end} (${assay.amplicon.length} bp), penalty ${assay.assay_penalty}`);
      lines.push(`  F ${assay.forward.sequence}  (${assay.forward.start}-${assay.forward.end}, Tm ${assay.forward.tm} °C, GC ${assay.forward.gc_percent}%)`);
      lines.push(`  R ${assay.reverse.sequence}  (${assay.reverse.start}-${assay.reverse.end}, Tm ${assay.reverse.tm} °C, GC ${assay.reverse.gc_percent}%)`);
      lines.push(`  P ${probe.sequence}  (${probe.start}-${probe.end}, ${probe.orientation}-oriented, ${probe.length} nt, Tm ${probe.tm} °C = ${probe.tm_delta_vs_primer >= 0 ? '+' : ''}${probe.tm_delta_vs_primer} °C vs the hotter primer, GC ${probe.gc_percent}%, ${probe.distance_from_primer_3prime} bp from the primer 3' end)`);
      if (probe.notes.length > 0) lines.push(`    probe flags: ${probe.notes.join('; ')}`);
    }
    for (const note of value.notes) lines.push(`note: ${note}`);
    lines.push('Label the probe 5\' with the reporter and 3\' with the quencher; Tm values are estimates, not an efficiency prediction.');
    return lines.join('\n');
  },
  execute(args) {
    const probeArgs = {
      probeLenMin: args.probe_len_min,
      probeLenMax: args.probe_len_max,
      probeTmMin: args.probe_tm_min,
      probeTmMax: args.probe_tm_max,
      probeGcMin: args.probe_gc_min,
      probeGcMax: args.probe_gc_max,
      minTmDelta: args.min_tm_delta,
      maxRun: args.probe_max_run,
      maxSelfAny: args.probe_max_self_any,
      minDistanceFromPrimer: args.probe_min_distance_from_primer,
      allowThreePrimeG: args.allow_3prime_g,
      maxProbesPerAmplicon: args.max_probes_per_amplicon,
      maxAmplicons: args.max_amplicons,
    };
    // Validate the probe windows and the nested primer windows before designing,
    // so a bad option is reported as itself rather than as "no assay found".
    resolveProbeOptions({ ...probeArgs, primer_options: args.primer_options ?? {} });
    return designTaqmanProbes(args.sequence, { ...probeArgs, primer_options: args.primer_options ?? {} });
  },
});

const MULTIPLEX_PRIMER_IN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'sequence'],
  properties: {
    name: { type: 'string', description: 'Target/amplicon name used in the report.' },
    sequence: { type: 'string', description: 'Template the pair was designed on (each target may have its own).' },
    forward: { type: 'string', description: 'Forward primer 5\'→3\'.' },
    reverse: { type: 'string', description: 'Reverse primer 5\'→3\'.' },
    forward_tm: { type: 'number', description: 'Known forward-primer Tm °C; recomputed from the sequence when omitted.' },
    reverse_tm: { type: 'number', description: 'Known reverse-primer Tm °C; recomputed from the sequence when omitted.' },
    amplicon_start: { type: 'integer', description: '1-based amplicon start on the template (used for the size-separation check).' },
    amplicon_end: { type: 'integer', description: '1-based amplicon end (used for the size-separation check).' },
  },
};

const multiplexTool = define({
  name: 'molbio_multiplex_check',
  description: 'Check whether several PCR primer pairs can be run together in one multiplex tube. It reports (1) every primer-primer interaction across the panel with the most stable (any) and 3\'-anchored duplex Tm, flagging the ones above the dimer threshold, (2) unintended annealing of each primer\'s 3\' tail — off-target sites in its own template and perfect matches in another target\'s template (the multiplex cross-reaction), and (3) amplicon sizes that are too close to resolve on a gel, plus concrete redesign advice. All Tms come from the same NN model as the primer designer and are risk estimates, not a prediction of the multiplex result.',
  parameters: {
    type: 'object',
    required: ['targets'],
    properties: {
      targets: { type: 'array', items: MULTIPLEX_PRIMER_IN_SCHEMA, description: 'One entry per amplicon: template sequence + the primer pair (and optional amplicon coordinates).' },
      dimer_tm_threshold: { type: 'number', description: 'Duplex Tm above which a primer-primer interaction is a conflict, °C (default 47, the Primer3 default).' },
      min_size_separation_bp: { type: 'integer', description: 'Amplicon size difference below which two bands are called indistinguishable (default 20).' },
      warn_size_separation_bp: { type: 'integer', description: 'Amplicon size difference below which two bands are called close (default 40).' },
      mispriming_3prime_bases: { type: 'integer', description: 'Length of the 3\' tail checked for unintended annealing (6-10, default 8).' },
      mispriming_max_mismatches: { type: 'integer', description: 'Mismatches tolerated for an own-template annealing site to count (0-2, default 1). Cross-template hits always require a perfect tail.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['compatible', 'target_count', 'template_count', 'primer_count', 'primers', 'interactions', 'conflicting_interactions', 'cross_target_conflicts', 'mispriming', 'cross_template_mispriming', 'amplicons', 'size_conflicts', 'advice', 'notes'],
    properties: {
      compatible: { type: 'boolean', description: 'False when any cross-target dimer, cross-template anneal or indistinguishable amplicon size was found.' },
      target_count: { type: 'integer' },
      template_count: { type: 'integer', description: 'Distinct template sequences (targets sharing a template are counted once).' },
      primer_count: { type: 'integer' },
      primers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'role', 'sequence', 'tm', 'gc_percent', 'hairpin_tm', 'self_any', 'self_end', 'runs'],
          properties: {
            target: { type: 'string' },
            role: { type: 'string', enum: ['forward', 'reverse'] },
            sequence: { type: 'string' },
            tm: { type: 'number' },
            gc_percent: { type: 'number' },
            hairpin_tm: { type: 'number' },
            self_any: { type: 'number' },
            self_end: { type: 'number' },
            runs: { type: 'integer' },
          },
        },
      },
      interactions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['a', 'b', 'cross_target', 'any_tm', 'end_tm', 'conflict'],
          properties: {
            a: { type: 'string', description: 'First primer, as "target/role".' },
            b: { type: 'string' },
            cross_target: { type: 'boolean' },
            any_tm: { type: 'number', description: 'Most stable duplex Tm between the two primers, °C.' },
            end_tm: { type: 'number', description: 'Most stable duplex Tm that involves a 3\' end, °C (the extension-relevant number).' },
            conflict: { type: 'boolean' },
          },
        },
      },
      conflicting_interactions: { type: 'integer' },
      cross_target_conflicts: { type: 'integer' },
      mispriming: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['primer', 'scope', 'target', 'count', 'perfect_count', 'sites'],
          properties: {
            primer: { type: 'string' },
            scope: { type: 'string', enum: ['own_template', 'other_templates'] },
            target: { type: 'string' },
            count: { type: 'integer' },
            perfect_count: { type: 'integer' },
            templates: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['template', 'positions', 'count'],
                properties: {
                  template: { type: 'integer', description: 'Index (1-based) into the distinct template list.' },
                  positions: { type: 'array', items: { type: 'integer' } },
                  count: { type: 'integer' },
                },
              },
            },
            sites: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['strand', 'position', 'matches'],
                properties: {
                  strand: { type: 'string', enum: ['top', 'bottom'] },
                  position: { type: 'integer' },
                  matches: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      cross_template_mispriming: { type: 'integer' },
      amplicons: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string' },
            start: { type: 'integer', description: '1-based amplicon start, when the caller supplied coordinates.' },
            end: { type: 'integer' },
            length: { type: 'integer', description: 'Amplicon length in bp, present only when coordinates were given.' },
          },
        },
      },
      size_conflicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['a', 'b', 'difference_bp', 'severity'],
          properties: {
            a: { type: 'string' },
            b: { type: 'string' },
            a_length: { type: 'integer' },
            b_length: { type: 'integer' },
            difference_bp: { type: 'integer' },
            severity: { type: 'string', enum: ['indistinguishable', 'close'] },
          },
        },
      },
      advice: { type: 'array', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    const lines = [
      `multiplex panel: ${value.target_count} target(s) on ${value.template_count} template(s), ${value.primer_count} primer(s) — ${value.compatible ? 'no blocking conflict found' : 'NOT compatible as designed'}`,
      `primer-primer interactions above the dimer threshold: ${value.conflicting_interactions} (${value.cross_target_conflicts} cross-target)`,
      `unintended annealing: ${value.mispriming.length} primer(s) affected, ${value.cross_template_mispriming} matching another target's template`,
      `amplicon size conflicts: ${value.size_conflicts.length}`,
    ];
    for (const conflict of value.size_conflicts) {
      lines.push(`  ${conflict.a} (${conflict.a_length ?? '?'} bp) vs ${conflict.b} (${conflict.b_length ?? '?'} bp): ${conflict.difference_bp} bp apart — ${conflict.severity}`);
    }
    for (const entry of value.mispriming.slice(0, 8)) {
      const where = entry.scope === 'other_templates'
        ? `templates ${entry.templates.map((template) => `${template.template} @ ${template.positions.join('/')}`).join('; ')}`
        : `${entry.sites.map((site) => `${site.position} (${site.strand})`).join(', ')}`;
      lines.push(`  ${entry.primer}: ${entry.count} unintended site(s) — ${where}`);
    }
    for (const conflict of value.interactions.filter((entry) => entry.conflict).slice(0, 8)) {
      lines.push(`  dimer ${conflict.a} x ${conflict.b}: any Tm ${conflict.any_tm} °C, 3' Tm ${conflict.end_tm} °C${conflict.cross_target ? ' (cross-target)' : ''}`);
    }
    for (const item of value.advice) lines.push(`advice: ${item}`);
    for (const note of value.notes) lines.push(`note: ${note}`);
    return lines.join('\n');
  },
  execute(args) {
    const options = {
      dimerTmThreshold: args.dimer_tm_threshold,
      minSizeSeparationBp: args.min_size_separation_bp,
      warnSizeSeparationBp: args.warn_size_separation_bp,
      mispriming3PrimeBases: args.mispriming_3prime_bases,
      misprimingMaxMismatches: args.mispriming_max_mismatches,
    };
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) delete options[key];
    }
    return checkMultiplex(args.targets, options);
  },
});

// ── v17: methylation-aware digests and double digests ───────────────────────

const METHYLATION_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['enzyme', 'site', 'sites', 'cut_positions', 'status', 'blocked_by', 'impaired_by'],
  properties: {
    enzyme: { type: 'string' },
    site: { type: 'string', description: 'Recognition site with the cut marked ((N/N) notation for type IIS).' },
    sites: { type: 'integer', description: 'Number of recognition events in this sequence (both strands).' },
    cut_positions: { type: 'array', items: { type: 'integer' }, description: '1-based top-strand cut positions.' },
    status: { type: 'string', enum: ['cuts', 'impaired', 'blocked', 'no_site'], description: 'cuts = usable; impaired = partial digest risk; blocked = will not cut this methylated template; no_site = no recognition site at all.' },
    blocked_by: { type: 'array', items: { type: 'string' }, description: 'Methylation marks that block this enzyme at one of its sites here.' },
    impaired_by: { type: 'array', items: { type: 'string' } },
    in_methylation_table: { type: 'boolean', description: 'True when the hand-transcribed methylation table carries this enzyme (false means "not known to be methylation-sensitive" rather than "insensitive").' },
  },
};

const methylationTool = define({
  name: 'molbio_methylation_check',
  description: 'Check whether Dam/Dcm methylation blocks a restriction digest, and pick enzymes that survive it. It finds every Dam (GATC) and Dcm (CCWGG, either strand) site in the sequence, reports which enzymes\' recognition sites those marks overlap, and classifies each enzyme as cuts / impaired / blocked / no_site — the classic "the enzyme is fine but the digest did not work" case is DNA prepared from a dam+/dcm+ E. coli host. Returns the usable enzyme list with cut positions and fragment sizes, the blocked and impaired ones, and advice. The methylation sensitivity table is a hand-transcribed quick reference (NEB/REBASE-style): verify against the supplier\'s current table before an experiment depends on it.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Template sequence (IUPAC).'),
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzymes to check; omit for the methylation-sensitive set the table covers, or pass ["common"] for the whole built-in enzyme table.' },
      marks: { type: 'array', items: { type: 'string', enum: ['dam', 'dcm'] }, description: 'Methylation marks to consider (default both).' },
      circular: { type: 'boolean', description: 'Treat the template as circular when computing fragment sizes (default false).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['length', 'circular', 'marks_checked', 'methylation_sites', 'sites_by_mark', 'enzymes_checked', 'blocked', 'impaired', 'usable', 'risky', 'recommended', 'per_enzyme', 'advice', 'notes'],
    properties: {
      length: { type: 'integer' },
      circular: { type: 'boolean' },
      marks_checked: { type: 'array', items: { type: 'string' } },
      methylation_sites: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['mark', 'site', 'start', 'sequence', 'strand', 'overlapping_enzymes'],
          properties: {
            mark: { type: 'string', enum: ['dam', 'dcm'] },
            site: { type: 'string', description: 'Recognition pattern of the mark (GATC / CCWGG).' },
            start: { type: 'integer', description: '1-based start of the methylated site on the top strand.' },
            sequence: { type: 'string', description: 'The actual bases at that site.' },
            strand: { type: 'string', enum: ['top', 'bottom'] },
            overlapping_enzymes: { type: 'array', items: { type: 'string' }, description: 'Methylation-sensitive enzymes whose own site overlaps this mark.' },
          },
        },
      },
      sites_by_mark: {
        type: 'object',
        additionalProperties: false,
        description: 'Site count per methylation mark actually checked (only the requested marks appear).',
        properties: {
          dam: { type: 'integer' },
          dcm: { type: 'integer' },
        },
      },
      enzymes_checked: { type: 'integer' },
      blocked: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['enzyme', 'by', 'sites'],
          properties: {
            enzyme: { type: 'string' },
            by: { type: 'array', items: { type: 'string' } },
            sites: { type: 'integer' },
          },
        },
      },
      impaired: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['enzyme', 'by', 'sites'],
          properties: {
            enzyme: { type: 'string' },
            by: { type: 'array', items: { type: 'string' } },
            sites: { type: 'integer' },
          },
        },
      },
      usable: { type: 'array', items: { type: 'string' }, description: 'Enzymes that cut this template and are not affected by its methylation.' },
      risky: { type: 'array', items: { type: 'string' }, description: 'Enzymes that cut the sequence but are blocked or impaired by its methylation.' },
      recommended: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['enzyme', 'cut_positions', 'fragments'],
          properties: {
            enzyme: { type: 'string' },
            cut_positions: { type: 'array', items: { type: 'integer' } },
            fragments: { type: 'array', items: { type: 'integer' }, description: 'Fragment sizes, largest first.' },
          },
        },
      },
      per_enzyme: { type: 'array', items: METHYLATION_STATUS_SCHEMA },
      advice: { type: 'array', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    const lines = [
      `${value.length} bp (${value.circular ? 'circular' : 'linear'}); methylation marks checked: ${value.marks_checked.join(', ')} — ${value.marks_checked.map((mark) => `${mark} ${value.sites_by_mark[mark] ?? 0}`).join(', ')} site(s)`,
      `${value.enzymes_checked} enzyme(s) checked: ${value.usable.length} usable, ${value.blocked.length} blocked, ${value.impaired.length} impaired`,
    ];
    if (value.blocked.length > 0) lines.push(`BLOCKED: ${value.blocked.map((entry) => `${entry.enzyme} (${entry.by.join('/')}, ${entry.sites} site(s))`).join(', ')}`);
    if (value.impaired.length > 0) lines.push(`impaired: ${value.impaired.map((entry) => `${entry.enzyme} (${entry.by.join('/')})`).join(', ')}`);
    if (value.usable.length > 0) {
      lines.push(`usable: ${value.usable.join(', ')}`);
      for (const entry of value.recommended.slice(0, 10)) {
        lines.push(`  ${entry.enzyme}: cut(s) ${entry.cut_positions.join(', ') || '—'} → fragments ${entry.fragments.join(', ')} bp`);
      }
    }
    for (const item of value.advice) lines.push(`advice: ${item}`);
    for (const note of value.notes) lines.push(`note: ${note}`);
    return lines.join('\n');
  },
  execute(args) {
    return analyzeMethylation(args.sequence, {
      enzymes: args.enzymes,
      marks: args.marks,
      circular: args.circular,
    });
  },
});

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'cut_positions', 'fragments'],
  properties: {
    name: { type: 'string' },
    cut_positions: { type: 'array', items: { type: 'integer' } },
    fragments: { type: 'array', items: { type: 'integer' } },
  },
};

const BUFFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'label', 'nacl_mm', 'legacy'],
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    nacl_mm: { type: 'number' },
    legacy: { type: 'boolean' },
  },
};

const doubleDigestTool = define({
  name: 'molbio_double_digest',
  description: 'Plan a double digest with two restriction enzymes: each enzyme\'s cut positions and fragments alone, the combined cut set and fragments (linear or circular), and whether the two enzymes share a reaction buffer in the reference table — when they do not, the answer is a sequential digest (cut, purify, cut) or a manufacturer\'s double-digest buffer. Use it instead of reasoning about two enzymes at once; buffer data is a hand-transcribed quick reference for the standard NEB series.',
  parameters: {
    type: 'object',
    required: ['sequence', 'first', 'second'],
    properties: {
      sequence: requiredString('Template sequence (IUPAC).'),
      first: requiredString('First enzyme name (from the built-in table).'),
      second: requiredString('Second enzyme name (must differ from the first).'),
      circular: { type: 'boolean', description: 'Circular template (default false).' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Extra enzyme names to include in the shared-buffer check (e.g. a third enzyme in the same tube).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['first', 'second', 'combined_cut_positions', 'combined_fragments', 'buffers', 'all_shared_buffers', 'sequential_required', 'advice', 'notes'],
    properties: {
      first: DIGEST_SCHEMA,
      second: DIGEST_SCHEMA,
      combined_cut_positions: { type: 'array', items: { type: 'integer' } },
      combined_fragments: { type: 'array', items: { type: 'integer' }, description: 'Fragment sizes of the double digest, largest first.' },
      buffers: { type: 'array', items: BUFFER_SCHEMA, description: 'Shared buffers to use (current colour-coded set preferred).' },
      all_shared_buffers: { type: 'array', items: BUFFER_SCHEMA, description: 'Every buffer the enzymes share, legacy ones included.' },
      sequential_required: { type: 'boolean' },
      advice: { type: 'array', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    const lines = [
      `${value.first.name}: cut(s) ${value.first.cut_positions.join(', ') || '—'} → ${value.first.fragments.join(', ')} bp`,
      `${value.second.name}: cut(s) ${value.second.cut_positions.join(', ') || '—'} → ${value.second.fragments.join(', ')} bp`,
      `double digest ${value.first.name} + ${value.second.name}: ${value.combined_cut_positions.length} cut(s) → ${value.combined_fragments.join(', ')} bp`,
      value.sequential_required
        ? 'no shared buffer in the reference table — sequential digest required'
        : `shared buffer(s): ${value.buffers.map((buffer) => buffer.label).join(', ')}`,
    ];
    for (const item of value.advice) lines.push(`advice: ${item}`);
    for (const note of value.notes) lines.push(`note: ${note}`);
    return lines.join('\n');
  },
  execute(args) {
    return planDoubleDigest(args.sequence, args.first, args.second, {
      circular: args.circular === true,
      enzymes: args.enzymes,
    });
  },
});

// ── GenBank parsing and plasmid maps ────────────────────────────────────────

const FEATURE_IN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'start', 'end'],
  properties: {
    label: { type: 'string' },
    type: { type: 'string', description: 'Feature type used for the color: CDS, gene, rep_origin, promoter, terminator, misc_feature, ...' },
    start: { type: 'integer', description: '1-based start position.' },
    end: { type: 'integer', description: '1-based end position (inclusive).' },
    strand: { type: 'integer', enum: [1, -1], description: '1 = forward, -1 = reverse complement (default 1).' },
  },
};

const parseGenbankTool = define({
  name: 'molbio_parse_genbank',
  description: 'Parse a GenBank flatfile record into structured data: locus name, accession, definition, topology (circular/linear), features (type, 1-based span, strand, label from /product or /gene), and the origin sequence. Feed the returned features to molbio_plasmid_map to draw the map.',
  parameters: {
    type: 'object',
    required: ['genbank'],
    properties: {
      genbank: requiredString('Complete GenBank record text (LOCUS ... //).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'length', 'features', 'sequence'],
    properties: {
      name: { type: 'string' },
      accession: { type: 'string' },
      definition: { type: 'string' },
      topology: { type: 'string', enum: ['circular', 'linear'] },
      length: { type: 'integer' },
      features: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'start', 'end', 'strand', 'label'],
          properties: {
            type: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            strand: { type: 'integer', enum: [1, -1] },
            label: { type: 'string' },
            gene: { type: 'string' },
            product: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
      sequence: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.name}${value.accession !== undefined ? ' (' + value.accession + ')' : ''}: ${value.length} bp${value.topology !== undefined ? ', ' + value.topology : ''}`,
      `${value.features.length} feature(s):`,
    ];
    for (const feature of value.features) {
      lines.push(`  ${feature.type} ${feature.start}-${feature.end} (${feature.strand === -1 ? 'complement' : 'forward'}): ${feature.label}`);
    }
    return lines.join('\n');
  },
  execute(args) {
    return parseGenBank(args.genbank);
  },
});

/** Safe default file name for a map. */
function svgFileName(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 60);
  return (cleaned === '' ? 'plasmid' : cleaned) + '.svg';
}

/**
 * Write an SVG image into the session workspace through the sandboxed fs
 * seam, then (unless auto_view is false) hand it to the OS default viewer so
 * the user sees it without opening the file manually. Returns the written
 * path, whether the auto-view hand-off succeeded, and — for a call that passed
 * `attach_image: true` — the rasterized attachment outcome for the result.
 */
async function writeSvgFile(ctx, exec, args, svg, defaultName) {
  const fs = fsService(ctx);
  const sandboxPolicyService = ctx.get('sandboxPolicy');
  const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
  const file = workspaceFilePath(args.output_path ?? svgFileName(defaultName), exec, policy?.workspaceRoot);
  await writeWorkspaceFile(fs, file, svg, policy);
  let viewed = false;
  if (args.auto_view !== false) {
    try {
      viewed = await openDefaultViewer(file);
    } catch {
      viewed = false;
    }
  }
  const stem = String(file).split(/[\\/]/).pop().replace(/\.[^.]*$/, '') || 'picture';
  return { file, viewed, attached: await withAttachedImage(ctx, exec, args, svg, stem) };
}

/** Auto-view one image written by a direct write path (clone/Golden Gate/qPCR/plot tools). */
async function autoViewWritten(args, file) {
  if (args.auto_view === false) return false;
  try {
    return await openDefaultViewer(file);
  } catch {
    return false;
  }
}

const plasmidMapTool = (ctx) => define({
  safe: false,
  name: 'molbio_plasmid_map',
  description: 'Render a plasmid map (circular by default, or linear) from a sequence plus features (from molbio_parse_genbank / molbio_parse_snapgene or hand-written) and WRITE it as a standalone SVG file in the session workspace. The tool writes the file itself — the SVG text never reaches the conversation, so do not try to re-render or copy it. After writing, the tool also opens the SVG automatically with the OS default application (auto_view, default true) so the user sees the picture without hunting for the file; pass auto_view: false to skip.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Full plasmid sequence (IUPAC).'),
      name: { type: 'string', description: 'Plasmid name shown in the map center (default "plasmid").' },
      circular: { type: 'boolean', description: 'Circular map (default true); false renders a linear track.' },
      features: { type: 'array', items: FEATURE_IN_SCHEMA, description: 'Features to draw with 1-based spans.' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction enzymes to mark (names from the built-in table).' },
      gc_skew: { type: 'boolean', description: 'Draw the GC skew ring (default false).' },
      show_unique_cutters: { type: 'boolean', description: 'Mark enzymes that cut this sequence exactly once (green labels, default false).' },
      output_path: { type: 'string', description: 'Optional SVG file path; default: <name>.svg in the session workspace.' },
      auto_view: { type: 'boolean', description: 'Open the SVG automatically with the OS default application after writing (default true; set false to skip).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['svg_path', 'name', 'length', 'circular', 'feature_count', 'enzyme_count'],
    properties: {
      svg_path: { type: 'string' },
      name: { type: 'string' },
      length: { type: 'integer' },
      circular: { type: 'boolean' },
      feature_count: { type: 'integer' },
      enzyme_count: { type: 'integer' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const enzymeNote = value.enzyme_count > 0
      ? `${value.enzyme_count} restriction enzyme cut site(s) marked.`
      : 'no restriction enzymes requested; pass `enzymes` to mark cut sites.';
    const viewNote = value.auto_viewed === true ? 'Opened automatically in your default viewer.' : 'Open the SVG file to view it.';
    return `SVG plasmid map saved to ${value.svg_path} (${value.name}, ${value.length} bp, ${value.circular ? 'circular' : 'linear'}, ${value.feature_count} feature(s)). ${enzymeNote} ${viewNote}${imageNote(value)}`;
  },
  // The map card in the transcript/panel reads this meta (see mapCardMeta).
  presentationMeta(_args, value) {
    return mapCardMeta(value, rememberedMapSvg(value.svg_path));
  },
  async execute(args, exec) {
    const sequence = normalizeSequence(args.sequence, 'plasmid sequence');
    const features = (args.features ?? []).map((feature) => {
      if (!Number.isInteger(feature.start) || !Number.isInteger(feature.end) || feature.start < 1 || feature.end > sequence.length || feature.start > feature.end) {
        throw new MolbioInputError(`feature ${JSON.stringify(feature.label)} has invalid span ${feature.start}-${feature.end} (sequence length ${sequence.length})`);
      }
      return {
        label: feature.label,
        type: feature.type,
        start: feature.start,
        end: feature.end,
        strand: feature.strand ?? 1,
      };
    });
    const enzymes = [];
    if (args.enzymes !== undefined) {
      const enzymeNames = args.enzymes.length === 1 && args.enzymes[0] === 'common' ? ENZYME_NAMES : args.enzymes;
      for (const result of digest(sequence, enzymeNames, args.circular !== false)) {
        enzymes.push({ name: result.name, cut_offsets: result.cut_positions });
      }
    }
    const circular = args.circular !== false;
    const marks = [];
    if (args.show_unique_cutters === true) {
      for (const entry of uniqueCutters(sequence, '', undefined, circular).ideal.slice(0, 20)) {
        marks.push({ label: entry.name, positions: [entry.cut_position - 1], color: '#1f883d' });
      }
    }
    const name = args.name ?? 'plasmid';
    const svg = renderPlasmidMap({
      name,
      length: sequence.length,
      circular,
      features,
      enzymes,
      marks,
      sequence,
      gc_skew: args.gc_skew === true,
    });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, args, svg, name);
    rememberMapSvg(file, svg);
    return mergeAttachedImage({
      svg_path: file,
      name,
      length: sequence.length,
      circular,
      feature_count: features.length,
      enzyme_count: enzymes.reduce((sum, enzyme) => sum + enzyme.cut_offsets.length, 0),
      auto_viewed: viewed,
    }, attached);
  },
});

// ── SnapGene .dna files ─────────────────────────────────────────────────────

const MAX_DNA_BYTES = 50 * 1024 * 1024;

function fsService(ctx) {
  const fs = ctx.get('fs');
  if (fs === undefined) throw new MolbioInputError('the filesystem service is not available in this composition; reading .dna/.gb files needs ctx.fs');
  return fs;
}

async function readFileBytes(ctx, exec, path) {
  const fs = fsService(ctx);
  const target = await fs.resolve(path);
  return await fs.readBytes(target, exec?.signal, MAX_DNA_BYTES);
}

const parseSnapgeneTool = (ctx) => define({
  name: 'molbio_parse_snapgene',
  description: 'Parse a SnapGene .dna file (binary) into structured data: map label, length, topology (circular/linear), annotated features (type, 1-based span, strand from SnapGene directionality, label), the full sequence, optional description/accession and any saved primers. Feed the returned features to molbio_plasmid_map to draw the map, or use molbio_plasmid_map_file to read a file and draw it in one call.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: requiredString('Path to the .dna file on disk.'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'length', 'topology', 'features', 'sequence'],
    properties: {
      name: { type: 'string' },
      length: { type: 'integer' },
      topology: { type: 'string', enum: ['circular', 'linear'] },
      description: { type: 'string' },
      accession: { type: 'string' },
      features: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'start', 'end', 'strand', 'label'],
          properties: {
            type: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            strand: { type: 'integer', enum: [1, -1] },
            label: { type: 'string' },
            gene: { type: 'string' },
            product: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
      sequence: { type: 'string' },
      primers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string' },
            location: { type: 'string' },
            bound_strand: { type: 'string' },
            sequence: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `${value.name}${value.accession !== undefined ? ' (' + value.accession + ')' : ''}: ${value.length} bp, ${value.topology}`,
      ...value.description !== undefined ? [value.description] : [],
      `${value.features.length} feature(s):`,
    ];
    for (const feature of value.features) {
      lines.push(`  ${feature.type} ${feature.start}-${feature.end} (${feature.strand === -1 ? 'reverse' : 'forward'}): ${feature.label}`);
    }
    if (value.primers !== undefined && value.primers.length > 0) {
      lines.push(`${value.primers.length} saved primer(s):`);
      for (const primer of value.primers) lines.push(`  ${primer.name}${primer.sequence !== undefined ? ': ' + primer.sequence : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const bytes = await readFileBytes(ctx, exec, args.path);
    return parseSnapGeneBytes(bytes);
  },
});

const plasmidMapFileTool = (ctx) => define({
  safe: false,
  name: 'molbio_plasmid_map_file',
  description: 'Read a plasmid file (.dna SnapGene, or .gb/.gbk GenBank) from disk and render its map, WRITING it as a standalone SVG file in the session workspace in one call. Features come from the file\'s annotations; optionally mark restriction enzyme cut sites. The tool writes the file itself — the SVG text never reaches the conversation, so do not try to re-render or copy it. After writing, the tool also opens the SVG automatically with the OS default application (auto_view, default true) so the user sees the picture without hunting for the file; pass auto_view: false to skip.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: requiredString('Path to the .dna / .gb / .gbk file on disk.'),
      name: { type: 'string', description: 'Override the map title (default: the file\'s own name).' },
      circular: { type: 'boolean', description: 'Override topology: true = circular map, false = linear (default: the file\'s topology).' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction enzymes to mark (names from the built-in table).' },
      gc_skew: { type: 'boolean', description: 'Draw the GC skew ring (default false).' },
      show_unique_cutters: { type: 'boolean', description: 'Mark enzymes that cut this plasmid exactly once (green labels, default false).' },
      output_path: { type: 'string', description: 'Optional SVG file path; default: <name>.svg in the session workspace.' },
      auto_view: { type: 'boolean', description: 'Open the SVG automatically with the OS default application after writing (default true; set false to skip).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['svg_path', 'name', 'length', 'circular', 'feature_count', 'enzyme_count'],
    properties: {
      svg_path: { type: 'string' },
      name: { type: 'string' },
      length: { type: 'integer' },
      circular: { type: 'boolean' },
      feature_count: { type: 'integer' },
      enzyme_count: { type: 'integer' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const viewNote = value.auto_viewed === true ? 'Opened automatically in your default viewer.' : 'Open the SVG file to view it.';
    return `SVG plasmid map saved to ${value.svg_path} (${value.name}, ${value.length} bp, ${value.circular ? 'circular' : 'linear'}, ${value.feature_count} feature(s), ${value.enzyme_count} enzyme cut mark(s)). ${viewNote}${imageNote(value)}`;
  },
  // The map card in the transcript/panel reads this meta (see mapCardMeta).
  presentationMeta(_args, value) {
    return mapCardMeta(value, rememberedMapSvg(value.svg_path));
  },
  async execute(args, exec) {
    const lower = args.path.toLowerCase();
    const isDna = lower.endsWith('.dna');
    const isGenbank = lower.endsWith('.gb') || lower.endsWith('.gbk') || lower.endsWith('.genbank');
    if (!isDna && !isGenbank) {
      throw new MolbioInputError('unsupported file type; expected a .dna (SnapGene) or .gb/.gbk (GenBank) file');
    }
    const bytes = await readFileBytes(ctx, exec, args.path);
    const parsed = isDna
      ? parseSnapGeneBytes(bytes)
      : parseGenBank(new TextDecoder().decode(bytes));
    if (parsed.sequence === '') throw new MolbioInputError('the file contains no sequence');
    const circular = args.circular ?? parsed.topology !== 'linear';
    const enzymes = [];
    if (args.enzymes !== undefined) {
      const enzymeNames = args.enzymes.length === 1 && args.enzymes[0] === 'common' ? ENZYME_NAMES : args.enzymes;
      for (const result of digest(parsed.sequence, enzymeNames, circular)) {
        enzymes.push({ name: result.name, cut_offsets: result.cut_positions });
      }
    }
    const name = args.name ?? parsed.name;
    const marks = [];
    if (args.show_unique_cutters === true) {
      for (const entry of uniqueCutters(parsed.sequence, '', undefined, circular).ideal.slice(0, 20)) {
        marks.push({ label: entry.name, positions: [entry.cut_position - 1], color: '#1f883d' });
      }
    }
    const svg = renderPlasmidMap({
      name,
      length: parsed.length,
      circular,
      features: parsed.features,
      enzymes,
      marks,
      sequence: parsed.sequence,
      gc_skew: args.gc_skew === true,
    });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, args, svg, name);
    rememberMapSvg(file, svg);
    return mergeAttachedImage({
      svg_path: file,
      name,
      length: parsed.length,
      circular,
      feature_count: parsed.features.length,
      enzyme_count: enzymes.reduce((sum, enzyme) => sum + enzyme.cut_offsets.length, 0),
      auto_viewed: viewed,
    }, attached);
  },
});

/**
 * Structured card data for a written plasmid map.
 *
 * `output.presentationMeta` is the documented path for a tool to hand the Web
 * Client structured data: the tool layer calls it for a ROOT call and records
 * the value, which reaches the browser as the tool-result block's `meta` — what
 * `tool.call.toolview` cards read (the shipped read card in `dsh-tool-fs` does
 * the same with `path`/`offset`/`lines`). It is a presentation projection, so it
 * must stay cheap and total: it never throws for a value the tool just produced.
 *
 * The SVG travels in the meta only when it fits `CARD_SVG_MAX_BYTES`; a plasmid
 * map of a real vector is 20-60 KB, but a huge construct could be megabytes and
 * that would land in the session log. When it does not fit, the card falls back
 * to reporting the written file path (one click away through `openFile`).
 */
const CARD_SVG_MAX_BYTES = 256 * 1024;

/**
 * Build the meta a map tool's card reads. `svg` is the markup the tool just
 * wrote, kept only when it is small enough to be worth carrying.
 */
function mapCardMeta(value, svg) {
  return {
    kind: 'molbio-map',
    name: value.name,
    svg_path: value.svg_path,
    length: value.length,
    circular: value.circular,
    feature_count: value.feature_count,
    enzyme_count: value.enzyme_count,
    svg_bytes: svg.length,
    ...svg.length <= CARD_SVG_MAX_BYTES ? { svg } : { svg_omitted: true },
  };
}

/**
 * Markup of the most recent maps, keyed by written path, so the card's
 * projection never has to read a file back. Bounded on both axes — a handful of
 * maps, each at most `CARD_SVG_MAX_BYTES` — because this is a module-level
 * cache in a long-lived host process, not a store.
 */
const recentMapSvg = new Map();

function rememberMapSvg(svgPath, svg) {
  if (recentMapSvg.has(svgPath)) recentMapSvg.delete(svgPath);
  recentMapSvg.set(svgPath, svg.length <= CARD_SVG_MAX_BYTES ? svg : '');
  while (recentMapSvg.size > 8) recentMapSvg.delete(recentMapSvg.keys().next().value);
}

/** The markup remembered for one written map ('' when it was too large or is gone). */
function rememberedMapSvg(svgPath) {
  return recentMapSvg.get(svgPath) ?? '';
}

// ── cross-intron primer design ──────────────────────────────────────────────

const INTRON_MISMATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'template_base', 'primer_base', 'spliced_position', 'genomic_position', 'distance_from_3prime'],
  properties: {
    position: { type: 'integer', description: '1-based position of the mismatch in the primer (5\'→3\').' },
    template_base: { type: 'string', description: 'The base a perfectly matching primer would carry at this position on the spliced transcript.' },
    primer_base: { type: 'string', description: 'The base the reported primer actually carries (primer_base !== template_base marks a real mismatch).' },
    spliced_position: { type: 'integer', description: '1-based position on the spliced transcript.' },
    genomic_position: { type: 'integer', description: '1-based position on the genomic sequence.' },
    distance_from_3prime: { type: 'integer', description: 'Number of bases between this mismatch and the primer 3\' end (0 = terminal base).' },
  },
};

const INTRON_MISPRIMING_SITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'genomic_position', 'strand', 'matches'],
  properties: {
    position: { type: 'integer', description: '1-based position on the spliced transcript where the 3\' tail can anneal.' },
    genomic_position: { type: 'integer', description: '1-based position on the genomic sequence.' },
    strand: { type: 'string', enum: ['top', 'bottom'], description: 'The transcript strand the primer would bind at this site.' },
    matches: { type: 'integer', description: 'Complementary bases between the 3\' tail and this site.' },
  },
};

const INTRON_PRIMER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'length', 'tm', 'gc_percent', 'spliced_start', 'spliced_end', 'genomic_start', 'genomic_end'],
  properties: {
    sequence: { type: 'string' },
    length: { type: 'integer' },
    tm: { type: 'number' },
    gc_percent: { type: 'number' },
    self_any: { type: 'number', description: 'Primer3-style self-complementarity alignment score (v12).' },
    self_end: { type: 'number', description: 'Primer3-style 3\'-anchored self-complementarity score (v12).' },
    hairpin_tm: { type: 'number', description: 'Melting temperature of the most stable hairpin (°C, 0 = none; v12).' },
    end_stability_kcal: { type: 'number', description: 'ΔG(37 °C) of the last five 3\' bases in kcal/mol (v12).' },
    end_gc_count: { type: 'integer', description: 'G/C bases among the last five 3\' bases (v12).' },
    spliced_start: { type: 'integer' },
    spliced_end: { type: 'integer' },
    genomic_start: { type: 'integer' },
    genomic_end: { type: 'integer' },
    exons: { type: 'array', items: { type: 'string' } },
    exon: { type: 'integer' },
    junction_left: { type: 'integer' },
    junction_right: { type: 'integer' },
    mismatch_count: { type: 'integer', description: 'Number of primer-template mismatches this primer carries (0 = exact match; v12).' },
    mismatches: { type: 'array', items: INTRON_MISMATCH_SCHEMA },
    mispriming_count: { type: 'integer', description: 'Extra transcript sites where the 3\' tail can anneal (v12 mispriming check).' },
    mispriming_sites: { type: 'array', items: INTRON_MISPRIMING_SITE_SCHEMA },
    target_distance: { type: 'integer', description: 'v13: spliced bp between the primer 3\' end and target_position (present only when target_position is given).' },
  },
};

const intronPrimersTool = (ctx) => define({
  name: 'molbio_design_intron_primers',
  description: 'Design qPCR primer pairs where the forward primer spans an exon-exon junction (>= min_junction_bases on each side) so genomic DNA cannot be amplified, and the reverse primer sits in a different exon. Provide the genomic sequence and the exon spans (1-based, inclusive). min_genomic_span enforces a minimal genomic distance between the primers (making gDNA amplification impossible or easily detectable). Coordinates come back both on the spliced transcript and on the genomic sequence. v12: Primer3-style structural filters (self-complementarity alignment scores, hairpin/dimer folding Tm at 47 °C defaults, end stability/end GC, GC clamp levels); pass max_mismatches > 0 to allow mismatched primers (never on the 3\'-terminal base) with spliced+genomic mismatch reports; pass check_mispriming: true to reject/penalize non-specific 3\'-tail annealing on the transcript.',
  parameters: {
    type: 'object',
    required: ['exons'],
    properties: {
      genomic: { type: 'string', description: 'Genomic sequence containing the exons (alternative to genomic_path).' },
      genomic_path: { type: 'string', description: 'Path to a .fa/.fasta/.txt genomic sequence file (alternative to genomic).' },
      exons: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end'],
          properties: {
            start: { type: 'integer', description: '1-based exon start on the genomic sequence.' },
            end: { type: 'integer', description: '1-based inclusive exon end.' },
          },
        },
        description: 'Exon spans, in genomic order.',
      },
      amplicon_min: { type: 'integer', description: 'Minimum spliced amplicon length (default 80).' },
      amplicon_max: { type: 'integer', description: 'Maximum spliced amplicon length (default 200).' },
      primer_len_min: { type: 'integer', description: 'Minimum primer length (default 18).' },
      primer_len_max: { type: 'integer', description: 'Maximum primer length (default 28).' },
      tm_min: { type: 'number', description: 'Minimum primer Tm (default 55).' },
      tm_max: { type: 'number', description: 'Maximum primer Tm (default 65).' },
      gc_min: { type: 'number', description: 'Minimum primer GC% (default 40).' },
      gc_max: { type: 'number', description: 'Maximum primer GC% (default 60).' },
      min_junction_bases: { type: 'integer', description: 'Bases required on each side of the junction (default 6).' },
      min_genomic_span: { type: 'integer', description: 'Minimum genomic distance between the primers (default 0).' },
      gc_clamp: { type: 'integer', description: 'Consecutive G/C bases required at the primer 3\' end (0-3, default 1). Replaces require_gc_clamp.' },
      require_gc_clamp: { type: 'boolean', description: 'Deprecated alias for gc_clamp: true = 1, false = 0. gc_clamp wins when both are given.' },
      max_run: { type: 'integer', description: 'Maximum allowed run of identical bases (default 3).' },
      max_self_any: { type: 'number', description: 'Maximum self-complementarity alignment score (match +1/mismatch -1/gap -0.25; default 8, the Primer3 default).' },
      max_self_end: { type: 'number', description: 'Maximum 3\'-anchored self-complementarity score (default 3, the Primer3 default).' },
      max_hairpin_tm: { type: 'number', description: 'Maximum hairpin folding Tm in °C (default 47, the Primer3 default).' },
      max_dimer_tm: { type: 'number', description: 'Maximum primer-dimer duplex Tm in °C (default 47, the Primer3 default).' },
      max_dimer_end_tm: { type: 'number', description: 'Maximum dimer Tm when a 3\' end participates in °C (default 47, the Primer3 default).' },
      max_end_stability: { type: 'number', description: 'Maximum |ΔG(37 °C)| of the last five 3\' bases in kcal/mol (default 9.0, the Primer3 default).' },
      max_end_gc: { type: 'integer', description: 'Maximum G/C bases allowed in the last five 3\' bases (default 5, the Primer3 default).' },
      max_tm_delta: { type: 'number', description: 'Maximum |Tm(forward) - Tm(reverse)| in °C (default 3).' },
      max_mismatches: { type: 'integer', description: 'Maximum primer-template mismatches the designer may introduce (0-5, default 0 = exact match required). Never placed on the 3\'-terminal base.' },
      max_3prime_mismatches: { type: 'integer', description: 'Maximum mismatches tolerated inside the 3\'-terminal critical zone (mismatch_3prime_zone bases before the terminal base); default 0 (none).' },
      mismatch_3prime_zone: { type: 'integer', description: 'Length of the 3\'-terminal critical zone in bases (1-10, default 5); mismatches inside it require max_3prime_mismatches > 0.' },
      check_mispriming: { type: 'boolean', description: 'Check that the 3\' tail of each primer has no extra annealing sites on the spliced transcript (either strand); default false. Extra sites are reported and penalized, and pairs beyond mispriming_max_sites are rejected.' },
      mispriming_3prime_bases: { type: 'integer', description: 'Length of the 3\' tail checked for non-specific annealing (6-10, default 8).' },
      mispriming_max_mismatches: { type: 'integer', description: 'Mismatches tolerated between the 3\' tail and a site for it to count as annealing (0-2, default 1); the terminal base must always pair.' },
      mispriming_max_sites: { type: 'integer', description: 'Maximum extra annealing sites allowed per primer (0-20, default 1); pairs with more are rejected.' },
      max_results: { type: 'integer', description: 'Maximum pairs to return (default 5).' },
      na_mm: { type: 'number', description: 'v13: monovalent cation concentration in mM for the Tm model (default 50; von Ahsen 2001 magnesium equivalence).' },
      mg_mm: { type: 'number', description: 'v13: Mg2+ concentration in mM (default 1.5).' },
      dntp_mm: { type: 'number', description: 'v13: dNTP concentration in mM (default 0.8).' },
      primer_nm: { type: 'number', description: 'v13: primer concentration in nM (default 200).' },
      target_position: { type: 'integer', description: 'v13: 1-based position on the SPLICED transcript the primer 3\' ends should land near; pairs are ranked by the distance of the nearer 3\' end.' },
      target_penalty: { type: 'number', description: 'v13: ranking penalty per bp of 3\'-end-to-target distance (default 0.5).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['spliced_length', 'genomic_length', 'exons', 'pairs', 'conditions'],
    properties: {
      conditions: {
        type: 'object',
        additionalProperties: false,
        required: ['na_mm', 'mg_mm', 'dntp_mm', 'primer_nm'],
        properties: {
          na_mm: { type: 'number', description: 'Monovalent cations used by the Tm model, mM.' },
          mg_mm: { type: 'number', description: 'Mg2+ used by the Tm model, mM.' },
          dntp_mm: { type: 'number', description: 'dNTP used by the Tm model, mM.' },
          primer_nm: { type: 'number', description: 'Primer concentration used by the Tm model, nM.' },
        },
      },
      spliced_length: { type: 'integer' },
      genomic_length: { type: 'integer' },
      exons: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end'],
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
          },
        },
      },
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['forward', 'reverse', 'spliced_amplicon', 'genomic_amplicon_length', 'penalty'],
          properties: {
            forward: INTRON_PRIMER_SCHEMA,
            reverse: INTRON_PRIMER_SCHEMA,
            spliced_amplicon: {
              type: 'object',
              additionalProperties: false,
              required: ['start', 'end', 'length'],
              properties: {
                start: { type: 'integer' },
                end: { type: 'integer' },
                length: { type: 'integer' },
              },
            },
            genomic_amplicon_length: { type: 'integer' },
            target_distance: { type: 'integer', description: 'v13: bp between the nearer primer 3\' end and target_position (spliced coordinates; present only when target_position is given).' },
            penalty: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    if (value.pairs.length === 0) {
      return 'no primer pair satisfied the constraints — relax Tm/GC/amplicon windows or reduce min_junction_bases/min_genomic_span and retry.';
    }
    const lines = [
      `Tm model conditions: ${value.conditions.na_mm} mM Na+ / ${value.conditions.mg_mm} mM Mg2+ / ${value.conditions.dntp_mm} mM dNTP / ${value.conditions.primer_nm} nM primer (SantaLucia 1998 NN — an estimate).`,
      `${value.pairs.length} candidate pair(s); the forward primer spans an exon-exon junction (genomic DNA will not amplify):`,
    ];
    const mismatchLine = (label, primer) => {
      if (primer.mismatch_count > 0) {
        const details = primer.mismatches
          .map((m) => `5'-pos ${m.position} ${m.template_base}→${m.primer_base} (spliced bp ${m.spliced_position}, genomic bp ${m.genomic_position}, ${m.distance_from_3prime} bp from 3')`)
          .join('; ');
        lines.push(`  ${label} carries ${primer.mismatch_count} mismatch(es) vs transcript: ${details}`);
      }
    };
    const misprimingLine = (label, primer) => {
      if (primer.mispriming_count > 0) {
        const details = primer.mispriming_sites
          .map((s) => `spliced bp ${s.position} / genomic bp ${s.genomic_position} (${s.strand} strand, ${s.matches} matches)`)
          .join('; ');
        lines.push(`  ${label} 3' tail anneals at ${primer.mispriming_count} extra site(s): ${details}`);
      }
    };
    for (const [index, pair] of value.pairs.entries()) {
      lines.push(`#${index + 1} spliced amplicon ${pair.spliced_amplicon.start}-${pair.spliced_amplicon.end} (${pair.spliced_amplicon.length} bp), genomic span ${pair.genomic_amplicon_length} bp${pair.target_distance !== undefined ? `, nearer 3' end ${pair.target_distance} spliced bp from target_position` : ''}, penalty ${pair.penalty}`);
      lines.push(`  F ${pair.forward.sequence}  (spliced ${pair.forward.spliced_start}-${pair.forward.spliced_end}; genomic ${pair.forward.genomic_start}-${pair.forward.genomic_end}; exons ${pair.forward.exons.join('/')}, junction ${pair.forward.junction_left}+${pair.forward.junction_right} bp; Tm ${pair.forward.tm} °C, self ${pair.forward.self_any}/${pair.forward.self_end}, hairpin ${pair.forward.hairpin_tm} °C)`);
      lines.push(`  R ${pair.reverse.sequence}  (spliced ${pair.reverse.spliced_start}-${pair.reverse.spliced_end}; genomic ${pair.reverse.genomic_start}-${pair.reverse.genomic_end}; exon ${pair.reverse.exon}; Tm ${pair.reverse.tm} °C, self ${pair.reverse.self_any}/${pair.reverse.self_end}, hairpin ${pair.reverse.hairpin_tm} °C)`);
      mismatchLine('F', pair.forward);
      mismatchLine('R', pair.reverse);
      misprimingLine('F', pair.forward);
      misprimingLine('R', pair.reverse);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    let genomic;
    if (args.genomic !== undefined && args.genomic !== '') {
      genomic = normalizeSequence(args.genomic, 'genomic');
    } else if (args.genomic_path !== undefined && args.genomic_path !== '') {
      const bytes = await readFileBytes(ctx, exec, args.genomic_path);
      const text = new TextDecoder().decode(bytes);
      genomic = normalizeSequence(text.replace(/^>.*$/gm, ''), 'genomic');
    } else {
      throw new MolbioInputError('provide either `genomic` (a sequence) or `genomic_path` (a .fa/.fasta/.txt file)');
    }
    const exons = args.exons.map((exon) => ({ start: exon.start, end: exon.end }));
    const { pairs, opts } = designIntronPrimers(genomic, exons, {
      ampliconMin: args.amplicon_min,
      ampliconMax: args.amplicon_max,
      lenMin: args.primer_len_min,
      lenMax: args.primer_len_max,
      tmMin: args.tm_min,
      tmMax: args.tm_max,
      gcMin: args.gc_min,
      gcMax: args.gc_max,
      minJunctionBases: args.min_junction_bases,
      minGenomicSpan: args.min_genomic_span,
      gcClamp: args.gc_clamp ?? (args.require_gc_clamp === true ? 1 : args.require_gc_clamp === false ? 0 : undefined),
      maxRun: args.max_run,
      maxSelfAny: args.max_self_any,
      maxSelfEnd: args.max_self_end,
      maxHairpinTm: args.max_hairpin_tm,
      maxDimerTm: args.max_dimer_tm,
      maxDimerEndTm: args.max_dimer_end_tm,
      maxEndStability: args.max_end_stability,
      maxEndGc: args.max_end_gc,
      maxTmDelta: args.max_tm_delta,
      maxMismatches: args.max_mismatches,
      max3PrimeMismatches: args.max_3prime_mismatches,
      mismatch3PrimeZone: args.mismatch_3prime_zone,
      checkMispriming: args.check_mispriming,
      mispriming3PrimeBases: args.mispriming_3prime_bases,
      misprimingMaxMismatches: args.mispriming_max_mismatches,
      misprimingMaxSites: args.mispriming_max_sites,
      maxResults: args.max_results,
      naMm: args.na_mm,
      mgMm: args.mg_mm,
      dntpMm: args.dntp_mm,
      primerNm: args.primer_nm,
      targetPosition: args.target_position,
      targetPenalty: args.target_penalty,
    });
    return {
      spliced_length: exons.reduce((sum, exon) => sum + (exon.end - exon.start + 1), 0),
      genomic_length: genomic.length,
      exons,
      pairs,
      conditions: {
        na_mm: opts.naMm,
        mg_mm: opts.mgMm,
        dntp_mm: opts.dntpMm,
        primer_nm: opts.primerNm,
      },
    };
  },
});

// ── cloning (batch 1) ───────────────────────────────────────────────────────

const CLONE_FEATURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'start', 'end', 'strand', 'label'],
  properties: {
    type: { type: 'string' },
    start: { type: 'integer' },
    end: { type: 'integer' },
    strand: { type: 'integer', enum: [1, -1] },
    label: { type: 'string' },
    gene: { type: 'string' },
    product: { type: 'string' },
    note: { type: 'string' },
    spans_insertion: { type: 'boolean' },
  },
};

/** Resolve a vector from either a raw sequence or a .dna/.gb file. */
async function resolveVector(ctx, exec, args, pathKey = 'vector_path') {
  if (args.vector !== undefined && args.vector !== null && args.vector !== '') {
    const sequence = normalizeSequence(args.vector, 'vector');
    return { sequence, features: [], name: 'vector', circular: true };
  }
  const path = args[pathKey];
  if (path === undefined || path === '') throw new MolbioInputError('provide either `vector` (a sequence) or `vector_path` (a .dna/.gb file)');
  const bytes = await readFileBytes(ctx, exec, path);
  const lower = path.toLowerCase();
  if (lower.endsWith('.dna')) {
    const parsed = parseSnapGeneBytes(bytes);
    return { sequence: parsed.sequence, features: parsed.features, name: parsed.name, circular: parsed.topology !== 'linear' };
  }
  if (lower.endsWith('.gb') || lower.endsWith('.gbk') || lower.endsWith('.genbank')) {
    const parsed = parseGenBank(new TextDecoder().decode(bytes));
    return { sequence: parsed.sequence, features: parsed.features, name: parsed.name, circular: parsed.topology !== 'linear' };
  }
  if (lower.endsWith('.fa') || lower.endsWith('.fasta') || lower.endsWith('.txt')) {
    const text = new TextDecoder().decode(bytes);
    const sequence = normalizeSequence(text.replace(/^>.*$/gm, ''), 'reference');
    return { sequence, features: [], name: 'reference', circular: true };
  }
  throw new MolbioInputError('unsupported vector file type; expected .dna / .gb / .gbk / .fa');
}

const uniqueCuttersTool = (ctx) => define({
  name: 'molbio_unique_cutters',
  description: 'Pick restriction enzymes for cloning: list enzymes that cut the vector exactly once (optionally inside a region such as the MCS) and NEVER cut the insert, plus enzymes that cut a vector region twice (fragment excision). Give the vector as a sequence or a .dna/.gb file path.',
  parameters: {
    type: 'object',
    properties: {
      vector: { type: 'string', description: 'Vector sequence (alternative to vector_path).' },
      vector_path: { type: 'string', description: 'Path to a .dna/.gb vector file (alternative to vector).' },
      insert: { type: 'string', description: 'Insert sequence; enzymes cutting it are excluded.' },
      region_start: { type: 'integer', description: '1-based start of the region (e.g. MCS) to prefer cuts in.' },
      region_end: { type: 'integer', description: '1-based end of the region.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['vector_length', 'insert_length', 'circular', 'ideal', 'region_double', 'insert_cutters', 'multi_cutters'],
    properties: {
      vector_length: { type: 'integer' },
      insert_length: { type: 'integer' },
      circular: { type: 'boolean' },
      ideal: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'site', 'cut_position', 'in_region'],
          properties: {
            name: { type: 'string' },
            site: { type: 'string' },
            cut_position: { type: 'integer' },
            in_region: { type: 'boolean' },
          },
        },
      },
      region_double: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'site', 'cut_positions', 'excised_fragment', 'backbone_fragment'],
          properties: {
            name: { type: 'string' },
            site: { type: 'string' },
            cut_positions: { type: 'array', items: { type: 'integer' } },
            excised_fragment: { type: 'integer' },
            backbone_fragment: { type: 'integer' },
          },
        },
      },
      insert_cutters: { type: 'array', items: { type: 'string' } },
      multi_cutters: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    const inRegion = value.ideal.filter((entry) => entry.in_region);
    const outside = value.ideal.filter((entry) => !entry.in_region);
    const lines = [`vector ${value.vector_length} bp (${value.circular ? 'circular' : 'linear'}), insert ${value.insert_length} bp.`];
    lines.push(`ideal single cutters (cut vector once, never cut insert): ${value.ideal.length}`);
    for (const entry of [...inRegion, ...outside]) lines.push(`  ${entry.name} (${entry.site}) at ${entry.cut_position}${entry.in_region ? ' [in region]' : ''}`);
    if (value.region_double.length > 0) {
      lines.push('region double cutters (excise a fragment from the region):');
      for (const entry of value.region_double) lines.push(`  ${entry.name} at ${entry.cut_positions.join('/')}: fragment ${entry.excised_fragment} bp, backbone ${entry.backbone_fragment} bp`);
    }
    if (value.insert_cutters.length > 0) lines.push(`${value.insert_cutters.length} enzyme(s) also cut the insert and were excluded: ${value.insert_cutters.join(', ')}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const vector = await resolveVector(ctx, exec, args);
    const insert = args.insert !== undefined && args.insert !== '' ? normalizeSequence(args.insert, 'insert') : '';
    const region = args.region_start !== undefined && args.region_end !== undefined
      ? { start: args.region_start, end: args.region_end }
      : undefined;
    const result = uniqueCutters(vector.sequence, insert, region, vector.circular);
    return {
      vector_length: vector.sequence.length,
      insert_length: insert.length,
      circular: vector.circular,
      ideal: result.ideal,
      region_double: result.region_double,
      insert_cutters: result.summary.insert_cutters,
      multi_cutters: result.summary.multi_cutters,
    };
  },
});

const cloneSimulateTool = (ctx) => define({
  safe: (args) => args.save_path === undefined && args.map_path === undefined,
  name: 'molbio_clone_simulate',
  description: 'Simulate a cloning reaction in silico and return the final plasmid sequence with its remapped features. method=restriction: the tool itself checks that each enzyme cuts the vector exactly once (do not pre-verify by thinking), digests the insert with the same enzymes, ligates, remaps feature coordinates, and predicts verification digests; add_flanks: true lets the tool add the enzyme sites to a bare insert; orientation=auto (default) reverse-complements an inverted insert automatically. method=gibson: replace the vector region (region_start..region_end) with the insert and report the insert-to-order with homology arms. Save the final plasmid with save_path (FASTA) and/or draw the new plasmid map directly with map_path (SVG), which then opens automatically with the OS default application (auto_view default true; set auto_view: false to skip).',
  parameters: {
    type: 'object',
    required: ['insert'],
    properties: {
      vector: { type: 'string', description: 'Vector sequence (alternative to vector_path).' },
      vector_path: { type: 'string', description: 'Path to a .dna/.gb vector file (alternative to vector).' },
      insert: requiredString('Insert sequence (with enzyme sites on the flanks for restriction mode).'),
      method: { type: 'string', enum: ['restriction', 'gibson'], description: 'Cloning method; default "restriction".' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction enzymes (1 or 2); required for method=restriction. The tool itself checks that each enzyme cuts the vector exactly once — no need to pre-verify.' },
      add_flanks: { type: 'boolean', description: 'Restriction mode: pass the BARE insert and let the tool add the enzyme recognition sites to its flanks (upstream enzyme 5\', downstream enzyme 3\'). Default false.' },
      orientation: { type: 'string', enum: ['auto', 'forward', 'reverse'], description: 'Insert orientation for restriction mode: auto (default) reverse-complements the insert if its enzyme sites are in the opposite order to the vector; forward forces the insert as written; reverse forces the reverse complement.' },
      region_start: { type: 'integer', description: '1-based start of the vector region being replaced; required for method=gibson.' },
      region_end: { type: 'integer', description: '1-based end of the replaced region; required for method=gibson.' },
      overhang: { type: 'integer', description: 'Gibson homology arm length in bp (default 20).' },
      verify_enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzymes for the verification digest (default: automatically chosen diagnostic enzymes).' },
      save_path: { type: 'string', description: 'Optional path to save the final plasmid as FASTA in the workspace.' },
      map_path: { type: 'string', description: 'Optional path to also draw the new plasmid map (SVG) with the remapped features and the top verification enzymes marked.' },
      auto_view: { type: 'boolean', description: 'Open the generated map SVG automatically with the OS default application (default true; set false to skip).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'final_sequence', 'length', 'delta', 'junctions', 'features', 'dropped_features', 'verify', 'notes'],
    properties: {
      method: { type: 'string', enum: ['restriction', 'gibson'] },
      final_sequence: { type: 'string' },
      length: { type: 'integer' },
      delta: { type: 'integer' },
      insert_to_order: { type: 'string' },
      junctions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['position', 'sequence'],
          properties: {
            position: { type: 'integer' },
            sequence: { type: 'string' },
          },
        },
      },
      features: { type: 'array', items: CLONE_FEATURE_SCHEMA },
      dropped_features: { type: 'array', items: CLONE_FEATURE_SCHEMA },
      verify: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'final_fragments', 'vector_fragments'],
          properties: {
            name: { type: 'string' },
            final_fragments: { type: 'array', items: { type: 'integer' } },
            vector_fragments: { type: 'array', items: { type: 'integer' } },
            reverse_orientation_fragments: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
      save_path: { type: 'string' },
      map_path: { type: 'string' },
      auto_viewed: { type: 'boolean' },
      insert_reverse_complemented: { type: 'boolean' },
      insert_with_flanks: { type: 'string' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.method} clone simulated: final plasmid ${value.length} bp (Δ ${value.delta > 0 ? '+' : ''}${value.delta} bp).`,
      `${value.features.length} feature(s) after coordinate remapping; ${value.dropped_features.length} dropped inside the replaced region.`,
    ];
    if (value.insert_reverse_complemented === true) lines.push('the insert was reverse-complemented to match the vector orientation.');
    if (value.insert_with_flanks !== undefined) lines.push(`insert with enzyme flanks added by the tool: ${value.insert_with_flanks}`);
    if (value.insert_to_order !== undefined) lines.push(`insert to order (with homology arms, ${value.insert_to_order.length} bp): ${value.insert_to_order}`);
    for (const junction of value.junctions) lines.push(`junction @${junction.position}: …${junction.sequence}…`);
    lines.push('verification digests (final vs original vector):');
    for (const entry of value.verify.slice(0, 5)) {
      lines.push(`  ${entry.name}: final ${entry.final_fragments.join('+')} bp vs vector ${entry.vector_fragments.join('+')} bp${entry.reverse_orientation_fragments !== undefined ? `; reverse orientation ${entry.reverse_orientation_fragments.join('+')} bp` : ''}`);
    }
    for (const note of value.notes) lines.push(`note: ${note}`);
    if (value.save_path !== undefined) lines.push(`final plasmid saved to ${value.save_path}`);
    if (value.map_path !== undefined) lines.push(`plasmid map SVG written to ${value.map_path}${value.auto_viewed === true ? ' and opened automatically in your default viewer' : ''}`);
    lines.push('The remapped `features` and `final_sequence` in the output value are ready for molbio_plasmid_map — do not recompute coordinates by hand.');
    if (imageNote(value) !== '') lines.push(imageNote(value).trim());
    return lines.join('\n');
  },
  async execute(args, exec) {
    const vector = await resolveVector(ctx, exec, args);
    const insert = normalizeSequence(args.insert, 'insert');
    const method = args.method ?? 'restriction';
    if (method === 'restriction') {
      if (!Array.isArray(args.enzymes) || args.enzymes.length < 1 || args.enzymes.length > 2) {
        throw new MolbioInputError('method=restriction needs 1 or 2 enzymes');
      }
    } else if (method === 'gibson') {
      if (args.region_start === undefined || args.region_end === undefined) {
        throw new MolbioInputError('method=gibson needs region_start and region_end (the vector region being replaced)');
      }
    } else {
      throw new MolbioInputError('method must be "restriction" or "gibson"');
    }
    const result = simulateClone({
      vectorSeq: vector.sequence,
      vectorFeatures: vector.features,
      insert,
      method,
      enzymes: args.enzymes,
      orientation: args.orientation ?? 'auto',
      addFlanks: args.add_flanks === true,
      region: args.region_start !== undefined ? { start: args.region_start, end: args.region_end } : undefined,
      overhang: args.overhang ?? 20,
      circular: vector.circular,
      verifyEnzymes: args.verify_enzymes,
    });
    const out = {
      method: result.method,
      final_sequence: result.final_sequence,
      length: result.final_sequence.length,
      delta: result.delta,
      ...result.insert_to_order !== undefined ? { insert_to_order: result.insert_to_order } : {},
      ...result.insert_with_flanks !== undefined ? { insert_with_flanks: result.insert_with_flanks } : {},
      junctions: result.junctions,
      features: result.features,
      dropped_features: result.dropped_features,
      verify: result.verify,
      notes: result.notes,
      ...result.insert_reverse_complemented !== undefined ? { insert_reverse_complemented: result.insert_reverse_complemented } : {},
    };
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    if (args.save_path !== undefined && args.save_path !== '') {
      const file = workspaceFilePath(args.save_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, `>${vector.name}_clone ${method}\n${result.final_sequence}\n`, policy);
      out.save_path = file;
    }
    if (args.map_path !== undefined && args.map_path !== '') {
      const marks = result.verify.slice(0, 3).map((entry) => ({
        name: entry.name,
        cut_offsets: digest(result.final_sequence, [entry.name], vector.circular)[0].cut_positions,
      }));
      const svg = renderPlasmidMap({
        name: `${vector.name}_clone`,
        length: result.final_sequence.length,
        circular: vector.circular,
        features: result.features,
        enzymes: marks,
      });
      const file = workspaceFilePath(args.map_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, svg, policy);
      out.map_path = file;
      out.auto_viewed = await autoViewWritten(args, file);
      Object.assign(out, await withAttachedImage(ctx, exec, args, svg, `${vector.name}_clone`) ?? {});
    }
    return out;
  },
});

// ── Golden Gate assembly (v13) ──────────────────────────────────────────────

const GG_JUNCTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'sequence'],
  properties: {
    position: { type: 'integer', description: '1-based position of the junction in the final sequence.' },
    sequence: { type: 'string', description: 'The 4 bp junction (overhang) sequence.' },
  },
};

const GG_FRAGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'sequence', 'length', 'left_overhang', 'right_overhang', 'insert_length'],
  properties: {
    index: { type: 'integer', description: '1-based fragment position in assembly order.' },
    sequence: { type: 'string', description: 'The fragment to order: recognition site + filler + left overhang + insert + right overhang + filler + reverse-complemented site.' },
    length: { type: 'integer' },
    left_overhang: { type: 'string', description: '4 bp 5\' overhang carried at the fragment\'s 5\' end after digestion.' },
    right_overhang: { type: 'string', description: '4 bp overhang carried at the fragment\'s 3\' end after digestion.' },
    insert_length: { type: 'integer', description: 'Length of the bare insert body.' },
  },
};

const goldenGateTool = (ctx) => define({
  safe: false,
  name: 'molbio_golden_gate',
  description: 'Simulate a Golden Gate assembly (type IIS enzyme, e.g. BsaI) in silico. Pass the vector (with its own inward BsaI-style cassette, or BARE with replace_region so the tool adds the cassette and designs both vector junctions) and the BARE fragment sequences in assembly order: the tool designs unique, non-palindromic, non-complementary 4 bp junctions, checks that the enzyme never cuts inside a fragment or the bare vector, builds the fragments-to-order with recognition sites and filler bases, assembles the final plasmid (no recognition site appears at any junction; the vector cassette sites stay in the backbone, as in standard destination vectors), remaps feature coordinates, and predicts verification digests. Save the final plasmid with save_path (FASTA) and/or draw the map with map_path (SVG), which then opens automatically with the OS default application (auto_view default true; set auto_view: false to skip).',
  parameters: {
    type: 'object',
    required: ['inserts'],
    properties: {
      vector: { type: 'string', description: 'Vector sequence (alternative to vector_path).' },
      vector_path: { type: 'string', description: 'Path to a .dna/.gb vector file (alternative to vector).' },
      inserts: { type: 'array', items: { type: 'string' }, description: 'BARE fragment sequences in assembly order (1-24 fragments, unambiguous ACGT, >= 12 bp each). The tool adds the enzyme flanks itself.' },
      enzyme: { type: 'string', description: 'Type IIS enzyme from the built-in table; default "BsaI" (also: BsmBI, Esp3I, BbsI, BspQI, SapI, LguI, PaqCI, AarI, BfuAI, BveI, BtgZI, BsmFI, FokI).' },
      replace_region: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start: { type: 'integer', description: '1-based start of the vector region being replaced by the fragments.' },
          end: { type: 'integer', description: '1-based inclusive end of the replaced region.' },
        },
        description: 'Bare-vector mode: the tool adds the inward cassette around this region and designs both vector junctions. Omit it when the vector already carries its own cassette (exactly one forward and one reverse-complemented recognition site).',
      },
      verify_enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzymes for the verification digest (default: automatically chosen diagnostic enzymes).' },
      save_path: { type: 'string', description: 'Optional path to save the final plasmid as FASTA in the workspace.' },
      map_path: { type: 'string', description: 'Optional path to also draw the new plasmid map (SVG) with the remapped features and the top verification enzymes marked.' },
      auto_view: { type: 'boolean', description: 'Open the generated map SVG automatically with the OS default application (default true; set false to skip).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'enzyme', 'enzyme_site', 'overhang_length', 'fragments_to_order', 'junctions', 'final_sequence', 'length', 'delta', 'features', 'dropped_features', 'verify', 'notes'],
    properties: {
      method: { type: 'string', enum: ['golden_gate'] },
      enzyme: { type: 'string' },
      enzyme_site: { type: 'string', description: 'Recognition site with the standard (N/N) cut notation.' },
      overhang_length: { type: 'integer' },
      fragments_to_order: { type: 'array', items: GG_FRAGMENT_SCHEMA },
      junctions: { type: 'array', items: GG_JUNCTION_SCHEMA },
      final_sequence: { type: 'string' },
      length: { type: 'integer' },
      delta: { type: 'integer' },
      features: { type: 'array', items: CLONE_FEATURE_SCHEMA },
      dropped_features: { type: 'array', items: CLONE_FEATURE_SCHEMA },
      verify: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'final_fragments', 'vector_fragments'],
          properties: {
            name: { type: 'string' },
            final_fragments: { type: 'array', items: { type: 'integer' } },
            vector_fragments: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
      save_path: { type: 'string' },
      map_path: { type: 'string' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `Golden Gate assembly with ${value.enzyme} (${value.enzyme_site}): final plasmid ${value.length} bp (Δ ${value.delta > 0 ? '+' : ''}${value.delta} bp).`,
      `${value.fragments_to_order.length} fragment(s) to order; ${value.junctions.length} junction(s) designed (unique, non-palindromic 4 bp).`,
      `${value.features.length} feature(s) after coordinate remapping; ${value.dropped_features.length} dropped inside the replaced region.`,
    ];
    for (const junction of value.junctions) lines.push(`junction @${junction.position}: ${junction.sequence}`);
    lines.push('fragments to order (synthetic orders):');
    for (const fragment of value.fragments_to_order) {
      lines.push(`  #${fragment.index} ${fragment.sequence}  (${fragment.length} bp, overhangs ${fragment.left_overhang} / ${fragment.right_overhang})`);
    }
    lines.push('verification digests (final vs original vector):');
    for (const entry of value.verify.slice(0, 5)) {
      lines.push(`  ${entry.name}: final ${entry.final_fragments.join('+')} bp vs vector ${entry.vector_fragments.join('+')} bp`);
    }
    for (const note of value.notes) lines.push(`note: ${note}`);
    if (value.save_path !== undefined) lines.push(`final plasmid saved to ${value.save_path}`);
    if (value.map_path !== undefined) lines.push(`plasmid map SVG written to ${value.map_path}${value.auto_viewed === true ? ' and opened automatically in your default viewer' : ''}`);
    lines.push('The remapped `features` and `final_sequence` are ready for molbio_plasmid_map — do not recompute coordinates by hand.');
    if (imageNote(value) !== '') lines.push(imageNote(value).trim());
    return lines.join('\n');
  },
  async execute(args, exec) {
    const vector = await resolveVector(ctx, exec, args);
    let replaceRegion;
    if (args.replace_region !== undefined) {
      if (!Number.isInteger(args.replace_region.start) || !Number.isInteger(args.replace_region.end)) {
        throw new MolbioInputError('replace_region needs both start and end (1-based integers)');
      }
      replaceRegion = { start: args.replace_region.start, end: args.replace_region.end };
    }
    const result = simulateGoldenGate({
      vectorSeq: vector.sequence,
      vectorFeatures: vector.features,
      inserts: args.inserts,
      enzyme: args.enzyme ?? 'BsaI',
      circular: vector.circular,
      replaceRegion,
    });
    const out = {
      method: 'golden_gate',
      enzyme: result.enzyme,
      enzyme_site: result.enzyme_site,
      overhang_length: result.overhang_length,
      fragments_to_order: result.fragments_to_order,
      junctions: result.junctions,
      final_sequence: result.final_sequence,
      length: result.final_sequence.length,
      delta: result.delta,
      features: result.features,
      dropped_features: result.dropped_features,
      verify: result.verify,
      notes: result.notes,
    };
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    if (args.save_path !== undefined && args.save_path !== '') {
      const file = workspaceFilePath(args.save_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, `>${vector.name}_golden_gate ${result.enzyme}\n${result.final_sequence}\n`, policy);
      out.save_path = file;
    }
    if (args.map_path !== undefined && args.map_path !== '') {
      const marks = result.verify.slice(0, 3).map((entry) => ({
        name: entry.name,
        cut_offsets: digest(result.final_sequence, [entry.name], vector.circular)[0].cut_positions,
      }));
      const svg = renderPlasmidMap({
        name: `${vector.name}_golden_gate`,
        length: result.final_sequence.length,
        circular: vector.circular,
        features: result.features,
        enzymes: marks,
      });
      const file = workspaceFilePath(args.map_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, svg, policy);
      out.map_path = file;
      out.auto_viewed = await autoViewWritten(args, file);
      Object.assign(out, await withAttachedImage(ctx, exec, args, svg, `${vector.name}_golden_gate`) ?? {});
    }
    return out;
  },
});

const clonePrimersTool = (ctx) => define({
  name: 'molbio_clone_primers',
  description: 'Design primers that amplify a template with cloning tails. mode=restriction: adds 5\' protection bases and restriction site(s) (1 or 2 enzymes) to the primer ends and re-checks Tm/GC/dimers; warns when an enzyme also cuts inside the template. mode=gibson: adds the vector homology arms flanking the replaced region to the primer ends.',
  parameters: {
    type: 'object',
    required: ['template'],
    properties: {
      template: requiredString('The sequence to amplify (the insert, with any template context you want copied).'),
      mode: { type: 'string', enum: ['restriction', 'gibson'], description: 'Tail type; default "restriction".' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzyme(s) for restriction mode (1 or 2).' },
      protect_bases: { type: 'boolean', description: 'Add recommended 5\' protection bases (default true).' },
      extra_bases: { type: 'integer', description: 'Extra C bases beyond the protection bases (default 0).' },
      binding_length: { type: 'integer', description: 'Template-binding length per primer (default 20 bp, 12-40).' },
      vector: { type: 'string', description: 'Vector sequence for gibson arms (alternative to vector_path).' },
      vector_path: { type: 'string', description: 'Vector file for gibson arms (alternative to vector).' },
      region_start: { type: 'integer', description: '1-based start of the vector region being replaced (gibson).' },
      region_end: { type: 'integer', description: '1-based end of the replaced region (gibson).' },
      overhang: { type: 'integer', description: 'Gibson homology arm length (default 20 bp).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'forward', 'reverse', 'forward_binding', 'reverse_binding', 'checks'],
    properties: {
      mode: { type: 'string', enum: ['restriction', 'gibson'] },
      forward: { type: 'string' },
      reverse: { type: 'string' },
      forward_binding: { type: 'string' },
      reverse_binding: { type: 'string' },
      checks: {
        type: 'object',
        additionalProperties: false,
        required: ['forward_tm', 'reverse_tm', 'binding_tm_forward', 'binding_tm_reverse', 'gc_forward', 'gc_reverse', 'dimer_score', 'forward_self_score', 'reverse_self_score', 'warnings'],
        properties: {
          forward_tm: { type: 'number' },
          reverse_tm: { type: 'number' },
          binding_tm_forward: { type: 'number' },
          binding_tm_reverse: { type: 'number' },
          gc_forward: { type: 'number' },
          gc_reverse: { type: 'number' },
          dimer_score: { type: 'integer' },
          forward_self_score: { type: 'integer' },
          reverse_self_score: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  render(value) {
    const c = value.checks;
    const lines = [
      `cloning primers (${value.mode}):`,
      `  forward: ${value.forward}  (binding ${value.forward_binding})`,
      `  reverse: ${value.reverse}  (binding ${value.reverse_binding})`,
      `Tm: forward ${c.forward_tm} °C / reverse ${c.reverse_tm} °C (binding parts: ${c.binding_tm_forward} / ${c.binding_tm_reverse} °C)`,
      `GC: ${c.gc_forward}% / ${c.gc_reverse}% · dimer score ${c.dimer_score} · self scores ${c.forward_self_score}/${c.reverse_self_score}`,
    ];
    for (const warning of c.warnings) lines.push(`WARNING: ${warning}`);
    lines.push('Tm values are SantaLucia-1998 NN estimates of the FULL primer; the tail does not anneal in the first cycles.');
    return lines.join('\n');
  },
  async execute(args, exec) {
    const mode = args.mode ?? 'restriction';
    let vectorSeq;
    if (mode === 'gibson') {
      const vector = await resolveVector(ctx, exec, args);
      vectorSeq = vector.sequence;
    }
    return designClonePrimers({
      template: args.template,
      mode,
      enzymes: args.enzymes,
      protectBases: args.protect_bases ?? true,
      extraBases: args.extra_bases ?? 0,
      bindingLength: args.binding_length ?? 20,
      vectorSeq,
      region: args.region_start !== undefined ? { start: args.region_start, end: args.region_end } : undefined,
      overhang: args.overhang ?? 20,
    });
  },
});

const mutagenesisTool = define({
  name: 'molbio_mutagenesis_primers',
  description: 'Design QuickChange-style site-directed mutagenesis primer pairs. Mutations are given as strings on the original template coordinates: substitutions "A123G" or "123A>G", deletions "123_125del", insertions "after123insGCT". The mutation is centered in the primers, which are checked for Tm (NN estimate), GC, G/C ends, runs and self-complementarity. The amino-acid change is reported assuming the template reads in frame 1.',
  parameters: {
    type: 'object',
    required: ['template', 'mutations'],
    properties: {
      template: requiredString('Template sequence to mutate.'),
      mutations: { type: 'array', items: { type: 'string' }, description: 'Mutation descriptions, e.g. ["A123G"], ["123_125del"], ["after123insGCT"].' },
      primer_len_min: { type: 'integer', description: 'Minimum primer length (default 25).' },
      primer_len_max: { type: 'integer', description: 'Maximum primer length (default 45).' },
      tm_min: { type: 'number', description: 'Minimum primer Tm °C (default 75).' },
      tm_max: { type: 'number', description: 'Maximum primer Tm °C (default 85).' },
      max_results: { type: 'integer', description: 'Maximum pairs to return (default 2).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mutated_sequence', 'mutation_span', 'amino_acid_change', 'pairs'],
    properties: {
      mutated_sequence: { type: 'string' },
      mutation_span: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'integer' },
          end: { type: 'integer' },
        },
      },
      amino_acid_change: {
        type: 'object',
        additionalProperties: false,
        required: ['before', 'after', 'silent'],
        properties: {
          before: { type: 'string' },
          after: { type: 'string' },
          silent: { type: 'boolean' },
        },
      },
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['forward', 'reverse', 'length', 'tm', 'gc_percent', 'start', 'penalty'],
          properties: {
            forward: { type: 'string' },
            reverse: { type: 'string' },
            length: { type: 'integer' },
            tm: { type: 'number' },
            gc_percent: { type: 'number' },
            start: { type: 'integer' },
            penalty: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `mutation span ${value.mutation_span.start}-${value.mutation_span.end} on the mutated template (${value.mutated_sequence.length} bp).`,
      `amino-acid change (frame 1 assumption): ${value.amino_acid_change.before || '(none)'} → ${value.amino_acid_change.after || '(none)'}${value.amino_acid_change.silent ? ' (silent)' : ''}`,
    ];
    if (value.pairs.length === 0) {
      lines.push('no primer pair satisfied the constraints — widen the length/Tm ranges and retry.');
    } else {
      lines.push(`${value.pairs.length} candidate pair(s):`);
      for (const [index, pair] of value.pairs.entries()) {
        lines.push(`#${index + 1} (${pair.length} bp, starts at ${pair.start}, Tm ${pair.tm} °C, GC ${pair.gc_percent}%)`);
        lines.push(`  F ${pair.forward}`);
        lines.push(`  R ${pair.reverse}`);
      }
    }
    return lines.join('\n');
  },
  execute(args) {
    return designMutagenesisPrimers(args.template, args.mutations, {
      lenMin: args.primer_len_min,
      lenMax: args.primer_len_max,
      tmMin: args.tm_min,
      tmMax: args.tm_max,
      maxResults: args.max_results,
    });
  },
});

const verifySangerTool = (ctx) => define({
  name: 'molbio_verify_sanger',
  description: 'Verify a clone by Sanger sequencing: read a trace file (.ab1 with quality values, or .seq/.txt/.fasta plain text), align it against a reference (sequence or .dna/.gb plasmid file, circular-aware), and report mismatches, deletions, insertions, coverage, identity, and amino-acid consequences inside a CDS window. Low-quality (<20) positions are flagged and excluded from a "differences found" verdict.',
  parameters: {
    type: 'object',
    required: ['trace_path'],
    properties: {
      trace_path: requiredString('Path to the .ab1 / .seq / .txt / .fasta trace file.'),
      reference: { type: 'string', description: 'Reference sequence (alternative to reference_path).' },
      reference_path: { type: 'string', description: 'Reference as a .dna/.gb/.fa file (alternative to reference).' },
      cds_start: { type: 'integer', description: '1-based start of the CDS on the reference for amino-acid reporting.' },
      cds_end: { type: 'integer', description: '1-based end of the CDS.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'trace_length', 'reference_length', 'aligned_span', 'identity_percent', 'differences'],
    properties: {
      verdict: { type: 'string', enum: ['match', 'match_with_low_quality_positions', 'differences_found'] },
      trace_length: { type: 'integer' },
      reference_length: { type: 'integer' },
      aligned_span: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'integer' },
          end: { type: 'integer' },
        },
      },
      identity_percent: { type: 'number' },
      quality_mean: { type: 'number' },
      differences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'ref_pos', 'ref_base', 'trace_base'],
          properties: {
            kind: { type: 'string', enum: ['mismatch', 'deletion', 'insertion'] },
            ref_pos: { type: 'integer' },
            ref_base: { type: 'string' },
            trace_base: { type: 'string' },
            trace_pos: { type: 'integer' },
            quality: { type: 'integer' },
          },
        },
      },
      aa_changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref_pos', 'kind'],
          properties: {
            ref_pos: { type: 'integer' },
            kind: { type: 'string', enum: ['silent', 'missense', 'stop_codon_change', 'frameshift', 'in_frame_deletion'] },
            length: { type: 'integer' },
            codon_before: { type: 'string' },
            codon_after: { type: 'string' },
            aa_before: { type: 'string' },
            aa_after: { type: 'string' },
            deleted_bases: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `verdict: ${value.verdict}`,
      `aligned ${value.aligned_span.start}-${value.aligned_span.end} of ${value.reference_length} bp reference; identity ${value.identity_percent}%`,
    ];
    if (value.quality_mean !== undefined) lines.push(`mean trace quality: ${value.quality_mean}`);
    const confident = value.differences.filter((d) => !(d.quality !== undefined && d.quality < 20));
    const low = value.differences.filter((d) => d.quality !== undefined && d.quality < 20);
    lines.push(`${confident.length} difference(s) at high confidence, ${low.length} at low quality:`);
    for (const d of [...confident, ...low].slice(0, 50)) {
      lines.push(`  ${d.kind} @ref ${d.ref_pos}: ${d.ref_base} → ${d.trace_base}${d.quality !== undefined ? ` (q${d.quality})` : ''}`);
    }
    if (value.aa_changes !== undefined && value.aa_changes.length > 0) {
      lines.push('amino-acid consequences in the CDS window:');
      for (const change of value.aa_changes) {
        if (change.kind === 'frameshift') lines.push(`  @${change.ref_pos}: frameshift (${change.note})`);
        else if (change.kind === 'in_frame_deletion') lines.push(`  @${change.ref_pos}: in-frame deletion of ${change.length} bp (${change.deleted_bases ?? ''} removed; aa ${change.aa_before ?? ''} deleted)`);
        else lines.push(`  @${change.ref_pos}: ${change.kind} ${change.aa_before}${change.aa_before === change.aa_after ? '' : '→' + change.aa_after} (${change.codon_before}→${change.codon_after})`);
      }
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const traceBytes = await readFileBytes(ctx, exec, args.trace_path);
    const trace = readTraceFromBytes(traceBytes, args.trace_path);
    let reference;
    let circular = true;
    if (args.reference !== undefined && args.reference !== '') {
      reference = normalizeSequence(args.reference, 'reference');
    } else if (args.reference_path !== undefined && args.reference_path !== '') {
      const vector = await resolveVector(ctx, exec, args, 'reference_path');
      reference = vector.sequence;
      circular = vector.circular;
    } else {
      throw new MolbioInputError('provide either `reference` (a sequence) or `reference_path` (a .dna/.gb/.fa file)');
    }
    return verifySanger({
      traceBases: trace.bases,
      traceQualities: trace.qualities,
      reference,
      circular,
      cdsStart: args.cds_start,
      cdsEnd: args.cds_end,
    });
  },
});

// ── protein and quantitative tools (batch 2) ────────────────────────────────

const proteinPropsTool = define({
  name: 'molbio_protein_props',
  description: 'Compute physicochemical properties of a protein sequence (one-letter codes): molecular weight (average residue masses + water), isoelectric point (Bjellqvist 1993 pK values), A280 extinction coefficients (reduced and with disulfides), A280(0.1%) absorbance, GRAVY hydropathy (Kyte-Doolittle) and the aliphatic index (Ikai 1980). All values are estimates.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein sequence (one-letter amino acid codes).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['length', 'mw_da', 'pi', 'extinction_reduced_m1cm1', 'extinction_oxidized_m1cm1', 'absorbance_0_1_percent', 'gravy', 'aliphatic_index'],
    properties: {
      length: { type: 'integer' },
      mw_da: { type: 'number' },
      pi: { type: 'number' },
      extinction_reduced_m1cm1: { type: 'integer' },
      extinction_oxidized_m1cm1: { type: 'integer' },
      absorbance_0_1_percent: { type: 'number' },
      gravy: { type: 'number' },
      aliphatic_index: { type: 'number' },
    },
  },
  render(value) {
    return [
      `${value.length} aa · MW ${value.mw_da} Da · pI ${value.pi}`,
      `A280 extinction: ${value.extinction_reduced_m1cm1} M⁻¹cm⁻¹ (reduced), ${value.extinction_oxidized_m1cm1} M⁻¹cm⁻¹ (all Cys as disulfides); A280(0.1%) ≈ ${value.absorbance_0_1_percent}`,
      `GRAVY ${value.gravy} · aliphatic index ${value.aliphatic_index}`,
      'Estimates: Bjellqvist pK values, Kyte-Doolittle hydropathy, average residue masses.',
    ].join('\n');
  },
  execute(args) {
    return proteinProperties(args.sequence);
  },
});

const peptideDigestTool = define({
  name: 'molbio_peptide_digest',
  description: 'In silico protease digestion for mass spectrometry: trypsin, chymotrypsin, LysC or GluC cleavage rules (no cleavage before proline where applicable), optional missed cleavages (0-3), monoisotopic or average [M+H]+ peptide masses, and optional mass-range filtering.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein sequence to digest.'),
      enzyme: { type: 'string', enum: ['trypsin', 'chymotrypsin', 'lysc', 'gluc'], description: 'Protease; default "trypsin".' },
      missed: { type: 'integer', description: 'Missed cleavages to include (0-3, default 0).' },
      mass_type: { type: 'string', enum: ['monoisotopic', 'average'], description: 'Mass type; default "monoisotopic".' },
      min_mass: { type: 'number', description: 'Optional minimum [M+H]+ mass filter (Da).' },
      max_mass: { type: 'number', description: 'Optional maximum [M+H]+ mass filter (Da).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['enzyme', 'missed_cleavages', 'mass_type', 'peptides'],
    properties: {
      enzyme: { type: 'string', enum: ['trypsin', 'chymotrypsin', 'lysc', 'gluc'] },
      missed_cleavages: { type: 'integer' },
      mass_type: { type: 'string', enum: ['monoisotopic', 'average'] },
      peptides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end', 'sequence', 'length', 'mh_mass', 'missed'],
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
            sequence: { type: 'string' },
            length: { type: 'integer' },
            mh_mass: { type: 'number' },
            missed: { type: 'integer' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [`${value.enzyme} digest, ${value.missed_cleavages} missed cleavage(s), ${value.mass_type} [M+H]+ masses: ${value.peptides.length} peptide(s)`];
    for (const peptide of value.peptides.slice(0, 80)) {
      lines.push(`  ${peptide.start}-${peptide.end} ${peptide.sequence}  [M+H]+ ${peptide.mh_mass}${peptide.missed > 0 ? ` (${peptide.missed} missed)` : ''}`);
    }
    if (value.peptides.length > 80) lines.push(`  … ${value.peptides.length - 80} more`);
    return lines.join('\n');
  },
  execute(args) {
    return peptideDigest(args.sequence, {
      enzyme: args.enzyme ?? 'trypsin',
      missed: args.missed ?? 0,
      massType: args.mass_type ?? 'monoisotopic',
      minMass: args.min_mass,
      maxMass: args.max_mass,
    });
  },
});

const codonOptimizeTool = define({
  name: 'molbio_codon_optimize',
  description: 'Codon-optimize a protein sequence for a host (E. coli, yeast, or human) using published high-frequency codon tables (heuristic). Optionally avoid introducing restriction sites (avoid_enzymes): synonymous swaps remove them where possible, deterministically.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein sequence to back-translate (one-letter codes).'),
      host: { type: 'string', enum: CODON_HOSTS, description: 'Expression host; default "e_coli".' },
      avoid_enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction sites to avoid introducing (enzyme names from the built-in table).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['host', 'dna_sequence', 'length', 'gc_percent', 'avoided_sites_remaining', 'notes'],
    properties: {
      host: { type: 'string', enum: CODON_HOSTS },
      dna_sequence: { type: 'string' },
      length: { type: 'integer' },
      gc_percent: { type: 'number' },
      avoided_sites_remaining: { type: 'integer' },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    const lines = [
      `${value.host} codon-optimized DNA: ${value.length} bp, GC ${value.gc_percent}%`,
      value.dna_sequence,
    ];
    for (const note of value.notes) lines.push(`note: ${note}`);
    if (value.avoided_sites_remaining > 0) lines.push(`WARNING: ${value.avoided_sites_remaining} avoided site(s) could not be removed by synonymous codons`);
    lines.push('Optimization uses published high-frequency codon tables — heuristic, not a guarantee of expression level.');
    return lines.join('\n');
  },
  execute(args) {
    return codonOptimize(args.sequence, {
      host: args.host ?? 'e_coli',
      avoidEnzymes: args.avoid_enzymes ?? [],
    });
  },
});

// ── v17: protein sequence plots (helical wheel, hydropathy) ─────────────────

const WHEEL_RESIDUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'amino_acid', 'class', 'angle_degrees', 'x', 'y', 'hydropathy', 'hydrophobicity'],
  properties: {
    position: { type: 'integer', description: '1-based position in the protein.' },
    amino_acid: { type: 'string' },
    class: { type: 'string', enum: ['hydrophobic', 'polar', 'acidic', 'basic'] },
    angle_degrees: { type: 'number', description: 'Wheel angle, 0-360 (residue 1 at the top, clockwise).' },
    x: { type: 'number', description: 'Unit-circle x (-1..1) for replotting.' },
    y: { type: 'number', description: 'Unit-circle y (-1..1).' },
    hydropathy: { type: 'number', description: 'Kyte-Doolittle value of this residue.' },
    hydrophobicity: { type: 'number', description: 'Eisenberg consensus value used for the hydrophobic moment.' },
  },
};

const helicalWheelTool = (ctx) => define({
  safe: (args) => args.output_path === undefined || args.output_path === '',
  name: 'molbio_helical_wheel',
  description: 'Draw the helical wheel (Schiffer-Edmundson projection) of a peptide or protein stretch and analyse it: residues are placed 100° apart on the circle (3.6 residues per turn of an ideal alpha-helix), coloured by residue class (hydrophobic/polar/acidic/basic), with the Eisenberg hydrophobic moment μH of the stretch and the maximum μH over every window of moment_window residues (11 by default). An amphipathic helix shows one hydrophobic face and one polar face. The tool WRITES an SVG file and opens it with the OS default viewer (auto_view, default true); all values are sequence-propensity estimates from published scales, not a structure prediction.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein/peptide sequence (one-letter amino acid codes).'),
      start: { type: 'integer', description: '1-based first residue drawn (default 1).' },
      residues_per_turn: { type: 'number', description: 'Helical periodicity (2-6, default 3.6 for an alpha-helix).' },
      moment_window: { type: 'integer', description: 'Window for the maximum hydrophobic moment (2-40, default 11, Eisenberg\'s standard).' },
      rotations: { type: 'integer', description: 'How many turns to draw (1-6, default 4).' },
      title: { type: 'string', description: 'Title drawn on the SVG (default "Helical wheel").' },
      output_path: { type: 'string', description: 'Optional SVG file path; default helical-wheel.svg in the session workspace.' },
      auto_view: { type: 'boolean', description: 'Open the SVG automatically with the OS default application (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['start', 'end', 'window', 'residues_shown', 'residues_per_turn', 'degrees_per_residue', 'moment_window', 'hydrophobic_moment', 'mean_hydrophobicity', 'maximum_window_moment', 'maximum_window_start', 'hydrophobic_fraction', 'class_counts', 'residues', 'notes', 'svg_path'],
    properties: {
      start: { type: 'integer' },
      end: { type: 'integer' },
      window: { type: 'string', description: 'The residues actually drawn.' },
      residues_shown: { type: 'integer' },
      residues_per_turn: { type: 'number' },
      degrees_per_residue: { type: 'number' },
      moment_window: { type: 'integer' },
      hydrophobic_moment: { type: 'number', description: 'Eisenberg μH of the drawn stretch (per residue).' },
      mean_hydrophobicity: { type: 'number', description: 'Mean Eisenberg hydrophobicity of the stretch.' },
      maximum_window_moment: { type: 'number', description: 'Highest μH over all windows of moment_window residues.' },
      maximum_window_start: { type: 'integer', description: '1-based start of the window with the highest μH.' },
      hydrophobic_fraction: { type: 'number', description: 'Fraction of drawn residues in the hydrophobic class.' },
      class_counts: {
        type: 'object',
        additionalProperties: false,
        required: ['hydrophobic', 'polar', 'acidic', 'basic'],
        properties: {
          hydrophobic: { type: 'integer' },
          polar: { type: 'integer' },
          acidic: { type: 'integer' },
          basic: { type: 'integer' },
        },
      },
      residues: { type: 'array', items: WHEEL_RESIDUE_SCHEMA },
      notes: { type: 'array', items: { type: 'string' } },
      svg_path: { type: 'string' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `helical wheel for residues ${value.start}-${value.end} (${value.residues_shown} residues, ${value.degrees_per_residue}°/residue, ${value.residues_per_turn} per turn) — SVG written to ${value.svg_path}`,
      `hydrophobic moment μH ${value.hydrophobic_moment} (mean hydrophobicity ${value.mean_hydrophobicity}); maximum ${value.maximum_window_moment} over ${value.moment_window}-residue windows starting at ${value.maximum_window_start}`,
      `residue classes: ${Object.entries(value.class_counts).map(([key, count]) => `${key} ${count}`).join(', ')} (hydrophobic fraction ${value.hydrophobic_fraction})`,
    ];
    for (const note of value.notes) lines.push(`note: ${note}`);
    lines.push(value.auto_viewed === true ? 'Opened automatically in your default viewer.' : 'Open the SVG file to view it.');
    lines.push('Residue classes and μH use published scales (Kyte-Doolittle, Eisenberg 1984) — sequence propensity, not a structure prediction.');
    if (imageNote(value) !== '') lines.push(imageNote(value).trim());
    return lines.join('\n');
  },
  async execute(args, exec) {
    const wheel = helicalWheel(args.sequence, {
      start: args.start,
      residuesPerTurn: args.residues_per_turn,
      momentWindow: args.moment_window,
      rotations: args.rotations,
    });
    const svg = renderHelicalWheel(wheel, { title: args.title ?? 'Helical wheel' });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, args, svg, 'helical-wheel.svg');
    const classCounts = {
      hydrophobic: wheel.class_counts.hydrophobic ?? 0,
      polar: wheel.class_counts.polar ?? 0,
      acidic: wheel.class_counts.acidic ?? 0,
      basic: wheel.class_counts.basic ?? 0,
    };
    // `sequence` is the analysis input, not part of this tool's output schema.
    const { sequence: analyzedSequence, ...wheelFields } = wheel;
    void analyzedSequence;
    return mergeAttachedImage({
      ...wheelFields,
      class_counts: classCounts,
      svg_path: file,
      auto_viewed: viewed,
    }, attached);
  },
});

const HYDROPATHY_POINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'amino_acid', 'hydropathy', 'window'],
  properties: {
    position: { type: 'integer' },
    amino_acid: { type: 'string' },
    hydropathy: { type: 'number', description: 'Kyte-Doolittle window average centred on this residue.' },
    window: { type: 'array', items: { type: 'integer' }, description: '1-based inclusive residue range averaged.' },
  },
};

const HYDROPATHY_PEAK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end', 'length', 'maximum', 'maximum_position'],
  properties: {
    start: { type: 'integer', description: '1-based first residue of the peak.' },
    end: { type: 'integer' },
    length: { type: 'integer' },
    maximum: { type: 'number', description: 'Highest window average in the peak.' },
    maximum_position: { type: 'integer' },
  },
};

const hydropathyTool = (ctx) => define({
  safe: (args) => args.output_path === undefined || args.output_path === '',
  name: 'molbio_hydropathy_plot',
  description: 'Plot the Kyte-Doolittle hydropathy profile of a protein: a sliding-window average (window, default 9; use 19-21 for transmembrane spans), the GRAVY value, and every peak whose window average reaches the threshold (default 1.6, the classic membrane-spanning cutoff). The tool WRITES an SVG file and opens it with the OS default viewer (auto_view, default true); the per-residue profile is also returned so it can feed further analysis. Values are the Kyte-Doolittle propensity scale, not a topology prediction.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein sequence (one-letter amino acid codes).'),
      window: { type: 'integer', description: 'Sliding-window length in residues (3-51, default 9; 19-21 for transmembrane spans).' },
      threshold: { type: 'number', description: 'Window average that counts as a hydrophobic peak (-4.5..4.5, default 1.6).' },
      title: { type: 'string', description: 'Title drawn on the SVG (default "Kyte-Doolittle hydropathy").' },
      output_path: { type: 'string', description: 'Optional SVG file path; default hydropathy.svg in the session workspace.' },
      auto_view: { type: 'boolean', description: 'Open the SVG automatically with the OS default application (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['length', 'window', 'threshold', 'gravy', 'mean_profile', 'minimum_hydropathy', 'maximum_hydropathy', 'peaks', 'points', 'svg_path'],
    properties: {
      length: { type: 'integer' },
      window: { type: 'integer' },
      threshold: { type: 'number' },
      gravy: { type: 'number', description: 'Grand average of hydropathy over the whole protein.' },
      mean_profile: { type: 'number', description: 'Mean of the windowed profile.' },
      minimum_hydropathy: { type: 'number' },
      maximum_hydropathy: { type: 'number' },
      peaks: { type: 'array', items: HYDROPATHY_PEAK_SCHEMA },
      points: { type: 'array', items: HYDROPATHY_POINT_SCHEMA },
      svg_path: { type: 'string' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `Kyte-Doolittle hydropathy: ${value.length} aa, window ${value.window}, threshold ${value.threshold}; GRAVY ${value.gravy} (SVG written to ${value.svg_path})`,
      `profile range ${value.minimum_hydropathy} .. ${value.maximum_hydropathy} (mean ${value.mean_profile})`,
    ];
    if (value.peaks.length === 0) {
      lines.push(`no window average reaches the ${value.threshold} threshold — no candidate membrane-spanning stretch at this window size`);
    } else {
      lines.push(`${value.peaks.length} peak(s) at or above the threshold:`);
      for (const peak of value.peaks) lines.push(`  ${peak.start}-${peak.end} (${peak.length} aa, max ${peak.maximum} at ${peak.maximum_position})`);
    }
    lines.push(value.auto_viewed === true ? 'Opened automatically in your default viewer.' : 'Open the SVG file to view it.');
    lines.push('Kyte-Doolittle values are a sequence propensity scale — a peak is a candidate span, not a proven topology.');
    if (imageNote(value) !== '') lines.push(imageNote(value).trim());
    return lines.join('\n');
  },
  async execute(args, exec) {
    const profile = hydropathyProfile(args.sequence, { window: args.window, threshold: args.threshold });
    const svg = renderHydropathyPlot(profile, { title: args.title ?? 'Kyte-Doolittle hydropathy' });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, args, svg, 'hydropathy.svg');
    return mergeAttachedImage({ ...profile, svg_path: file, auto_viewed: viewed }, attached);
  },
});

const qpcrEfficiencyTool = (ctx) => define({
  safe: (args) => args.plot_path === undefined || args.plot_path === '',
  name: 'molbio_qpcr_efficiency',
  description: 'Fit a qPCR standard curve from a dilution series: dilution_factors (e.g. [1, 10, 100, 1000]) with the matching ct_values. Fits Ct vs log10(relative quantity), reports slope, intercept, R², and amplification efficiency E = 10^(−1/slope) − 1. Pass plot_path to write the scatter + fit line as an SVG file in the workspace and open it automatically with the OS default application (auto_view default true).',
  parameters: {
    type: 'object',
    required: ['dilution_factors', 'ct_values'],
    properties: {
      dilution_factors: { type: 'array', items: { type: 'number' }, description: 'Dilution factors, e.g. [1, 10, 100, 1000].' },
      ct_values: { type: 'array', items: { type: 'number' }, description: 'Ct values matching the dilution factors.' },
      plot_path: { type: 'string', description: 'Optional path to write the standard-curve SVG plot.' },
      auto_view: { type: 'boolean', description: 'Open the plot automatically with the OS default application (default true; set false to skip).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['n', 'slope', 'intercept', 'r_squared', 'efficiency', 'efficiency_percent', 'points'],
    properties: {
      n: { type: 'integer' },
      slope: { type: 'number' },
      intercept: { type: 'number' },
      r_squared: { type: 'number' },
      efficiency: { type: 'number' },
      efficiency_percent: { type: 'number' },
      points: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
      },
      plot_path: { type: 'string' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `standard curve from ${value.n} points: Ct = ${value.intercept} + ${value.slope}·log10(relative quantity)`,
      `R² = ${value.r_squared} · efficiency = ${value.efficiency_percent}%`,
    ];
    if (value.plot_path !== undefined) lines.push(`plot written to ${value.plot_path}${value.auto_viewed === true ? ' and opened automatically in your default viewer' : ''}`);
    if (imageNote(value) !== '') lines.push(imageNote(value).trim());
    return lines.join('\n');
  },
  async execute(args, exec) {
    const factors = args.dilution_factors;
    const cts = args.ct_values;
    if (!Array.isArray(factors) || !Array.isArray(cts) || factors.length !== cts.length || factors.length < 3) {
      throw new MolbioInputError('dilution_factors and ct_values must be arrays of the same length (>= 3)');
    }
    const xs = factors.map((f) => {
      if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) throw new MolbioInputError('dilution_factors must be positive numbers');
      return Math.log10(1 / f);
    });
    for (const ct of cts) {
      if (typeof ct !== 'number' || !Number.isFinite(ct)) throw new MolbioInputError('ct_values must be finite numbers');
    }
    const fit = linearFit(xs, cts);
    const efficiency = Math.pow(10, -1 / fit.slope) - 1;
    const out = {
      n: factors.length,
      slope: Math.round(fit.slope * 10000) / 10000,
      intercept: Math.round(fit.intercept * 10000) / 10000,
      r_squared: Math.round(fit.r_squared * 10000) / 10000,
      efficiency: Math.round(efficiency * 10000) / 10000,
      efficiency_percent: Math.round(efficiency * 10000) / 100,
      points: xs.map((x, i) => ({ x: Math.round(x * 10000) / 10000, y: cts[i] })),
    };
    if (args.plot_path !== undefined && args.plot_path !== '') {
      const fs = fsService(ctx);
      const sandboxPolicyService = ctx.get('sandboxPolicy');
      const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
      const file = workspaceFilePath(args.plot_path, exec, policy?.workspaceRoot);
      const svg = renderScatterChart({
        title: 'qPCR standard curve',
        x_label: 'log10(relative quantity)',
        y_label: 'Ct',
        x: xs,
        y: cts,
        fit,
      });
      await writeWorkspaceFile(fs, file, svg, policy);
      out.plot_path = file;
      out.auto_viewed = await autoViewWritten(args, file);
      Object.assign(out, await withAttachedImage(ctx, exec, args, svg, 'qpcr-standard-curve') ?? {});
    }
    return out;
  },
});

const plotTool = (ctx) => define({
  safe: false,
  name: 'molbio_plot',
  description: 'Draw a chart as a standalone SVG file in the workspace. kind=bar: labels/values with optional error bars (e.g. qPCR fold change mean ± SD). kind=scatter: x/y series, with fit=true adding a least-squares line. output_path is required — the SVG is written by the tool and then opened automatically with the OS default application (auto_view default true; set auto_view: false to skip).',
  parameters: {
    type: 'object',
    required: ['kind', 'output_path'],
    properties: {
      kind: { type: 'string', enum: ['bar', 'scatter'], description: 'Chart type.' },
      output_path: requiredString('SVG file path in the workspace.'),
      title: { type: 'string' },
      x_label: { type: 'string' },
      y_label: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Bar labels.' },
      values: { type: 'array', items: { type: 'number' }, description: 'Bar values.' },
      errors: { type: 'array', items: { type: 'number' }, description: 'Optional error-bar half-widths (SD).' },
      x: { type: 'array', items: { type: 'number' }, description: 'Scatter x values.' },
      y: { type: 'array', items: { type: 'number' }, description: 'Scatter y values.' },
      fit: { type: 'boolean', description: 'Scatter: draw the least-squares line (default false).' },
      auto_view: { type: 'boolean', description: 'Open the chart automatically with the OS default application (default true; set false to skip).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['plot_path', 'kind', 'points'],
    properties: {
      plot_path: { type: 'string' },
      kind: { type: 'string', enum: ['bar', 'scatter'] },
      points: { type: 'integer' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const viewNote = value.auto_viewed === true ? 'Opened automatically in your default viewer.' : 'Open the SVG file to view it.';
    return `chart written to ${value.plot_path} (${value.kind}, ${value.points} points). ${viewNote}${imageNote(value)}`;
  },
  async execute(args, exec) {
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
    let svg;
    let points;
    if (args.kind === 'bar') {
      if (!Array.isArray(args.labels) || !Array.isArray(args.values) || args.labels.length !== args.values.length) {
        throw new MolbioInputError('kind=bar needs labels and values arrays of the same length');
      }
      svg = renderBarChart({
        title: args.title,
        x_label: args.x_label,
        y_label: args.y_label,
        labels: args.labels,
        values: args.values,
        errors: args.errors,
      });
      points = args.values.length;
    } else if (args.kind === 'scatter') {
      if (!Array.isArray(args.x) || !Array.isArray(args.y) || args.x.length !== args.y.length) {
        throw new MolbioInputError('kind=scatter needs x and y arrays of the same length');
      }
      const fit = args.fit === true ? linearFit(args.x, args.y) : undefined;
      svg = renderScatterChart({
        title: args.title,
        x_label: args.x_label,
        y_label: args.y_label,
        x: args.x,
        y: args.y,
        fit,
      });
      points = args.x.length;
    } else {
      throw new MolbioInputError('kind must be "bar" or "scatter"');
    }
    await writeWorkspaceFile(fs, file, svg, policy);
    return mergeAttachedImage(
      { plot_path: file, kind: args.kind, points, auto_viewed: await autoViewWritten(args, file) },
      await withAttachedImage(ctx, exec, args, svg, 'chart'),
    );
  },
});

// ── sequence analysis and records (batch 3) ────────────────────────────────

// ── virtual agarose gel (v13) ──────────────────────────────────────────────

const virtualGelTool = (ctx) => define({
  safe: false,
  name: 'molbio_virtual_gel',
  description: 'Render a virtual agarose gel as an SVG file in the workspace. Each lane lists the EXPECTED DNA fragment sizes in bp (e.g. a restriction digest, a PCR, or a ligation check) and the tool draws the band pattern with a size ladder so the expected picture can be compared against a real gel. The tool writes the file itself — the SVG never reaches the conversation — and then opens it automatically with the OS default application (auto_view default true; set auto_view: false to skip).',
  parameters: {
    type: 'object',
    required: ['lanes'],
    properties: {
      lanes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'fragments'],
          properties: {
            label: { type: 'string', description: 'Lane label (e.g. "EcoRI digest" or a sample name).' },
            fragments: { type: 'array', items: { type: 'integer' }, description: 'Expected fragment sizes in bp (1-50000).' },
          },
        },
        description: '1-12 lanes, each with a label and the expected fragment sizes.',
      },
      ladder: { type: 'string', enum: ['1kb', '100bp'], description: 'Size ladder; default "1kb" (250 bp - 10 kb).' },
      title: { type: 'string', description: 'Gel title (default "Agarose gel").' },
      output_path: { type: 'string', description: 'Optional SVG file path; default: <title>.svg in the session workspace.' },
      auto_view: { type: 'boolean', description: 'Open the gel automatically with the OS default application (default true; set false to skip).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['svg_path', 'lane_count', 'band_count', 'ladder'],
    properties: {
      svg_path: { type: 'string' },
      lane_count: { type: 'integer' },
      band_count: { type: 'integer' },
      ladder: { type: 'string', enum: ['1kb', '100bp'] },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const viewNote = value.auto_viewed === true ? 'Opened automatically in your default viewer.' : 'Open the SVG file to view it.';
    return `Virtual gel SVG saved to ${value.svg_path}: ${value.lane_count} lane(s), ${value.band_count} band(s), ladder ${value.ladder}. ${viewNote}${imageNote(value)}`;
  },
  async execute(args, exec) {
    if (!Array.isArray(args.lanes) || args.lanes.length < 1 || args.lanes.length > 12) {
      throw new MolbioInputError('lanes must be an array of 1-12 lane objects');
    }
    const lanes = args.lanes.map((lane) => {
      const fragments = (lane.fragments ?? []).map((size) => {
        if (!Number.isInteger(size) || size < 1 || size > 50000) {
          throw new MolbioInputError(`fragment sizes must be integers between 1 and 50000 bp, got ${JSON.stringify(size)}`);
        }
        return size;
      });
      return { label: String(lane.label ?? ''), fragments };
    });
    const ladder = args.ladder ?? '1kb';
    const title = args.title ?? 'Agarose gel';
    const svg = renderGel({ title, lanes, ladder, showLadder: true });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, { output_path: args.output_path, auto_view: args.auto_view, attach_image: args.attach_image }, svg, title);
    return mergeAttachedImage({
      svg_path: file,
      lane_count: lanes.length,
      band_count: lanes.reduce((sum, lane) => sum + lane.fragments.length, 0),
      ladder,
      auto_viewed: viewed,
    }, attached);
  },
});

const alignTool = define({
  name: 'molbio_align',
  description: 'Locally align two sequences (Smith-Waterman). Returns the aligned strings, aligned spans (1-based), identity %, and a list of mismatches/gaps. Use it to compare two sequences, check a primer against a template, or verify an edited region.',
  parameters: {
    type: 'object',
    required: ['sequence1', 'sequence2'],
    properties: {
      sequence1: requiredString('First sequence (typically the query/read).'),
      sequence2: requiredString('Second sequence (typically the reference).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['a_aligned', 'b_aligned', 'a_start', 'b_start', 'a_end', 'b_end', 'score', 'identity_percent', 'aligned_columns', 'differences'],
    properties: {
      a_aligned: { type: 'string' },
      b_aligned: { type: 'string' },
      a_start: { type: 'integer' },
      b_start: { type: 'integer' },
      a_end: { type: 'integer' },
      b_end: { type: 'integer' },
      score: { type: 'integer' },
      identity_percent: { type: 'number' },
      aligned_columns: { type: 'integer' },
      differences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'pos1', 'pos2', 'base1', 'base2'],
          properties: {
            kind: { type: 'string', enum: ['mismatch', 'deletion', 'insertion'] },
            pos1: { type: 'integer' },
            pos2: { type: 'integer' },
            base1: { type: 'string' },
            base2: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const show = (s) => (s.length > 240 ? s.slice(0, 120) + ` …[${s.length - 240} bp]… ` + s.slice(-120) : s);
    let matchLine = '';
    const a = value.a_aligned;
    const b = value.b_aligned;
    for (let i = 0; i < a.length; i++) matchLine += a[i] === b[i] ? '|' : ' ';
    const lines = [
      `identity ${value.identity_percent}% over ${value.aligned_columns} aligned columns; sequence1 ${value.a_start + 1}-${value.a_end}, sequence2 ${value.b_start + 1}-${value.b_end}`,
      `seq1 ${show(a)}`,
      `     ${show(matchLine)}`,
      `seq2 ${show(b)}`,
    ];
    const confident = value.differences.slice(0, 60);
    if (confident.length > 0) {
      lines.push(`${value.differences.length} difference(s):`);
      for (const d of confident) lines.push(`  ${d.kind} @seq1 ${d.pos1} / seq2 ${d.pos2}: ${d.base1} vs ${d.base2}`);
    }
    return lines.join('\n');
  },
  execute(args) {
    const a = normalizeSequence(args.sequence1, 'sequence1');
    const b = normalizeSequence(args.sequence2, 'sequence2');
    const result = smithWaterman(a, b);
    const differences = result.differences.map((d) => ({
      kind: d.kind,
      pos1: d.trace_pos ?? (d.kind === 'deletion' ? d.trace_pos + 1 : d.trace_pos),
      pos2: d.ref_pos,
      base1: d.trace_base,
      base2: d.ref_base,
    }));
    return {
      a_aligned: result.a_aligned,
      b_aligned: result.b_aligned,
      a_start: result.a_start,
      b_start: result.b_start,
      a_end: result.a_end,
      b_end: result.b_end,
      score: result.score,
      identity_percent: result.identity_percent,
      aligned_columns: result.aligned_columns,
      differences,
    };
  },
});

// ── v15: multiple sequence alignment and conservation analysis ──────────────

/**
 * Collect the sequence list for the MSA tools from either the inline
 * `sequences` array or a workspace FASTA file — exactly one must be given.
 */
async function msaEntries(ctx, exec, args, toolName) {
  const hasSequences = args.sequences !== undefined;
  const hasPath = args.fasta_path !== undefined && args.fasta_path !== '';
  if (hasSequences === hasPath) throw new MolbioInputError(`${toolName}: provide exactly one of "sequences" (array) or "fasta_path"`);
  if (hasSequences) {
    if (args.sequences.length < 2) throw new MolbioInputError(`${toolName} needs at least 2 sequences (got ${args.sequences.length})`);
    return args.sequences.map((raw, k) => ({ id: `seq${k + 1}`, sequence: normalizeMsaSequence(raw, `sequences[${k}]`) }));
  }
  const bytes = await readFileBytes(ctx, exec, args.fasta_path);
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  const parsed = parseFasta(text);
  if (parsed.length < 2) throw new MolbioInputError(`${toolName}: the FASTA file must contain at least 2 sequences (got ${parsed.length})`);
  return parsed.map((entry) => ({ id: entry.id, sequence: normalizeMsaSequence(entry.sequence, `FASTA entry ${JSON.stringify(entry.id)}`) }));
}

function showMsaSlice(sequence) {
  return sequence.length > 120 ? sequence.slice(0, 60) + ` …[${sequence.length - 120} bp]… ` + sequence.slice(-60) : sequence;
}

const msaAlignTool = (ctx) => define({
  safe: (args) => args.save_path === undefined || args.save_path === '',
  name: 'molbio_msa_align',
  description: 'Progressive multiple sequence alignment of 2-50 IUPAC DNA sequences (up to 3000 bases each, 30000 bases total). Pairwise/profile global alignment uses affine gaps with free terminal gaps (match +4 / mismatch -4 / gap open -6 / extend -2); the merge order comes from a UPGMA tree over 5-mer distances and profiles are aligned with sum-of-pairs scoring ("once a gap, always a gap"). Returns the aligned sequences in input order plus pairwise identity statistics. Provide either `sequences` (array of strings) or `fasta_path` (workspace FASTA); pass `save_path` to also write the aligned FASTA into the workspace. Deterministic heuristic — a working alignment for comparison, not phylogenetic ground truth.',
  parameters: {
    type: 'object',
    properties: {
      sequences: { type: 'array', items: { type: 'string' }, description: 'IUPAC DNA sequences to align (2-50; U treated as T).' },
      fasta_path: { type: 'string', description: 'Path to a workspace FASTA file with the sequences (alternative to sequences).' },
      save_path: { type: 'string', description: 'Optional FASTA output path for the aligned sequences.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'sequence_count', 'aligned_columns', 'ids', 'alignment', 'pairwise_identity_percent', 'score', 'saved_to'],
    properties: {
      method: { type: 'string' },
      sequence_count: { type: 'integer' },
      aligned_columns: { type: 'integer' },
      ids: { type: 'array', items: { type: 'string' } },
      alignment: { type: 'array', items: { type: 'string' } },
      pairwise_identity_percent: {
        type: 'object',
        additionalProperties: false,
        required: ['mean', 'min', 'max'],
        properties: {
          mean: { type: 'number' },
          min: { type: 'number' },
          max: { type: 'number' },
        },
      },
      score: { type: 'integer' },
      saved_to: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `progressive multiple sequence alignment: ${value.sequence_count} sequences, ${value.aligned_columns} columns; pairwise identity mean ${value.pairwise_identity_percent.mean}% (min ${value.pairwise_identity_percent.min}%, max ${value.pairwise_identity_percent.max}%); score ${value.score}`,
    ];
    const count = Math.min(20, value.ids.length);
    const width = Math.max(...value.ids.slice(0, count).map((id) => id.length));
    for (let k = 0; k < count; k++) lines.push(`  ${value.ids[k].padEnd(width)} ${showMsaSlice(value.alignment[k])}`);
    if (value.ids.length > count) lines.push(`  … ${value.ids.length - count} more sequence(s) …`);
    if (value.saved_to !== '') lines.push(`aligned FASTA saved to ${value.saved_to}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const entries = await msaEntries(ctx, exec, args, 'molbio_msa_align');
    const result = progressiveAlign(entries);
    const alignment = result.alignment.map((row) => row.sequence);
    let savedTo = '';
    if (args.save_path !== undefined && args.save_path !== '') {
      const fs = fsService(ctx);
      const sandboxPolicyService = ctx.get('sandboxPolicy');
      const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
      const file = workspaceFilePath(args.save_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, toFasta(result.alignment.map((row) => ({ id: row.id, description: '', sequence: row.sequence }))), policy);
      savedTo = file;
    }
    return {
      method: 'progressive MSA: UPGMA guide tree over 5-mer distances, affine-gap Needleman-Wunsch profile alignment (match +4/mismatch -4/gap open -6/extend -2, free terminal gaps)',
      sequence_count: alignment.length,
      aligned_columns: result.columns,
      ids: result.alignment.map((row) => row.id),
      alignment,
      pairwise_identity_percent: pairwiseIdentities(alignment),
      score: result.score,
      saved_to: savedTo,
    };
  },
});

const conservationTool = (ctx) => define({
  safe: true,
  name: 'molbio_conservation',
  description: 'Conservation analysis of a set of IUPAC DNA sequences: consensus sequence, per-column identity (fraction of residues matching the top residue), entropy-based conservation score, conserved/variable columns, and pairwise identity statistics. Provide exactly one of `alignment` (pre-aligned equal-length sequences, "-" for gaps — e.g. the output of molbio_msa_align), `sequences` (unaligned; aligned first with the molbio_msa_align method), or `fasta_path`. `threshold` (default 0.8) is the column identity at or above which a column counts as conserved; columns below it are listed in variable_positions (capped at 200, see variable_positions_truncated). All-gap columns count as conserved; per_column details are returned for alignments up to 300 columns. Deterministic; all scores are heuristic estimates.',
  parameters: {
    type: 'object',
    properties: {
      alignment: { type: 'array', items: { type: 'string' }, description: 'Pre-aligned sequences of equal length ("-" for gaps).' },
      sequences: { type: 'array', items: { type: 'string' }, description: 'Unaligned IUPAC DNA sequences (2-50; U treated as T).' },
      fasta_path: { type: 'string', description: 'Workspace FASTA file with unaligned sequences.' },
      threshold: { type: 'number', description: 'Conserved-column identity threshold in (0, 1]; default 0.8.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'sequence_count', 'aligned_columns', 'consensus', 'identity_percent', 'conserved_columns', 'conserved_percent', 'variable_positions', 'variable_positions_truncated', 'pairwise_identity_percent'],
    properties: {
      source: { type: 'string', enum: ['msa', 'alignment'] },
      sequence_count: { type: 'integer' },
      aligned_columns: { type: 'integer' },
      consensus: { type: 'string' },
      identity_percent: { type: 'number' },
      conserved_columns: { type: 'integer' },
      conserved_percent: { type: 'number' },
      variable_positions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['column', 'consensus', 'identity'],
          properties: {
            column: { type: 'integer' },
            consensus: { type: 'string' },
            identity: { type: 'number' },
          },
        },
      },
      variable_positions_truncated: { type: 'boolean' },
      per_column: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['column', 'consensus', 'identity', 'conservation'],
          properties: {
            column: { type: 'integer' },
            consensus: { type: 'string' },
            identity: { type: 'number' },
            conservation: { type: 'number' },
          },
        },
      },
      pairwise_identity_percent: {
        type: 'object',
        additionalProperties: false,
        required: ['mean', 'min', 'max'],
        properties: {
          mean: { type: 'number' },
          min: { type: 'number' },
          max: { type: 'number' },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `conservation over ${value.sequence_count} sequences × ${value.aligned_columns} columns (source: ${value.source}): column identity ${value.identity_percent}%, ${value.conserved_columns} conserved column(s) (${value.conserved_percent}%), pairwise identity mean ${value.pairwise_identity_percent.mean}%`,
      `consensus ${showMsaSlice(value.consensus)}`,
    ];
    if (value.variable_positions.length > 0) {
      lines.push(`${value.variable_positions.length} variable position(s)${value.variable_positions_truncated ? ' (list truncated at 200)' : ''}:`);
      for (const v of value.variable_positions.slice(0, 20)) lines.push(`  column ${v.column}: consensus ${v.consensus}, identity ${v.identity}`);
    } else {
      lines.push('no variable positions at this threshold');
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const hasAlignment = args.alignment !== undefined;
    const hasSequences = args.sequences !== undefined;
    const hasPath = args.fasta_path !== undefined && args.fasta_path !== '';
    if ((hasAlignment ? 1 : 0) + (hasSequences ? 1 : 0) + (hasPath ? 1 : 0) !== 1) {
      throw new MolbioInputError('molbio_conservation: provide exactly one of "alignment", "sequences", or "fasta_path"');
    }
    const threshold = args.threshold ?? 0.8;
    let rows;
    let source;
    if (hasAlignment) {
      rows = args.alignment.map((raw, k) => normalizeAlignedRow(raw, `alignment[${k}]`));
      source = 'alignment';
    } else {
      const entries = await msaEntries(ctx, exec, args, 'molbio_conservation');
      rows = progressiveAlign(entries).alignment.map((row) => row.sequence);
      source = 'msa';
    }
    return { source, ...conservationAnalysis(rows, threshold) };
  },
});

// ── v16: sequence logo and CRISPR gRNA design ───────────────────────────────

/**
 * Resolve an alignment for the logo tool: either pre-aligned `alignment` rows
 * or unaligned `sequences` / `fasta_path` that are aligned first (exactly one
 * source). Returns per-column composition plus the metadata the SVG header
 * needs.
 */
async function logoComposition(ctx, exec, args) {
  const hasAlignment = args.alignment !== undefined;
  const hasSequences = args.sequences !== undefined;
  const hasPath = args.fasta_path !== undefined && args.fasta_path !== '';
  if ((hasAlignment ? 1 : 0) + (hasSequences ? 1 : 0) + (hasPath ? 1 : 0) !== 1) {
    throw new MolbioInputError('molbio_sequence_logo: provide exactly one of "alignment", "sequences", or "fasta_path"');
  }
  let rows;
  let source;
  if (hasAlignment) {
    rows = args.alignment.map((raw, k) => normalizeAlignedRow(raw, `alignment[${k}]`));
    source = 'alignment';
  } else {
    const entries = await msaEntries(ctx, exec, args, 'molbio_sequence_logo');
    rows = progressiveAlign(entries).alignment.map((row) => row.sequence);
    source = 'msa';
  }
  return {
    rows,
    source,
    compositions: columnComposition(rows, { smallSample: args.small_sample !== false }),
  };
}

const sequenceLogoTool = (ctx) => define({
  name: 'molbio_sequence_logo',
  description: 'Render a sequence logo (per-position base composition, letter height = information content in bits) as an SVG file in the session workspace, then open it with the OS default application. Provide exactly one of `alignment` (pre-aligned equal-length sequences, "-" for gaps — e.g. the output of molbio_msa_align), `sequences` (unaligned; aligned first), or `fasta_path`. Frequencies are computed over residues only (gaps excluded and reported per column); IUPAC ambiguity codes are expanded into their base sets. `small_sample` (default true) subtracts the conventional (K-1)/(2·ln2·n) entropy correction, which matters most for few sequences; `score_type: "frequency"` switches to a plain frequency plot (letters sum to 1, y axis 0-1) instead of bits (0-2). Heuristic visualisation of an alignment — it shows the data you give it, and says nothing about function on its own.',
  parameters: {
    type: 'object',
    properties: {
      alignment: { type: 'array', items: { type: 'string' }, description: 'Pre-aligned sequences of equal length ("-" for gaps).' },
      sequences: { type: 'array', items: { type: 'string' }, description: 'Unaligned IUPAC DNA sequences (2-50; aligned first).' },
      fasta_path: { type: 'string', description: 'Workspace FASTA file with unaligned sequences.' },
      title: { type: 'string', description: 'Title drawn at the top of the logo (default "Sequence logo").' },
      small_sample: { type: 'boolean', description: 'Apply the small-sample entropy correction (default true).' },
      score_type: { type: 'string', enum: ['bits', 'frequency'], description: 'Letter-height scale: information content in bits (default) or plain frequencies.' },
      output_path: { type: 'string', description: 'Optional SVG file path; default logo.svg in the session workspace.' },
      auto_view: { type: 'boolean', description: 'Open the SVG automatically with the OS default application after writing (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['svg_path', 'source', 'sequence_count', 'columns', 'small_sample', 'score_type', 'total_bits', 'mean_bits', 'most_conserved', 'gap_columns', 'auto_viewed'],
    properties: {
      svg_path: { type: 'string' },
      source: { type: 'string', enum: ['msa', 'alignment'] },
      sequence_count: { type: 'integer' },
      columns: { type: 'integer' },
      small_sample: { type: 'boolean' },
      score_type: { type: 'string', enum: ['bits', 'frequency'] },
      total_bits: { type: 'number' },
      mean_bits: { type: 'number' },
      most_conserved: { type: 'integer' },
      gap_columns: { type: 'integer' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    return [
      `sequence logo written to ${value.svg_path} (${value.sequence_count} sequences x ${value.columns} columns, ${value.score_type}${value.small_sample && value.score_type === 'bits' ? ', small-sample corrected' : ''}${value.auto_viewed ? ', opened in the default viewer' : ''})${imageNote(value)}`,
      `total information ${value.total_bits} bits (mean ${value.mean_bits} bits/column); most conserved column ${value.most_conserved}${value.gap_columns > 0 ? `; ${value.gap_columns} column(s) contain gaps (excluded from frequencies)` : ''}`,
    ].join('\n');
  },
  async execute(args, exec) {
    const { rows, source, compositions } = await logoComposition(ctx, exec, args);
    const svg = renderSequenceLogo(compositions, {
      title: args.title ?? 'Sequence logo',
      scoreType: args.score_type === 'frequency' ? 'frequency' : 'bits',
      sequenceCount: rows.length,
      smallSample: args.small_sample !== false,
    });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, args, svg, 'logo.svg');
    const total = compositions.reduce((sum, column) => sum + column.bits, 0);
    const best = compositions.reduce((top, column) => (column.bits > top.bits ? column : top), compositions[0]);
    const round2 = (x) => Math.round(x * 100) / 100;
    return mergeAttachedImage({
      svg_path: file,
      source,
      sequence_count: rows.length,
      columns: compositions.length,
      small_sample: args.small_sample !== false,
      score_type: args.score_type === 'frequency' ? 'frequency' : 'bits',
      total_bits: round2(total),
      mean_bits: round2(total / compositions.length),
      most_conserved: best.column,
      gap_columns: compositions.filter((column) => column.gaps > 0).length,
      auto_viewed: viewed,
    }, attached);
  },
});

/**
 * Resolve the gRNA design target: a raw `sequence` or a `sequence_path` file.
 * Guides are only searchable on unambiguous bases, so a plasmid with N/R/Y
 * runs is rejected with a pointer to the offending position instead of
 * silently skipping PAM sites.
 */
async function crisprTarget(ctx, exec, args) {
  const hasSequence = args.sequence !== undefined && args.sequence !== '';
  const hasPath = args.sequence_path !== undefined && args.sequence_path !== '';
  if (hasSequence === hasPath) {
    throw new MolbioInputError('molbio_grna_design: provide exactly one of "sequence" (raw) or "sequence_path" (a .dna/.gb/FASTA/text file)');
  }
  let sequence;
  let name;
  if (hasSequence) {
    sequence = normalizeSequence(args.sequence, 'sequence');
    name = 'sequence';
  } else {
    const vector = await resolveVector(ctx, exec, { vector_path: args.sequence_path }, 'vector_path');
    sequence = vector.sequence;
    name = vector.name;
  }
  if (sequence.length < 23) {
    throw new MolbioInputError(`the target is only ${sequence.length} bp; a 20 nt protospacer plus a 3 nt PAM needs at least 23 bp`);
  }
  if (sequence.length > CRISPR_LIMITS.maxSequenceLength) {
    throw new MolbioInputError(`the target is ${sequence.length} bp; the limit is ${CRISPR_LIMITS.maxSequenceLength} bp per call (the off-target index and the variant enumeration are both quadratic-ish in this length)`);
  }
  for (let i = 0; i < sequence.length; i++) {
    if (!DNA_BASES.has(sequence[i])) {
      throw new MolbioInputError(`the target contains the ambiguous base ${sequence[i]} at position ${i + 1}; gRNA design needs an unambiguous A/C/G/T target (extract the region or resolve the ambiguity first)`);
    }
  }
  return { sequence, name };
}

const GRNA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rank', 'sequence', 'pam', 'strand', 'start', 'end', 'gc_percent', 'tm_celsius', 'self_any', 'self_end', 'seed_self_any', 'hairpin_tm', 'longest_t_run', 'score'],
  properties: {
    rank: { type: 'integer' },
    sequence: { type: 'string' },
    pam: { type: 'string' },
    strand: { type: 'string', enum: ['forward', 'reverse'] },
    start: { type: 'integer' },
    end: { type: 'integer' },
    gc_percent: { type: 'number' },
    // The harness schema subset has no type unions and forbids `enum`/`const`
    // beside `oneOf`, so "number or null" is a two-branch oneOf with a bare
    // null branch (a `{ type: 'null', const: null }` branch would be rejected).
    tm_celsius: {
      description: 'NN Tm in °C, or null when the model has no physical solution for this sequence.',
      oneOf: [
        { type: 'number' },
        { type: 'null' },
      ],
    },
    self_any: { type: 'number' },
    self_end: { type: 'number' },
    seed_self_any: { type: 'number' },
    hairpin_tm: {
      description: 'Most stable hairpin Tm in °C, or null when the guide has no hairpin.',
      oneOf: [
        { type: 'number' },
        { type: 'null' },
      ],
    },
    longest_t_run: { type: 'integer' },
    score: { type: 'number' },
    off_target_count: { type: 'integer' },
    pam_disrupted_sites: { type: 'integer' },
    notes: { type: 'array', items: { type: 'string' } },
    off_target_sites: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['strand', 'start', 'end', 'pam', 'pam_intact', 'mismatches', 'mismatch_positions'],
        properties: {
          strand: { type: 'string', enum: ['forward', 'reverse'] },
          start: { type: 'integer' },
          end: { type: 'integer' },
          pam: { type: 'string' },
          pam_intact: { type: 'boolean' },
          mismatches: { type: 'integer' },
          mismatch_positions: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
};

const grnaDesignTool = (ctx) => define({
  safe: (args) => (args.save_path === undefined || args.save_path === '') && (args.map_path === undefined || args.map_path === ''),
  name: 'molbio_grna_design',
  description: 'Design CRISPR guide RNAs (SpCas9 default `NGG` PAM) over a target sequence and rank them. Scans BOTH strands for PAM-anchored 20 nt protospacers, then reports per guide: 1-based top-strand coordinates, strand, GC%, NN Tm, Primer3-style self-complementarity (self-any/self-end), seed self-complementarity, hairpin Tm, longest poly-T run, and a documented heuristic score. Hard filters (rejected guides are counted, not returned): GC bounds, poly-T, 3\' self-complementarity, G/C homopolymer runs — tune them with gc_min/gc_max/max_t_run/max_self_end. WITH `check_off_target: true` (default) it also indexes the same sequence (both strands), searches every variant of each of the best `max_off_target_guides` candidates within `max_mismatches` substitutions whose PAM is still intact, and folds the hit count into the score (8 points per off-target); substitution off-targets only — no bulges or indels, and a whole-genome search means passing the genome as the target. Output is a ranked list, optionally a CSV for ordering (`save_path`) and a plasmid map with the guides drawn as features (`map_path`). Every score is a heuristic ranking aid, not a validated efficiency or specificity prediction.',
  parameters: {
    type: 'object',
    properties: {
      sequence: { type: 'string', description: 'Target sequence (IUPAC; must resolve to A/C/G/T only).' },
      sequence_path: { type: 'string', description: 'Target file (.dna/.gb/FASTA/text), alternative to sequence.' },
      pam: { type: 'string', description: 'PAM pattern with a degenerate first position, e.g. "NGG" (default, SpCas9), "NNGRRT" (SaCas9).' },
      guide_length: { type: 'integer', description: 'Protospacer length in nt (default 20).' },
      max_guides: { type: 'integer', description: 'Maximum number of guides returned (default 20).' },
      region_start: { type: 'integer', description: '1-based start of the region to target (default: whole sequence).' },
      region_end: { type: 'integer', description: '1-based inclusive end of the region to target.' },
      gc_min: { type: 'number', description: 'Minimum GC percent (default 40).' },
      gc_max: { type: 'number', description: 'Maximum GC percent (default 70).' },
      tm_min: { type: 'number', description: 'Preferred minimum Tm in °C (default 50).' },
      tm_max: { type: 'number', description: 'Preferred maximum Tm in °C (default 70).' },
      max_t_run: { type: 'integer', description: 'Maximum consecutive T allowed (default 4; longer runs terminate U6 transcription).' },
      max_self_end: { type: 'number', description: 'Maximum accepted 3\' self-complementarity score (default 3).' },
      max_hairpin_tm: { type: 'number', description: 'Hairpin Tm threshold in °C (default 47).' },
      check_off_target: { type: 'boolean', description: 'Search the target for off-target sites (default true).' },
      max_mismatches: { type: 'integer', description: 'Off-target mismatch tolerance, 0-4 (default 2).' },
      max_off_target_guides: { type: 'integer', description: 'How many top candidates get the off-target search (default 200).' },
      save_path: { type: 'string', description: 'Optional CSV path listing the guides for ordering.' },
      map_path: { type: 'string', description: 'Optional SVG path for a plasmid map with the guides drawn on it.' },
      auto_view: { type: 'boolean', description: 'Open the map automatically after writing (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['target_name', 'target_length', 'pam', 'guide_length', 'candidate_count', 'rejected_count', 'off_target_checked', 'off_target_scanned', 'max_mismatches', 'guides', 'guides_truncated', 'saved_to', 'map_path', 'auto_viewed'],
    properties: {
      target_name: { type: 'string' },
      target_length: { type: 'integer' },
      pam: { type: 'string' },
      guide_length: { type: 'integer' },
      candidate_count: { type: 'integer' },
      rejected_count: { type: 'integer' },
      off_target_checked: { type: 'boolean' },
      off_target_scanned: { type: 'integer' },
      max_mismatches: { type: 'integer' },
      guides: { type: 'array', items: GRNA_SCHEMA },
      guides_truncated: { type: 'boolean' },
      saved_to: { type: 'string' },
      map_path: { type: 'string' },
      auto_viewed: { type: 'boolean' },
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.candidate_count} candidate(s) for ${value.pam} over ${value.target_name} (${value.target_length} bp), ${value.rejected_count} filtered out; showing ${value.guides.length}${value.guides_truncated ? ' (more available — raise max_guides)' : ''}`,
    ];
    for (const guide of value.guides) {
      const offTarget = guide.off_target_count === undefined ? '' : `, off-targets ${guide.off_target_count}`;
      const tm = guide.tm_celsius === null ? 'n/a' : `${guide.tm_celsius} °C`;
      lines.push(`  ${guide.rank}. ${guide.sequence} ${guide.pam} (${guide.strand} ${guide.start}-${guide.end}) score ${guide.score} — GC ${guide.gc_percent}%, Tm ${tm}${offTarget}`);
      for (const note of guide.notes ?? []) lines.push(`       note: ${note}`);
      for (const site of guide.off_target_sites ?? []) {
        lines.push(`       off-target: ${site.strand} ${site.start}-${site.end} ${site.pam}${site.pam_intact ? '' : ' (PAM disrupted)'} — ${site.mismatches} mismatch(es) at guide position(s) ${site.mismatch_positions.join(', ') || 'none'}`);
      }
    }
    if (value.saved_to !== '') lines.push(`guide CSV saved to ${value.saved_to}`);
    if (value.map_path !== '') lines.push(`plasmid map with guides written to ${value.map_path}${value.auto_viewed ? ' (opened)' : ''}`);
    lines.push('Ranking is a heuristic: validate top candidates experimentally.');
    if (imageNote(value) !== '') lines.push(imageNote(value).trim());
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { sequence, name } = await crisprTarget(ctx, exec, args);
    validateGrnaOptions(args);
    const result = designGrnas(sequence, {
      pam: args.pam ?? DEFAULT_PAM,
      guideLength: args.guide_length ?? 20,
      maxGuides: args.max_guides ?? 20,
      regionStart: args.region_start ?? 1,
      regionEnd: args.region_end ?? sequence.length,
      gcMin: args.gc_min ?? 40,
      gcMax: args.gc_max ?? 70,
      tmMin: args.tm_min ?? 50,
      tmMax: args.tm_max ?? 70,
      maxTRun: args.max_t_run ?? 4,
      maxSelfEnd: args.max_self_end ?? 3,
      maxHairpinTm: args.max_hairpin_tm ?? 47,
      checkOffTarget: args.check_off_target !== false,
      maxMismatches: args.max_mismatches ?? 2,
      maxOffTargetGuides: args.max_off_target_guides ?? CRISPR_LIMITS.maxOffTargetGuides,
    });
    // `max_guides` truncates the RETURNED list; candidate_count already tells
    // the caller how many existed, so guides_truncated is the explicit signal.
    const guides = result.guides.map((guide, index) => ({
      rank: index + 1,
      sequence: guide.sequence,
      pam: guide.pam,
      strand: guide.strand,
      start: guide.start,
      end: guide.end,
      gc_percent: guide.gc_percent,
      tm_celsius: guide.tm_celsius,
      self_any: guide.self_any,
      self_end: guide.self_end,
      seed_self_any: guide.seed_self_any,
      hairpin_tm: guide.hairpin_tm,
      longest_t_run: guide.longest_t_run,
      score: guide.score,
      ...guide.off_target_count !== undefined ? { off_target_count: guide.off_target_count } : {},
      ...guide.pam_disrupted_sites !== undefined ? { pam_disrupted_sites: guide.pam_disrupted_sites } : {},
      notes: guide.notes,
      ...guide.off_target_sites !== undefined ? { off_target_sites: guide.off_target_sites } : {},
    }));
    let savedTo = '';
    if (args.save_path !== undefined && args.save_path !== '') {
      const fs = fsService(ctx);
      const sandboxPolicyService = ctx.get('sandboxPolicy');
      const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
      const file = workspaceFilePath(args.save_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, guideCsv(guides), policy);
      savedTo = file;
    }
    let mapPath = '';
    let viewed = false;
    let attached;
    if (args.map_path !== undefined && args.map_path !== '') {
      const features = guides.map((guide) => ({
        label: `gRNA ${guide.rank} (${guide.strand === 'forward' ? '+' : '-'})`,
        start: guide.start,
        end: guide.end,
        strand: guide.strand === 'forward' ? 1 : -1,
        type: 'guide',
      }));
      const svg = renderPlasmidMap({
        name: args.map_title ?? `${name} gRNAs`,
        length: sequence.length,
        circular: args.circular !== false,
        features,
        enzymes: [],
      });
      const written = await writeSvgFile(ctx, exec, { output_path: args.map_path, auto_view: args.auto_view, attach_image: args.attach_image }, svg, 'grna-map.svg');
      mapPath = written.file;
      viewed = written.viewed;
      attached = written.attached;
    }
    return mergeAttachedImage({
      target_name: name,
      target_length: sequence.length,
      pam: result.pam,
      guide_length: result.guide_length,
      candidate_count: result.candidate_count,
      rejected_count: result.rejected_count,
      off_target_checked: args.check_off_target !== false,
      off_target_scanned: result.off_target_scanned,
      max_mismatches: args.max_mismatches ?? 2,
      guides,
      guides_truncated: result.guides.length < result.accepted_count,
      saved_to: savedTo,
      map_path: mapPath,
      auto_viewed: viewed,
    }, attached);
  },
});

/** CSV of the returned guides, for pasting into an ordering sheet. */
function guideCsv(guides) {
  const header = 'rank,sequence,pam,strand,start,end,gc_percent,tm_celsius,self_any,self_end,longest_t_run,off_target_count,score';
  const rows = guides.map((guide) => [
    guide.rank,
    guide.sequence,
    guide.pam,
    guide.strand,
    guide.start,
    guide.end,
    guide.gc_percent,
    guide.tm_celsius === null ? '' : guide.tm_celsius,
    guide.self_any,
    guide.self_end,
    guide.longest_t_run,
    guide.off_target_count ?? '',
    guide.score,
  ].join(','));
  return `${[header, ...rows].join('\n')}\n`;
}

/** Range checks for the gRNA options (the schema only checks types/enums). */
function validateGrnaOptions(args) {
  const integer = (value, min, max, label) => {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new MolbioInputError(`${label} must be an integer between ${min} and ${max} (got ${value})`);
    }
  };
  integer(args.guide_length, 15, 30, 'guide_length');
  integer(args.max_guides, 1, 200, 'max_guides');
  integer(args.max_t_run, 1, 10, 'max_t_run');
  integer(args.max_mismatches, 0, CRISPR_LIMITS.maxMismatches, 'max_mismatches');
  integer(args.max_off_target_guides, 0, CRISPR_LIMITS.maxOffTargetGuides, 'max_off_target_guides');
  integer(args.region_start, 1, 1_000_000_000, 'region_start');
  integer(args.region_end, 1, 1_000_000_000, 'region_end');
  const range = (value, min, max, label) => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new MolbioInputError(`${label} must be a number between ${min} and ${max} (got ${value})`);
    }
  };
  range(args.gc_min, 0, 100, 'gc_min');
  range(args.gc_max, 0, 100, 'gc_max');
  range(args.tm_min, 0, 120, 'tm_min');
  range(args.tm_max, 0, 120, 'tm_max');
  range(args.max_self_end, 0, 40, 'max_self_end');
  range(args.max_hairpin_tm, 0, 120, 'max_hairpin_tm');
  if (args.gc_min !== undefined && args.gc_max !== undefined && args.gc_min > args.gc_max) {
    throw new MolbioInputError(`gc_min (${args.gc_min}) must not exceed gc_max (${args.gc_max})`);
  }
}

const fastaFastqTool = (ctx) => define({
  safe: (args) => args.action !== 'convert' && args.action !== 'extract',
  name: 'molbio_fasta_fastq',
  description: 'Work with FASTA/FASTQ files in the workspace. action=stats: per-entry and overall statistics (length/GC). action=extract: pull entries by id (exact or substring) and optionally write them to a FASTA file. action=convert: FASTQ → FASTA (output_path required). action=qc: FASTQ quality statistics (mean/min/max Phred, low-quality fraction, per-position means).',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: requiredString('Path to the .fasta/.fa/.fastq/.fq file.'),
      action: { type: 'string', enum: ['stats', 'extract', 'convert', 'qc'], description: 'What to do; default "stats".' },
      id: { type: 'string', description: 'Entry id (exact or substring) for action=extract.' },
      output_path: { type: 'string', description: 'FASTA output file for extract/convert.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'format', 'entries', 'stats', 'saved_to'],
    properties: {
      action: { type: 'string', enum: ['stats', 'extract', 'convert', 'qc'] },
      format: { type: 'string', enum: ['fasta', 'fastq'] },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'length', 'gc_percent'],
          properties: {
            id: { type: 'string' },
            length: { type: 'integer' },
            gc_percent: { type: 'number' },
            sequence: { type: 'string' },
          },
        },
      },
      stats: {
        type: 'object',
        additionalProperties: false,
        required: ['entries', 'total_bases', 'min_length', 'max_length', 'mean_length', 'gc_percent'],
        properties: {
          entries: { type: 'integer' },
          total_bases: { type: 'integer' },
          min_length: { type: 'integer' },
          max_length: { type: 'integer' },
          mean_length: { type: 'number' },
          gc_percent: { type: 'number' },
          quality_mean: { type: 'number' },
          quality_min: { type: 'integer' },
          quality_max: { type: 'integer' },
          low_quality_fraction: { type: 'number' },
          quality_per_position_mean: { type: 'array', items: { type: 'number' } },
        },
      },
      saved_to: { type: 'string' },
    },
  },
  render(value) {
    const s = value.stats;
    const lines = [
      `${value.format} ${value.action}: ${s.entries} entries, ${s.total_bases} bases, lengths ${s.min_length}-${s.max_length} (mean ${s.mean_length}), GC ${s.gc_percent}%`,
    ];
    if (s.quality_mean !== undefined) lines.push(`quality: mean ${s.quality_mean}, min ${s.quality_min}, max ${s.quality_max}, low-quality (<20) fraction ${s.low_quality_fraction}`);
    if (value.action === 'extract') {
      for (const entry of value.entries) lines.push(`  ${entry.id} (${entry.length} bp, GC ${entry.gc_percent}%)${entry.sequence !== undefined ? ': ' + entry.sequence : ''}`);
    } else if (value.entries.length > 0 && value.entries.length <= 20) {
      for (const entry of value.entries) lines.push(`  ${entry.id} (${entry.length} bp, GC ${entry.gc_percent}%)`);
    }
    if (value.saved_to !== undefined && value.saved_to !== '') lines.push(`saved to ${value.saved_to}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const action = args.action ?? 'stats';
    const bytes = await readFileBytes(ctx, exec, args.path);
    const text = new TextDecoder().decode(bytes);
    const first = text.replace(/^\uFEFF/, '').trimStart();
    const isFasta = first.startsWith('>');
    const parsed = isFasta ? parseFasta(text) : parseFastq(text);
    const format = isFasta ? 'fasta' : 'fastq';
    if (action === 'qc' && format !== 'fastq') throw new MolbioInputError('action=qc needs a FASTQ file');
    let savedTo = '';
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    if (action === 'extract') {
      if (args.id === undefined || args.id === '') throw new MolbioInputError('action=extract needs an id');
      const exact = parsed.filter((entry) => entry.id === args.id);
      const matches = exact.length > 0 ? exact : parsed.filter((entry) => entry.id.includes(args.id));
      const outEntries = matches.map((entry) => ({
        id: entry.id,
        length: entry.sequence.length,
        gc_percent: gcPercentOf(entry.sequence),
        sequence: entry.sequence,
      }));
      if (args.output_path !== undefined && args.output_path !== '') {
        const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
        await writeWorkspaceFile(fs, file, toFasta(matches), policy);
        savedTo = file;
      }
      return {
        action,
        format,
        entries: outEntries.slice(0, 100),
        stats: entryStats(parsed),
        saved_to: savedTo,
      };
    }
    if (action === 'convert') {
      if (args.output_path === undefined || args.output_path === '') throw new MolbioInputError('action=convert needs an output_path');
      const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, toFasta(parsed), policy);
      return {
        action,
        format,
        entries: parsed.slice(0, 100).map((entry) => ({
          id: entry.id,
          length: entry.sequence.length,
          gc_percent: gcPercentOf(entry.sequence),
        })),
        stats: entryStats(parsed),
        saved_to: file,
      };
    }
    return {
      action,
      format,
      entries: parsed.slice(0, 100).map((entry) => ({
        id: entry.id,
        length: entry.sequence.length,
        gc_percent: gcPercentOf(entry.sequence),
      })),
      stats: entryStats(parsed, action === 'qc'),
      saved_to: '',
    };
  },
});

function gcPercentOf(sequence) {
  let gc = 0;
  let at = 0;
  for (const base of sequence) {
    if (base === 'G' || base === 'C') gc++;
    else if (base === 'A' || base === 'T') at++;
  }
  return gc + at === 0 ? 0 : Math.round((gc / (gc + at)) * 1000) / 10;
}

const extractRegionTool = (ctx) => define({
  safe: (args) => args.output_path === undefined || args.output_path === '',
  name: 'molbio_extract_region',
  description: 'Extract a sub-sequence from a plasmid (a .dna/.gb file or a raw sequence) by coordinates and/or feature name — e.g. pull a CDS, a promoter, or the MCS for downstream cloning or design. Optionally return the reverse complement and save the region as FASTA.',
  parameters: {
    type: 'object',
    properties: {
      source_path: { type: 'string', description: 'Path to a .dna/.gb plasmid file (alternative to sequence).' },
      sequence: { type: 'string', description: 'Raw sequence (alternative to source_path).' },
      feature: { type: 'string', description: 'Feature label to extract (e.g. "AmpR", "MCS"); overrides start/end.' },
      start: { type: 'integer', description: '1-based start (used when feature is not given).' },
      end: { type: 'integer', description: '1-based inclusive end.' },
      complement: { type: 'boolean', description: 'Return the reverse complement (e.g. the coding strand of a reverse-strand feature).' },
      output_path: { type: 'string', description: 'Optional FASTA output file in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'start', 'end', 'length', 'sequence', 'complement', 'saved_to'],
    properties: {
      source: { type: 'string' },
      feature_label: { type: 'string' },
      start: { type: 'integer' },
      end: { type: 'integer' },
      length: { type: 'integer' },
      sequence: { type: 'string' },
      complement: { type: 'boolean' },
      saved_to: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `extracted ${value.source}${value.feature_label !== undefined ? ' feature ' + JSON.stringify(value.feature_label) : ''} ${value.start}-${value.end} (${value.length} bp${value.complement ? ', reverse complement' : ''}):`,
      value.sequence,
    ];
    if (value.saved_to !== '') lines.push(`saved to ${value.saved_to}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const vector = await resolveVector(ctx, exec, args, 'source_path');
    let start;
    let end;
    let featureLabel;
    if (args.feature !== undefined && args.feature !== '') {
      const label = args.feature.toLowerCase();
      const matches = vector.features.filter((f) => f.label.toLowerCase().includes(label));
      if (matches.length === 0) throw new MolbioInputError(`no feature matches ${JSON.stringify(args.feature)}; available: ${vector.features.map((f) => f.label).join(', ') || '(none)'}`);
      const exact = matches.find((f) => f.label.toLowerCase() === label) ?? matches[0];
      start = exact.start;
      end = exact.end;
      featureLabel = exact.label;
    } else {
      if (args.start === undefined || args.end === undefined) throw new MolbioInputError('provide feature, or start and end');
      start = args.start;
      end = args.end;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > vector.sequence.length || start > end) {
      throw new MolbioInputError(`invalid span ${start}-${end} (source length ${vector.sequence.length})`);
    }
    let fragment = vector.sequence.slice(start - 1, end);
    if (args.complement === true) fragment = reverseComplement(fragment);
    let savedTo = '';
    if (args.output_path !== undefined && args.output_path !== '') {
      const fs = fsService(ctx);
      const sandboxPolicyService = ctx.get('sandboxPolicy');
      const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
      const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, `>${vector.name}_${start}-${end}\n${fragment}\n`, policy);
      savedTo = file;
    }
    return {
      source: vector.name,
      ...featureLabel !== undefined ? { feature_label: featureLabel } : {},
      start,
      end,
      length: fragment.length,
      sequence: fragment,
      complement: args.complement === true,
      saved_to: savedTo,
    };
  },
});

// ── v19: bench analysis (FASTQ QC, codon usage, phylogeny, PCR, GC/CpG) ─────
// ── v19: bench analysis (FASTQ QC, codon usage, phylogeny, PCR, GC/CpG) ─────

const PCR_SITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end', 'mismatches', 'mismatch_positions'],
  properties: {
    start: { type: 'integer' },
    end: { type: 'integer' },
    mismatches: { type: 'integer' },
    mismatch_positions: { type: 'array', items: { type: 'integer' } },
  },
};

const PCR_AMPLICON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['size', 'forward_site', 'reverse_site', 'total_mismatches', 'wraps_origin', 'in_range', 'sequence'],
  properties: {
    size: { type: 'integer' },
    forward_site: PCR_SITE_SCHEMA,
    reverse_site: PCR_SITE_SCHEMA,
    total_mismatches: { type: 'integer' },
    wraps_origin: { type: 'boolean' },
    in_range: { type: 'boolean' },
    sequence: { type: 'string' },
  },
};

const PCR_PAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'forward', 'reverse', 'forward_sites', 'reverse_sites', 'amplicons', 'amplicon_count', 'truncated', 'out_of_range', 'on_target_count', 'off_target_count', 'verdict'],
  properties: {
    name: { type: 'string' },
    forward: { type: 'string' },
    reverse: { type: 'string' },
    forward_sites: { type: 'array', items: { type: 'object', additionalProperties: true } },
    reverse_sites: { type: 'array', items: { type: 'object', additionalProperties: true } },
    amplicons: { type: 'array', items: PCR_AMPLICON_SCHEMA },
    amplicon_count: { type: 'integer' },
    truncated: { type: 'boolean' },
    out_of_range: { type: 'integer' },
    on_target_count: { type: 'integer' },
    off_target_count: { type: 'integer' },
    verdict: { type: 'string', enum: ['specific', 'specific_with_mismatches', 'multiple_bands', 'no_product'] },
    // Optional: a pair with no product has nothing to point at (a JSON value
    // cannot be `undefined` at a required key).
    best_amplicon: PCR_AMPLICON_SCHEMA,
  },
};

const PCR_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['template_length', 'circular', 'pairs', 'screens', 'settings', 'verdicts', 'gel_path', 'auto_viewed'],
  properties: {
    template_length: { type: 'integer' },
    circular: { type: 'boolean' },
    pairs: { type: 'array', items: PCR_PAIR_SCHEMA },
    screens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'products'],
        properties: {
          name: { type: 'string' },
          products: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['pair', 'amplicon_count', 'sizes', 'verdict'],
              properties: {
                pair: { type: 'string' },
                amplicon_count: { type: 'integer' },
                sizes: { type: 'array', items: { type: 'integer' } },
                verdict: { type: 'string' },
              },
            },
          },
        },
      },
    },
    settings: {
      type: 'object',
      additionalProperties: false,
      required: ['mismatches', 'three_prime_exact', 'min_size', 'max_size', 'circular'],
      properties: {
        mismatches: { type: 'integer' },
        three_prime_exact: { type: 'integer' },
        min_size: { type: 'integer' },
        max_size: { type: 'integer' },
        circular: { type: 'boolean' },
      },
    },
    verdicts: { type: 'array', items: { type: 'string' } },
    gel_path: { type: 'string' },
    auto_viewed: { type: 'boolean' },
  },
};

const PCR_PAIR_IN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['forward', 'reverse'],
  properties: {
    name: { type: 'string' },
    forward: { type: 'string' },
    reverse: { type: 'string' },
  },
};

const pcrSimulateTool = (ctx) => define({
  safe: false,
  name: 'molbio_pcr_simulate',
  description: 'In-silico PCR: find every amplicon a primer pair produces on a template, searching both strands, with product sizes, coordinates and mismatch detail. Answers "where else will this pair amplify, and what band should I see". Mismatch tolerance (`max_mismatches`) and the exact-match requirement at the primer 3\' end (`three_prime_exact`, default 3 bases) are separate knobs, because a middle mismatch still extends while a 3\' mismatch usually does not. Handles circular templates (products across the origin) and can screen extra templates such as a vector. Draws the expected gel with the same renderer as molbio_virtual_gel.',
  parameters: {
    type: 'object',
    properties: {
      template: { type: 'string', description: 'Template sequence (both strands are searched).' },
      path: { type: 'string', description: 'Workspace path to a FASTA/sequence file, instead of `template`.' },
      primer_pairs: { type: 'array', items: PCR_PAIR_IN_SCHEMA, description: 'Primer pairs, each {name?, forward, reverse} written 5\'->3\' as ordered.' },
      max_mismatches: { type: 'integer', description: 'Mismatches allowed per primer (default 0).' },
      three_prime_exact: { type: 'integer', description: 'Bases at the primer\'s 3\' end that must match exactly (default 3); 0 ignores the 3\' end.' },
      min_size: { type: 'integer', description: 'Smallest product to report (default 0).' },
      max_size: { type: 'integer', description: 'Largest product to report (default 100000).' },
      circular: { type: 'boolean', description: 'Treat the template as circular so a product can cross the origin (default false).' },
      max_products: { type: 'integer', description: 'Cap on reported products per pair (default 200).' },
      include_sequence: { type: 'boolean', description: 'Return each product sequence inline (default true; products longer than 5000 bp are left empty with their size).' },
      screen_templates: {
        type: 'array',
        description: 'Extra templates to screen the same pairs against (e.g. a vector backbone): [{name, sequence, circular?}].',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'sequence'],
          properties: {
            name: { type: 'string' },
            sequence: { type: 'string' },
            circular: { type: 'boolean' },
          },
        },
      },
      gel_path: { type: 'string', description: 'SVG gel path; default pcr-gel.svg in the workspace.' },
      auto_view: { type: 'boolean', description: 'Open the gel automatically with the OS default application (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [...PCR_TOOL_SCHEMA.required],
    properties: {
      ...PCR_TOOL_SCHEMA.properties,
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.template_length} bp ${value.circular ? 'circular' : 'linear'} template; mismatch tolerance ${value.settings.mismatches}, 3' exact match ${value.settings.three_prime_exact} base(s), size window ${value.settings.min_size}-${value.settings.max_size} bp`,
    ];
    for (const pair of value.pairs) {
      const sizes = pair.amplicons.map((amplicon) => amplicon.size);
      lines.push(`${pair.name}: ${pair.verdict.replace(/_/g, ' ')} — ${pair.forward_sites.length} forward site(s), ${pair.reverse_sites.length} reverse site(s), ${pair.amplicon_count} product(s)${sizes.length === 0 ? '' : ` of ${sizes.join(', ')} bp`}`);
      for (const amplicon of pair.amplicons.slice(0, 8)) {
        lines.push(`  ${amplicon.size} bp: ${amplicon.forward_site.start}-${amplicon.forward_site.end} → ${amplicon.reverse_site.start}-${amplicon.reverse_site.end}${amplicon.wraps_origin ? ' (crosses the origin)' : ''}${amplicon.total_mismatches === 0 ? '' : `, ${amplicon.total_mismatches} mismatch(es)`}`);
      }
      if (pair.truncated) lines.push(`  more products exist than the listing cap (${pair.amplicon_count} shown)`);
      if (pair.out_of_range > 0) lines.push(`  ${pair.out_of_range} product(s) fell outside the size window`);
    }
    for (const screen of value.screens) {
      const hits = screen.products.filter((entry) => entry.amplicon_count > 0);
      lines.push(`screen ${screen.name}: ${hits.length === 0 ? 'no pair amplifies' : hits.map((entry) => `${entry.pair} (${entry.sizes.join(', ')} bp)`).join('; ')}`);
    }
    lines.push(`expected gel written to ${value.gel_path}`);
    return lines.join('\n') + imageNote(value);
  },
  async execute(args, exec) {
    if ((args.template === undefined || args.template === '') === (args.path === undefined || args.path === '')) {
      throw new MolbioInputError('provide exactly one of template (a sequence) or path (a workspace file)');
    }
    let templateText;
    if (args.template !== undefined && args.template !== '') {
      templateText = args.template;
    } else {
      const text = new TextDecoder().decode(await readFileBytes(ctx, exec, args.path));
      templateText = text.replace(/^\uFEFF/, '').trimStart().startsWith('>') ? parseFasta(text)[0].sequence : text;
    }
    const outcome = simulatePcr(templateText, args.primer_pairs ?? [], {
      mismatches: args.max_mismatches ?? PCR_DEFAULTS.mismatches,
      three_prime_exact: args.three_prime_exact ?? PCR_DEFAULTS.three_prime_exact,
      min_size: args.min_size ?? PCR_DEFAULTS.min_size,
      max_size: args.max_size ?? PCR_DEFAULTS.max_size,
      max_products: args.max_products ?? PCR_DEFAULTS.max_products,
      max_returned_sequence: args.include_sequence === false ? 0 : PCR_DEFAULTS.max_returned_sequence,
      circular: args.circular === true,
      screen_templates: args.screen_templates ?? [],
    });
    const gel = pcrGel(outcome.pairs, { title: `In-silico PCR (${outcome.template_length} bp${outcome.circular ? ', circular' : ''})` });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, { ...args, output_path: args.gel_path ?? 'pcr-gel.svg' }, gel, 'pcr-gel');
    return mergeAttachedImage({
      ...outcome,
      verdicts: outcome.pairs.map((pair) => pair.verdict),
      gel_path: file,
      auto_viewed: viewed,
    }, attached);
  },
});

const GC_ISLAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end', 'length', 'gc_percent', 'cpg_observed', 'cpg_expected', 'cpg_oe'],
  properties: {
    start: { type: 'integer' },
    end: { type: 'integer' },
    length: { type: 'integer' },
    gc_percent: { type: 'number' },
    cpg_observed: { type: 'integer' },
    cpg_expected: { type: 'number' },
    cpg_oe: { type: 'number' },
  },
};

const COMPOSITION_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['length', 'gc_percent', 'at_percent', 'n_percent', 'gc_windows', 'gc_skew_windows', 'at_skew_windows', 'cumulative_gc_skew', 'cumulative_at_skew', 'ori_hint', 'ter_hint', 'cpg_islands', 'criteria', 'observed_expected_cpg', 'dinucleotides', 'top_words', 'entropy_bits', 'linguistic_complexity', 'n50', 'l50', 'notes', 'svg_path', 'auto_viewed'],
  properties: {
    length: { type: 'integer' },
    gc_percent: { type: 'number' },
    at_percent: { type: 'number' },
    n_percent: { type: 'number' },
    gc_windows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'gc_percent'],
        properties: {
          start: { type: 'integer' },
          end: { type: 'integer' },
          gc_percent: { type: 'number' },
        },
      },
    },
    gc_skew_windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
    at_skew_windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
    cumulative_gc_skew: { type: 'array', items: { type: 'number' } },
    cumulative_at_skew: { type: 'array', items: { type: 'number' } },
    ori_hint: { type: 'object', additionalProperties: true },
    ter_hint: { type: 'object', additionalProperties: true },
    cpg_islands: { type: 'array', items: GC_ISLAND_SCHEMA },
    criteria: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'window', 'min_length', 'gc_threshold', 'cpg_oe_threshold', 'reference'],
      properties: {
        name: { type: 'string' },
        window: { type: 'integer' },
        min_length: { type: 'integer' },
        gc_threshold: { type: 'number' },
        cpg_oe_threshold: { type: 'number' },
        reference: { type: 'string' },
      },
    },
    observed_expected_cpg: { type: 'number' },
    dinucleotides: { type: 'array', items: { type: 'object', additionalProperties: true } },
    top_words: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['word', 'length', 'count', 'frequency_per_kb'],
        properties: {
          word: { type: 'string' },
          length: { type: 'integer' },
          count: { type: 'integer' },
          frequency_per_kb: { type: 'number' },
        },
      },
    },
    entropy_bits: { type: 'number' },
    linguistic_complexity: { type: 'number' },
    n50: { type: 'integer' },
    l50: { type: 'integer' },
    notes: { type: 'array', items: { type: 'string' } },
    svg_path: { type: 'string' },
    auto_viewed: { type: 'boolean' },
  },
};

const gcCompositionTool = (ctx) => define({
  safe: false,
  name: 'molbio_gc_composition',
  description: 'GC composition analysis: sliding-window GC, CpG island detection (Gardiner-Garden & Frommer 1987 by default, Takai & Jones 2002 optional), GC and AT skew with cumulative skew as the conventional origin/terminus indicator, dinucleotide observed/expected, word frequencies, Shannon entropy, linguistic complexity and N50/L50, plus a three-panel SVG. Use it for "is this a promoter region", "where is the origin of replication", and general composition questions. Every threshold is stated in the result, and the skew hints are labelled as indicators, not calls.',
  parameters: {
    type: 'object',
    properties: {
      sequence: { type: 'string', description: 'DNA sequence.' },
      path: { type: 'string', description: 'Workspace FASTA/sequence file, instead of `sequence`.' },
      window: { type: 'integer', description: 'Window length in bp for GC and skew (default 100).' },
      step: { type: 'integer', description: 'Step between windows (default = window, i.e. non-overlapping).' },
      criteria: { type: 'string', enum: ['gardiner', 'takai'], description: 'CpG island criteria: gardiner (>=200 bp, GC > 50, obs/exp > 0.6) or takai (>=500 bp, GC > 55, obs/exp > 0.65). Default gardiner.' },
      min_length: { type: 'integer', description: 'Override the minimum island length.' },
      gc_threshold: { type: 'number', description: 'Override the GC percent threshold for an island.' },
      cpg_oe_threshold: { type: 'number', description: 'Override the observed/expected CpG threshold for an island.' },
      top_words: { type: 'integer', description: 'How many of the most frequent words to report (default 20).' },
      svg_path: { type: 'string', description: 'SVG output path; default gc-composition.svg in the workspace.' },
      auto_view: { type: 'boolean', description: 'Open the SVG automatically with the OS default application (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [...COMPOSITION_TOOL_SCHEMA.required],
    properties: {
      ...COMPOSITION_TOOL_SCHEMA.properties,
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.length} bp: GC ${value.gc_percent}%, AT ${value.at_percent}%, N ${value.n_percent}%`,
      `CpG observed/expected ${value.observed_expected_cpg}; ${value.cpg_islands.length} CpG island(s) by the ${value.criteria.name} criteria (window ${value.criteria.window}, >=${value.criteria.min_length} bp, GC > ${value.criteria.gc_threshold}%, obs/exp > ${value.criteria.cpg_oe_threshold})`,
    ];
    for (const island of value.cpg_islands.slice(0, 10)) {
      lines.push(`  island ${island.start}-${island.end} (${island.length} bp): GC ${island.gc_percent}%, CpG obs/exp ${island.cpg_oe}`);
    }
    if (value.ori_hint !== undefined && value.ori_hint.position !== undefined) {
      lines.push(`cumulative GC skew minimum at ${value.ori_hint.position} (${value.ori_hint.value}) — the conventional ori indicator; maximum at ${value.ter_hint.position} (${value.ter_hint.value})`);
    }
    lines.push(`entropy ${value.entropy_bits} bits/base, linguistic complexity ${value.linguistic_complexity}, N50 ${value.n50}, L50 ${value.l50}`);
    for (const note of value.notes) lines.push(`note: ${note}`);
    lines.push(`figure written to ${value.svg_path}`);
    return lines.join('\n') + imageNote(value);
  },
  async execute(args, exec) {
    if ((args.sequence === undefined || args.sequence === '') === (args.path === undefined || args.path === '')) {
      throw new MolbioInputError('provide exactly one of sequence or path');
    }
    let text;
    if (args.sequence !== undefined && args.sequence !== '') {
      text = args.sequence;
    } else {
      const raw = new TextDecoder().decode(await readFileBytes(ctx, exec, args.path));
      text = raw.replace(/^\uFEFF/, '').trimStart().startsWith('>') ? parseFasta(raw)[0].sequence : raw;
    }
    const report = gcComposition(text, {
      ...args.window === undefined ? {} : { window: args.window },
      ...args.step === undefined ? {} : { step: args.step },
      ...args.criteria === undefined ? {} : { criteria: args.criteria },
      ...args.min_length === undefined ? {} : { min_length: args.min_length },
      ...args.gc_threshold === undefined ? {} : { gc_threshold: args.gc_threshold },
      ...args.cpg_oe_threshold === undefined ? {} : { cpg_oe_threshold: args.cpg_oe_threshold },
      ...args.top_words === undefined ? {} : { top_words: args.top_words },
    });
    const svg = renderCompositionSvg(report, { title: 'GC composition' });
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, { ...args, output_path: args.svg_path ?? 'gc-composition.svg' }, svg, 'gc-composition');
    return mergeAttachedImage({ ...report, svg_path: file, auto_viewed: viewed }, attached);
  },
});

const FASTQ_QC_PER_BASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'observations', 'mean', 'median', 'lower_quartile', 'upper_quartile', 'percentile_10', 'percentile_90', 'min', 'max', 'a_percent', 'c_percent', 'g_percent', 't_percent', 'n_percent'],
  properties: {
    position: { type: 'integer' },
    observations: { type: 'integer' },
    mean: { type: 'number' },
    median: { type: 'number' },
    lower_quartile: { type: 'number' },
    upper_quartile: { type: 'number' },
    percentile_10: { type: 'number' },
    percentile_90: { type: 'number' },
    min: { type: 'number' },
    max: { type: 'number' },
    a_percent: { type: 'number' },
    c_percent: { type: 'number' },
    g_percent: { type: 'number' },
    t_percent: { type: 'number' },
    n_percent: { type: 'number' },
  },
};

const FASTQ_QC_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reads', 'reads_total', 'truncated', 'bases', 'length', 'gc_percent', 'n_bases', 'n_percent', 'quality_mean', 'quality_q20_percent', 'quality_q30_percent', 'quality_tail_below_30', 'quality_tail_below_20', 'per_base', 'per_sequence_quality', 'gc_distribution', 'content_entropy_bits', 'duplication', 'adapter', 'overrepresented', 'thresholds'],
  properties: {
    reads: { type: 'integer' },
    reads_total: { type: 'integer' },
    truncated: { type: 'boolean' },
    bases: { type: 'integer' },
    length: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max', 'mean', 'median', 'n50', 'distinct_lengths', 'histogram'],
      properties: {
        min: { type: 'integer' },
        max: { type: 'integer' },
        mean: { type: 'number' },
        median: { type: 'number' },
        n50: { type: 'integer' },
        distinct_lengths: { type: 'integer' },
        histogram: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to', 'reads'],
            properties: {
              from: { type: 'integer' },
              to: { type: 'integer' },
              reads: { type: 'integer' },
            },
          },
        },
      },
    },
    gc_percent: { type: 'number' },
    n_bases: { type: 'integer' },
    n_percent: { type: 'number' },
    quality_mean: { type: 'number' },
    quality_q20_percent: { type: 'number' },
    quality_q30_percent: { type: 'number' },
    quality_tail_below_30: { type: 'integer' },
    quality_tail_below_20: { type: 'integer' },
    per_base: { type: 'array', items: FASTQ_QC_PER_BASE_SCHEMA },
    per_sequence_quality: {
      type: 'object',
      additionalProperties: false,
      required: ['histogram', 'mean', 'median', 'worst', 'best'],
      properties: {
        histogram: { type: 'array', items: { type: 'integer' } },
        mean: { type: 'number' },
        median: { type: 'number' },
        worst: { type: 'number' },
        best: { type: 'number' },
      },
    },
    gc_distribution: {
      type: 'object',
      additionalProperties: false,
      required: ['measured_percent', 'theoretical_percent', 'theoretical_model'],
      properties: {
        measured_percent: { type: 'array', items: { type: 'number' } },
        theoretical_percent: { type: 'array', items: { type: 'number' } },
        theoretical_model: { type: 'string' },
      },
    },
    content_entropy_bits: { type: 'number' },
    duplication: {
      type: 'object',
      additionalProperties: false,
      required: ['sampled_reads', 'unique_sequences', 'duplicate_reads', 'duplicate_groups', 'duplication_percent', 'remaining_percent', 'top_sequences', 'basis', 'estimate_only'],
      properties: {
        sampled_reads: { type: 'integer' },
        unique_sequences: { type: 'integer' },
        duplicate_reads: { type: 'integer' },
        duplicate_groups: { type: 'integer' },
        duplication_percent: { type: 'number' },
        remaining_percent: { type: 'number' },
        top_sequences: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sequence', 'count', 'percent'],
            properties: {
              sequence: { type: 'string' },
              count: { type: 'integer' },
              percent: { type: 'number' },
            },
          },
        },
        basis: { type: 'string' },
        estimate_only: { type: 'boolean' },
      },
    },
    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['sampled_reads', 'hits', 'reads_with_adapter', 'per_base_percent'],
      properties: {
        sampled_reads: { type: 'integer' },
        hits: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'sequence', 'reads', 'percent'],
            properties: {
              name: { type: 'string' },
              sequence: { type: 'string' },
              reads: { type: 'integer' },
              percent: { type: 'number' },
            },
          },
        },
        reads_with_adapter: { type: 'integer' },
        per_base_percent: { type: 'array', items: { type: 'number' } },
      },
    },
    overrepresented: {
      type: 'object',
      additionalProperties: false,
      required: ['sampled_reads', 'minimum_count', 'rows', 'basis', 'minimum_fraction'],
      properties: {
        sampled_reads: { type: 'integer' },
        minimum_count: { type: 'integer' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sequence', 'count', 'percent', 'possible_source'],
            properties: {
              sequence: { type: 'string' },
              count: { type: 'integer' },
              percent: { type: 'number' },
              possible_source: { type: 'string' },
            },
          },
        },
        basis: { type: 'string' },
        minimum_fraction: { type: 'number' },
      },
    },
    thresholds: {
      type: 'object',
      additionalProperties: false,
      required: ['q30_good', 'q20_acceptable', 'adapter_list', 'duplication_note'],
      properties: {
        q30_good: { type: 'integer' },
        q20_acceptable: { type: 'integer' },
        adapter_list: { type: 'array', items: { type: 'string' } },
        duplication_note: { type: 'string' },
      },
    },
    report_path: { type: 'string' },
    auto_viewed: { type: 'boolean' },
  },
};

const fastqQcTool = (ctx) => define({
  safe: false,
  name: 'molbio_fastq_qc',
  description: 'Read-level quality control for a FASTQ file (FastQC-style, but every number is returned as data, not only drawn): per-base quality with quartiles, per-sequence quality, per-base A/C/G/T/N content, per-sequence GC against the theoretical normal, read-length distribution, exact-sequence duplication, over-represented sequences, and an adapter-content screen against a built-in public fragment list. Also writes a multi-panel SVG report into the workspace. Use it to answer "is this sequencing run good, and where does quality fall off".',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to a .fastq/.fq file in the session workspace.' },
      fastq: { type: 'string', description: 'Inline FASTQ text, when the reads are already in the conversation and there is no file.' },
      max_reads: { type: 'integer', description: 'Analyse at most this many reads (default 0 = all, capped at 200000).' },
      max_plot_bases: { type: 'integer', description: 'Bases shown on the per-position plots (default 150).' },
      duplication_reads: { type: 'integer', description: 'Reads used for the duplication estimate (default 100000).' },
      overrepresented_reads: { type: 'integer', description: 'Reads sampled for the over-represented-sequence scan (default 50000). Its minimum count is max(20, 0.1% of the sample), so a small sample legitimately reports nothing.' },
      output_path: { type: 'string', description: 'SVG report path; default <input>.qc.svg in the workspace.' },
      auto_view: { type: 'boolean', description: 'Open the report automatically with the OS default application (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [...FASTQ_QC_TOOL_SCHEMA.required],
    properties: {
      ...FASTQ_QC_TOOL_SCHEMA.properties,
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.reads} read(s)${value.truncated ? ` sampled from ${value.reads_total}` : ''}, ${value.bases} bases, lengths ${value.length.min}-${value.length.max} (mean ${value.length.mean}, N50 ${value.length.n50})`,
      `quality: mean Phred ${value.quality_mean}, Q30 ${value.quality_q30_percent}%, Q20 ${value.quality_q20_percent}%`,
      value.quality_tail_below_30 === 0
        ? 'per-base mean quality never drops below Q30'
        : `per-base mean quality drops below Q30 from position ${value.quality_tail_below_30}${value.quality_tail_below_20 === 0 ? '' : ` (below Q20 from ${value.quality_tail_below_20})`}`,
      `GC ${value.gc_percent}%, N ${value.n_percent}%, content entropy ${value.content_entropy_bits} bits`,
      `duplication: ${value.duplication.duplication_percent}% of reads duplicated, ${value.duplication.remaining_percent}% unique (${value.duplication.basis})`,
    ];
    if (value.adapter.hits.length === 0) {
      lines.push(`adapter content: no fragment from the built-in list found in ${value.adapter.sampled_reads} sampled reads`);
    } else {
      lines.push(`adapter content: ${value.adapter.hits.map((hit) => `${hit.name} ${hit.percent}%`).join(', ')}`);
    }
    if (value.overrepresented.rows.length > 0) {
      lines.push(`over-represented sequences: ${value.overrepresented.rows.length} above ${value.overrepresented.minimum_count} reads (top: ${value.overrepresented.rows[0].percent}%${value.overrepresented.rows[0].possible_source === 'unknown' ? '' : ', ' + value.overrepresented.rows[0].possible_source})`);
    }
    if (value.report_path !== undefined && value.report_path !== '') lines.push(`report written to ${value.report_path}`);
    return lines.join('\n') + imageNote(value);
  },
  async execute(args, exec) {
    if ((args.path === undefined || args.path === '') === (args.fastq === undefined || args.fastq === '')) {
      throw new MolbioInputError('provide exactly one of path (a FASTQ file) or fastq (inline FASTQ text)');
    }
    let text;
    if (args.path !== undefined && args.path !== '') {
      const bytes = await readFileBytes(ctx, exec, args.path);
      text = new TextDecoder().decode(bytes);
    } else {
      text = args.fastq;
    }
    const trimmed = text.replace(/^\uFEFF/, '').trimStart();
    if (trimmed.startsWith('>')) throw new MolbioInputError('this looks like FASTA, not FASTQ: molbio_fastq_qc needs per-base quality strings (use molbio_fasta_fastq for FASTA statistics)');
    const entries = parseFastq(text);
    const report = fastqQcReport(entries, {
      ...args.max_reads === undefined ? {} : { max_reads: args.max_reads },
      ...args.max_plot_bases === undefined ? {} : { max_plot_bases: args.max_plot_bases },
      ...args.duplication_reads === undefined ? {} : { duplication_reads: args.duplication_reads },
      ...args.overrepresented_reads === undefined ? {} : { overrepresented_reads: args.overrepresented_reads },
    });
    // `svgFileName` appends ".svg", so pass the stem WITHOUT an extension.
    const stem = (args.path !== undefined && args.path !== ''
      ? String(args.path).split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
      : 'fastq').replace(/\.qc$/i, '');
    const defaultName = `${stem === '' ? 'reads' : stem}.qc`;
    const svg = renderFastqQcReport(report);
    const { file, viewed, attached } = await writeSvgFile(ctx, exec, args, svg, defaultName);
    return mergeAttachedImage({ ...report, report_path: file, auto_viewed: viewed }, attached);
  },
});

const RARE_CODON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'codon', 'amino_acid', 'host_frequency', 'relative_adaptiveness'],
  properties: {
    position: { type: 'integer' },
    codon: { type: 'string' },
    amino_acid: { type: 'string' },
    host_frequency: { type: 'number' },
    relative_adaptiveness: { type: 'number' },
  },
};

const CODON_USAGE_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['host', 'length', 'analysed_codons', 'ignored_trailing_bases', 'cai', 'cai_interpretation', 'cai_codons', 'cai_by_codon', 'cai_counted_codons', 'cai_profile', 'zero_frequency_codons', 'n_codon', 'n_codon_interpretation', 'gc3', 'gc123', 'gc3_distribution', 'rscu', 'codon_counts', 'amino_acid_counts', 'rare_codons', 'rare_codon_count', 'cpg', 'internal_stops', 'internal_stop_count', 'has_start_codon', 'has_stop_codon', 'standard_code', 'warnings'],
  properties: {
    host: { type: 'string' },
    length: { type: 'integer' },
    analysed_codons: { type: 'integer' },
    ignored_trailing_bases: { type: 'integer' },
    cai: { type: 'number' },
    cai_interpretation: { type: 'string' },
    cai_codons: { type: 'integer' },
    cai_by_codon: { type: 'object', additionalProperties: true },
    cai_counted_codons: { type: 'object', additionalProperties: true },
    cai_profile: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start_codon', 'end_codon', 'cai'],
        properties: {
          start_codon: { type: 'integer' },
          end_codon: { type: 'integer' },
          cai: { type: 'number' },
        },
      },
    },
    zero_frequency_codons: { type: 'array', items: { type: 'string' } },
    n_codon: { type: 'number' },
    n_codon_interpretation: { type: 'string' },
    gc3: { type: 'number' },
    gc123: { type: 'array', items: { type: 'number' } },
    gc3_distribution: {
      type: 'object',
      additionalProperties: false,
      required: ['A', 'C', 'G', 'T'],
      properties: {
        A: { type: 'integer' },
        C: { type: 'integer' },
        G: { type: 'integer' },
        T: { type: 'integer' },
      },
    },
    rscu: { type: 'object', additionalProperties: true },
    codon_counts: { type: 'object', additionalProperties: true },
    amino_acid_counts: { type: 'object', additionalProperties: true },
    rare_codons: { type: 'array', items: RARE_CODON_SCHEMA },
    rare_codon_count: { type: 'integer' },
    cpg: {
      type: 'object',
      additionalProperties: false,
      required: ['observed', 'expected', 'observed_expected', 'interpretation'],
      properties: {
        observed: { type: 'integer' },
        expected: { type: 'number' },
        observed_expected: { type: 'number' },
        interpretation: { type: 'string' },
      },
    },
    internal_stops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['codon', 'position'],
        properties: {
          codon: { type: 'string' },
          position: { type: 'integer' },
        },
      },
    },
    internal_stop_count: { type: 'integer' },
    has_start_codon: { type: 'boolean' },
    has_stop_codon: { type: 'boolean' },
    standard_code: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const codonUsageTool = define({
  name: 'molbio_codon_usage',
  description: 'Codon-usage analysis of a coding sequence against a host (E. coli / yeast / human): CAI (Sharp & Li, geometric mean of relative adaptiveness), RSCU per codon, Nc (effective number of codons), GC3/GC123, a rare-codon list with positions, CDS CpG observed/expected, and a hidden-stop scan. Complements molbio_codon_optimize: this one explains what is wrong with the sequence, that one rewrites it. Every model and threshold is named in the result; CAI and Nc are ESTIMATES from published usage tables, not expression measurements.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Coding sequence (ACGT; U is read as T).'),
      host: { type: 'string', enum: CODON_HOSTS, description: 'Host whose codon usage to compare against (default "e_coli").' },
      region_window: { type: 'integer', description: 'Optional sliding window in codons for a local CAI profile (minimum 3).' },
    },
  },
  outputSchema: CODON_USAGE_TOOL_SCHEMA,
  render(value) {
    const lines = [
      `${value.host}: ${value.analysed_codons} codon(s) analysed${value.ignored_trailing_bases === 0 ? '' : `, ${value.ignored_trailing_bases} trailing base(s) ignored`}`,
      `CAI ${value.cai} (${value.cai_interpretation}) over ${value.cai_codons} codon(s)`,
      `Nc ${value.n_codon} (${value.n_codon_interpretation}), GC3 ${value.gc3}%, GC123 ${value.gc123.join('/')}%`,
      `CpG observed/expected ${value.cpg.observed_expected} (${value.cpg.interpretation})`,
      `start codon ATG: ${value.has_start_codon ? 'yes' : 'no'}; terminal stop codon: ${value.has_stop_codon ? 'yes' : 'no'}`,
    ];
    if (value.zero_frequency_codons.length > 0) lines.push(`codons with zero frequency in ${value.host} (w set to 0.5/f_max): ${value.zero_frequency_codons.join(', ')}`);
    if (value.internal_stop_count > 0) {
      lines.push(`internal stop codons: ${value.internal_stops.map((stop) => `${stop.codon}@${stop.position}`).join(', ')}`);
    }
    if (value.rare_codons.length > 0) {
      const worst = value.rare_codons.slice().sort((a, b) => a.relative_adaptiveness - b.relative_adaptiveness).slice(0, 8);
      lines.push(`${value.rare_codon_count} rare codon(s) (w < 0.2); rarest: ${worst.map((codon) => `${codon.codon}@${codon.position} (${codon.amino_acid}, w=${codon.relative_adaptiveness})`).join(', ')}`);
    } else {
      lines.push('no rare codons (no sense codon with relative adaptiveness below 0.2)');
    }
    if (value.cai_profile.length > 0) {
      const lowest = value.cai_profile.slice().sort((a, b) => a.cai - b.cai).slice(0, 3);
      lines.push(`local CAI (window ${value.cai_profile[0].end_codon - value.cai_profile[0].start_codon + 1} codons): weakest at ${lowest.map((row) => `${row.start_codon}-${row.end_codon} (${row.cai})`).join(', ')}`);
    }
    for (const warning of value.warnings) lines.push(`warning: ${warning}`);
    return lines.join('\n');
  },
  execute(args) {
    return codonUsageAnalysis(args.sequence, {
      host: args.host ?? 'e_coli',
      ...args.region_window === undefined ? {} : { region_window: args.region_window },
    });
  },
});

const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'length'],
  properties: {
    name: { type: 'string' },
    length: { type: 'number' },
    support: { type: 'number' },
    children: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

const PHYLO_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'distance_model', 'taxa', 'alignment_columns', 'aligned_by_tool', 'tree', 'newick', 'distance_labels', 'distance_matrix', 'composition', 'saturated_pairs', 'bootstrap_replicates', 'bootstrap_seed', 'support', 'consensus', 'notes', 'nwk_path', 'svg_path', 'auto_viewed'],
  properties: {
    method: { type: 'string', enum: [...TREE_METHODS] },
    distance_model: { type: 'string' },
    taxa: { type: 'integer' },
    alignment_columns: { type: 'integer' },
    aligned_by_tool: { type: 'boolean' },
    tree: NODE_SCHEMA,
    newick: { type: 'string' },
    distance_labels: { type: 'array', items: { type: 'string' } },
    distance_matrix: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    composition: { type: 'object', additionalProperties: true },
    saturated_pairs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pair', 'reason'],
        properties: {
          pair: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          clipped_to: { type: 'number' },
        },
      },
    },
    bootstrap_replicates: { type: 'integer' },
    bootstrap_seed: { type: 'integer' },
    support: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['clade', 'support'],
        properties: {
          clade: { type: 'array', items: { type: 'string' } },
          support: { type: 'number' },
        },
      },
    },
    consensus: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'threshold', 'clades', 'newick'],
      properties: {
        mode: { type: 'string' },
        threshold: { type: 'number' },
        clades: { type: 'integer' },
        newick: { type: 'string' },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    nwk_path: { type: 'string' },
    svg_path: { type: 'string' },
    auto_viewed: { type: 'boolean' },
  },
};

/** Flatten a tree into the schema's recursive shape (support only when set). */
function serializeTreeNode(node) {
  return {
    name: node.name ?? '',
    length: Math.round((node.length ?? 0) * 1e6) / 1e6,
    ...Number.isFinite(node.support) ? { support: node.support } : {},
    ...node.children.length > 0 ? { children: node.children.map(serializeTreeNode) } : {},
  };
}

const phylogeneticTreeTool = (ctx) => define({
  safe: false,
  name: 'molbio_phylogenetic_tree',
  description: 'Build a distance-based phylogenetic tree from sequences: corrected distances (p-distance / Jukes-Cantor / Kimura 2P / Tamura-Nei), UPGMA or neighbour-joining, bootstrap support with an explicit seed, a strict or majority-rule consensus, Newick I/O, and an SVG tree (rectangular, circular or fan layout). Raw sequences are aligned first with the same progressive aligner as molbio_msa_align. This is a DISTANCE method, not maximum likelihood: bootstrap percentages are resampling support, NOT p-values, and the output says so.',
  parameters: {
    type: 'object',
    properties: {
      sequences: { type: 'array', items: { type: 'string' }, description: 'Sequences (2-200). Either this or fasta/path is required.' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Optional names for `sequences`, in the same order (defaults to seq1, seq2, …).' },
      fasta: { type: 'string', description: 'FASTA text (alternative to `sequences`).' },
      path: { type: 'string', description: 'Path to a FASTA file in the workspace (alternative to `sequences`).' },
      aligned: { type: 'boolean', description: 'Set true when the input is already an alignment (same length); raw sequences are aligned with molbio_msa_align first (default false).' },
      method: { type: 'string', enum: [...TREE_METHODS], description: 'upgma (assumes a molecular clock) or nj (neighbour-joining, default).' },
      distance_model: { type: 'string', enum: [...DISTANCE_MODELS], description: 'Distance correction (default kimura-2p). Saturated pairs are reported and clamped.' },
      bootstrap: { type: 'integer', description: 'Bootstrap replicates (default 100, 0 disables). Same seed always gives the same numbers.' },
      seed: { type: 'integer', description: 'Bootstrap RNG seed (default 1).' },
      consensus: { type: 'string', enum: ['none', 'strict', 'majority'], description: 'Also build a consensus tree from the bootstrap replicates (default none).' },
      layout: { type: 'string', enum: [...LAYOUTS], description: 'Tree drawing layout (default rectangular).' },
      support_threshold: { type: 'number', description: 'Support (%) below which branches are drawn as dashed in the SVG (default 50).' },
      nwk_path: { type: 'string', description: 'Path for the Newick file; default tree.nwk in the workspace.' },
      svg_path: { type: 'string', description: 'Path for the SVG tree; default tree.svg in the workspace.' },
      auto_view: { type: 'boolean', description: 'Open the SVG automatically with the OS default application (default true).' },
      ...ATTACH_IMAGE_PARAM,
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [...PHYLO_TOOL_SCHEMA.required],
    properties: {
      ...PHYLO_TOOL_SCHEMA.properties,
      image: ATTACHED_IMAGE_SCHEMA,
      image_note: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.taxa} taxa x ${value.alignment_columns} columns (${value.aligned_by_tool ? 'aligned by this tool' : 'input alignment'}), ${value.method} with ${value.distance_model}`,
      `tree: ${value.newick}`,
    ];
    if (value.bootstrap_replicates > 0) {
      const strong = value.support.filter((entry) => entry.support >= 70);
      const weak = value.support.filter((entry) => entry.support < 50);
      lines.push(`bootstrap (${value.bootstrap_replicates} replicates, seed ${value.bootstrap_seed}): ${strong.length} clade(s) at >=70%, ${weak.length} below 50%`);
      for (const entry of value.support.slice().sort((a, b) => b.support - a.support)) {
        lines.push(`  ${entry.support}%  ${entry.clade.join(' + ')}`);
      }
    }
    if (value.consensus.mode !== 'none') {
      lines.push(`${value.consensus.mode} consensus (${value.consensus.clades} clade(s)): ${value.consensus.newick}`);
    }
    if (value.saturated_pairs.length > 0) {
      lines.push(`${value.saturated_pairs.length} pair(s) are saturated for ${value.distance_model} and were clamped: ${value.saturated_pairs.slice(0, 5).map((entry) => entry.pair.join('/')).join(', ')}${value.saturated_pairs.length > 5 ? ', …' : ''}`);
    }
    for (const note of value.notes) lines.push(`note: ${note}`);
    lines.push(`Newick written to ${value.nwk_path}; tree drawn to ${value.svg_path}`);
    return lines.join('\n') + imageNote(value);
  },
  async execute(args, exec) {
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    // 1. Collect the input rows.
    let entries;
    if (args.sequences !== undefined && args.sequences.length > 0) {
      if (args.fasta !== undefined || args.path !== undefined) {
        throw new MolbioInputError('provide sequences, fasta or path — not more than one');
      }
      const ids = args.ids ?? [];
      entries = args.sequences.map((sequence, index) => ({
        id: ids[index] ?? `seq${index + 1}`,
        sequence: String(sequence).toUpperCase().replace(/[\s\d]+/g, '').replace(/U/g, 'T'),
      }));
    } else if (args.fasta !== undefined) {
      entries = parseFasta(args.fasta).map((entry) => ({ id: entry.id, sequence: entry.sequence.replace(/U/g, 'T') }));
    } else if (args.path !== undefined) {
      const text = new TextDecoder().decode(await readFileBytes(ctx, exec, args.path));
      entries = parseFasta(text).map((entry) => ({ id: entry.id, sequence: entry.sequence.replace(/U/g, 'T') }));
    } else {
      throw new MolbioInputError('provide sequences, fasta or path');
    }
    if (entries.length < 2) throw new MolbioInputError(`phylogenetics needs at least 2 sequences (got ${entries.length})`);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new MolbioInputError('sequence names must be unique — duplicate ids would make the tree ambiguous');
    }
    const notes = [
      'distance-based tree: this is not a maximum-likelihood or Bayesian analysis',
      'bootstrap support is a resampling percentage, not a p-value',
    ];
    // 2. Align if needed.
    let rows = entries;
    let alignedByTool = false;
    const lengths = new Set(entries.map((entry) => entry.sequence.length));
    const alreadyAligned = lengths.size === 1;
    if (args.aligned === true && !alreadyAligned) {
      throw new MolbioInputError('aligned=true but the sequences have different lengths; drop the flag to have them aligned automatically');
    }
    if (!alreadyAligned) {
      if (args.aligned !== false) {
        const alignment = progressiveAlign(entries.map((entry) => ({ id: entry.id, sequence: normalizeMsaSequence(entry.sequence) })));
        rows = alignment.alignment;
        alignedByTool = true;
        notes.push(`raw sequences were aligned with the progressive aligner in molbio_msa_align (${alignment.columns} columns)`);
        // Coverage check: an alignment that drops residues would build a tree
        // from data the user never supplied, so say so instead of letting a
        // shortened row pass unnoticed.
        const lost = [];
        rows.forEach((row, index) => {
          const kept = [...row.sequence].filter((base) => base !== '-').length;
          const supplied = entries[index].sequence.length;
          if (kept !== supplied) lost.push(`${row.id} (${kept} of ${supplied} bases kept)`);
        });
        if (lost.length > 0) {
          notes.push(`WARNING: the alignment did not place every residue — ${lost.join(', ')}. The tree was built from the aligned columns, so those residues are NOT represented. Verify the alignment (molbio_msa_align) before trusting this tree.`);
        }
      } else {
        throw new MolbioInputError('aligned=false but the sequences are not all the same length; align them first or omit `aligned`');
      }
    }
    // 3. Distances and the tree.
    const method = args.method ?? 'nj';
    const model = args.distance_model ?? 'kimura-2p';
    const { matrix, compared, saturated, composition } = distanceMatrix(rows, { model });
    const names = rows.map((row) => row.id);
    const flat = new Float64Array(names.length * names.length);
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) flat[i * names.length + j] = matrix[i][j];
    }
    const tree = method === 'upgma' ? upgmaTree(flat, names) : neighbourJoiningTree(matrix, names);
    void compared;
    // 4. Bootstrap + consensus.
    const bootstrap = args.bootstrap ?? 100;
    let support = [];
    let consensus = { mode: 'none', threshold: 0, clades: 0, newick: '' };
    let replicateTrees = [];
    if (bootstrap > 0) {
      const outcome = bootstrapSupport(rows, tree, { method, model, replicates: bootstrap, seed: args.seed ?? 1 });
      applySupport(tree, outcome.support);
      // The ROOT's split is an artefact of where the tree was rooted, not a
      // testable clade, so it gets no support label (Newick readers and
      // reviewers alike object to a number there).
      tree.support = undefined;
      replicateTrees = outcome.replicateTrees;
      support = [...outcome.support.entries()]
        .map(([key, value]) => ({ clade: key.split('\u0000'), support: value }))
        .sort((a, b) => b.support - a.support || a.clade.join().localeCompare(b.clade.join()));
      notes.push(`support values come from ${bootstrap} column-resampling replicates (seed ${args.seed ?? 1}); the same seed reproduces them exactly`);
      if (args.consensus !== undefined && args.consensus !== 'none') {
        const consensusResult = consensusTree(rows, replicateTrees, { mode: args.consensus, threshold: 0.5 });
        consensus = {
          mode: args.consensus,
          threshold: 0.5,
          clades: consensusResult.clades,
          newick: toNewick(consensusResult.tree),
        };
      }
    } else if (args.consensus !== undefined && args.consensus !== 'none') {
      throw new MolbioInputError('consensus needs bootstrap replicates (set bootstrap > 0)');
    }
    // 5. Write the Newick and the picture.
    const baseName = (args.path !== undefined && args.path !== ''
      ? String(args.path).split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
      : 'tree') || 'tree';
    const newickText = toNewick(tree);
    const nwkPath = workspaceFilePath(args.nwk_path ?? `${baseName}.nwk`, exec, policy?.workspaceRoot);
    await writeWorkspaceFile(fs, nwkPath, `${newickText}\n`, policy);
    const svg = renderTreeSvg(tree, {
      layout: args.layout ?? 'rectangular',
      title: args.path !== undefined && args.path !== '' ? `${baseName}: phylogenetic tree` : 'Phylogenetic tree',
      subtitle: `${method.toUpperCase()} · ${model} · ${names.length} taxa${bootstrap > 0 ? ` · ${bootstrap} bootstrap replicates` : ''}`,
      supportThreshold: args.support_threshold ?? 50,
    });
    const { file: svgPath, viewed, attached } = await writeSvgFile(ctx, exec, { ...args, output_path: args.svg_path ?? `${baseName}-tree.svg` }, svg, `${baseName}-tree`);
    return mergeAttachedImage({
      method,
      distance_model: model,
      taxa: names.length,
      alignment_columns: rows[0].sequence.length,
      aligned_by_tool: alignedByTool,
      tree: serializeTreeNode(tree),
      newick: newickText,
      distance_labels: names,
      distance_matrix: matrix.map((row) => row.map((value) => Math.round(value * 1e6) / 1e6)),
      composition: Object.fromEntries(Object.entries(composition).map(([base, value]) => [base, Math.round(value * 1e4) / 1e4])),
      saturated_pairs: saturated,
      bootstrap_replicates: bootstrap > 0 ? bootstrap : 0,
      bootstrap_seed: bootstrap > 0 ? (args.seed ?? 1) : 0,
      support,
      consensus,
      notes,
      nwk_path: nwkPath,
      svg_path: svgPath,
      auto_viewed: viewed,
    }, attached);
  },
});

const pubmedAbstractTool = (ctx) => define({
  name: 'molbio_pubmed_abstract',
  description: 'Fetch PubMed abstracts for PMIDs via NCBI E-utilities (efetch). Requires the deployment to provide the web fetch capability; otherwise it reports that clearly. Use it to pull abstracts for papers found by molbio_pubmed_search before adding them to the library.',
  parameters: {
    type: 'object',
    required: ['pmids'],
    properties: {
      pmids: { type: 'array', items: { type: 'string' }, description: 'PubMed IDs, e.g. ["37607951"].' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['pmids', 'abstracts'],
    properties: {
      pmids: { type: 'array', items: { type: 'string' } },
      abstracts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['pmid', 'title', 'abstract', 'error'],
          properties: {
            pmid: { type: 'string' },
            title: { type: 'string' },
            abstract: { type: 'string' },
            error: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [];
    for (const entry of value.abstracts) {
      if (entry.error !== '') {
        lines.push(`PMID ${entry.pmid}: ${entry.error}`);
        continue;
      }
      lines.push(`PMID ${entry.pmid}: ${entry.title}`);
      lines.push(entry.abstract.length > 1200 ? entry.abstract.slice(0, 1200) + ' …' : entry.abstract);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const pmids = args.pmids.filter((pmid) => /^\d+$/.test(String(pmid).trim()));
    if (pmids.length === 0) throw new MolbioInputError('pmids must contain numeric PubMed IDs');
    const web = ctx.get('web');
    if (web === undefined || typeof web.fetch !== 'function') {
      throw new MolbioInputError('this deployment provides no web fetch capability, so PubMed abstracts cannot be retrieved; molbio_pubmed_search still works for titles and snippets');
    }
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml`;
    const result = await web.fetch({ url }, exec?.signal);
    const body = result?.body?.content;
    if (typeof body !== 'string' || body === '') {
      throw new MolbioInputError(`efetch returned no content (status ${result?.statusCode ?? 'unknown'})`);
    }
    const doc = parseXml(body);
    const set = doc.children.find((node) => node.tag === 'PubmedArticleSet');
    const records = set === undefined ? [] : set.children.filter((node) => node.tag === 'PubmedArticle');
    const byPmid = new Map();
    for (const article of records) {
      const citation = article.children.find((node) => node.tag === 'MedlineCitation');
      const pmidNode = citation === undefined ? undefined : citation.children.find((node) => node.tag === 'PMID');
      const pmid = pmidNode === undefined ? '' : pmidNode.text.trim();
      const articleInfo = citation === undefined ? undefined : citation.children.find((node) => node.tag === 'Article');
      const titleNode = articleInfo === undefined ? undefined : articleInfo.children.find((node) => node.tag === 'ArticleTitle');
      const title = titleNode === undefined ? '' : titleNode.text.trim();
      const abstractNode = articleInfo === undefined ? undefined : articleInfo.children.find((node) => node.tag === 'Abstract');
      let abstractText = '';
      if (abstractNode !== undefined) {
        abstractText = abstractNode.children.filter((node) => node.tag === 'AbstractText').map((node) => node.text.trim()).filter((t) => t !== '').join(' ');
      }
      if (pmid !== '') byPmid.set(pmid, { title, abstract: abstractText });
    }
    const abstracts = pmids.map((pmid) => {
      const found = byPmid.get(pmid);
      if (found === undefined) return { pmid, title: '', abstract: '', error: 'no record returned by efetch' };
      return { pmid, title: found.title, abstract: found.abstract, error: '' };
    });
    return { pmids, abstracts };
  },
});

const bibtexTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_export_bibtex',
  description: 'Export the literature library (papers.json) to a BibTeX .bib file in the workspace. Optional tag_filter exports only papers carrying one of the given tags.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
      output_path: { type: 'string', description: 'Output .bib path; default: the library path with a .bib extension.' },
      tag_filter: { type: 'array', items: { type: 'string' }, description: 'Only export papers with at least one of these tags.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['output_path', 'count'],
    properties: {
      output_path: { type: 'string' },
      count: { type: 'integer' },
    },
  },
  render(value) {
    return `exported ${value.count} reference(s) to ${value.output_path}`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const bibtex = toBibtex(library.papers, args.tag_filter);
    const output = args.output_path !== undefined && args.output_path !== ''
      ? workspaceFilePath(args.output_path, exec, policy?.workspaceRoot)
      : path.replace(/\.json$/i, '.bib');
    await writeWorkspaceFile(fs, output, bibtex, policy);
    return { output_path: output, count: bibtex.trim() === '' ? 0 : library.papers.filter((paper) => args.tag_filter === undefined || args.tag_filter.length === 0 || (paper.tags !== undefined && args.tag_filter.some((tag) => paper.tags.includes(tag)))).length };
  },
});

const PROTOCOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'created_at'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    created_at: { type: 'string' },
    category: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    parameters: { type: 'object', additionalProperties: true },
    source_paper_id: { type: 'string' },
  },
};

const EXPERIMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'date', 'logged_at'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    date: { type: 'string' },
    logged_at: { type: 'string' },
    protocol_id: { type: 'string' },
    paper_ids: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    results: { type: 'string' },
  },
};

const protocolAddTool = (ctx) => define({
  safe: false,
  name: 'molbio_protocol_add',
  description: 'Save a protocol to the protocol library (protocols.json in the workspace): name, optional category, ordered steps, a free-form parameters object, and an optional source paper id from the literature library.',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: requiredString('Protocol name (unique in the library).'),
      category: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Ordered protocol steps.' },
      parameters: { type: 'object', additionalProperties: true, description: 'Free-form parameters (reagent volumes, temperatures, timings).' },
      source_paper_id: { type: 'string', description: 'Paper id from molbio_paper_list, when the protocol comes from a paper.' },
      file: { type: 'string', description: 'Protocols file; default protocols.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'protocol', 'total'],
    properties: {
      file: { type: 'string' },
      protocol: PROTOCOL_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    const lines = [`saved protocol ${value.protocol.id} "${value.protocol.name}" to ${value.file} (${value.total} total)`];
    if (value.protocol.steps !== undefined) {
      lines.push('steps:');
      value.protocol.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path, policy } = recordDeps(ctx, exec, args, 'protocols.json');
    const data = await loadRecords(fs, path, 'protocols');
    const protocol = addProtocol(data.protocols, args);
    await saveRecords(fs, path, data, policy);
    return { file: path, protocol, total: data.protocols.length };
  },
});

const protocolListTool = (ctx) => define({
  name: 'molbio_protocol_list',
  description: 'List the protocol library (protocols.json in the workspace).',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Protocols file; default protocols.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'protocols'],
    properties: {
      file: { type: 'string' },
      protocols: { type: 'array', items: PROTOCOL_SCHEMA },
    },
  },
  render(value) {
    if (value.protocols.length === 0) return `no protocols in ${value.file}`;
    const lines = [`${value.protocols.length} protocol(s) in ${value.file}:`];
    for (const protocol of value.protocols) {
      lines.push(`- ${protocol.id}: ${protocol.name}${protocol.category !== undefined ? ` [${protocol.category}]` : ''}${protocol.steps !== undefined ? ` (${protocol.steps.length} steps)` : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path } = recordDeps(ctx, exec, args, 'protocols.json');
    const data = await loadRecords(fs, path, 'protocols');
    return { file: path, protocols: data.protocols };
  },
});

const protocolUpdateTool = (ctx) => define({
  safe: false,
  name: 'molbio_protocol_update',
  description: 'Update a protocol by id (from molbio_protocol_list). Only supplied fields change; steps replace the whole step list.',
  parameters: {
    type: 'object',
    required: ['id'],
    properties: {
      id: requiredString('Protocol id to update.'),
      name: { type: 'string' },
      category: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
      parameters: { type: 'object', additionalProperties: true },
      source_paper_id: { type: 'string' },
      file: { type: 'string', description: 'Protocols file; default protocols.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'found', 'total'],
    properties: {
      file: { type: 'string' },
      found: { type: 'boolean' },
      protocol: PROTOCOL_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    return value.found
      ? `updated protocol "${value.protocol.name}" in ${value.file} (${value.total} total)`
      : `no protocol with that id in ${value.file} — list ids with molbio_protocol_list`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = recordDeps(ctx, exec, args, 'protocols.json');
    const data = await loadRecords(fs, path, 'protocols');
    const protocol = updateProtocol(data.protocols, args.id, args);
    if (protocol === undefined) return { file: path, found: false, total: data.protocols.length };
    await saveRecords(fs, path, data, policy);
    return { file: path, found: true, protocol, total: data.protocols.length };
  },
});

const experimentLogTool = (ctx) => define({
  safe: false,
  name: 'molbio_experiment_log',
  description: 'Append an entry to the experiment log (experiments.json in the workspace): title, date (default today), optional protocol id, related paper ids, free-text notes and results.',
  parameters: {
    type: 'object',
    required: ['title'],
    properties: {
      title: requiredString('Experiment title.'),
      date: { type: 'string', description: 'Experiment date (YYYY-MM-DD); default today.' },
      protocol_id: { type: 'string', description: 'Protocol id from molbio_protocol_list.' },
      paper_ids: { type: 'array', items: { type: 'string' }, description: 'Related paper ids from the literature library.' },
      notes: { type: 'string' },
      results: { type: 'string' },
      file: { type: 'string', description: 'Experiments file; default experiments.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'experiment', 'total'],
    properties: {
      file: { type: 'string' },
      experiment: EXPERIMENT_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    const e = value.experiment;
    const lines = [`logged experiment ${e.id} "${e.title}" (${e.date}) to ${value.file} (${value.total} total)`];
    if (e.protocol_id !== undefined) lines.push(`protocol: ${e.protocol_id}`);
    if (e.paper_ids !== undefined && e.paper_ids.length > 0) lines.push(`papers: ${e.paper_ids.join(', ')}`);
    if (e.results !== undefined) lines.push(`results: ${e.results}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path, policy } = recordDeps(ctx, exec, args, 'experiments.json');
    const data = await loadRecords(fs, path, 'experiments');
    const experiment = addExperiment(data.experiments, args);
    await saveRecords(fs, path, data, policy);
    return { file: path, experiment, total: data.experiments.length };
  },
});

const experimentListTool = (ctx) => define({
  name: 'molbio_experiment_list',
  description: 'List the experiment log (experiments.json in the workspace).',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Experiments file; default experiments.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'experiments'],
    properties: {
      file: { type: 'string' },
      experiments: { type: 'array', items: EXPERIMENT_SCHEMA },
    },
  },
  render(value) {
    if (value.experiments.length === 0) return `no experiments logged in ${value.file}`;
    const lines = [`${value.experiments.length} experiment(s) in ${value.file}:`];
    for (const experiment of value.experiments) {
      lines.push(`- ${experiment.id}: ${experiment.date} ${experiment.title}${experiment.protocol_id !== undefined ? ` [protocol ${experiment.protocol_id}]` : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path } = recordDeps(ctx, exec, args, 'experiments.json');
    const data = await loadRecords(fs, path, 'experiments');
    return { file: path, experiments: data.experiments };
  },
});

function recordDeps(ctx, exec, args, defaultFile) {
  const fs = fsService(ctx);
  const sandboxPolicyService = ctx.get('sandboxPolicy');
  const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
  const path = recordPath(args, exec, policy?.workspaceRoot, defaultFile);
  return { fs, path, policy };
}

// ── literature assistant ────────────────────────────────────────────────────

const PAPER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'added_at'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    added_at: { type: 'string' },
    pmid: { type: 'string' },
    url: { type: 'string' },
    authors: { type: 'string' },
    year: { type: 'string' },
    journal: { type: 'string' },
    note: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

const PAPER_IN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string' },
    pmid: { type: 'string' },
    url: { type: 'string' },
    authors: { type: 'string' },
    year: { type: 'string' },
    journal: { type: 'string' },
    note: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

function paperServiceDeps(ctx, exec, args) {
  const fs = ctx.get('fs');
  if (fs === undefined) throw new MolbioInputError('the filesystem service is not available in this composition; the paper library needs ctx.fs');
  const sandboxPolicyService = ctx.get('sandboxPolicy');
  const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
  const path = libraryPath(args, exec, policy?.workspaceRoot);
  return { fs, path, policy };
}

const pubmedSearchTool = (ctx) => define({
  name: 'molbio_pubmed_search',
  description: 'Search the web for literature (PubMed results preferred). Uses the harness web-search service; returns up to max_results sources with titles, snippets, URLs and extracted PMIDs. Add the ones you keep to the reading library with molbio_paper_add.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: requiredString('Search query, e.g. "CRISPR base editing review 2024" or "site:pubmed.ncbi.nlm.nih.gov KRAS G12D".'),
      max_results: { type: 'integer', description: 'Maximum results (1-20, default 8).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query', 'sources'],
    properties: {
      query: { type: 'string' },
      answer: { type: 'string' },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'url'],
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            snippet: { type: 'string' },
            pmid: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    if (value.sources.length === 0) return `no results for "${value.query}"`;
    const lines = [`results for "${value.query}":`];
    if (value.answer !== undefined) lines.push(value.answer);
    for (const source of value.sources) {
      const pmid = source.pmid !== undefined ? ` [PMID ${source.pmid}]` : '';
      lines.push(`- ${source.title}${pmid} — ${source.url}`);
      if (source.snippet !== undefined) lines.push(`  ${source.snippet}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const web = ctx.get('web');
    if (web === undefined) throw new MolbioInputError('the web search service is not available in this composition; molbio_pubmed_search needs ctx.web');
    const maxResults = args.max_results ?? 8;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
      throw new MolbioInputError('max_results must be an integer between 1 and 20');
    }
    const result = await web.search({ query: args.query, maxResults }, exec?.signal);
    const sources = result.sources.map((source) => {
      const pmid = pmidFromUrl(source.url ?? '');
      return {
        title: source.title ?? '',
        url: source.url ?? '',
        ...source.snippet !== undefined && source.snippet !== '' ? { snippet: source.snippet } : {},
        ...pmid !== undefined ? { pmid } : {},
      };
    });
    return {
      query: args.query,
      ...result.content !== undefined ? { answer: result.content } : {},
      sources,
    };
  },
});

const paperAddTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_add',
  description: 'Append papers to the literature library (a JSON file, default papers.json in the session workspace). Entries are deduplicated by PMID, then URL, then title+year. Takes an array of papers with at least a title; pmid/url/authors/year/journal/note/tags are optional.',
  parameters: {
    type: 'object',
    required: ['papers'],
    properties: {
      papers: { type: 'array', items: PAPER_IN_SCHEMA, description: 'Papers to add.' },
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'added', 'total'],
    properties: {
      file: { type: 'string' },
      added: { type: 'array', items: PAPER_SCHEMA },
      total: { type: 'integer' },
    },
  },
  render(value) {
    return `added ${value.added.length} paper(s); library now holds ${value.total} paper(s) in ${value.file}`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const added = addPapers(library, args.papers);
    await saveLibrary(fs, path, library, policy);
    return { file: path, added, total: library.papers.length };
  },
});

const paperListTool = (ctx) => define({
  name: 'molbio_paper_list',
  description: 'List the literature library (default papers.json in the session workspace).',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'papers'],
    properties: {
      file: { type: 'string' },
      papers: { type: 'array', items: PAPER_SCHEMA },
    },
  },
  render(value) {
    if (value.papers.length === 0) return `the library at ${value.file} is empty`;
    const lines = [`${value.papers.length} paper(s) in ${value.file}:`];
    for (const paper of value.papers) {
      lines.push(`- ${paper.id}: ${paper.title}${paper.year !== undefined ? ' (' + paper.year + ')' : ''}${paper.tags !== undefined && paper.tags.length > 0 ? ' [tags: ' + paper.tags.join(', ') + ']' : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    return { file: path, papers: library.papers };
  },
});

const paperUpdateTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_update',
  description: 'Update one paper in the literature library by id (the id is the PMID, URL, or title:year key shown by molbio_paper_list). Only the supplied fields change; tags replace the whole tag list.',
  parameters: {
    type: 'object',
    required: ['id'],
    properties: {
      id: requiredString('The paper id to update.'),
      title: { type: 'string' },
      note: { type: 'string' },
      authors: { type: 'string' },
      year: { type: 'string' },
      journal: { type: 'string' },
      url: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'found', 'total'],
    properties: {
      file: { type: 'string' },
      found: { type: 'boolean' },
      paper: PAPER_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    if (!value.found) return `no paper with id in ${value.file} — list ids with molbio_paper_list`;
    return `updated "${value.paper.title}" in ${value.file} (${value.total} paper(s) total)`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const paper = updatePaper(library, args.id, args);
    if (paper === undefined) return { file: path, found: false, total: library.papers.length };
    await saveLibrary(fs, path, library, policy);
    return { file: path, found: true, paper, total: library.papers.length };
  },
});

const paperRemoveTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_remove',
  description: 'Remove one paper from the literature library by id (use molbio_paper_list to see ids).',
  parameters: {
    type: 'object',
    required: ['id'],
    properties: {
      id: requiredString('The paper id to remove.'),
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'removed', 'total'],
    properties: {
      file: { type: 'string' },
      removed: { type: 'boolean' },
      total: { type: 'integer' },
    },
  },
  render(value) {
    return value.removed
      ? `removed the paper; ${value.total} paper(s) remain in ${value.file}`
      : `no paper with that id in ${value.file} — list ids with molbio_paper_list`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const removed = removePaper(library, args.id);
    if (removed) await saveLibrary(fs, path, library, policy);
    return { file: path, removed, total: library.papers.length };
  },
});

// ── plugin apply ────────────────────────────────────────────────────────────

const PROMPT_SECTION = `Molecular-biology tools (dsh-molbio-tools) are available with the molbio_* prefix:
- Sequence math: molbio_reverse_complement, molbio_gc_content, molbio_translate, molbio_restriction_sites, molbio_methylation_check (which enzymes a Dam/Dcm-methylated template blocks, plus the enzymes that survive), molbio_double_digest (two enzymes: per-enzyme and combined fragments + whether they share a buffer).
- Primer work: molbio_design_primers (automatic pair design), molbio_design_intron_primers (qPCR primers spanning an exon-exon junction against a genomic sequence + exon list, so gDNA does not amplify), molbio_primer_tm, molbio_primer_check, molbio_design_taqman (hydrolysis-probe assay: primer pair + probe with the no-5'-G / probe-Tm-margin rules), molbio_multiplex_check (whether several primer pairs can share one tube: cross-dimers, cross-template annealing, gel-resolvable amplicon sizes).
- qPCR and bench math: molbio_qpcr_analysis, molbio_lab_math.
- Plasmids: molbio_parse_genbank (GenBank text), molbio_parse_snapgene (SnapGene .dna files — researchers usually have .dna files, so when the user names a .dna path use this), molbio_plasmid_map_file (reads a .dna/.gb file and writes the map SVG directly into the workspace in one call), molbio_plasmid_map (same, from a sequence + features). Both map tools WRITE the .svg file themselves and return svg_path — never try to reproduce SVG text in the conversation. Every image-writing tool (maps, plots, virtual gels, qPCR standard curves, clone/Golden Gate maps) opens the generated SVG automatically with the OS default application (auto_view defaults to true; the result's auto_viewed field says whether the hand-off worked), so there is normally nothing for the user to open manually; pass auto_view: false only when the caller explicitly wants no viewer window.
- Cloning: molbio_unique_cutters (pick enzymes that cut the vector once and never the insert), molbio_clone_simulate (restriction-ligation or Gibson assembly → final plasmid sequence + verification digests; pass save_path to write a FASTA), molbio_golden_gate (type IIS multi-fragment assembly: the tool designs the 4 bp junctions and the fragments-to-order, and simulates the final plasmid — use it for BsaI-style Golden Gate instead of reasoning about overhangs by hand), molbio_enzyme_lookup (enzyme catalog: recognition/cut geometry/overhang, plus every cut of a sequence in both strand orientations), molbio_clone_primers (enzyme tails or Gibson arms on amplification primers, with re-checks), molbio_mutagenesis_primers (QuickChange-style mutation primers).
- Verification: molbio_verify_sanger (read .ab1/.seq traces, align to the reference plasmid — circular-aware — and report mismatches/indels/amino-acid changes).
- Proteins: molbio_protein_props (MW/pI/A280/GRAVY — estimates), molbio_peptide_digest (trypsin etc. for MS), molbio_codon_optimize (E. coli/yeast/human, can avoid restriction sites), molbio_helical_wheel (Schiffer-Edmundson wheel + Eisenberg hydrophobic moment, written as an SVG), molbio_hydropathy_plot (Kyte-Doolittle sliding-window profile with the 1.6 threshold peaks, written as an SVG).
- Quantitation: molbio_qpcr_efficiency (standard curve + plot), molbio_plot (bar/scatter SVG charts written to files), molbio_virtual_gel (expected band pattern as an SVG gel image with a size ladder).
- Sequences & files: molbio_align (local alignment with a readable match line), molbio_msa_align (progressive multiple sequence alignment — pass an array of sequences or a workspace FASTA), molbio_conservation (consensus + per-column identity/conservation + variable positions; accepts aligned rows or raw sequences it aligns first), molbio_sequence_logo (draws the same alignment as a sequence logo SVG — pass the molbio_msa_align output rows as the alignment argument; letters are sized by per-position information content), molbio_fasta_fastq (FASTA/FASTQ stats/extract/convert/QC on workspace files), molbio_extract_region (pull a CDS/promoter/region from a plasmid file by feature label or coordinates).
- CRISPR: molbio_grna_design (SpCas9-style guide RNAs over a sequence or plasmid file: both strands scanned for the PAM, guides filtered on GC/poly-T/self-complementarity and ranked, with a mismatch-tolerant off-target search over the same sequence — reaching a whole genome simply means passing it as the target). Pass the top candidates on for ordering with save_path (CSV) or map_path (SVG map); the ranking is a heuristic and says so, so present it as candidate ranking, never as a validated efficiency prediction.
- Map extras: pass gc_skew: true for the GC skew ring, show_unique_cutters: true to mark single-cutting enzymes on the map.
- Literature & records: molbio_pubmed_abstract (fetch abstracts by PMID — works only when the deployment provides web fetch), molbio_paper_export_bibtex (papers.json → .bib), molbio_protocol_add / molbio_protocol_list / molbio_protocol_update (protocols.json), molbio_experiment_log / molbio_experiment_list (experiments.json).
- Bench analysis (v19): molbio_fastq_qc (read-level QC for a FASTQ file: per-base quality with quartiles, per-read quality, base content, GC distribution, length, exact duplication, over-represented sequences, adapter screen, plus a report SVG — use it for "is this run good"), molbio_codon_usage (CAI/RSCU/Nc/GC3, rare-codon list and CDS CpG against E. coli/yeast/human — use it for "will this gene express"; it explains, molbio_codon_optimize rewrites), molbio_phylogenetic_tree (distance method: p-distance/JC/K2P/Tamura-Nei, UPGMA or neighbour-joining, bootstrap support, consensus, Newick file and an SVG tree — it is NOT a maximum-likelihood or Bayesian analysis, and bootstrap percentages are not p-values), molbio_pcr_simulate (where a primer pair amplifies: product sizes and coordinates on both strands, mismatch detail, the 3'-end exact-match requirement, circular templates, screening other templates, and an expected gel — use it for "what band will I see"), molbio_gc_composition (sliding-window GC, CpG islands under the Gardiner-Garden or Takai criteria, GC/AT skew with the cumulative-skew origin/terminus indication, dinucleotide obs/exp, entropy, complexity, N50/L50, plus a figure — use it for "is this a promoter or an origin").
- Literature: molbio_pubmed_search (web search), and the reading library molbio_paper_add / molbio_paper_list / molbio_paper_update / molbio_paper_remove (papers.json in the workspace).

Cloning workflow rules (follow them to avoid slow re-derivation):
- To clone a sequence into a plasmid, call molbio_clone_simulate FIRST — pass the BARE insert with add_flanks: true and the tool adds the enzyme recognition sites itself. The tool also validates single cutting, insert orientation, and internal sites itself: never pre-verify enzymes, cutting counts, or flank construction by thinking. Its output already contains final_sequence AND the remapped feature coordinates (features field). NEVER recompute feature coordinates or insert positions by reasoning — always take them from the tool output.
- To draw the new plasmid, either pass map_path to molbio_clone_simulate (one call writes the SVG with remapped features and verification enzymes marked) or feed its features + final_sequence to molbio_plasmid_map. Never rebuild the feature list by hand.
- Insert orientation is the tool's job: orientation=auto (the default) reverse-complements an inverted insert automatically. If the tool still reports an inverted insert, pass orientation=reverse instead of re-deriving coordinates.
- Never parse tool outputs with regex, shell commands, or throwaway scripts — every tool returns structured data that feeds the next tool directly. Mutation descriptions (A123G etc.) are parsed by molbio_mutagenesis_primers, not by you.
- All tools are pure computations except the paper library, pubmed search, and file-backed outputs, which use the harness filesystem and web services under the usual sandbox policy. The Tm model is a SantaLucia-1998 nearest-neighbour estimate — always say it is an estimate.`;

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:molbio',
    order: 110,
    text: PROMPT_SECTION,
  });
  const tools = [
    reverseComplementTool,
    gcTool,
    translateTool,
    restrictionTool,
    enzymeLookupTool,
    primerTmTool,
    primerCheckTool,
    qpcrTool,
    labMathTool,
    designPrimersTool,
    intronPrimersTool(ctx),
    taqmanTool,
    multiplexTool,
    methylationTool,
    doubleDigestTool,
    parseGenbankTool,
    plasmidMapTool(ctx),
    parseSnapgeneTool(ctx),
    plasmidMapFileTool(ctx),
    uniqueCuttersTool(ctx),
    cloneSimulateTool(ctx),
    goldenGateTool(ctx),
    clonePrimersTool(ctx),
    mutagenesisTool,
    verifySangerTool(ctx),
    proteinPropsTool,
    peptideDigestTool,
    codonOptimizeTool,
    helicalWheelTool(ctx),
    hydropathyTool(ctx),
    qpcrEfficiencyTool(ctx),
    plotTool(ctx),
    virtualGelTool(ctx),
    alignTool,
    msaAlignTool(ctx),
    conservationTool(ctx),
    sequenceLogoTool(ctx),
    grnaDesignTool(ctx),
    fastaFastqTool(ctx),
    fastqQcTool(ctx),
    codonUsageTool,
    phylogeneticTreeTool(ctx),
    pcrSimulateTool(ctx),
    gcCompositionTool(ctx),
    extractRegionTool(ctx),
    pubmedAbstractTool(ctx),
    bibtexTool(ctx),
    protocolAddTool(ctx),
    protocolListTool(ctx),
    protocolUpdateTool(ctx),
    experimentLogTool(ctx),
    experimentListTool(ctx),
    pubmedSearchTool(ctx),
    paperAddTool(ctx),
    paperListTool(ctx),
    paperUpdateTool(ctx),
    paperRemoveTool(ctx),
  ];
  for (const tool of tools) ctx.tools.register(tool);
}
