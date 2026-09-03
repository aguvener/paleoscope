import { DICT_KEYS } from '../src/types.ts';
import type { RawDataset } from '../src/types.ts';

export function tinyDataset(): RawDataset {
  const dictionaries = Object.fromEntries(
    DICT_KEYS.map((key) => [key, [`${key}-a`, `${key}-b`]]),
  ) as RawDataset['dictionaries'];
  const codes = Object.fromEntries(DICT_KEYS.map((key) => [key, [0, 1, 0]]));

  return {
    source: {
      name: 'Test', release: 'test-v1', panel: 'test', doi: '', license: 'CC0',
      url: '', citation: 'Test citation.',
    },
    pca: { method: 'test', bases: ['we'], basisLabels: { we: 'West Eurasian' } },
    count: 3,
    dictionaries,
    columns: {
      ...codes,
      geneticId: ['S1', 'S2', 'S3'],
      fullDate: ['1000 BP', '2000 BP', 'present-day'],
      lat: [40, 41, 42],
      lon: [30, 31, 32],
      dateBP: [1000, 2000, 0],
      dateSD: [50, 100, -1],
      snpsHit: [100_000, 200_000, 276_725],
      isAncient: [1, 1, 0],
      we: [[0.1, 0.2, 0.3], [-0.1, -0.2, -0.3]],
    },
  };
}

export function stubLocalStorage(): { clear: () => void } {
  const cells = new Map<string, string>();
  const storage = {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => void cells.set(key, value),
    removeItem: (key: string) => void cells.delete(key),
    clear: () => cells.clear(),
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  return storage;
}
