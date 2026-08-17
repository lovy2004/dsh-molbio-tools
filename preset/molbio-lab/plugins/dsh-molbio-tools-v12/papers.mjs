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
