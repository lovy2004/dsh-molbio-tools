/**
 * dsh-molbio-tools/font-metrics.mjs
 *
 * Metrics of the built-in stroke font in `svgpng.mjs`, split into their own
 * tiny module so BOTH halves of the drawing path can agree on them:
 *
 *   - `svgpng.mjs` (the rasterizer) imports the grid values it draws glyphs
 *     with. It also imports `node:zlib`, so nothing that runs in the browser
 *     may import `svgpng.mjs`.
 *   - `svgio.mjs` (the SVG-emitting helpers, host side) needs the same numbers
 *     to estimate how wide a run will be, so a caller can decide where to break
 *     a long label BEFORE emitting it.
 *
 * A duplicated constant would be a silent failure mode: the layout would
 * reserve space using one metric and the rasterizer would draw with another,
 * and the only symptom would be a label that overlaps its neighbour. Importing
 * one definition is the whole point of this file.
 *
 * Host side only, like `svgpng.mjs` and `svgio.mjs` — it is not part of the
 * client bundle.
 */

/**
 * Advance width of every glyph, in grid units. The font is monospaced by
 * construction: each glyph is drawn on a 6-wide grid, so measuring a run needs
 * no per-character table.
 */
export const GLYPH_ADVANCE = 6;

/** Grid units per em. Cap height is 7 units, i.e. 0.7 em caps. */
export const FONT_UNITS_PER_EM = 10;

/** Characters a hard break may cut after, for readability of long identifiers. */
const SEPARATORS = new Set(['_', '-', '.', '|', ':', '/', ',']);

/**
 * Width in pixels that one character occupies at `fontSize`.
 * @param {number} fontSize - the SVG `font-size`, in user units.
 * @returns {number} pixels per character.
 */
export function characterAdvance(fontSize) {
  return (GLYPH_ADVANCE / FONT_UNITS_PER_EM) * fontSize;
}

/**
 * Estimated pixel width of `text` at `fontSize`.
 *
 * This is the geometric width of the built-in font, not a browser text metric:
 * `<textLength>`/`lengthAdjust` can stretch a run and `<tspan>` reflow is the
 * caller's decision, so this is deliberately an upper-bound-ish estimate for
 * laying out our own drawings.
 *
 * @param {string} text
 * @param {number} fontSize
 * @returns {number}
 */
export function textWidth(text, fontSize) {
  return [...String(text)].length * characterAdvance(fontSize);
}

/**
 * Greedy word wrap to a pixel budget, using the built-in font's advance.
 *
 * A single word longer than the budget is hard-broken rather than allowed to
 * overflow (a 60-character accession number has no spaces to break at, and
 * letting it run off the canvas is how a label gets clipped). Newlines already
 * present in the input are honoured as forced breaks.
 *
 * The hard break prefers to cut immediately AFTER a separator (`_`, `-`, `.`,
 * `|`, `:`), because that is where sequence identifiers and accession numbers
 * are conventionally readable — breaking
 * `Escherichia_coli_K12_MG1655_chromosome_complete` mid-word reads as damage,
 * while breaking after `_` reads as a wrapped name.
 *
 * @param {string} text
 * @param {number} maxWidth - pixel budget per line.
 * @param {number} fontSize
 * @returns {string[]} one entry per line; never empty (an empty input gives `['']`).
 */
export function wrapText(text, maxWidth, fontSize) {
  const advance = characterAdvance(fontSize);
  const perLine = Math.max(1, Math.floor(maxWidth / advance));
  const lines = [];
  /** Split an over-long token into budget-sized chunks, preferring a separator. */
  const breakToken = (token) => {
    const characters = [...token];
    let start = 0;
    while (characters.length - start > perLine) {
      let cut = start + perLine;
      // Walk back to just after the last separator inside this chunk, but never
      // so far back that the line carries almost nothing.
      for (let at = cut - 1; at > start + Math.floor(perLine / 2); at--) {
        if (SEPARATORS.has(characters[at])) {
          cut = at + 1;
          break;
        }
      }
      lines.push(characters.slice(start, cut).join(''));
      start = cut;
    }
    return characters.slice(start).join('');
  };
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if ([...candidate].length <= perLine) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      if ([...word].length > perLine) current = breakToken(word);
      else current = word;
    }
    lines.push(current);
  }
  return lines.length === 0 ? [''] : lines;
}
