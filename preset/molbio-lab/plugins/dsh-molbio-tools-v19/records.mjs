/**
 * dsh-molbio-tools/records.mjs
 *
 * Lightweight protocol library and experiment log: JSON files in the session
 * workspace (protocols.json / experiments.json), read and written through the
 * harness fs service under the standing sandbox policy — same pattern as the
 * paper library.
 */

import { MolbioInputError } from './lib.mjs';
import { workspaceFilePath, writeWorkspaceFile } from './papers.mjs';

export const DEFAULT_PROTOCOLS_FILE = 'protocols.json';
export const DEFAULT_EXPERIMENTS_FILE = 'experiments.json';

/** Load a JSON record file; a missing file is an empty collection. */
export async function loadRecords(fs, path, key) {
  let raw;
  try {
    const target = await fs.resolve(path);
    const info = await fs.stat(target);
    if (info === undefined) return { [key]: [] };
    raw = await fs.readText(target);
  } catch (error) {
    throw new MolbioInputError(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed[key])) {
      throw new Error(`expected an object with a "${key}" array`);
    }
    return parsed;
  } catch (error) {
    throw new MolbioInputError(`${path} is not a valid record file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Write a JSON record file atomically with the standing policy. */
export async function saveRecords(fs, path, data, sandboxPolicy) {
  await writeWorkspaceFile(fs, path, JSON.stringify(data, null, 2) + '\n', sandboxPolicy);
}

/** Resolve the record file path (absolute stays, relative joins the workspace). */
export function recordPath(args, exec, workspaceRoot, defaultFile) {
  return workspaceFilePath(args.file ?? defaultFile, exec, workspaceRoot);
}

function nextId(records) {
  let n = records.length + 1;
  while (records.some((record) => record.id === `rec${n}`)) n++;
  return `rec${n}`;
}

/** Add one protocol. */
export function addProtocol(records, entry) {
  if (typeof entry !== 'object' || entry === null || typeof entry.name !== 'string' || entry.name.trim() === '') {
    throw new MolbioInputError('each protocol needs a non-empty "name"');
  }
  if (records.some((record) => record.name.trim().toLowerCase() === entry.name.trim().toLowerCase())) {
    throw new MolbioInputError(`a protocol named ${JSON.stringify(entry.name)} already exists`);
  }
  const protocol = {
    id: nextId(records),
    name: entry.name.trim(),
    created_at: new Date().toISOString().slice(0, 10),
  };
  if (typeof entry.category === 'string' && entry.category.trim() !== '') protocol.category = entry.category.trim();
  if (Array.isArray(entry.steps)) {
    protocol.steps = entry.steps.filter((step) => typeof step === 'string').map((step) => step.trim()).filter((step) => step !== '');
  }
  if (typeof entry.parameters === 'object' && entry.parameters !== null && !Array.isArray(entry.parameters)) {
    protocol.parameters = entry.parameters;
  }
  if (typeof entry.source_paper_id === 'string' && entry.source_paper_id.trim() !== '') protocol.source_paper_id = entry.source_paper_id.trim();
  records.push(protocol);
  return protocol;
}

/** Update one protocol by id. */
export function updateProtocol(records, id, changes) {
  const protocol = records.find((record) => record.id === id);
  if (protocol === undefined) return undefined;
  if (typeof changes.name === 'string' && changes.name.trim() !== '') protocol.name = changes.name.trim();
  if (typeof changes.category === 'string' && changes.category.trim() !== '') protocol.category = changes.category.trim();
  if (Array.isArray(changes.steps)) {
    protocol.steps = changes.steps.filter((step) => typeof step === 'string').map((step) => step.trim()).filter((step) => step !== '');
  }
  if (typeof changes.parameters === 'object' && changes.parameters !== null && !Array.isArray(changes.parameters)) {
    protocol.parameters = changes.parameters;
  }
  if (typeof changes.source_paper_id === 'string' && changes.source_paper_id.trim() !== '') protocol.source_paper_id = changes.source_paper_id.trim();
  return protocol;
}

/** Append one experiment log entry. */
export function addExperiment(records, entry) {
  if (typeof entry !== 'object' || entry === null || typeof entry.title !== 'string' || entry.title.trim() === '') {
    throw new MolbioInputError('each experiment needs a non-empty "title"');
  }
  const experiment = {
    id: nextId(records),
    title: entry.title.trim(),
    date: typeof entry.date === 'string' && entry.date.trim() !== '' ? entry.date.trim() : new Date().toISOString().slice(0, 10),
    logged_at: new Date().toISOString(),
  };
  for (const key of ['protocol_id', 'notes', 'results']) {
    if (typeof entry[key] === 'string' && entry[key].trim() !== '') experiment[key] = entry[key].trim();
  }
  if (Array.isArray(entry.paper_ids)) {
    experiment.paper_ids = entry.paper_ids.filter((id) => typeof id === 'string').map((id) => id.trim()).filter((id) => id !== '');
  }
  records.push(experiment);
  return experiment;
}
