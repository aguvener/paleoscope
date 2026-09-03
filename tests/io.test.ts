import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCsv, parseImportedSamples } from '../src/io.ts';

test('parseCsv preserves commas and escaped quotes inside quoted cells', () => {
  assert.deepEqual(
    parseCsv('id,population\nA,"Turkey, Neolithic"\nB,"said ""hello"""\n'),
    [['id', 'population'], ['A', 'Turkey, Neolithic'], ['B', 'said "hello"']],
  );
});

test('parseImportedSamples maps aliases and numeric fields', () => {
  assert.deepEqual(
    parseImportedSamples('sample,group,date_bp,date_sd,PC1,PC2\nLOCAL-1,Test,7200,80,1.5,-2.25'),
    [{ geneticId: 'LOCAL-1', population: 'Test', dateBP: 7200, dateSD: 80, pc1: 1.5, pc2: -2.25 }],
  );
});

test('parseImportedSamples rejects malformed numeric values', () => {
  assert.throws(
    () => parseImportedSamples('id,lat\nA,not-a-number'),
    /Invalid number/,
  );
});

test('parseImportedSamples accepts whitespace-delimited eigenvec-style data', () => {
  assert.deepEqual(
    parseImportedSamples('#IID PC1 PC2\nLOCAL-2 4.5 -1.25'),
    [{ geneticId: 'LOCAL-2', pc1: 4.5, pc2: -1.25 }],
  );
});

test('parseImportedSamples keeps whitespace delimiters when a data cell contains a comma', () => {
  assert.deepEqual(
    parseImportedSamples('IID population\nLOCAL-3 Yamnaya,Samara'),
    [{ geneticId: 'LOCAL-3', population: 'Yamnaya,Samara' }],
  );
});
