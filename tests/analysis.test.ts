import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSetSummaries, timelineBins } from '../src/analysis.ts';
import type { Store } from '../src/store.ts';

const dictionary = (values: string[]) => values;
const mockData = {
    count: 3,
    dict: {
      group: dictionary(['A', 'B']), polity: dictionary(['R']), publication: dictionary(['P']),
      doi: dictionary(['']), dateMethod: dictionary(['C14']), locality: dictionary(['L']),
      yHaplogroup: dictionary(['Y']), mtHaplogroup: dictionary(['M']),
      molecularSex: dictionary(['F']), assessment: dictionary(['Pass']),
    },
    code: Object.fromEntries(['group', 'polity', 'publication', 'doi', 'dateMethod', 'locality', 'yHaplogroup', 'mtHaplogroup', 'molecularSex', 'assessment'].map((key) => [key, new Uint16Array(key === 'group' ? [0, 0, 1] : [0, 0, 0])])),
    dateBP: new Int32Array([1000, 2000, 3000]),
    dateSD: new Int32Array([50, 100, 150]),
    snpsHit: new Int32Array([100, 200, 300]),
    isAncient: new Uint8Array([1, 1, 1]),
};

const mock = {
  dataset: mockData,
  pc(component: number) {
    return component === 0 ? new Float32Array([0, 2, 10]) : new Float32Array([0, 0, 0]);
  },
  label(key: string, index: number) {
    const dictionaries = mockData.dict as Record<string, string[]>;
    const codes = mockData.code as Record<string, Uint16Array>;
    return dictionaries[key][codes[key][index]];
  },
} as unknown as Store;

test('timelineBins conserves samples across bins', () => {
  const bins = timelineBins(mock, [0, 1, 2], { bins: 4, fromBP: 0, toBP: 4000 });
  assert.equal(bins.reduce((sum, bin) => sum + bin.n, 0), 3);
});

test('compareSetSummaries reports overlap and descriptive differences', () => {
  const result = compareSetSummaries(mock, [0, 1], [1, 2]);
  assert.equal(result.overlap.n, 1);
  assert.equal(result.overlap.jaccard, 1 / 3);
  assert.equal(result.date?.medianDifferenceBP, -1000);
  assert.equal(result.pca?.centroidDistance, 5);
});
