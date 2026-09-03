import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPlot } from '../src/digest.ts';
import { Store } from '../src/store.ts';
import { stubLocalStorage, tinyDataset } from './fixtures.ts';

stubLocalStorage();

function loaded(): Store {
  const store = new Store();
  store.replaceDataset(tinyDataset(), 'user', false);
  return store;
}

test('renderPlot places every visible sample, its marks and its landmarks', () => {
  const store = loaded();
  const digest = renderPlot(store, {
    panel: 'pca',
    width: 12,
    height: 6,
    markIndices: [1],
    markLabel: 'selection',
    landmarks: 2,
  });
  assert.ok(digest);
  assert.equal(digest.plotted, 3);
  assert.equal(digest.outsideFrame, 0);
  assert.equal(digest.grid.length, 6);
  assert.ok(digest.grid.every((row) => row.length === 12));
  assert.ok(digest.grid.join('').includes('O'), 'the marked sample is stamped on the grid');
  assert.equal(digest.marks?.O, 'selection (1 in frame)');
  assert.equal(digest.landmarks?.length, 2);
  assert.ok(digest.landmarks?.every((entry) => /^[A-Z] group-[ab] \(n=\d+\)$/.test(entry)));
});

test('renderPlot on the map panel frames longitude and latitude', () => {
  const digest = renderPlot(loaded(), { panel: 'map', width: 10, height: 5, landmarks: 0 });
  assert.ok(digest);
  assert.deepEqual(Object.keys(digest.frame), ['lon', 'lat']);
  assert.equal(digest.landmarks, undefined);
  assert.equal(digest.marks, undefined);
  assert.equal(digest.plotted, 3);
});

test('renderPlot returns null before a dataset is loaded', () => {
  assert.equal(renderPlot(new Store(), { panel: 'pca', width: 8, height: 4, landmarks: 0 }), null);
});
