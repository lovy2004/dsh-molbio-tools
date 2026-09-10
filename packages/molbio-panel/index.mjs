/**
 * dsh-molbio-panel — host half.
 *
 * This package exists so the browser panel can be installed WITHOUT dragging
 * the 46 molbio tools into every session of a profile. It is a `dsh.client`
 * dual-face package: the host half below, and the browser half built from the
 * `dsh-molbio-tools` sources into `lib/client.js`.
 *
 * The host half deliberately registers no tool and publishes no service. A
 * Cordis plugin row only needs to load, because the client scan keys on the
 * Loader entry: the row's package manifest is what carries `dsh.client` and
 * `exports["./client"]`, and that is how the browser bundle reaches the page.
 *
 * `inject` is declared even though the row touches no service, so Cordis holds
 * the row's fiber until the tool registry exists — the same ordering the rest
 * of the preset relies on, and a loud failure if this row is ever mounted in a
 * composition without one.
 *
 * To get the tools as well, install `dsh-molbio-tools` (the preset or the
 * bundle), or the Molecular Biology Lab preset, which carries both.
 */

/** Cordis plugin name. */
export const name = 'molbio-panel';

/** Required service: the tool registry, present in every agent/host composition. */
export const inject = ['tools'];

/**
 * Host-half body. Intentionally empty: this row exists to make the package's
 * browser half discoverable, not to contribute host capability.
 */
export function apply() {}
