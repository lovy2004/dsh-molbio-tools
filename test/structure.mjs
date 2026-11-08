/**
 * dsh-molbio-tools/test/structure.mjs
 *
 * Pure-parser and projection tests for the browser structure preview
 * (PDB / mmCIF / SDF-MOL V2000). The renderer is deterministic on purpose, so
 * these assertions check both the facts a user reads (atom/chain counts) and
 * the geometry the panel actually draws (a line and a circle land inside the
 * plotting rectangle), not merely "some SVG came out".
 */
import assert from 'node:assert/strict';
import {
  MAX_STRUCTURE_ATOMS,
  STRUCTURE_EXTENSIONS,
  parseStructureText,
  renderStructureProjection,
  structureFormatOf,
} from '../structure-preview.mjs';

const PDB = `HEADER    TEST PROTEIN
TITLE     TINY THREE-CA PEPTIDE
ATOM      1  N   GLY A   1      -1.200   0.000   0.000  1.00 20.00           N
ATOM      2  CA  GLY A   1       0.000   0.000   0.000  1.00 20.00           C
ATOM      3  C   GLY A   1       1.200   0.200   0.000  1.00 20.00           C
ATOM      4  O   GLY A   1       2.000  -0.400   0.000  1.00 20.00           O
ATOM      5  CA  ALA A   2       3.800   0.000   0.000  1.00 20.00           C
ATOM      6  CA  SER A   3       1.900   3.300   0.000  1.00 20.00           C
ATOM      7  CA  THR A   4       1.900   1.100   3.100  1.00 20.00           C
HETATM    8  O   HOH A 101       8.000   8.000   8.000  1.00 20.00           O
CONECT    1    2
CONECT    2    3
END
`;

const MMCIF = `data_test
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM 1 C CA ALA A 1 0.000 0.000 0.000
ATOM 2 C CA ALA A 1 3.800 0.000 0.000
ATOM 3 C CA ALA A 1 1.900 3.300 0.000
#
`;

const SDF = `benzene
  test

  6  6  0  0  0  0  0  0  0  0999 V2000
    1.4000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.7000    1.2124    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.7000    1.2124    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.4000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.7000   -1.2124    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.7000   -1.2124    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  2  0  0  0  0
  3  4  1  0  0  0  0
  4  5  2  0  0  0  0
  5  6  1  0  0  0  0
  6  1  2  0  0  0  0
M  END
$$$$
`;

// ── format routing ──────────────────────────────────────────────────────────

assert.equal(structureFormatOf('model.pdb'), 'pdb');
assert.equal(structureFormatOf('model.ENT'), 'pdb');
assert.equal(structureFormatOf('model.cif'), 'mmcif');
assert.equal(structureFormatOf('ligand.sdf'), 'sdf');
assert.equal(structureFormatOf('ligand.mol'), 'sdf');
assert.equal(structureFormatOf('sequence.fa'), undefined);
assert.ok(Object.keys(STRUCTURE_EXTENSIONS).length >= 6);

// ── PDB ─────────────────────────────────────────────────────────────────────

const pdb = parseStructureText('pdb', PDB, 'tiny.pdb');
assert.equal(pdb.format, 'pdb');
assert.equal(pdb.title, 'TINY THREE-CA PEPTIDE');
assert.equal(pdb.atoms.length, 8);
assert.equal(pdb.chain_count, 1);
assert.equal(pdb.residue_count, 5, '4 residues + the HOH hetatm residue');
assert.equal(pdb.hetatm_count, 1);
assert.equal(pdb.bonds.length, 2, 'CONECT is read into bonds');
assert.equal(pdb.atoms[1].name, 'CA');
assert.equal(pdb.atoms[1].element, 'C');

const pdbSvg = renderStructureProjection(pdb);
assert.match(pdbSvg, /^<svg /);
assert.match(pdbSvg, /Cα trace/);
assert.match(pdbSvg, /<line /);
assert.match(pdbSvg, /<circle /);
assert.doesNotMatch(pdbSvg, /<g[ >]/, 'the rasterizer/paste path does not need <g>');
assert.match(pdbSvg, /not a molecular viewer/);
// The CA trace must have segments: three consecutive CA atoms at 3.8 Å.
assert.ok((pdbSvg.match(/<line /g) ?? []).length >= 2);
// Deterministic: the same record produces the same markup.
assert.equal(renderStructureProjection(pdb), pdbSvg);

// Coordinates stay inside the declared canvas (640x480) with the frame at 24/58.
for (const match of pdbSvg.matchAll(/<circle cx="([0-9.]+)" cy="([0-9.]+)"/g)) {
  const x = Number(match[1]);
  const y = Number(match[2]);
  assert.ok(x >= 24 && x <= 616, `circle x ${x} inside the plot`);
  assert.ok(y >= 58 && y <= 426, `circle y ${y} inside the plot`);
}

// ── mmCIF ───────────────────────────────────────────────────────────────────

const cif = parseStructureText('mmcif', MMCIF, 'tiny.cif');
assert.equal(cif.format, 'mmcif');
assert.equal(cif.atoms.length, 3);
assert.equal(cif.chain_count, 1);
assert.equal(cif.residue_count, 1);
const cifSvg = renderStructureProjection(cif);
assert.match(cifSvg, /MMCIF/);
assert.match(cifSvg, /Cα trace/);

// ── SDF / MOL V2000 ─────────────────────────────────────────────────────────

const sdf = parseStructureText('sdf', SDF, 'benzene.mol');
assert.equal(sdf.format, 'sdf');
assert.equal(sdf.title, 'benzene');
assert.equal(sdf.atoms.length, 6);
assert.equal(sdf.bonds.length, 6);
assert.equal(sdf.atoms[0].element, 'C');
const sdfSvg = renderStructureProjection(sdf);
assert.match(sdfSvg, /heavy atoms/);
assert.match(sdfSvg, /<line /);
assert.match(sdfSvg, /<circle /);

// ── error paths ─────────────────────────────────────────────────────────────

assert.throws(() => parseStructureText('xyz', 'nothing'), /accepts pdb, mmcif or sdf/);
assert.throws(() => parseStructureText('pdb', 'HEADER only\n'), /no usable atom coordinates/);
assert.throws(() => parseStructureText('sdf', 'title\n  x\n\n  0  0  0  0  0  0  0  0  0  0999 V3000\n'), /V3000 is not supported/);
assert.throws(() => renderStructureProjection({ atoms: [] }), /needs a parsed structure/);
assert.throws(() => parseStructureText('sdf', 'title\n  x\n\n  0  0  0  0  0  0  0  0  0  0999 V2000\n'), /declares no atoms/);

// A file above the atom cap is refused rather than silently truncated.
const oneAtom = 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C';
const manyAtoms = ['HEADER huge', ...Array.from({ length: MAX_STRUCTURE_ATOMS + 1 }, () => oneAtom)].join('\n');
assert.throws(() => parseStructureText('pdb', manyAtoms), new RegExp(`at most ${MAX_STRUCTURE_ATOMS}`));

console.log('structure preview checks passed');
