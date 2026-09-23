/**
 * dsh-molbio-tools/benchmark/tools.mjs
 *
 * Load the plugin's registered tools and RUN one offline, in memory.
 *
 * The benchmark needs three things from the plugin, and all three have to agree
 * with `test/smoke.mjs` or the offline score would be measuring a different
 * program than the shipped one:
 *
 *  1. the tool definitions as the plugin registers them (same mock registry
 *     shape, so a definition that only mounts in the real harness still shows
 *     up here the same way);
 *  2. a `ctx` with the service seams the tools reach for — `fs`, `web`,
 *     `sandboxPolicy`, `systemPrompt` — with `get()` answering `undefined` for
 *     everything else, exactly like a bare composition;
 *  3. a workspace rooted at a scratch directory, because the `output_path` /
 *     `save_path` tools resolve relative paths against the session workspace
 *     and the benchmark must not litter the package.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as plugin from '../index.mjs';

/**
 * The in-memory key for a workspace path.
 *
 * Keyed by `resolve()` rather than by string concatenation: the plugin resolves
 * a tool argument through `fs.resolve()` and the host's Windows filesystem
 * provider normalizes separators (`C:/x/y` becomes `C:\x\y`), so a seam that
 * keyed on the literal argument would answer ENOENT for a file it is holding.
 * `resolve` is the same normalization, so the two agree by construction.
 */
function key(path) {
  return resolve(String(path));
}

/**
 * A workspace-backed `fs` seam with the surface the plugin uses.
 *
 * Deliberately thin: `readBytes`/`writeText`/`writeFile`/`stat`/`resolve` are
 * what the tools call. Text and bytes are both held as `Uint8Array` so a `.dna`
 * fixture and a plain `.txt` travel the same path.
 */
export function createMemFs(workspaceRoot) {
  const files = new Map();
  return {
    workspaceRoot,
    files,
    async resolve(path) {
      return { path: key(path) };
    },
    async stat(target) {
      const value = files.get(key(target.path));
      return value === undefined ? undefined : { size: value.length };
    },
    async readText(target) {
      const value = files.get(key(target.path));
      if (value === undefined) throw new Error(`ENOENT: ${target.path}`);
      return new TextDecoder().decode(value);
    },
    async readBytes(target) {
      const value = files.get(key(target.path));
      if (value === undefined) throw new Error(`ENOENT: ${target.path}`);
      return value;
    },
    async writeText(target, content) {
      files.set(key(target.path), new TextEncoder().encode(content));
      return { version: 1 };
    },
    async writeFile(target, content) {
      files.set(key(target.path), content instanceof Uint8Array ? content : new TextEncoder().encode(content));
      return { version: 1 };
    },
  };
}

/**
 * Register the plugin against a mock registry and return runnable tools.
 *
 * @param {{workspaceRoot: string, fs?: object, web?: object}} options
 * @returns {{byName: Map<string, object>, names: string[], memFs: object, workspaceRoot: string,
 *            run: (name: string, args?: object) => Promise<unknown>}}
 */
export function loadTools(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? resolve(tmpdir(), 'molbio-bench');
  const memFs = options.fs ?? createMemFs(workspaceRoot);

  const registered = [];
  const services = new Map();
  if (options.web !== undefined) services.set('web', options.web);
  // The tools write through `ctx.fs` carrying the session sandbox policy, so
  // the seam has to answer with a policy object rather than undefined —
  // otherwise every writing tool would take its "no policy" branch.
  services.set('sandboxPolicy', {
    resolve() {
      return { workspaceRoot, mode: 'workspace-write' };
    },
  });

  const mockCtx = {
    systemPrompt: { section() {} },
    get(name) {
      if (name === 'fs') return memFs;
      return services.get(name);
    },
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
  };

  plugin.apply(mockCtx);

  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  const exec = { agent: { session: { header: { cwd: workspaceRoot } } } };

  return {
    byName,
    names: [...byName.keys()].sort(),
    memFs,
    workspaceRoot,
    /**
     * Run one tool and return its output value.
     *
     * @param {string} name the `molbio_*` tool name.
     * @param {object} [args] validated arguments.
     * @returns {Promise<unknown>} the tool's output value.
     */
    async run(name, args = {}) {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`benchmark: no such tool "${name}"`);
      return await tool.execute(args, exec);
    },
    /** The text projection a model would read for this result. */
    render(name, args, value) {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`benchmark: no such tool "${name}"`);
      return tool.output
        .render(args, value)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    },
  };
}

/**
 * A scratch workspace that is removed unless the caller keeps it.
 *
 * @param {{prefix?: string, keep?: boolean}} [options]
 * @returns {Promise<{path: string, dispose: () => Promise<void>}>}
 */
export async function makeWorkspace(options = {}) {
  const path = await mkdtemp(join(tmpdir(), options.prefix ?? 'molbio-bench-'));
  return {
    path,
    async dispose() {
      if (options.keep === true) return;
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a fixture directory into a workspace seam.
 *
 * Fixtures stay OUTSIDE the repository (the plugin's own `test/fixtures` holds
 * the committed ones): the benchmark copies what a task declares, so a task can
 * name a real `.dna` file without the package's published surface growing.
 *
 * @param {object} memFs the seam from {@link loadTools}.
 * @param {Record<string, string>} manifest map of workspace-relative path → absolute source path.
 * @returns {Promise<string[]>} the workspace paths that were seeded.
 */
export async function seedFixtures(memFs, manifest) {
  const seeded = [];
  for (const [relative, source] of Object.entries(manifest)) {
    if (!existsSync(source)) throw new Error(`benchmark: fixture source is missing: ${source}`);
    memFs.files.set(resolve(join(memFs.workspaceRoot, relative)), new Uint8Array(await readFile(source)));
    seeded.push(relative);
  }
  return seeded;
}

/** Write a text file straight into the seam (task inputs, FASTQ fixtures). */
export function seedText(memFs, relative, text) {
  memFs.files.set(resolve(join(memFs.workspaceRoot, relative)), new TextEncoder().encode(text));
}

/** Read a file the tool wrote, as text. */
export async function readWorkspaceText(memFs, relative) {
  const value = memFs.files.get(resolve(join(memFs.workspaceRoot, relative)));
  if (value === undefined) return undefined;
  return new TextDecoder().decode(value);
}

/** Write a file on the real disk (used by probes to dump JSON). */
export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
