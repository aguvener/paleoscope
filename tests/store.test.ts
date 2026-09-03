import assert from 'node:assert/strict';
import test from 'node:test';

import { Store } from '../src/store.ts';
import { stubLocalStorage, tinyDataset } from './fixtures.ts';

const storage = stubLocalStorage();

function loadedStore(): Store {
  const store = new Store();
  store.replaceDataset(tinyDataset(), 'user', false);
  return store;
}

test('a reloaded store does not reissue the id of a deleted finding', () => {
  storage.clear();
  const first = loadedStore();
  first.addNote('one', null, 'user');
  first.addNote('two', null, 'user');
  first.addNote('three', null, 'user');
  first.deleteNote('n2', 'user');
  assert.deepEqual(first.notes.map((note) => note.id), ['n1', 'n3']);

  const second = loadedStore();
  assert.deepEqual(second.notes.map((note) => note.id), ['n1', 'n3']);
  const minted = second.addNote('four', null, 'user');
  assert.equal(minted.id, 'n4', 'a fresh note must not collide with an existing id');
  assert.equal(new Set(second.notes.map((note) => note.id)).size, second.notes.length);

  second.updateNote('n4', { text: 'edited' }, 'user');
  assert.equal(second.notes.find((note) => note.id === 'n3')?.text, 'three');
  assert.equal(second.notes.find((note) => note.id === 'n4')?.text, 'edited');
});

test('a restored workspace keeps minting ids above the ones it carries', () => {
  storage.clear();
  const store = loadedStore();
  store.addNote('one', null, 'user');
  store.addNote('two', null, 'user');
  const workspace = store.exportWorkspace();

  const restored = loadedStore();
  restored.importWorkspace(workspace, 'user');
  assert.equal(restored.addNote('three', null, 'user').id, 'n3');
});

test('imported samples reuse existing dictionary entries', () => {
  storage.clear();
  const store = loadedStore();
  const before = store.dataset!.dict.group.length;
  const result = store.importSamples(
    [
      { geneticId: 'LOCAL-1', population: 'group-a' },
      { geneticId: 'LOCAL-2', population: 'Novel population' },
      { geneticId: 'S1', population: 'group-a' },
    ],
    'user',
  );
  assert.deepEqual(result, { added: 2, skipped: 1 }, 'a duplicate geneticId is skipped');
  assert.equal(store.dataset!.dict.group.length, before + 1, 'only the novel label is appended');
  assert.equal(store.dataset!.count, 5);

  store.clearImportedSamples('user');
  assert.equal(store.dataset!.count, 3);
});
