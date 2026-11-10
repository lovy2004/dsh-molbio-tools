/**
 * dsh-molbio-tools/test/structure.mjs
 *
 * Parser and software-renderer tests for the realistic 3D structure preview.
 *
 * The renderer returns a deterministic RGB buffer, so these assertions can
 * check real pixels (an atom is painted at the projected centre, a bond graph
 * is inferred, space-filling paints more area than ball-and-stick) without a
 * browser or a canvas package. PNG encoding is exercised here too so the same
 * buffer path used by the documentation screenshots is covered.
 */
import assert from 'node:assert/strict';
import {
  MAX_STRUCTURE_ATOMS,
  STRUCTURE_EXTENSIONS,
  parseStructureText,
  structureFormatOf,
} from '../structure-preview.mjs';
import {
  MAX_RENDER_ATOMS,
  STRUCTURE_REPRESENTATIONS,
  inferStructureBonds,
  renderStructureImage,
} from '../structure-render.mjs';
import { encodePng } from '../svgpng.mjs';

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
assert.deepEqual(STRUCTURE_REPRESENTATIONS, ['ball-and-stick', 'space-filling']);

// ── PDB ─────────────────────────────────────────────────────────────────────

const pdb = parseStructureText('pdb', PDB, 'tiny.pdb');
assert.equal(pdb.format, 'pdb');
assert.equal(pdb.title, 'TINY THREE-CA PEPTIDE');
assert.equal(pdb.atoms.length, 8);
assert.equal(pdb.chain_count, 1);
assert.equal(pdb.residue_count, 5, '4 residues + the HOH hetatm residue');
assert.equal(pdb.hetatm_count, 1);
assert.equal(pdb.bonds.length, 2, 'CONECT is read into bonds');

// ── mmCIF / SDF ─────────────────────────────────────────────────────────────

const cif = parseStructureText('mmcif', MMCIF, 'tiny.cif');
assert.equal(cif.format, 'mmcif');
assert.equal(cif.atoms.length, 3);
assert.equal(cif.chain_count, 1);
assert.equal(cif.residue_count, 1);

const sdf = parseStructureText('sdf', SDF, 'benzene.mol');
assert.equal(sdf.format, 'sdf');
assert.equal(sdf.title, 'benzene');
assert.equal(sdf.atoms.length, 6);
assert.equal(sdf.bonds.length, 6);
assert.equal(sdf.atoms[0].element, 'C');

// ── bond inference ──────────────────────────────────────────────────────────

const twoCarbons = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: 1.54, y: 0, z: 0 },
];
assert.deepEqual(inferStructureBonds(twoCarbons), [[0, 1]]);
const farApart = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: 4.0, y: 0, z: 0 },
];
assert.deepEqual(inferStructureBonds(farApart), [], 'a non-bonded distance is not a bond');

// ── realistic renderer ──────────────────────────────────────────────────────

const image = renderStructureImage(pdb, { width: 96, height: 96, supersample: 1 });
assert.equal(image.width, 96);
assert.equal(image.height, 96);
assert.equal(image.rgb.length, 96 * 96 * 3);
assert.equal(image.atoms, 7, 'water is not drawn');
assert.ok(image.bonds > 0, 'the protein gets a covalent bond graph');
const background = [image.rgb[0], image.rgb[1], image.rgb[2]];
let coloured = 0;
for (let offset = 0; offset < image.rgb.length; offset += 3) {
  if (image.rgb[offset] !== background[0] || image.rgb[offset + 1] !== background[1] || image.rgb[offset + 2] !== background[2]) coloured += 1;
}
assert.ok(coloured > 200, `the model covers real pixels (${coloured})`);
assert.deepEqual(
  renderStructureImage(pdb, { width: 96, height: 96, supersample: 1 }).rgb,
  image.rgb,
  'the same record and camera produce the same pixels',
);

const space = renderStructureImage(pdb, { width: 96, height: 96, supersample: 1, representation: 'space-filling' });
assert.equal(space.bonds, 0, 'space-filling has no visible bonds');
assert.notDeepEqual(space.rgb, image.rgb, 'the representation changes the image');
assert.throws(() => renderStructureImage(pdb, { representation: 'cartoon' }), /unknown structure representation/);

// A single atom at the origin must paint the centre: a renderer that silently
// shifts the camera would leave the canvas empty.
const single = parseStructureText('pdb', 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C\nEND', 'single.pdb');
const singleImage = renderStructureImage(single, { width: 64, height: 64, supersample: 1 });
const centre = (32 * 64 + 32) * 3;
const corner = 0;
assert.notDeepEqual(
  [singleImage.rgb[centre], singleImage.rgb[centre + 1], singleImage.rgb[centre + 2]],
  [singleImage.rgb[corner], singleImage.rgb[corner + 1], singleImage.rgb[corner + 2]],
  'the atom is centred',
);

// The PNG path used by the documentation screenshots must accept the buffer.
const png = encodePng({ width: image.width, height: image.height, rgb: image.rgb });
assert.equal(png[0], 0x89);
assert.equal(png[1], 0x50);

// ── error paths ─────────────────────────────────────────────────────────────

assert.throws(() => parseStructureText('xyz', 'nothing'), /accepts pdb, mmcif or sdf/);
assert.throws(() => parseStructureText('pdb', 'HEADER only\n'), /no usable atom coordinates/);
assert.throws(() => parseStructureText('sdf', 'title\n  x\n\n  0  0  0  0  0  0  0  0  0  0999 V3000\n'), /V3000 is not supported/);
assert.throws(() => renderStructureImage({ atoms: [] }), /no heavy atoms/);
assert.throws(() => renderStructureImage({}), /needs a parsed structure/);

const oneAtom = 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C';
const tooMany = Array.from({ length: MAX_RENDER_ATOMS + 1 }, (_, index) => ({
  serial: index + 1,
  element: 'C',
  name: 'CA',
  residue: 'ALA',
  chain: 'A',
  residue_number: '1',
  x: index % 100,
  y: 0,
  z: 0,
  hetatm: false,
}));
assert.throws(
  () => renderStructureImage({ format: 'pdb', atoms: tooMany, bonds: [] }),
  new RegExp(`at most ${MAX_RENDER_ATOMS}`),
);
assert.throws(() => parseStructureText('pdb', ['HEADER huge', ...Array.from({ length: MAX_STRUCTURE_ATOMS + 1 }, () => oneAtom)].join('\n')), new RegExp(`at most ${MAX_STRUCTURE_ATOMS}`));

console.log('structure preview checks passed');
