/**
 * dsh-molbio-tools/build/browser-api.mjs
 *
 * The browser-safe face of this package: every module the panels may import,
 * re-exported from the SAME source files the Node plugin ships, so the browser
 * bundle can never drift from the plugin's behaviour.
 *
 * Only these modules are browser-safe (they import nothing but `./lib.mjs`,
 * which is pure computation): lib, genbank, snapgene, plasmid, msa, logo,
 * crispr, align, seqio, plot, design. The Node-only ones (view, papers,
 * records, sanger, protein is fine but unused here, index) are deliberately
 * absent — importing them would drag `node:child_process` and friends into the
 * browser bundle, which the bundler rejects loudly.
 */
export {
  DNA_BASES,
  ENZYME_NAMES,
  MolbioInputError,
  baseCounts,
  complement,
  enzymeCatalog,
  enzymeCuts,
  enzymePattern,
  findRuns,
  hairpinThermo,
  isIisEnzyme,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfAnyScore,
  selfEndScore,
} from '../lib.mjs';
export { parseGenBank } from '../genbank.mjs';
export { parseSnapGeneBytes, parseXml } from '../snapgene.mjs';
export { renderPlasmidMap } from '../plasmid.mjs';
export { normalizeAlignedRow, progressiveAlign, conservationAnalysis, pairwiseIdentities } from '../msa.mjs';
export { columnComposition, renderSequenceLogo } from '../logo.mjs';
export { designGrnas, findProtospacers, evaluateGuide } from '../crispr.mjs';
export { entryStats, parseFasta } from '../seqio.mjs';
export { digest } from '../lib.mjs';
// v17 data + renderers that are pure computation and need no host services:
// the methylation/buffer reference tables, the probe/multiplex analysers, and
// the protein plot renderers. Exported so the browser half CAN use them; the
// panels themselves are unchanged in v17.
export {
  BUFFERS,
  METHYLATION_SENSITIVITY,
  METHYLATION_SITES,
  methylationImpact,
  methylationSites,
  sharedBuffers,
} from '../lib.mjs';
export { designTaqmanProbes, evaluateProbe, probeCandidates } from '../taqman.mjs';
export { checkMultiplex } from '../multiplex.mjs';
export { helicalWheel, hydropathyProfile, renderHelicalWheel, renderHydropathyPlot } from '../protein-structure.mjs';
export { analyzeMethylation, bufferReport, planDoubleDigest } from '../methylation.mjs';
