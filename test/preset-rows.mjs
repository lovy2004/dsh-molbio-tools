/**
 * dsh-molbio-tools/test/preset-rows.mjs
 *
 * Read a preset DECLARATION's child rows out of a bundle patch.
 *
 * DSH 0.1.7-alpha.1 moved presets from a scanned `agent.cordis.yml` file into a
 * `@deepseek-ai/dsh-agent-preset` ROW whose `config.plugins` carries the rows.
 * Both sides of every drift comparison are now patch layers — ours
 * (`preset/molbio-lab/preset.patch.yml`) and the harness's shipped
 * `standard` (`dsh-web-app/presets/standard.patch.yml`) — so the two checks that
 * compare them share this one reader rather than each re-implementing the walk.
 *
 * `test/preset-health.mjs` imports it directly; `test/drift-probe.mjs` imports
 * it through the re-export there, keeping one URL and one module instance.
 */

/**
 * The child rows of one preset declaration.
 *
 * A pre-0.1.7 composition was a BARE row list, and that shape is still accepted
 * so `--check` against an old file reports what it holds instead of silently
 * finding zero rows and reporting a clean bill of health.
 *
 * @param {unknown} document a parsed patch layer or a bare row list.
 * @returns {object[]} the preset's child rows, or [] when it declares none.
 */
export function presetPlugins(document) {
  const entries = Array.isArray(document) ? document : [];
  for (const entry of entries) {
    for (const row of entry?.insert ?? []) {
      if (row?.name === '@deepseek-ai/dsh-agent-preset') return row.config?.plugins ?? [];
    }
  }
  return entries.length > 0 && entries.every((row) => row !== null && typeof row === 'object' && 'id' in row)
    ? entries
    : [];
}

/**
 * Wrap a row list back into the patch shape the Loader mounts.
 *
 * `drift-probe` mutates a copy of a declaration and asserts the guard notices.
 * Building a runnable patch means the probe exercises the SAME container the
 * real files use, so a change to the container cannot slip past it.
 *
 * NOTE: `noRefs` is mandatory when this is serialized. `yaml.dump` otherwise
 * emits a YAML anchor/alias for any value that appears twice, and the Loader's
 * entry schema expands an alias into a SECOND row object — which shows up as
 * duplicated rows in the parsed list (the group rows and the `!!js` `disabled`
 * expressions are the shared values that trigger it). Only `drift-probe`
 * serializes these back to YAML; the real files are written by hand and carry no
 * anchors.
 *
 * @param {object[]} rows the child rows.
 * @returns {object[]} a one-entry `insert` layer.
 */
export function asPresetPatch(rows) {
  return [
    {
      insert: [
        {
          id: 'preset-molbio-lab',
          name: '@deepseek-ai/dsh-agent-preset',
          config: { id: 'molbio-lab', plugins: rows },
        },
      ],
    },
  ];
}
