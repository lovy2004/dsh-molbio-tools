/**
 * dsh-molbio-tools/papers.mjs
 *
 * Literature-library storage and PubMed search projection. Storage goes
 * through the harness `fs` service with the session's standing sandbox policy,
 * so the library file respects the same confinement as the agent's own write
 * tool. The library is a single JSON file (default: papers.json in the session
 * workspace) that users can read, edit, and version like any other file.
 */

import { isAbsolute, join } from 'node:path';
import { MolbioInputError } from './lib.mjs';

export const DEFAULT_LIBRARY_FILE = 'papers.json';

/** Resolve a workspace file path: absolute stays, relative joins the workspace. */
export function workspaceFilePath(file, exec, workspaceRoot) {
  const base = workspaceRoot ?? exec?.agent?.session?.header?.cwd ?? process.cwd();
  return isAbsolute(file) ? file : join(base, file);
}

/** Resolve the library file path: args.file, or papers.json under the workspace. */
export function libraryPath(args, exec, workspaceRoot) {
  return workspaceFilePath(args.file ?? DEFAULT_LIBRARY_FILE, exec, workspaceRoot);
}

/** Write one text file atomically through the fs service with the standing policy. */
export async function writeWorkspaceFile(fs, path, content, sandboxPolicy) {
  try {
    const target = await fs.resolve(path);
    await fs.writeText(target, content, undefined, undefined, sandboxPolicy);
    return target;
  } catch (error) {
    throw new MolbioInputError(`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read the library; a missing file is an empty library. */
export async function loadLibrary(fs, path) {
  let raw;
  try {
    const target = await fs.resolve(path);
    const info = await fs.stat(target);
    if (info === undefined) return { papers: [] };
    raw = await fs.readText(target);
  } catch (error) {
    throw new MolbioInputError(`could not read the paper library at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.papers)) {
      throw new Error('expected an object with a "papers" array');
    }
    return parsed;
  } catch (error) {
    throw new MolbioInputError(`the paper library at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Write the library atomically through the fs service with the standing policy. */
export async function saveLibrary(fs, path, library, sandboxPolicy) {
  await writeWorkspaceFile(fs, path, JSON.stringify(library, null, 2) + '\n', sandboxPolicy);
}

/** Stable identity for dedupe: pmid, else url, else title (+year). */
export function paperKey(paper) {
  if (typeof paper.pmid === 'string' && paper.pmid !== '') return `pmid:${paper.pmid}`;
  if (typeof paper.url === 'string' && paper.url !== '') return `url:${paper.url}`;
  return `title:${paper.title}:${paper.year ?? ''}`;
}

/** Canonicalize one incoming paper entry. */
export function canonicalPaper(entry) {
  if (typeof entry !== 'object' || entry === null) throw new MolbioInputError('each paper must be an object');
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  if (title === '') throw new MolbioInputError('each paper needs at least a non-empty "title"');
  const paper = {
    id: '',
    title,
    added_at: new Date().toISOString().slice(0, 10),
  };
  for (const key of ['pmid', 'url', 'authors', 'year', 'journal', 'note']) {
    if (typeof entry[key] === 'string' && entry[key].trim() !== '') paper[key] = entry[key].trim();
  }
  if (Array.isArray(entry.tags)) {
    const tags = entry.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag !== '');
    if (tags.length > 0) paper.tags = tags;
  }
  paper.id = paperKey(paper);
  return paper;
}

/** Add papers; entries that duplicate an existing key are skipped. */
export function addPapers(library, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new MolbioInputError('papers must be a non-empty array');
  const existing = new Set(library.papers.map(paperKey));
  const added = [];
  for (const entry of entries) {
    const paper = canonicalPaper(entry);
    if (existing.has(paper.id)) continue;
    existing.add(paper.id);
    library.papers.push(paper);
    added.push(paper);
  }
  return added;
}

/** Merge updatable fields into one paper by id. */
export function updatePaper(library, id, changes) {
  const paper = library.papers.find((candidate) => candidate.id === id);
  if (paper === undefined) return undefined;
  for (const key of ['title', 'note', 'authors', 'year', 'journal', 'url']) {
    if (typeof changes[key] === 'string' && changes[key].trim() !== '') paper[key] = changes[key].trim();
  }
  if (Array.isArray(changes.tags)) {
    paper.tags = changes.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag !== '');
  }
  return paper;
}

/** Remove one paper by id; returns true when something was removed. */
export function removePaper(library, id) {
  const index = library.papers.findIndex((candidate) => candidate.id === id);
  if (index === -1) return false;
  library.papers.splice(index, 1);
  return true;
}

/** Extract a PMID from a PubMed URL. */
export function pmidFromUrl(url) {
  const match = /pubmed(?:\.ncbi\.nlm\.nih\.gov)?\/(\d+)/i.exec(url);
  return match?.[1];
}

// ── PubMed E-utilities (official API) ───────────────────────────────────────
//
// `molbio_pubmed_search` used to depend entirely on the harness web-search
// service. The official API is a different thing: it answers with PubMed's own
// records (PMIDs, indexed titles, journal/year/DOI) instead of whatever a
// general search engine indexed, and an NCBI API key raises the rate limit from
// 3 to 10 requests per second. The helpers below build the request URLs and
// normalize the responses; the tool keeps the transport (ctx.web.fetch) so the
// existing sandbox/consent rules still apply.

/** The E-utilities endpoint prefix. */
export const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/**
 * The NCBI API key for this call: an explicit tool argument first, then the two
 * environment variables a deployment can set once. A blank value counts as
 * absent, so an empty `api_key` falls back instead of sending `api_key=` (NCBI
 * rejects the empty form with a 400 that blames the query).
 */
export function pubmedApiKey(args, env = process.env) {
  for (const candidate of [args?.api_key, env?.NCBI_API_KEY, env?.MOLBIO_NCBI_API_KEY]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

function eutilsUrl(endpoint, params) {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return `${EUTILS_BASE}/${endpoint}?${pairs.join('&')}`;
}

/** esearch: the PMIDs matching a query, relevance-ranked. */
export function pubmedSearchUrl(query, maxResults, apiKey) {
  return eutilsUrl('esearch.fcgi', {
    db: 'pubmed',
    term: query,
    retmax: maxResults,
    retmode: 'json',
    sort: 'relevance',
    tool: 'dsh-molbio-tools',
    api_key: apiKey,
  });
}

/** esummary: title/authors/journal/year/DOI for the PMIDs esearch returned. */
export function pubmedSummaryUrl(pmids, apiKey) {
  return eutilsUrl('esummary.fcgi', {
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'json',
    tool: 'dsh-molbio-tools',
    api_key: apiKey,
  });
}

/** efetch: the full XML records (abstracts live here, not in esummary). */
export function pubmedFetchUrl(pmids, apiKey) {
  return eutilsUrl('efetch.fcgi', {
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'xml',
    tool: 'dsh-molbio-tools',
    api_key: apiKey,
  });
}

/** The PMIDs and total hit count in an esearch JSON response. */
export function parseEsearch(payload) {
  if (typeof payload?.error === 'string' && payload.error !== '') {
    throw new MolbioInputError(`PubMed E-utilities error: ${payload.error}`);
  }
  const result = payload?.esearchresult;
  if (result === undefined || result === null || typeof result !== 'object') {
    throw new MolbioInputError('PubMed esearch returned no esearchresult — is the response really E-utilities JSON?');
  }
  if (typeof result.ERROR === 'string' && result.ERROR !== '') {
    throw new MolbioInputError(`PubMed esearch failed: ${result.ERROR}`);
  }
  const ids = Array.isArray(result.idlist)
    ? result.idlist.map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id))
    : [];
  const count = Number.parseInt(String(result.count ?? ''), 10);
  return { ids, count: Number.isFinite(count) ? count : ids.length };
}

/**
 * Normalize the records in an esummary JSON response.
 *
 * The response puts a `uids` array beside one object per PMID; walking `uids`
 * (rather than Object.keys) keeps the esearch order, which is relevance order.
 */
export function parseEsummaryRecords(payload) {
  if (typeof payload?.error === 'string' && payload.error !== '') {
    throw new MolbioInputError(`PubMed E-utilities error: ${payload.error}`);
  }
  const result = payload?.result;
  if (result === undefined || result === null || typeof result !== 'object') {
    throw new MolbioInputError('PubMed esummary returned no result — is the response really E-utilities JSON?');
  }
  if (typeof result.error === 'string' && result.error !== '') {
    throw new MolbioInputError(`PubMed esummary failed: ${result.error}`);
  }
  const uids = Array.isArray(result.uids) ? result.uids.map(String) : [];
  const records = [];
  for (const uid of uids) {
    const row = result[uid];
    if (row === undefined || row === null || typeof row !== 'object') continue;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const authors = Array.isArray(row.authors)
      ? row.authors
        .map((author) => (typeof author?.name === 'string' ? author.name.trim() : ''))
        .filter((name) => name !== '')
      : [];
    const articleIds = Array.isArray(row.articleids) ? row.articleids : [];
    const doi = articleIds.find((id) => id?.idtype === 'doi' && typeof id.value === 'string')?.value ?? '';
    const pubdate = typeof row.pubdate === 'string' ? row.pubdate : '';
    const year = /\b(?:1[89]|20)\d{2}\b/.exec(pubdate)?.[0] ?? '';
    const journal = typeof row.fulljournalname === 'string' && row.fulljournalname !== ''
      ? row.fulljournalname
      : (typeof row.source === 'string' ? row.source : '');
    records.push({
      pmid: String(row.uid ?? uid),
      title,
      authors,
      journal,
      pubdate,
      year,
      doi,
    });
  }
  return records;
}

/** One esummary record as a search source (the shape molbio_pubmed_search returns). */
export function esummarySource(record) {
  const source = {
    title: record.title === '' ? `PMID ${record.pmid}` : record.title,
    url: `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`,
    pmid: record.pmid,
  };
  const authorText = record.authors.length > 2 ? `${record.authors[0]} et al.` : record.authors.join(', ');
  const snippet = [record.journal, record.year, authorText].filter((part) => part !== '').join(' · ');
  if (snippet !== '') source.snippet = snippet;
  if (record.authors.length > 0) source.authors = record.authors.join(', ');
  if (record.journal !== '') source.journal = record.journal;
  if (record.year !== '') source.year = record.year;
  if (record.doi !== '') source.doi = record.doi;
  return source;
}
/** Escape a string for BibTeX. */
function bibtexEscape(text) {
  return String(text)
    .replaceAll('\\', '\\\\')
    .replace(/[{}]/g, (ch) => `\\${ch}`)
    .replaceAll('&', '\\&')
    .replaceAll('%', '\\%')
    .replaceAll('$', '\\$')
    .replaceAll('#', '\\#')
    .replaceAll('_', '\\_');
}

/** Render papers as BibTeX entries (tag_filter keeps only matching tags). */
export function toBibtex(papers, tagFilter) {
  const filtered = tagFilter === undefined || tagFilter.length === 0
    ? papers
    : papers.filter((paper) => paper.tags !== undefined && tagFilter.some((tag) => paper.tags.includes(tag)));
  const lines = [];
  for (const paper of filtered) {
    const key = paper.pmid !== undefined
      ? `pmid${paper.pmid}`
      : `ref${String(paper.title).slice(0, 24).replace(/[^A-Za-z0-9]+/g, '')}${paper.year ?? ''}`;
    lines.push('@article{' + key + ',');
    lines.push(`  title = {${bibtexEscape(paper.title)}},`);
    if (paper.authors !== undefined) lines.push(`  author = {${bibtexEscape(paper.authors)}},`);
    if (paper.journal !== undefined) lines.push(`  journal = {${bibtexEscape(paper.journal)}},`);
    if (paper.year !== undefined) lines.push(`  year = {${paper.year}},`);
    if (paper.pmid !== undefined) lines.push(`  pmid = {${paper.pmid}},`);
    if (paper.url !== undefined) lines.push(`  url = {${bibtexEscape(paper.url)}},`);
    if (paper.note !== undefined) lines.push(`  note = {${bibtexEscape(paper.note)}},`);
    lines.push('}');
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
