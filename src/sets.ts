/**
 * This is the load-bearing abstraction of the agent interface. The user's selection is a set,
 * the rows passing the filter are a set, a lasso makes a set, an outlier search returns a set.
 * Because every tool consuming individuals takes one `set` argument and every tool producing
 * individuals returns a handle, results compose instead of dead-ending — and a forty-individual
 * result costs one short string rather than forty IDs.
 *
 * This module knows nothing about the store, the DOM or WebMCP. Handle resolution, which needs
 * live view state, lives on the Store.
 */

export type SetOrigin = 'lasso' | 'click' | 'agent' | 'filter' | 'result' | 'saved' | 'restore';

export interface StoredSet {
  id: string;
  label: string;
  indices: Int32Array;
  origin: SetOrigin;
  createdRev: number;
  /** Saved sets are durable and persisted; minted ones are evicted. */
  saved: boolean;
}

/** Reserved handles that always resolve against live view state. */
export const LIVE_HANDLES = ['selection', 'visible', 'all'] as const;
export type LiveHandle = (typeof LIVE_HANDLES)[number];

export function isLiveHandle(id: string): id is LiveHandle {
  return (LIVE_HANDLES as readonly string[]).includes(id);
}

const MAX_EPHEMERAL = 24;
const MAX_PERSISTED_INDICES = 4000;

export class SetRegistry {
  #stored = new Map<string, StoredSet>();
  #counter = 0;

  mint(
    indices: Iterable<number>,
    options: { origin: SetOrigin; label: string; rev: number },
  ): StoredSet {
    const id = `s${++this.#counter}`;
    const entry: StoredSet = {
      id,
      label: options.label,
      indices: Int32Array.from(indices),
      origin: options.origin,
      createdRev: options.rev,
      saved: false,
    };
    this.#stored.set(id, entry);
    this.#evict();
    return entry;
  }

  save(source: StoredSet, name: string, rev: number): StoredSet {
    const id = name.trim().toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'set';
    const entry: StoredSet = {
      id,
      label: name.trim().slice(0, 60),
      indices: source.indices,
      origin: 'saved',
      createdRev: rev,
      saved: true,
    };
    this.#stored.set(id, entry);
    return entry;
  }

  adopt(entry: StoredSet): void {
    this.#stored.set(entry.id, entry);
    if (entry.id.startsWith('s')) {
      const n = Number(entry.id.slice(1));
      if (Number.isInteger(n) && n > this.#counter) this.#counter = n;
    }
  }

  get(id: string): StoredSet | undefined {
    return this.#stored.get(id);
  }

  delete(id: string): boolean {
    return this.#stored.delete(id);
  }

  clear(): void {
    this.#stored.clear();
    this.#counter = 0;
  }

  list(): StoredSet[] {
    return [...this.#stored.values()];
  }

  get named(): StoredSet[] {
    return this.list().filter((entry) => entry.saved);
  }

  #evict(): void {
    const ephemeral = this.list().filter((entry) => !entry.saved);
    if (ephemeral.length <= MAX_EPHEMERAL) return;
    const oldest = ephemeral
      .toSorted((a, b) => a.createdRev - b.createdRev)
      .slice(0, ephemeral.length - MAX_EPHEMERAL);
    for (const entry of oldest) this.#stored.delete(entry.id);
  }

  toJSON(): unknown {
    return this.named
      .filter((entry) => entry.indices.length <= MAX_PERSISTED_INDICES)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        indices: [...entry.indices],
        createdRev: entry.createdRev,
      }));
  }

  restore(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      const entry = item as { id?: string; label?: string; indices?: unknown[] };
      if (
        typeof entry.id !== 'string'
        || !/^[a-z0-9-]{1,40}$/.test(entry.id)
        || isLiveHandle(entry.id)
        || !Array.isArray(entry.indices)
      ) continue;
      const indices = entry.indices
        .filter((index): index is number => Number.isInteger(index) && Number(index) >= 0)
        .slice(0, MAX_PERSISTED_INDICES);
      this.adopt({
        id: entry.id,
        label: typeof entry.label === 'string' ? entry.label.slice(0, 60) : entry.id,
        indices: Int32Array.from(indices),
        origin: 'saved',
        createdRev: 0,
        saved: true,
      });
    }
  }
}

export type SetOperation = 'union' | 'intersect' | 'minus';

export function combine(a: Iterable<number>, b: Iterable<number>, op: SetOperation): number[] {
  const left = new Set(a);
  const right = new Set(b);
  switch (op) {
    case 'union': {
      for (const value of right) left.add(value);
      return [...left].toSorted((x, y) => x - y);
    }
    case 'intersect':
      return [...left].filter((value) => right.has(value)).toSorted((x, y) => x - y);
    case 'minus':
      return [...left].filter((value) => !right.has(value)).toSorted((x, y) => x - y);
  }
}
