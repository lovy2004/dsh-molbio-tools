# Capability-gap survey: what to build next in `dsh-molbio-tools`

**Question answered:** given the 52 shipped, zero-dependency, pure-JS `molbio_*` tools, what does the
mainstream bioinformatics landscape offer that this toolset does **not**, and which of those gaps are
(a) genuinely useful to bench/analysis work and (b) plausibly implementable as self-contained
deterministic algorithms in a few hundred lines of dependency-free JS with **no external data files,
binaries, network, or reference databases**?

**Method.** Surveyed nine source families (commercial plasmid/cloning suites; bench web calculators;
Biopython/BioPerl/SeqKit/EMBOSS command-line toolkits; standard sequence/statistics analyses;
microbiome; population genetics; protein prediction; alignment post-processing; sequencing QC),
then filtered every candidate through the (a)/(b) test. Baseline coverage was verified **by reading
the package itself**, not from the summary: `README.md`, `package.json`, `lib.mjs`, `protein.mjs`,
`seqio.mjs`, `docs/maintainer.md`.

Verified baseline facts that drive the rankings:

- `package.json` declares **no `dependencies`** at all (two optional harness peerDeps only) — the
  zero-dependency claim holds.
- `lib.mjs` carries the enzyme table as a plain literal (`export const ENZYMES = { EcoRI: 'A^AATTC', … }`),
  i.e. a few hundred bytes per family. Adding enzyme or Cas/PAM families is cheap.
- `protein.mjs` already embeds a **preferred-codon table** for `e_coli`/`yeast`/`human`
  (`CODON_USAGE`), so CAI/RSCU/rare-codon reporting can **reuse** it rather than import a new dataset.
- `seqio.mjs` FASTQ support is thin: entries + mean/min/max quality + a per-position mean truncated
  to 150 bp. There is **no** per-base quartile/boxplot, N content, GC distribution, duplication,
  adapter, overrepresentation or k-mer analysis.
- `docs/maintainer.md` §Roadmap already lists v18 candidates (more Cas families, genome-scale
  off-target, multiplex temperature balancing, TaqMan MGB/probe CSV, PNG output). Those are **not**
  re-proposed here except where the survey independently ranks them.

Every row is tagged **[doc]** (verified against vendor/tool documentation, URLs in §5) or
**[judgement]** (my own assessment of value or implementability). Feasibility verdicts are judgement
calls grounded in the algorithmic references in §5 and in the measured size of the shipped modules
(`align.mjs` 5.5 KB Smith-Waterman; `msa.mjs` 18 KB progressive MSA + a UPGMA guide tree;
`crispr.mjs` 24 KB PAM scan + scoring + off-target; `lib.mjs` 54 KB incl. the enzyme table).

---

## 1. Ranked candidate capabilities

Legend — *ext?*: needs external binary / reference database / network?
*Pure-JS?*: **yes** = small self-contained algorithm; **yes-but-heavy** = correct but needs an
embedded parameter table (transcribed constants, not downloaded data) and/or gets uncomfortable at
the top of the input range; **no** = not achievable in this architecture.
*Size*: **S** ≈ under ~200 lines, **M** ≈ 200–600, **L** ≈ 600+ or a new module plus tests.

Ranked by expected value × feasibility.

| # | Capability | Typical user question it answers | ext? | Pure-JS? | Size | Value |
|---|---|---|---|---|---|---|
| 1 | **Read-level FASTQ QC report** — per-base quality with quartiles, per-sequence quality, per-base sequence content, per-sequence GC, per-base N, length distribution, duplication by exact-match counting, Q20/Q30 [doc] | "Is this sequencing run any good, and where does quality fall off?" | no | yes | M | high |
| 2 | **Codon usage analysis** — CAI, RSCU, ENC/Nc, per-gene codon table, rare-codon and CDS CpG-content report [doc] | "Will this gene express well in *E. coli*, and which codons are the problem?" | no (reuse `CODON_USAGE`) | yes | S–M | high |
| 3 | **In-silico PCR / primer-pair search** — find all amplicons for a primer pair on both strands, product sizes, mismatch and 3′-end status, mispriming/vector screening [doc] | "Where else does this primer pair amplify, and what size band do I expect?" | no | yes | S–M | high |
| 4 | **Phylogenetic trees + Newick I/O + SVG rendering** — UPGMA, neighbour-joining, p/Jukes-Cantor/Kimura-2P distances, bootstrap & jackknife, strict/majority/greedy consensus, rooted/circular/unrooted layout [doc] | "What is this sample closest to, and how confident is that?" | no | yes | M–L | high |
| 5 | **CpG island + GC/cumulative skew detection** — sliding window, island = length ≥ 200 **and** %GC > 50 **and** obs/exp ≥ 0.6 (window default 100); cumulative skew for ori/ter [doc] | "Is this a promoter region? Where is the replication origin?" | no | yes | S | high |
| 6 | **Alignment post-processing suite** — IUPAC consensus, gap-fraction trimming, identity matrix, pairwise distance matrix, per-column coverage [doc] | "Which columns are junk, what is the consensus, how similar is everything?" | no | yes | M | high |
| 7 | **Batch multi-file analysis + tabular export** — run a chosen analysis over every matching file in the workspace and emit one CSV/TSV report [doc] | "Do this same check on all 60 of my plasmids/reads." | no | yes | M | high |
| 8 | **Duplicate / mutagenesis design** — silent mutation to add or remove a restriction site without changing the protein, codon-degeneracy suggestions, multi-site mutagenesis, back-translation with ambiguity options [doc] | "Can I destroy this internal EcoRI site silently, and what primers do I need?" | no | yes | S–M | high |
| 9 | **Duplex thermodynamics extras** — ΔG°37 and Tm for a *specified* duplex, ΔG of a given secondary structure, mismatch-duplex ΔG (Allawi/SantaLucia tables), dNTP/Mg²⁺/DMSO corrections beyond the current salt model [doc] | "What is the ΔG of this hairpin, and will this mismatch duplex melt?" | no | yes | S–M | high |
| 10 | **Batch annotation & format toolkit** — write features back out, transfer annotations between files, extract all CDS/promoter regions in bulk, GFF3/BED read+write, EMBL read, extract/rotate/insert/split/join/rename [doc] | "Pull every CDS out of these GenBank files, translate them, and hand me a BED." | no | yes | M | high |
| 11 | **Vector/adapter contamination screening** — screen reads or a sequence against a small *embedded* common-vector/adapter set (pUC, pET, pcDNA, Gateway attB/attR, Illumina TruSeq/Nextera) [doc] | "Is this assembly contaminated with vector backbone or adapter?" | no — embedded short list | yes | S–M | high |
| 12 | **FASTQ trimming/filtering utilities** — sliding-window and BWA-style partial-sum quality trimming, poly-G/poly-A tail trimming, length/N filters, primer trimming, subsampling, FASTQ↔FASTA, Phred+33/+64/Solexa conversion, read merging for overlapping pairs [doc] | "Clean these reads up before I look at them, and merge the overlapping pairs." | no | yes | M | high |
| 13 | **Protein sequence-feature suite** — PTM motif scan (N-glycosylation N-{P}-[S/T], C-mannosylation W-x-x-W, myristoylation, SUMO ψKxE, PKA R-R-x-[S/T], CK2 [S/T]-x-x-[D/E], [S/T]-P), low-complexity/SEG entropy regions, instability index, aliphatic index, aromaticity, flexibility [doc] | "Where are the glycosylation sites and the low-complexity tail?" | no (embedded tables) | yes | M | high |
| 14 | **Antigenicity / surface-epitope heuristics** — Kolaskar-Tongaonkar antigenic propensity (20-value A(p) table, 7-mer average, runs ≥ 6) plus Parker hydrophilicity / Emini accessibility / Karplus-Schulz flexibility plots [doc] | "Which stretches are likely surface-exposed epitopes?" | no | yes | S | med–high |
| 15 | **Standard-curve & qPCR extras** — 4-parameter-logistic / sigmoid amplification-curve fitting, Cq determination from raw fluorescence, melt-curve *peak calling* from a raw curve (not just a Tm array), master-mix and plate-layout calculator [doc] | "Fit my standard curve, find my Cq, and tell me exactly what to pipette." | no | yes | S–M | med–high |
| 16 | **PWM/PSSM motif scanning from user-supplied matrices** — accept a JASPAR/PFM/PWM matrix as *input text*, score both strands, report hits with score/p-value threshold; also build a PWM from a supplied alignment [doc] | "Scan my promoter for this transcription-factor motif." | no — matrices are user input, not a shipped DB | yes | M | med–high |
| 17 | **Tandem / inverted / interspersed repeat detection** — `etandem`-style periodicity search (+1 match / −1 mismatch, default threshold 20), inverted repeats by local DP of the sequence vs its reverse complement, palindrome heuristic, interspersed repeats via k-mer index [doc] | "Are there microsatellites or repeats here that will break my PCR or assembly?" | no | yes (TRF-grade statistics: partial) | M | med–high |
| 18 | **Population genetics from a genotype table** — allele/genotype frequencies, Hₒ/Hₑ, HWE χ² **and** exact test, F_IS, F_ST (Weir & Cockerham), LD r²/D′ by EM, PCA from genotypes [doc] | "Is this locus in Hardy-Weinberg, and do my samples cluster?" | no — genotype table only | yes-but-heavy | M–L | med–high |
| 19 | **Microbiome / OTU-table analysis** — Shannon, Simpson, Chao1 (with variance/CI), rarefaction curves, Bray-Curtis/Jaccard, PCoA from a distance matrix, PERMANOVA by permutation, differential abundance by Wilcoxon/χ²/Fisher [doc] | "Is diversity different between my groups, and which taxa drive it?" | no | yes-but-heavy (eigensolver) | M–L | med–high |
| 20 | **Additional Cas/PAM families and HDR donor design** — Cas12a TTTV, Cas13, SaCas9 NNGRRT, nickase pairing (D10A) with overlap/spacing rules; HDR ssODN/donor design with homology arms and silent PAM-blocking edits [doc] | "Design a Cas12a guide and an HDR donor to fix this point mutation." | no | yes | M | med–high |
| 21 | **Transmembrane / signal-peptide heuristics** — windowed Kyte-Doolittle hydropathy (EMBOSS `pepwindow` default window 19; classic TM call ≈ window mean ≥ 1.6) with orientation call; von Heijne (−3,−1) rule; `sigcleave`-style position-specific weight matrix (positions −13..+2, minweight 3.5) [doc] | "Is this a membrane protein, and is there a cleavable signal peptide?" | no | yes | S–M | med |
| 22 | **Coiled-coil and disorder heuristics** — COILS-style 28-residue window log-odds against a coiled-coil matrix in both heptad registers; IUPred-style composition pairwise-energy core; charge-hydropathy / FoldIndex boundary [doc] | "Does this protein have a coiled-coil or a disordered linker?" | no | yes | S–M | med |
| 23 | **Dotplot / self-comparison** — word-match and window dotplots, direct and inverted repeats visualised, all-vs-all within a set (k-mer hash, O(n+m+matches)) [doc] | "Show me the repeated and inverted structure of this sequence." | no | yes | S–M | med |
| 24 | **RNA secondary structure (Nussinov)** — base-pair-maximisation DP with traceback, hairpin/loop listing, dot-bracket output, arc/linear SVG rendering [doc] | "What is the likely fold of this short RNA, and where are the hairpins?" | no | yes-but-heavy (O(n³); fine ≈500 nt) | M–L | med |
| 25 | **Microsatellite / oligo-design utilities** — siRNA/shRNA duplex selection by the documented Tuschl/Elbashir rules (23-mer window, AA(N19)TT preference, GC 30–70%, no 4-nt runs, NARN(17)YNN for Pol III), guide-strand asymmetry scoring, antisense oligo scan [doc] | "Design me a siRNA/shRNA against this mRNA." | no | yes | S–M | med |
| 26 | **Splice-site and regulatory-element scanning** — MaxEntScan-style maximum-entropy donor/acceptor scoring (fixed 4⁷ and 4³/4⁴ decomposition tables), Kozak context (GCCRCCAUGG), Shine-Dalgarno (AGGAGG), polyadenylation signal (AATAAA), TATA-box/promoter element scan [doc] | "Where are the exon junctions and the Kozak context around this ATG?" | no — tables are transcribed constants | yes-but-heavy (MaxEnt tables) | M | med |
| 27 | **Sanger read assembly into contigs** — greedy overlap-layout-consensus over a handful of `.ab1`/`.seq` reads, low-quality end trimming, consensus with quality [doc] | "Assemble these Sanger reads into one verified contig." | no | yes | M | med |
| 28 | **Coverage / depth analysis from a text depth or BED-like table** — per-base depth, mean and breadth over targets, histogram, low-coverage gap calling [doc] | "Did my panel cover every target, and where are the gaps?" | no | yes | S–M | med |
| 29 | **Hierarchical clustering / k-medoids / MDS on any distance matrix** — single/complete/average linkage by Lance-Williams, k-medoids (not k-means — a distance matrix is not Euclidean), classical MDS via a Jacobi eigensolver (~80 lines, no linear-algebra dependency) [doc] | "Cluster these samples/profiles and plot them in 2-D." | no | yes-but-heavy | M | med |
| 30 | **Sequence composition & statistics report** — word/dimer/trimer frequencies, GC123 (per-codon-position GC), isochore-style GC windows, Shannon entropy, linguistic complexity, N50/L50, MD5-style sequence digest [doc] | "Give me a full composition report on this sequence." | no | yes | S | med |
| 31 | **Genome-editing outcome analysis** — collapse Sanger or amplicon-NGS reads into variant clusters with min-frequency, classify protein effect (frameshift / in-frame stop / in-frame protein / silent) [doc] | "Did my CRISPR edit work, and what alleles did I get?" | no | yes | M | med |
| 32 | **Chou-Fasman / GOR-style secondary structure prediction** — fixed 20×7 conformational-parameter table with nucleation/extension/turn rules; GOR information-value windows [doc] | "Roughly where are the helices and strands in this protein?" | no (embedded tables) | yes-but-heavy (accuracy is ~60%) | M | med |
| 33 | **Pileup-style variant calling on a text alignment vs a reference** — build a pileup from pre-aligned text, call SNVs/indels with depth/QUAL/strand-bias filters, emit VCF-like output | "What variants are in this amplicon alignment?" | no binary parsing | yes-but-heavy | M–L | med |
| 34 | **Charge-vs-pH curve and pI refinement** — Henderson-Hasselbalch charge summation with selectable pK sets (EMBOSS `Epk.dat`: N-term 8.6, C-term 3.6, C 8.5, D 3.9, E 4.1, H 6.5, K 10.8, R 12.5, Y 10.1), disulphide and modified-lysine handling, titration-curve SVG [doc] | "Plot this protein's charge across pH." | no | yes | S | med |
| 35 | **Protein digest & MS mass-fingerprinting extras** — more enzymes/reagents, semi-specific and non-specific digests (`allpartials`), missed-cleavage statistics, monoisotopic masses, peak-list export [doc] | "What peptides will I see, and do they match this protein?" | no | yes | S–M | med |
| 36 | **Haplotype inference and LD structure** — EM haplotype-frequency estimation, D′/r² matrices, LD clumping by distance/threshold | "What haplotypes are present, and which markers are linked?" | no | yes | M | med |
| 37 | **Oligo/probe libraries and lab-inventory calculators** — resuspension (nmol → µM), unit conversion (mass ↔ moles ↔ copies), serial dilution, master mix, primer/probe inventory with freezer location and batch reorder export [doc] | "How do I resuspend 40 nmol, and what do I pipette for 24 reactions?" | no | yes | S | med |
| 38 | **Additional cloning strategies** — Gateway BP/LR (attB/attR recombination simulation), In-Fusion, TA/TOPO, overlap-extension PCR, parts cloning [doc] | "Simulate a Gateway LR reaction / an overlap-extension PCR." | no | yes | M | med |
| 39 | **Secondary-structure display** — dot-bracket parsing + arc/linear SVG rendering, oligo self-dimer and hairpin structure diagrams [doc] | "Draw the predicted structure and this primer dimer." | no | yes | S | med |
| 40 | **Rare-codon / codon-pair adaptation reporting at CDS scale** — per-CDS codon table with host comparison, codon-pair bias heuristics, GC3, hidden-stop scan | "Show me codon-by-codon how this CDS compares with the host." | no | yes | S–M | med |

---

## 2. Must-have five for a bench-focused toolset

1. **Read-level FASTQ QC report.** Every sequencing-adjacent bench user's first question is "is this
   run good?", and the shipped `seqio.mjs` already parses FASTQ but reports only mean quality and a
   truncated per-position mean; the whole FastQC module set is pure text arithmetic with no database.
2. **Codon usage analysis (CAI/RSCU/ENC + rare-codon report).** The package already ships a
   preferred-codon table *and* a silent codon optimiser, so an *explaining* counterpart is the
   cheapest high-value add in the list and answers the recurring "will this express?" question.
3. **Phylogenetics with Newick I/O and SVG rendering.** `msa.mjs` already builds a UPGMA guide tree
   and the package already draws SVG, so distance matrices + NJ/UPGMA + bootstrap + tree SVG reuse
   both halves; it is the largest missing *analysis* capability relative to Geneious, which ships
   NJ/UPGMA with Jukes-Cantor/HKY/Tamura-Nei and Newick.
4. **In-silico PCR / primer-pair search with mispriming and product sizes.** It closes the loop on the
   existing primer-design tools, is trivially pure-JS, and is exactly what bench users reach for when
   a PCR gives an unexpected band.
5. **CpG island + GC/cumulative skew detection.** Tiny, deterministic and fully documented
   (Gardiner-Garden & Frommer thresholds), and it turns the existing plasmid/GenBank parsers into a
   promoter/origin-annotation tool rather than a map drawer.

---

## 3. Tempting but infeasible

Each entry names the exact blocker.

- **BAM reading, indexing, pileup.** BGZF is concatenated gzip members each ≤ 64 KB before *and*
  after compression, with a `BC` extra sub-field carrying the block size; `.bai`/`.csi`/`.gzi` are
  little-endian offset tables. Sequential gunzip is JS-doable, but block-level semantics and virtual
  offsets mean hand-parsing the gzip extra field. Blocker: **binary format**. (A JSON/text pileup
  input is the feasible substitute — row 33.)
- **CRAM.** Reference-based compression: decoding needs the *exact* reference sequence plus CRAM
  slice containers. Blocker: **binary format + reference**.
- **De-novo genome assembly (SPAdes/Flye/Velvet).** overlap/de Bruijn graphs at memory and time
  scales far beyond a browser/agent tool call. Blocker: **compute scale** (+ external binary).
- **Read mapping (BWA/Bowtie/Minimap2).** FM-index/BWT construction over a genome plus
  seed-chain-align; needs an index. Blocker: **external binary + compute scale**.
- **Taxonomic classification (Kraken/QIIME/BLAST-based).** The multi-GB reference database (or
  trained model) *is* the method. Blocker: **reference database**.
- **Reference-indexed variant calling and structural variants (GATK/FreeBayes).** Index, local
  realignment, pair/HMM models; SV needs split/discordant evidence over mapped BAM. Blocker:
  **binary format + external binary**.
- **BLAST-family homology search against public databases.** Remote DB + network. Blocker:
  **network + database**. Shipped Smith-Waterman against a user-supplied sequence is the honest local
  substitute.
- **MAFFT/MUSCLE/Clustal Omega/T-Coffee-grade MSA; RAxML/IQ-TREE/MrBayes ML/Bayesian trees.**
  Iterative refinement, guide-tree optimisation, and likelihood/Bayesian search. A progressive
  aligner and distance trees are feasible (rows 4, 6); the rest are a different product. Blocker:
  **external binary + compute scale**.
- **HMMER/Pfam, PROSITE, PRINTS, REBASE, TRANSFAC/JASPAR, CUTG, AAINDEX scans.** The scan is easy; the
  *curated database* is the product. Blocker: **reference database**. The shipped compromise is
  already the right shape: a small embedded table (90+ enzymes) plus **user-supplied** matrices
  (row 16).
- **HMM/ML predictors: TMHMM, Phobius, DeepTMHMM, all SignalP ≥ 1.1 (6.0 is a transformer + CRF),
  PSIPRED/JPred, SOPMA (needs MSA), DisEMBL, PONDR, Marcoil, NetPhos-class, NetNGlyc, BepiPred,
  AlphaFold2, ANCHOR2, DisEMBL.** Trained weights are not derivable in a few hundred lines. Blocker:
  **model weights**. The heuristic counterparts (rows 14, 21, 22, 32) are the defensible substitutes
  and must be labelled as heuristics.
- **ViennaRNA/RNAfold/Mfold MFE and partition-function folding.** A full nearest-neighbour energy
  model with loop tables and Boltzmann sampling is a separately validated program; Zuker+McCaskill is
  ~5–10× Nussinov's code *plus* transcribed Turner tables. Nussinov (row 24) is the feasible subset —
  but do not market it as ViennaRNA parity. Blocker: **algorithm scope** (partial only).
- **Structure-based 3-D protein viewing/modelling.** PDB is text, so a 2-D Cα projection is feasible,
  but real structure prediction needs weights and compute. Blocker: **model weights + compute scale**
  (prediction), **3-D rendering** (viewing).
- **Genome-scale CRISPR off-target search (Cas-OFFinder class).** Needs an indexed whole genome and a
  bulge-tolerant search. Blocker: **reference database + compute scale**.
- **Tandem Repeats Finder-grade repeat statistics.** The detection core (k-tuple match lists,
  distance lists, sum-of-heads normal approximation, random-walk bound, banded wraparound DP) is
  reimplementable; the *statistical criterion distributions* are the hard part. Blocker: **partial** —
  ship the `etandem`-style core and label the statistics as approximate.
- **ABI microsatellite genotyping (`.fsa` fragment analysis with ladder fitting, Local Southern /
  cubic-spline sizing, binning).** Geneious ships this; the maths is implementable, but it needs the
  `.fsa` binary trace format. Blocker: **binary format**. The shipped ABIF `.ab1` parser is the
  precedent that this is *feasible but a real parser effort*, not a few hundred lines.
- **Genotype imputation, ancestry projection onto 1000-Genomes PCs, supervised ADMIXTURE,
  LD-based clumping.** All need a reference panel. Blocker: **reference database**.
- **DESeq2/edgeR-grade differential abundance.** Negative-binomial GLM with empirical-Bayes
  dispersion shrinkage. Blocker: **algorithm scope** — use Wilcoxon/χ²/Fisher (row 19) instead.
- **UniFrac.** Requires a phylogenetic tree *plus* tip abundances. Blocker: **partial** — it becomes
  feasible only after row 4 ships.
- **Chou-Fasman accuracy expectations.** Implementable (row 32) but ~60% accurate and superseded
  decades ago; ship only as a labelled heuristic, never as a PSIPRED substitute. Blocker: **not a
  blocker — an expectation/correctness caveat**.
- **Genome-scale PCA (10⁵ samples × 10⁶ SNPs), PHASE/STRUCTURE MCMC haplotype inference, streaming
  multi-GB files.** Blocker: **compute scale**; mitigate by sampling/subsampling (row 12) and by
  scoping row 18 to hundreds of samples × thousands–tens-of-thousands of SNPs.

---

## 4. Method note: verified vs judged

- **[doc]** marks a claim read from vendor or tool documentation (§5). **[judgement]** marks my own
  assessment of value, effort, or "defensible heuristic" status.
- Feasibility ratings are judgements, anchored on: the algorithmic references in §5, the shipped
  module sizes, and (for the heavy items) the explicit complexity notes below.
- Items where a subagent or I could not reach authoritative documentation are flagged inline in §5
  as **(u)** / partially verified. Notably: `support.snapgene.com` and `help.benchling.com` return
  HTTP 403 to automated fetching, so SnapGene/Benchling findings come from vendor feature pages and
  CRISPR guides rather than user manuals; `en.wikipedia.org`, `web.archive.org` (from the research
  sandbox) and some PubMed pages returned no body, so those specific algorithm details rest on
  printed/adjacent sources or on general literature and should be spot-checked before publication.
- **Important honesty constraint for row 9 (duplex thermodynamics).** Verified: the *same* primer can
  differ by 10+ °C in reported Tm between IDT OligoAnalyzer, the NEB Tm Calculator and local Primer3,
  because each uses a different nearest-neighbour parameter set and salt model. Any new ΔG/Tm feature
  must therefore name its parameter set and salt model in the output (the existing tools already
  follow this discipline — the README's "方法学与使用须知" section states the SantaLucia 1998 +
  von Ahsen 2001 choice and echoes actual conditions), and must **not** present a Tm as
  interchangeable with a vendor calculator. Recommended extra parameter sets, all transcribed
  constants: Breslauer 1986, Sugimoto 1996 (OligoCalc's recomputation), SantaLucia & Hicks 2004
  dangling ends, Bommarito 2000, and Allawi/Peyret mismatch parameters.
- Verified reference points for the calculator surface: IDT OligoAnalyzer takes sequence + Na⁺/Mg²⁺/
  dNTP/oligo-concentration and returns Tm, GC%, MW, molar extinction coefficient, nmol/OD₂₆₀ and
  µg/OD₂₆₀, with self-dimer ΔG risk bands (> −3 low, −3…−6 moderate, < −6 high); the NEB Tm Calculator
  takes 1–2 primers **plus a polymerase identity** (54 supported products) and returns Tm, and Ta for
  two primers; OligoCalc is a genuinely **client-side pure-JS** calculator (Wallace, Howley 1979
  salt-adjusted, and NN via Breslauer/Sugimoto; MW from dNMP masses) — direct precedent that this
  whole class is browser-feasible.
- Two complexity facts worth carrying into the design of rows 18/19/24/29:
  - **PCA/PCoA** costs O(n·m·k) for k components with a randomised/truncated SVD, or O(n³) per Jacobi
    sweep for the n×n Gram/double-centred matrix — fine for hundreds of samples.
  - **All-pairs LD** is O(m²) pairs: ~5 000 SNPs ≈ 12.5 M pairs is fine; 10⁶ SNPs ≈ 5·10¹¹ pairs is
    not a browser task.

---

## 5. URLs relied on

**Baseline (read locally):** `dsh-molbio-tools/README.md`, `package.json`, `lib.mjs`, `protein.mjs`,
`seqio.mjs`, `docs/maintainer.md`.

**Commercial plasmid / cloning suites**
- SnapGene features (and CRISPR guide — documents a *manual* NGG Ctrl-F workflow, no scoring engine): https://www.snapgene.com/features · https://www.snapgene.com/guides/design-grna-for-crispr · https://www.snapgene.com/series/annotate
- Geneious Prime features; manual chapters used for verified algorithm detail — phylogenetics (NJ/UPGMA, Jukes-Cantor/HKY/Tamura-Nei, bootstrap/jackknife, Newick, consensus trees): https://www.geneious.com/features/prime · https://manual.geneious.com/en/latest/Phylogenetics.html
- Geneious microsatellite analysis (`.fsa`, ladder fitting, Local Southern/cubic spline, binning, allele table): https://manual.geneious.com/en/latest/Microsatellites.html
- Geneious FastQC report integration: https://manual.geneious.com/en/latest/FastQC.html
- Geneious manual chapters referenced for primers, CRISPR, annotations, analyses, sequences: https://manual.geneious.com/en/latest/Primers.html · https://manual.geneious.com/en/latest/CRISPR.html · https://manual.geneious.com/en/latest/Annotations.html · https://manual.geneious.com/en/latest/Analyses.html · https://manual.geneious.com/en/latest/Sequences.html
- Benchling molecular biology / primers / alignments / CRISPR (help centre 403 — vendor pages only): https://www.benchling.com/molecular-biology · https://www.benchling.com/primers · https://www.benchling.com/alignments · https://www.benchling.com/crispr
- Serial Cloner (freeware, last documented 2.6.1 / March 2012): http://serialbasics.free.fr/Serial_Cloner.html · http://serialbasics.free.fr/serialcloner/version.html
- UGENE key features (aligners, BAM/SAMtools, IQ-TREE/MrBayes/PhyML, TFBS weight matrices + SITECON, repeat finder, dotplots, GOR IV/PSIPRED): https://ugene.net/key_features.html

**Bench calculators / web tools**
- IDT web tools overview (SciTools set, resuspension & dilution, primer design): https://beta.idtdna.com/page/support-and-education/decoded-plus/primer-design-and-other-tools-you-should-know-about/ · https://beta.idtdna.com/page/support-and-education/decoded-plus/easy-resuspension-and-dilution-of-oligonucleotides/
- IDT OligoAnalyzer and NEB Tm Calculator parameters/algorithms (read via a documentation mirror, since the vendor pages block automated fetch): https://zitniklab.hms.harvard.edu/ToolUniverse/en/tools/idt_tools.html · https://zitniklab.hms.harvard.edu/ToolUniverse/en/tools/neb_tm_tools.html
- NEB interactive tools / molecular-cloning tech guide (Double Digest Finder, NEBcutter, Golden Gate & NEBuilder tools): https://www.neb.com/en/tools-and-resources/interactive-tools *(HTTP 403 to automated fetch — cited from search metadata)* · https://www.neb.com/en-gb/-/media/nebuk/files/brochures/molcloning_tech_guide.pdf
- Benchling well plates / calculator context, and Benchling CRISPR (160+ reference genomes, on/off-target scores — i.e. DB-backed): https://www.benchling.com/blog/well-plates · https://www.benchling.com/crispr
- **OligoCalc** — a genuinely client-side pure-JS calculator (Wallace rule; Howley 1979 salt adjustment; Breslauer 1986 / Sugimoto 1996 NN; Xia & SantaLucia 1998 RNA parameters; MW from dNMP masses): https://oligocalc.eu/OligoCalc.html
- **Primer3web 4.1.0** help (SantaLucia 1998 or Breslauer 1986 selectable Tm tables; ~150 `PRIMER_*` tags; mispriming library): https://yanglab.hzau.edu.cn/primer/html/primer3web_help.htm
- **WebLogo 3** manual (information content per Schneider & Stephens 1990; Bayesian Dirichlet small-sample correction; credible-interval error bars): https://cibiv.at/~huy/EpiSpeller/weblogo-3.2/weblogolib/htdocs/manual.html
- **RNAfold** man page (Zuker & Stiegler 1981 MFE; McCaskill 1990 partition function; Mathews 2004 parameters): https://man.freebsd.org/cgi/man.cgi?query=RNAfold&sektion=1&manpath=freebsd-ports
- **iTOL** help (visualisation/layout only — performs no phylogeny inference, confirming that tree *rendering* and tree *building* are separate capabilities): https://itol.embl.de/help.cgi
- **ExPASy ProtParam** documentation (Edelhoch 1967 with Pace 1995 extinction coefficients; N-end-rule half-life; Guruprasad instability index; Ikai aliphatic index; Kyte-Doolittle GRAVY): https://web.expasy.org/protparam/protparam-doc.html

*(Benchling's help centre, Thermo Fisher, Promega and Sigma calculator pages could not be read: Cloudflare 403, JS-only rendering, or cross-origin redirect loops. Any statement about those vendors' internal formulas is therefore omitted rather than asserted.)*

**Toolkits (Biopython / SeqKit / EMBOSS)**
- Biopython `Bio.SeqUtils` (gc_fraction with ambiguous weighting, GC123, GC_skew, molecular_weight incl. monoisotopic and circular, six_frame_translations, CodonAdaptationIndex with `calculate`/`optimize`, ProtParam's instability/flexibility/aromaticity/charge_at_pH/secondary_structure_fraction, MeltingTemp Tm_NN/Tm_GC/Wallace + salt_correction/chem_correction, IsoelectricPoint): https://biopython.org/docs/latest/api/Bio.SeqUtils.html
- SeqKit subcommand list (38 commands; `stats` has no N50/L50 column; `fx2tab` adds GC-skew/length/MD5 and mean-error-probability quality; `fq2fa`, `sample`, `rmdup`, `pair`, `amplicon`, `convert`): https://bioinf.shenwei.me/seqkit/ · https://bioinf.shenwei.me/seqkit/usage/
- EMBOSS application index (full program list: `cai`, `chips`, `cusp`, `cpgreport`/`newcpgreport`, `etandem`, `equicktandem`, `einverted`, `palindrome`, `tmap`, `pepwindow`, `pepstats`, `iep`, `antigenic`, `sigcleave`, `garnier`, `hmoment`, `digest`, `distmat`, `cons`, `infoalign`, `sirna`, `recoder`, `silent`, `dan`, `wordcount`, `compseq`, `isochore`, `tcode`, `syco`): https://emboss.sourceforge.net/apps/release/6.3/emboss/apps/index.html
- EMBOSS `cai` (Sharp & Li 1987 CAI; requires a reference codon-usage table; notes CAI/Fop vs Nc/Shannon entropy): https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/cai.html
- EMBOSS `iep` (pI by Henderson-Hasselbalch charge summation; full `Epk.dat` pK table; disulphide/modified-lysine options): https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/iep.html
- EMBOSS `antigenic` (Kolaskar-Tongaonkar A(p) propensity table and the exact 7-mer prediction algorithm): https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/antigenic.html
- EMBOSS `sigcleave`, `pepwindow`, `pepstats`, `pepdigest`, `newcpgreport`, `etandem`, `einverted`, `tmap` (algorithms, parameters and default thresholds): https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/sigcleave.html · https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/pepwindow.html · https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/pepstats.html · https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/pepdigest.html · https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/newcpgreport.html · https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/etandem.html · https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/einverted.html · https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/tmap.html
- EMBOSS `sirna` (full Tuschl/Elbashir design algorithm, scoring table and Pol III NARN(17)YNN rule): https://emboss.sourceforge.net/apps/release/6.6/emboss/apps/sirna.html

**Sequencing QC**
- FastQC analysis-module index (the 12 modules) plus the duplication, adapter-content and per-tile pages: https://www.bioinformatics.babraham.ac.uk/projects/fastqc/Help/3%20Analysis%20Modules/ · https://www.bioinformatics.babraham.ac.uk/projects/fastqc/Help/3%20Analysis%20Modules/8%20Duplicate%20Sequences.html · https://www.bioinformatics.babraham.ac.uk/projects/fastqc/Help/3%20Analysis%20Modules/10%20Adapter%20Content.html · https://www.bioinformatics.babraham.ac.uk/projects/fastqc/Help/3%20Analysis%20Modules/12%20Per%20Tile%20Sequence%20Quality.html
- FastQC embedded adapter list (12-bp fragments, no DB): https://sources.debian.org/src/fastqc/0.11.8+dfsg-2/Configuration/adapter_list.txt/
- fastp README (one-pass QC + trimming; full TruSeq adapter sequences; overlap-merge parameters `overlap_len_require` 30 / `overlap_diff_limit` 5 / 20%; sliding-window and poly-G; overrepresentation sampling): https://raw.githubusercontent.com/OpenGene/fastp/v0.12.1/README.md
- cutadapt algorithms (semiglobal adapter alignment; BWA partial-sum quality trimming; poly-A scoring): https://cutadapt.readthedocs.io/en/stable/algorithms.html
- Trimmomatic manual (ILLUMINACLIP Palindrome/Simple, SLIDINGWINDOW, LEADING/TRAILING/CROP/MINLEN): http://www.usadellab.org/cms/?page=trimmomatic
- FLASH and PEAR read merging (overlap-based merging; PEAR's statistical p-value test and OES scoring): https://ccb.jhu.edu/software/FLASH/ · https://cme.h-its.org/exelixis/web/software/pear/doc.html
- FastQ Screen (needs an aligner + reference indices — the counter-example): https://www.bioinformatics.babraham.ac.uk/projects/fastq_screen/
- BGZF/bgzip and samtools format docs (why BAM is not a text format; `.gzi`/index structure): https://www.htslib.org/doc/bgzip.html · http://www.htslib.org/doc/samtools-depth.html · http://www.htslib.org/algorithms/duplicate.html
- MultiQC (report aggregator — computes nothing itself): https://docs.seqera.io/multiqc/

**Population genetics**
- PLINK 1.9 basic statistics (`--freq/--hardy/--het/--fst/--pca/--make-grm-bin/--assoc`) and LD (`--r/--r2`): https://www.cog-genomics.org/plink/1.9/basic_stats · https://www.cog-genomics.org/plink/1.9/ld
- Wigginton, Cutler & Abecasis 2005, HWE exact test: https://pubmed.ncbi.nlm.nih.gov/15789306/ *(HTTP 203, no body — cited from search metadata)*
- Tajima 1989: https://pubmed.ncbi.nlm.nih.gov/2513255/ *(same caveat)*
- VCFtools: https://vcftools.github.io/ · Genepop (HWE exact tests, F_IS, LD): https://search.r-project.org/CRAN/refmans/genepop/html/00Index.html · Arlequin manual: http://labs.icb.ufmg.br/lbem/aulas/pg/apepop/Arlequin.pdf

**Protein prediction and alignment/phylogenetics algorithms**
- Chou-Fasman parameters and rules: https://webs.iiitd.edu.in/raghava/betatpred/chou.html
- TMHMM 2.0 and SignalP 6.0 service pages (documenting that these are HMM/transformer models, not heuristics): https://services.healthtech.dtu.dk/services/TMHMM-2.0/ · https://services.healthtech.dtu.dk/services/SignalP-6.0/ · Phobius: https://pubmed.ncbi.nlm.nih.gov/15111065/
- IUPred2A (composition pairwise-energy content; the boundary with trained ANCHOR2): https://iupred2a.elte.hu/
- SOPMA (requires an MSA): https://pubmed.ncbi.nlm.nih.gov/8808585/
- SantaLucia 1998 unified nearest-neighbour parameters (ΔH/ΔS dimers, initiation, symmetry, salt corrections): https://pmc.ncbi.nlm.nih.gov/articles/PMC19045/
- MaxEntScan model card (fixed maximum-entropy tables, not a trainable NN): https://multimolecule.danling.org/models/maxentscan/
- Newick format specification: http://vc.arb-home.de/readonly/tags/arb-6.0.3/SOURCE_TOOLS/docs/newick_doc.html
- Tandem Repeats Finder README (detection core vs statistical criteria): https://raw.githubusercontent.com/Benson-Genomics-Lab/TRF/master/README.md
- Sequence logos (Schneider & Stephens): https://academic.oup.com/nar/article/18/20/6097/1141316 *(HTTP 403 — formula from general literature, flagged)*
- mothur Chao1 (formula, variance, CI): https://mothur.org/wiki/chao/
- JASPAR (an external matrix database — hence user-supplied matrices, not a shipped DB): https://jaspar.genereg.net/
- Neighbour-joining (Saitou & Nei) — archived reference: http://web.archive.org/web/20111217113421/http://en.wikipedia.org/wiki/Neighbor-joining

---

## 6. One-paragraph recommendation

Ship the five must-haves as a single "bench analysis" release: FASTQ QC, codon usage, phylogenetics +
Newick + tree SVG, in-silico PCR, and CpG/skew. They share almost all of their infrastructure with
what already exists (`seqio.mjs`, `CODON_USAGE`, the UPGMA guide tree in `msa.mjs`, the SVG
renderers, and the GenBank/SnapGene parsers), they need no new external data, and together they close
the three largest *user-visible* gaps versus the commercial suites: "is my sequencing data good",
"will my gene express", and "what is this sequence related to / where is its promoter". Everything in
§3 should be explicitly declined in the README as out of scope, with the exact blocker named, so
users stop asking the tool to do BLAST, BAM or alignment.
