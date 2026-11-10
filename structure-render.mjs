/**
 * dsh-molbio-tools/structure-render.mjs
 *
 * A small, dependency-free software renderer for the realistic 3D structure
 * preview: ball-and-stick and space-filling models with perspective, a z-buffer
 * and simple Phong lighting.
 *
 * WHY A SOFTWARE RENDERER
 * -----------------------
 * The DSH Web client is a browser, but this package ships zero runtime
 * dependencies and must keep the browser half Node-free. Canvas 2D is available
 * everywhere, yet gradients/shadow support differs between engines and is hard
 * to test in Node. Rendering an RGB buffer here gives:
 *
 *   - one implementation shared by the panel and the tests;
 *   - a PNG the tests can encode and inspect without a browser;
 *   - deterministic pixels for a given record and view;
 *   - no WebGL context, shader compilation or asset download.
 *
 * The tradeoff is CPU rasterization. The panel renders at reduced supersampling
 * while a pointer drag is active and at full quality when it settles; the
 * atom cap keeps a single frame bounded.
 *
 * WHAT THIS IS NOT
 * ----------------
 * No molecular surface, no electrostatics, no ambient occlusion, no secondary
 * structure ribbons. It is a realistic atom/bond model, not an analysis tool.
 */
import { MolbioInputError } from './lib.mjs';

/** The representations the panel offers, in display order. */
export const STRUCTURE_REPRESENTATIONS = ['ball-and-stick', 'space-filling'];

/** CPK-like colours, exported so the panel legend and renderer cannot drift. */
export const STRUCTURE_ELEMENT_COLORS = Object.freeze({
  H: '#e8ebef',
  C: '#6b7480',
  N: '#2f6fdb',
  O: '#d64545',
  S: '#d0a02a',
  P: '#e07a2f',
  F: '#3aa76d',
  CL: '#3aa76d',
  BR: '#a6512c',
  I: '#7b4bb7',
  FE: '#c26a2e',
  ZN: '#7b8794',
  MG: '#3aa76d',
  CA: '#3aa76d',
  NA: '#3aa76d',
  K: '#3aa76d',
});

/** The initial camera the panel uses when a structure is selected. */
export const DEFAULT_STRUCTURE_VIEW = Object.freeze({
  yaw: 0.55,
  pitch: 0.18,
  zoom: 1,
  representation: 'ball-and-stick',
});

/** A single frame above this atom count is refused rather than freezing the tab. */
export const MAX_RENDER_ATOMS = 12000;

const VDW = { H: 1.20, C: 1.70, N: 1.55, O: 1.52, P: 1.80, S: 1.80, F: 1.47, CL: 1.75, BR: 1.85, I: 1.98, FE: 1.80, ZN: 1.39, MG: 1.73, CA: 1.95, NA: 2.27, K: 2.75 };
const COVALENT = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, P: 1.07, S: 1.05, F: 0.57, CL: 1.02, BR: 1.20, I: 1.39, FE: 1.24, ZN: 1.22, MG: 1.41, CA: 1.76, NA: 1.66, K: 2.03 };
const BG = [247, 249, 251];
const EMPTY = new Uint8Array(0);

/** Is this atom a crystallographic water that should not clutter the preview? */
function isWater(atom) {
  const residue = String(atom.residue ?? '').toUpperCase();
  return residue === 'HOH' || residue === 'WAT' || residue === 'DOD';
}

/** Rounded element colour, with a neutral fallback for metals and unknowns. */
function elementColor(element) {
  return STRUCTURE_ELEMENT_COLORS[String(element ?? '').toUpperCase()] ?? '#5b9b74';
}

/** Hex colour to [r,g,b]. */
function rgbOf(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Spatial hash of atom indices on a cubic grid. */
function gridIndex(atoms, cell) {
  const grid = new Map();
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index];
    const key = `${Math.floor(atom.x / cell)},${Math.floor(atom.y / cell)},${Math.floor(atom.z / cell)}`;
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [index]);
    else bucket.push(index);
  }
  return grid;
}

/**
 * Infer a covalent bond graph from 3D coordinates.
 *
 * Covalent radii (not van der Waals radii) are the right scale for a bond: a
 * vdW-sum threshold would connect every atom pair in a tightly packed helix.
 * The 0.45 Å tolerance absorbs coordinate precision without reaching the next
 * bonded neighbour in the common C-C/N-C/O-C cases.
 * @param {Array} atoms
 * @returns {Array<[number, number]>} index pairs into `atoms`.
 */
export function inferStructureBonds(atoms) {
  const bonds = [];
  if (!Array.isArray(atoms) || atoms.length < 2 || atoms.length > MAX_RENDER_ATOMS) return bonds;
  const cell = 2.4;
  const grid = gridIndex(atoms, cell);
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.element === 'H') continue;
    const gx = Math.floor(a.x / cell);
    const gy = Math.floor(a.y / cell);
    const gz = Math.floor(a.z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (bucket === undefined) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = atoms[j];
            if (b.element === 'H') continue;
            const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
            const limit = (COVALENT[a.element] ?? 0.8) + (COVALENT[b.element] ?? 0.8) + 0.45;
            if (distance > 0.35 && distance <= limit) bonds.push([i, j]);
          }
        }
      }
    }
  }
  return bonds;
}

/** Filter atoms the preview does not draw, keeping a serial -> index map. */
function preparedAtoms(record) {
  const atoms = [];
  const bySerial = new Map();
  for (const atom of record.atoms) {
    if (atom.element === 'H' || isWater(atom)) continue;
    if (!Number.isFinite(atom.x) || !Number.isFinite(atom.y) || !Number.isFinite(atom.z)) continue;
    bySerial.set(atom.serial, atoms.length);
    atoms.push(atom);
  }
  return { atoms, bySerial };
}

/** Explicit bonds from the parser, mapped onto the filtered atom array. */
function explicitBonds(record, bySerial) {
  const bonds = [];
  const seen = new Set();
  for (const bond of record.bonds ?? []) {
    const fromAtom = record.atoms[bond.a];
    const toAtom = record.atoms[bond.b];
    if (fromAtom === undefined || toAtom === undefined) continue;
    const a = bySerial.get(fromAtom.serial);
    const b = bySerial.get(toAtom.serial);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bonds.push([a, b]);
  }
  return bonds;
}

/** The bond list used by the renderer for one representation. */
function bondList(record, atoms, bySerial, representation) {
  if (representation === 'space-filling') return [];
  if (record.format === 'sdf') return explicitBonds(record, bySerial);
  const inferred = inferStructureBonds(atoms);
  const explicit = explicitBonds(record, bySerial);
  if (explicit.length === 0) return inferred;
  const seen = new Set(inferred.map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`)));
  const merged = [...inferred];
  for (const [a, b] of explicit) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push([a, b]);
  }
  return merged;
}

/** Clamp a finite number, or use the fallback. */
function numberOr(value, fallback, min, max) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numeric));
}

/**
 * Render one structure frame to an RGB buffer.
 *
 * @param {object} record a parseStructureText record.
 * @param {object} [options]
 * @param {number} [options.width=640]
 * @param {number} [options.height=480]
 * @param {1|2} [options.supersample=2] 1 is the interaction-quality setting.
 * @param {number} [options.yaw=0.55]
 * @param {number} [options.pitch=0.18]
 * @param {number} [options.zoom=1]
 * @param {'ball-and-stick'|'space-filling'} [options.representation='ball-and-stick']
 * @returns {{width:number,height:number,rgb:Uint8Array,atoms:number,bonds:number,representation:string}}
 */
export function renderStructureImage(record, options = {}) {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.atoms)) {
    throw new MolbioInputError('renderStructureImage needs a parsed structure record');
  }
  const representation = options.representation ?? 'ball-and-stick';
  if (!STRUCTURE_REPRESENTATIONS.includes(representation)) {
    throw new MolbioInputError(`unknown structure representation ${JSON.stringify(representation)}; use ${STRUCTURE_REPRESENTATIONS.join(' or ')}`);
  }
  const width = Math.round(numberOr(options.width, 640, 64, 1600));
  const height = Math.round(numberOr(options.height, 480, 64, 1200));
  const supersample = Math.round(numberOr(options.supersample, 2, 1, 2));
  const yaw = numberOr(options.yaw, DEFAULT_STRUCTURE_VIEW.yaw, -Math.PI * 8, Math.PI * 8);
  const pitch = numberOr(options.pitch, DEFAULT_STRUCTURE_VIEW.pitch, -1.45, 1.45);
  const zoom = numberOr(options.zoom, 1, 0.35, 5);
  const { atoms, bySerial } = preparedAtoms(record);
  if (atoms.length === 0) throw new MolbioInputError('the structure has no heavy atoms to draw');
  if (atoms.length > MAX_RENDER_ATOMS) {
    throw new MolbioInputError(`the structure has ${atoms.length} heavy atoms; the preview renders at most ${MAX_RENDER_ATOMS}`);
  }
  const bonds = bondList(record, atoms, bySerial, representation);
  const W = width * supersample;
  const H = height * supersample;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const atom of atoms) {
    if (atom.x < minX) minX = atom.x;
    if (atom.x > maxX) maxX = atom.x;
    if (atom.y < minY) minY = atom.y;
    if (atom.y > maxY) maxY = atom.y;
    if (atom.z < minZ) minZ = atom.z;
    if (atom.z > maxZ) maxZ = atom.z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let radius = 6;
  for (const atom of atoms) radius = Math.max(radius, Math.hypot(atom.x - cx, atom.y - cy, atom.z - cz));
  const camera = (radius * 2.0) / zoom;
  const focal = Math.min(W, H) * 1.15;
  const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  const project = (atom) => {
    const x = atom.x - cx;
    const y = atom.y - cy;
    const z = atom.z - cz;
    const x1 = x * cyaw + z * syaw;
    const z1 = -x * syaw + z * cyaw;
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const depth = camera - z2;
    const scale = focal / Math.max(1, depth);
    return { x: W / 2 + x1 * scale, y: H / 2 - y1 * scale, depth, scale };
  };
  const projected = atoms.map(project);

  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const t = y / Math.max(1, H - 1);
    const r = Math.round(248 - 5 * t);
    const g = Math.round(250 - 5 * t);
    const b = Math.round(252 - 4 * t);
    for (let x = 0; x < W; x++) {
      const offset = (y * W + x) * 3;
      rgb[offset] = r;
      rgb[offset + 1] = g;
      rgb[offset + 2] = b;
    }
  }
  const depthBuffer = new Float32Array(W * H).fill(Infinity);
  const light = [0.35, 0.45, 0.82];
  const lightLength = Math.hypot(light[0], light[1], light[2]);
  const L = [light[0] / lightLength, light[1] / lightLength, light[2] / lightLength];

  const shade = (base, nx, ny, nz, depth) => {
    const diffuse = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    const hx = L[0], hy = L[1], hz = L[2] + 1;
    const hLength = Math.hypot(hx, hy, hz);
    const specular = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hLength), 42) * 0.35;
    const ambient = 0.30;
    const fog = Math.max(0, Math.min(0.28, (depth - camera * 0.45) / (camera * 1.8)));
    const lightLevel = ambient + diffuse * 0.68;
    return [
      Math.round((base[0] * lightLevel + 255 * specular) * (1 - fog) + BG[0] * fog),
      Math.round((base[1] * lightLevel + 255 * specular) * (1 - fog) + BG[1] * fog),
      Math.round((base[2] * lightLevel + 255 * specular) * (1 - fog) + BG[2] * fog),
    ];
  };

  // Bonds are rasterized as shaded capsules. The z-buffer makes draw order
  // irrelevant for overlaps, so no global primitive sort is needed.
  if (representation !== 'space-filling') {
    for (const [i, j] of bonds) {
      const a = projected[i];
      const b = projected[j];
      const bondRadius = 0.18 * ((a.scale + b.scale) / 2);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length2 = dx * dx + dy * dy;
      if (length2 < 1e-6 || bondRadius < 0.25) continue;
      const padding = bondRadius + 2;
      const minPX = Math.max(0, Math.floor(Math.min(a.x, b.x) - padding));
      const maxPX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x) + padding));
      const minPY = Math.max(0, Math.floor(Math.min(a.y, b.y) - padding));
      const maxPY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y) + padding));
      const base = [116, 126, 141];
      for (let py = minPY; py <= maxPY; py++) {
        for (let px = minPX; px <= maxPX; px++) {
          const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / length2));
          const qx = a.x + dx * t;
          const qy = a.y + dy * t;
          const vx = px - qx;
          const vy = py - qy;
          const distance = Math.hypot(vx, vy);
          if (distance > bondRadius) continue;
          const front = Math.sqrt(Math.max(0, bondRadius * bondRadius - distance * distance)) / Math.max(1e-6, (a.scale + b.scale) / 2);
          const depth = a.depth + (b.depth - a.depth) * t - front;
          const index = py * W + px;
          if (depth >= depthBuffer[index]) continue;
          const nx = vx / Math.max(1e-6, bondRadius);
          const ny = -vy / Math.max(1e-6, bondRadius);
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          const colour = shade(base, nx, ny, nz, depth);
          const offset = index * 3;
          rgb[offset] = colour[0];
          rgb[offset + 1] = colour[1];
          rgb[offset + 2] = colour[2];
          depthBuffer[index] = depth;
        }
      }
    }
  }

  // Front-to-back atom order reduces z-buffer writes, but correctness comes
  // from the depth test, not the order.
  const order = atoms.map((_, index) => index).sort((left, right) => projected[left].depth - projected[right].depth);
  for (const index of order) {
    const atom = atoms[index];
    const point = projected[index];
    const baseRadius = (VDW[atom.element] ?? 1.5) * (representation === 'space-filling' ? 1.0 : 0.28);
    const screenRadius = baseRadius * point.scale;
    if (screenRadius < 0.4) continue;
    const base = rgbOf(elementColor(atom.element));
    const minPX = Math.max(0, Math.floor(point.x - screenRadius - 1));
    const maxPX = Math.min(W - 1, Math.ceil(point.x + screenRadius + 1));
    const minPY = Math.max(0, Math.floor(point.y - screenRadius - 1));
    const maxPY = Math.min(H - 1, Math.ceil(point.y + screenRadius + 1));
    const radius2 = screenRadius * screenRadius;
    for (let py = minPY; py <= maxPY; py++) {
      const dy = py - point.y;
      for (let px = minPX; px <= maxPX; px++) {
        const dx = px - point.x;
        const distance2 = dx * dx + dy * dy;
        if (distance2 > radius2) continue;
        const dz = Math.sqrt(Math.max(0, radius2 - distance2));
        const depth = point.depth - dz / point.scale;
        const bufferIndex = py * W + px;
        if (depth >= depthBuffer[bufferIndex]) continue;
        const nx = dx / screenRadius;
        const ny = -dy / screenRadius;
        const nz = dz / screenRadius;
        const colour = shade(base, nx, ny, nz, depth);
        const offset = bufferIndex * 3;
        rgb[offset] = colour[0];
        rgb[offset + 1] = colour[1];
        rgb[offset + 2] = colour[2];
        depthBuffer[bufferIndex] = depth;
      }
    }
  }

  // Box-filter the supersampled image back to the requested size.
  const out = new Uint8Array(width * height * 3);
  const samples = supersample * supersample;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const offset = ((y * supersample + sy) * W + (x * supersample + sx)) * 3;
          r += rgb[offset];
          g += rgb[offset + 1];
          b += rgb[offset + 2];
        }
      }
      const offset = (y * width + x) * 3;
      out[offset] = Math.round(r / samples);
      out[offset + 1] = Math.round(g / samples);
      out[offset + 2] = Math.round(b / samples);
    }
  }
  return { width, height, rgb: out, atoms: atoms.length, bonds: bonds.length, representation };
}
