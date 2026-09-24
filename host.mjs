/**
 * dsh-molbio-tools/host.mjs — the client bundle's HOST-PLANE ANCHOR.
 *
 * This module registers no tool and publishes no service. Its only job is to be
 * a loader row the client-module scan can see.
 *
 * ── WHY A SEPARATE ANCHOR IS NEEDED ────────────────────────────────────────
 *
 * The browser half of this package (`lib/client.js`, which draws the Molbio and
 * Papers tabs in the right sidebar) reaches the page through DSH's client-module
 * scan, and that scan walks the HOST Loader's entries only:
 *
 *     for (const entry of this.ctx.loader.entries()) {
 *       if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue;
 *       const source = this.resolveSource(entry);   // reads the row's package manifest
 *       ...
 *
 * A preset's rows are mounted in an isolated, disposable subtree that this scan
 * never visits (dsh-client-modules: "scans the host Loader's entries"). So a
 * `dsh.client` package that is referenced ONLY from inside a preset has no
 * discoverable row, its bundle never enters `window.__DSH_BOOT__`, and its
 * sidebar tabs silently do not exist.
 *
 * That is exactly what happened when the 57 tools moved into the molbio-lab
 * preset: the tools no longer load into every session (the point of the move),
 * but the package also lost its only host-plane row — and with it the two tabs.
 *
 * ── WHY NOT JUST ANCHOR ON index.mjs ───────────────────────────────────────
 *
 * `index.mjs` is the TOOL plugin: importing it must register 57 tools and a
 * prompt section. A host row naming it would put every tool back into every
 * session, which is the thing the preset split exists to avoid. This anchor is
 * deliberately inert.
 *
 * `packages/molbio-panel/index.mjs` is the same pattern for the panel-only
 * package, which is why that package's tabs never disappeared.
 */

/** Cordis plugin name. */
export const name = 'molbio-client';

/**
 * Required service: the tool registry.
 *
 * The anchor touches nothing, but declaring the dependency keeps its fiber
 * ordered behind the host composition that owns the registry — the same
 * ordering every other row in the toolset relies on, and a loud failure rather
 * than a silent no-op if this row is ever mounted without one.
 */
export const inject = ['tools'];

/**
 * Host-half body. Intentionally empty: this row exists to make the package's
 * browser half discoverable, not to contribute host capability.
 */
export function apply() {}
