import { SetRegistry } from './sets.ts';
import type { SetOrigin, StoredSet } from './sets.ts';
import { DICT_KEYS } from './types.ts';
import type {
  BoundingBox,
  Dataset,
  DictKey,
  Filter,
  RawDataset,
  SelectionSource,
} from './types.ts';

export const DEFAULT_FILTER: Filter = {
  dateBP: null,
  bbox: null,
  population: null,
  locality: null,
  publication: null,
  dateMethod: null,
  mtHaplogroup: null,
  yHaplogroup: null,
  molecularSex: null,
  minSnps: null,
  passOnly: false,
  era: 'both',
  dateMode: 'point',
};

export type Actor = 'user' | 'agent';

export interface ChangeEvent {
  rev: number;
  at: number;
  actor: Actor;
  kind: 'filter' | 'basis' | 'selection' | 'focus' | 'set' | 'note' | 'undo' | 'load';
  what: string;
}

export interface Note {
  id: string;
  about: string | null;
  text: string;
  at: number;
  actor: Actor;
  kind?: 'observation' | 'hypothesis' | 'caveat';
  status?: 'open' | 'supported' | 'rejected';
  tags?: string[];
  revision?: number;
}

export interface Snapshot {
  filter: Filter;
  basis: string;
  selection: number[];
  focused: number | null;
  comparison: { a: string; b: string } | null;
}

export interface WorkspaceState {
  schema: 'paleoscope-workspace';
  version: 1;
  exportedAt: string;
  dataset: { release: string; count: number };
  view: Snapshot;
  sets: unknown;
  notes: Note[];
  changes: ChangeEvent[];
  importedSamples?: ImportedSample[];
}

export interface ImportedSample {
  geneticId: string;
  basis?: string;
  population?: string;
  region?: string;
  locality?: string;
  dateBP?: number;
  dateSD?: number;
  lat?: number;
  lon?: number;
  pc1?: number;
  pc2?: number;
  snpsHit?: number;
  molecularSex?: string;
  yHaplogroup?: string;
  mtHaplogroup?: string;
  assessment?: string;
  publication?: string;
  doi?: string;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const MAX_CHANGES = 200;
const STORAGE_PREFIX = 'paleoscope.journal.v1';

function toFloat32(values: unknown): Float32Array {
  const list = values as (number | null)[];
  const out = new Float32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    out[i] = value === null ? Number.NaN : value;
  }
  return out;
}

function toInt32(values: unknown): Int32Array {
  const list = values as (number | null)[];
  const out = new Int32Array(list.length);
  for (let i = 0; i < list.length; i++) out[i] = list[i] ?? -1;
  return out;
}

function appendFloat(source: Float32Array, values: number[]): Float32Array {
  const next = new Float32Array(source.length + values.length);
  next.set(source);
  next.set(values, source.length);
  return next;
}

function appendInt(source: Int32Array, values: number[]): Int32Array {
  const next = new Int32Array(source.length + values.length);
  next.set(source);
  next.set(values, source.length);
  return next;
}

function appendUint8(source: Uint8Array, values: number[]): Uint8Array {
  const next = new Uint8Array(source.length + values.length);
  next.set(source);
  next.set(values, source.length);
  return next;
}

function appendUint16(source: Uint16Array, values: number[]): Uint16Array {
  const next = new Uint16Array(source.length + values.length);
  next.set(source);
  next.set(values, source.length);
  return next;
}

/**
 * Minting from the note *count* instead reissues an id whenever a note has been deleted, and
 * every later edit or delete by id then lands on the wrong note.
 */
function highestNoteId(notes: Note[]): number {
  return notes.reduce((max, note) => {
    const n = Number(/^n(\d+)$/.exec(note.id ?? '')?.[1]);
    return Number.isInteger(n) ? Math.max(max, n) : max;
  }, 0);
}

function numeric(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function pack(raw: RawDataset): Dataset {
  const columns = raw.columns as Record<string, unknown>;
  const code = {} as Record<DictKey, Uint16Array>;
  for (const key of DICT_KEYS) code[key] = Uint16Array.from(columns[key] as number[]);

  const pcs: Record<string, Float32Array[]> = {};
  for (const basis of raw.pca.bases) {
    pcs[basis] = (columns[basis] as unknown[]).map(toFloat32);
  }

  const byGroup = new Map<number, number[]>();
  const groupCodes = code.group;
  for (let i = 0; i < groupCodes.length; i++) {
    const group = groupCodes[i];
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(i);
    else byGroup.set(group, [i]);
  }

  return {
    source: raw.source,
    pca: raw.pca,
    count: raw.count,
    dict: raw.dictionaries,
    code,
    geneticId: columns.geneticId as string[],
    fullDate: columns.fullDate as string[],
    lat: toFloat32(columns.lat),
    lon: toFloat32(columns.lon),
    dateBP: toInt32(columns.dateBP),
    dateSD: toInt32(columns.dateSD),
    snpsHit: toInt32(columns.snpsHit),
    isAncient: Uint8Array.from(columns.isAncient as number[]),
    pcs,
    byGroup,
  };
}

type Listener = () => void;

export interface ResolvedSet {
  id: string;
  label: string;
  indices: Int32Array;
  live: boolean;
}

/**
 * Panels and WebMCP tools mutate through the same methods, so an agent has no code path a
 * human lacks and a human makes no change an agent cannot observe. Every mutation bumps
 * `revision` and appends an attributed entry to the change log, which is what lets both
 * parties read one shared history of one shared session.
 */
export class Store {
  dataset: Dataset | null = null;
  load: LoadState = 'idle';
  error: string | null = null;
  basis = 'we';
  filter: Filter = { ...DEFAULT_FILTER };
  visible: Int32Array = new Int32Array(0);
  selection = new Set<number>();
  selectionSource: SelectionSource = 'restore';
  focused: number | null = null;
  comparison: { a: string; b: string } | null = null;

  readonly sets = new SetRegistry();
  notes: Note[] = [];

  revision = 0;
  changes: ChangeEvent[] = [];

  #listeners = new Set<Listener>();
  #undo: Snapshot[] = [];
  #noteCounter = 0;
  #baseCount = 0;
  #importedSamples: ImportedSample[] = [];
  #comparisonCache: { rev: number; value: { a: Set<number>; b: Set<number> } | null } | null = null;

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  record(actor: Actor, kind: ChangeEvent['kind'], what: string): ChangeEvent {
    this.revision++;
    const event: ChangeEvent = { rev: this.revision, at: Date.now(), actor, kind, what };
    this.changes.push(event);
    if (this.changes.length > MAX_CHANGES) this.changes.shift();
    return event;
  }

  changesSince(rev: number): ChangeEvent[] {
    return this.changes.filter((event) => event.rev > rev);
  }

  // --- loading --------------------------------------------------------------

  async fetchDataset(url: string): Promise<void> {
    this.load = 'loading';
    this.error = null;
    this.#emit();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const raw = (await response.json()) as RawDataset;
      this.replaceDataset(raw, 'user', false);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.load = 'error';
    }
    this.#emit();
  }

  replaceDataset(raw: RawDataset, actor: Actor = 'user', emit = true): void {
    if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.count) || raw.count < 1) {
      throw new Error('The dataset has no valid positive sample count.');
    }
    if (!raw.source?.release || !Array.isArray(raw.pca?.bases) || raw.pca.bases.length === 0) {
      throw new Error('The dataset is missing source or PCA metadata.');
    }
    const next = pack(raw);
    if (next.geneticId.length !== next.count || next.dateBP.length !== next.count) {
      throw new Error('The dataset columns do not match its declared sample count.');
    }
    this.dataset = next;
    this.#baseCount = next.count;
    this.#importedSamples = [];
    this.filter = { ...DEFAULT_FILTER };
    this.selection = new Set();
    this.focused = null;
    this.comparison = null;
    this.sets.clear();
    this.notes = [];
    this.changes = [];
    this.revision = 0;
    this.#undo = [];
    if (!raw.pca.bases.includes(this.basis)) this.basis = raw.pca.bases[0];
    this.recompute();
    this.load = 'ready';
    this.#hydrate();
    this.record(actor, 'load', `loaded ${next.count.toLocaleString()} individuals from ${raw.source.release}`);
    if (emit) this.#emit();
  }

  get #storageKey(): string {
    return `${STORAGE_PREFIX}.${this.dataset?.source.release ?? 'unknown'}`;
  }

  #hydrate(): void {
    try {
      const raw = localStorage.getItem(this.#storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { sets?: unknown; notes?: unknown; view?: Partial<Snapshot> };
      this.sets.restore(parsed.sets);
      const count = this.dataset?.count ?? 0;
      for (const entry of this.sets.list()) {
        if ([...entry.indices].some((index) => index < 0 || index >= count)) this.sets.delete(entry.id);
      }
      if (Array.isArray(parsed.notes)) {
        this.notes = (parsed.notes as Note[]).filter(
          (note) => typeof note?.text === 'string',
        );
        this.#noteCounter = highestNoteId(this.notes);
      }
      if (parsed.view) this.#applyView(parsed.view);
    } catch {
      // A private window, cleared site data or a schema change: start empty.
    }
  }

  #persist(): void {
    try {
      localStorage.setItem(
        this.#storageKey,
        JSON.stringify({ sets: this.sets.toJSON(), notes: this.notes, view: this.snapshot() }),
      );
    } catch {
      // Persistence is a convenience, never a requirement.
    }
  }

  // --- undo -----------------------------------------------------------------

  snapshot(): Snapshot {
    return {
      filter: { ...this.filter },
      basis: this.basis,
      selection: [...this.selection],
      focused: this.focused,
      comparison: this.comparison ? { ...this.comparison } : null,
    };
  }

  #pushUndo(): void {
    this.#undo.push(this.snapshot());
    if (this.#undo.length > 50) this.#undo.shift();
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  undo(actor: Actor = 'user'): boolean {
    const previous = this.#undo.pop();
    if (!previous) return false;
    this.filter = previous.filter;
    this.basis = previous.basis;
    this.selection = new Set(previous.selection);
    this.selectionSource = 'restore';
    this.focused = previous.focused;
    this.comparison = previous.comparison;
    this.recompute();
    this.record(actor, 'undo', 'undid the last change');
    this.#emit();
    return true;
  }

  // --- filtering ------------------------------------------------------------

  recompute(): void {
    const data = this.dataset;
    if (!data) {
      this.visible = new Int32Array(0);
      return;
    }
    const { dateBP, lat, lon, snpsHit, isAncient, code, dict } = data;
    const filter = this.filter;
    const dictionaryMatch = (key: DictKey, query: string | null): Uint8Array | null => {
      const needle = query?.trim().toLowerCase();
      if (!needle) return null;
      const matches = new Uint8Array(dict[key].length);
      for (let i = 0; i < dict[key].length; i++) {
        matches[i] = dict[key][i].toLowerCase().includes(needle) ? 1 : 0;
      }
      return matches;
    };
    const textMatches: [DictKey, Uint8Array | null][] = [
      ['group', dictionaryMatch('group', filter.population)],
      ['locality', dictionaryMatch('locality', filter.locality)],
      ['publication', dictionaryMatch('publication', filter.publication)],
      ['dateMethod', dictionaryMatch('dateMethod', filter.dateMethod)],
      ['mtHaplogroup', dictionaryMatch('mtHaplogroup', filter.mtHaplogroup)],
      ['yHaplogroup', dictionaryMatch('yHaplogroup', filter.yHaplogroup)],
      ['molecularSex', dictionaryMatch('molecularSex', filter.molecularSex)],
    ];
    let passMatches: Uint8Array | null = null;
    if (filter.passOnly) {
      passMatches = new Uint8Array(dict.assessment.length);
      for (let a = 0; a < dict.assessment.length; a++) {
        passMatches[a] = dict.assessment[a].startsWith('Pass') ? 1 : 0;
      }
    }

    const bbox = filter.bbox;
    const range = filter.dateBP;
    const out = new Int32Array(data.count);
    let n = 0;

    for (let i = 0; i < data.count; i++) {
      if (filter.era === 'ancient' && isAncient[i] === 0) continue;
      if (filter.era === 'present' && isAncient[i] === 1) continue;
      if (range) {
        const age = dateBP[i];
        const uncertainty = Math.max(0, data.dateSD[i]);
        const low = age - uncertainty;
        const high = age + uncertainty;
        if (filter.dateMode === 'overlap') {
          if (high < range[0] || low > range[1]) continue;
        } else if (filter.dateMode === 'contained') {
          if (low < range[0] || high > range[1]) continue;
        } else if (age < range[0] || age > range[1]) continue;
      }
      if (bbox) {
        const la = lat[i];
        const lo = lon[i];
        if (Number.isNaN(la) || Number.isNaN(lo)) continue;
        if (la < bbox.south || la > bbox.north) continue;
        if (bbox.west <= bbox.east) {
          if (lo < bbox.west || lo > bbox.east) continue;
        } else if (lo < bbox.west && lo > bbox.east) {
          continue;
        }
      }
      if (filter.minSnps !== null && snpsHit[i] < filter.minSnps) continue;
      if (textMatches.some(([key, matches]) => matches && matches[code[key][i]] === 0)) continue;
      if (passMatches && passMatches[code.assessment[i]] === 0) continue;
      out[n++] = i;
    }
    this.visible = out.subarray(0, n);
  }

  previewFilter(patch: Partial<Filter>, replace = false): Int32Array {
    const before = this.filter;
    const beforeVisible = this.visible;
    this.filter = replace ? { ...DEFAULT_FILTER, ...patch } : { ...before, ...patch };
    this.recompute();
    const preview = this.visible;
    this.filter = before;
    this.visible = beforeVisible;
    return preview;
  }

  setFilter(
    patch: Partial<Filter>,
    options: { actor?: Actor; undoable?: boolean } = {},
  ): ChangeEvent | null {
    const description = describeFilterPatch(this.filter, patch);
    if (description === null) return null;
    if (options.undoable !== false) this.#pushUndo();
    this.filter = { ...this.filter, ...patch };
    this.recompute();
    const event = this.record(options.actor ?? 'user', 'filter', description);
    this.#persist();
    this.#emit();
    return event;
  }

  clearFilters(actor: Actor = 'user'): ChangeEvent | null {
    if (describeFilterPatch(this.filter, DEFAULT_FILTER) === null) return null;
    this.#pushUndo();
    this.filter = { ...DEFAULT_FILTER };
    this.recompute();
    const event = this.record(actor, 'filter', 'cleared all filters');
    this.#persist();
    this.#emit();
    return event;
  }

  setBasis(basis: string, actor: Actor = 'user'): ChangeEvent | null {
    if (!this.dataset?.pca.bases.includes(basis) || basis === this.basis) return null;
    this.#pushUndo();
    this.basis = basis;
    const label = this.dataset.pca.basisLabels[basis] ?? basis;
    const event = this.record(actor, 'basis', `PCA basis → ${label}`);
    this.#persist();
    this.#emit();
    return event;
  }

  // --- selection and sets ---------------------------------------------------

  /**
   * Minting alongside selection keeps every human gesture immediately addressable by the agent.
   */
  setSelection(
    indices: Iterable<number>,
    source: SelectionSource,
    actor: Actor = 'user',
  ): StoredSet | null {
    this.#pushUndo();
    this.selection = new Set(indices);
    this.selectionSource = source;
    if (this.selection.size === 0) {
      this.record(actor, 'selection', 'cleared the selection');
      this.#emit();
      return null;
    }
    const minted = this.mintSet(this.selection, {
      origin: source === 'agent' ? 'agent' : (source as SetOrigin),
      label: `${source} selection`,
    });
    this.record(
      actor,
      'selection',
      `selected ${this.selection.size.toLocaleString()} individuals by ${source} → ${minted.id}`,
    );
    this.#persist();
    this.#emit();
    return minted;
  }

  clearSelection(actor: Actor = 'user'): void {
    if (this.selection.size === 0) return;
    this.#pushUndo();
    this.selection = new Set();
    this.record(actor, 'selection', 'cleared the selection');
    this.#persist();
    this.#emit();
  }

  mintSet(
    indices: Iterable<number>,
    options: { origin: SetOrigin; label: string },
  ): StoredSet {
    return this.sets.mint(indices, { ...options, rev: this.revision });
  }

  createResultSet(indices: Iterable<number>, label: string, actor: Actor = 'agent'): StoredSet {
    const entry = this.mintSet(indices, { origin: 'result', label });
    this.record(actor, 'set', `created ${entry.id}: ${entry.label} (${entry.indices.length} samples)`);
    this.#emit();
    return entry;
  }

  saveSet(handle: string, name: string, actor: Actor = 'user'): StoredSet | null {
    const resolved = this.resolve(handle);
    if (!resolved || resolved.indices.length === 0) return null;
    const entry = this.sets.save(
      {
        id: resolved.id,
        label: resolved.label,
        indices: resolved.indices,
        origin: 'saved',
        createdRev: this.revision,
        saved: true,
      },
      name,
      this.revision,
    );
    this.record(actor, 'set', `saved ${entry.indices.length} individuals as "${entry.label}"`);
    this.#persist();
    this.#emit();
    return entry;
  }

  deleteSet(id: string, actor: Actor = 'user'): boolean {
    const entry = this.sets.get(id);
    if (!entry) return false;
    this.sets.delete(id);
    if (this.comparison && (this.comparison.a === id || this.comparison.b === id)) {
      this.comparison = null;
    }
    this.record(actor, 'set', `deleted the set "${entry.label}"`);
    this.#persist();
    this.#emit();
    return true;
  }

  resolve(handle: string): ResolvedSet | null {
    const id = handle.trim();
    if (id === 'selection') {
      return {
        id: 'selection',
        label: 'the current selection',
        indices: Int32Array.from(this.selection),
        live: true,
      };
    }
    if (id === 'visible') {
      return { id: 'visible', label: 'everything visible', indices: this.visible, live: true };
    }
    if (id === 'all') {
      const count = this.dataset?.count ?? 0;
      const all = new Int32Array(count);
      for (let i = 0; i < count; i++) all[i] = i;
      return { id: 'all', label: 'the whole dataset', indices: all, live: true };
    }
    const stored = this.sets.get(id);
    if (!stored) return null;
    return { id: stored.id, label: stored.label, indices: stored.indices, live: false };
  }

  get handles(): string[] {
    return ['selection', 'visible', 'all', ...this.sets.list().map((entry) => entry.id)];
  }

  setComparison(a: string, b: string, actor: Actor = 'user'): boolean {
    if (a === b || !this.resolve(a) || !this.resolve(b)) return false;
    this.#pushUndo();
    this.comparison = { a, b };
    this.record(actor, 'set', `comparing ${a} with ${b}`);
    this.#persist();
    this.#emit();
    return true;
  }

  clearComparison(actor: Actor = 'user'): void {
    if (!this.comparison) return;
    this.#pushUndo();
    this.comparison = null;
    this.record(actor, 'set', 'cleared the set comparison');
    this.#persist();
    this.#emit();
  }

  get comparisonSets(): { a: Set<number>; b: Set<number> } | null {
    if (this.#comparisonCache?.rev === this.revision) return this.#comparisonCache.value;
    if (!this.comparison) return null;
    const a = this.resolve(this.comparison.a);
    const b = this.resolve(this.comparison.b);
    if (!a || !b) return null;
    const value = { a: new Set(a.indices), b: new Set(b.indices) };
    this.#comparisonCache = { rev: this.revision, value };
    return value;
  }

  // --- journal --------------------------------------------------------------

  addNote(
    text: string,
    about: string | null,
    actor: Actor = 'user',
    details: { kind?: Note['kind']; status?: Note['status']; tags?: string[] } = {},
  ): Note {
    const note: Note = {
      id: `n${++this.#noteCounter}`,
      about,
      text: text.trim().slice(0, 600),
      at: Date.now(),
      actor,
      kind: details.kind ?? 'observation',
      status: details.status ?? 'open',
      tags: details.tags?.map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
      revision: this.revision,
    };
    this.notes = [...this.notes, note];
    this.record(actor, 'note', `noted: ${note.text.slice(0, 80)}`);
    this.#persist();
    this.#emit();
    return note;
  }

  deleteNote(id: string, actor: Actor = 'user'): boolean {
    const before = this.notes.length;
    this.notes = this.notes.filter((note) => note.id !== id);
    if (this.notes.length === before) return false;
    this.record(actor, 'note', 'deleted a note');
    this.#persist();
    this.#emit();
    return true;
  }

  updateNote(
    id: string,
    patch: { text?: string; kind?: Note['kind']; status?: Note['status']; tags?: string[] },
    actor: Actor = 'user',
  ): boolean {
    const note = this.notes.find((entry) => entry.id === id);
    if (!note) return false;
    if (patch.text !== undefined) note.text = patch.text.trim().slice(0, 600);
    if (patch.kind !== undefined) note.kind = patch.kind;
    if (patch.status !== undefined) note.status = patch.status;
    if (patch.tags !== undefined) note.tags = patch.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
    this.notes = [...this.notes];
    this.record(actor, 'note', `updated finding ${id}`);
    this.#persist();
    this.#emit();
    return true;
  }

  exportWorkspace(): WorkspaceState {
    const data = this.dataset;
    if (!data) throw new Error('The dataset is not loaded.');
    return {
      schema: 'paleoscope-workspace',
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: { release: data.source.release, count: data.count },
      view: this.snapshot(),
      sets: this.sets.toJSON(),
      notes: this.notes,
      changes: this.changes,
      importedSamples: this.#importedSamples,
    };
  }

  importWorkspace(raw: unknown, actor: Actor = 'user'): { warnings: string[] } {
    const value = raw as Partial<WorkspaceState>;
    if (value.schema !== 'paleoscope-workspace' || value.version !== 1 || !value.view) {
      throw new Error('This is not a supported PaleoScope workspace file.');
    }
    const warnings: string[] = [];
    if (value.dataset?.release !== this.dataset?.source.release) {
      warnings.push(`Workspace release ${value.dataset?.release ?? 'unknown'} differs from the loaded dataset.`);
    }
    this.clearImportedSamples(actor, false);
    this.sets.clear();
    this.sets.restore(value.sets);
    if (Array.isArray(value.importedSamples)) this.importSamples(value.importedSamples, actor, false);
    const count = this.dataset?.count ?? 0;
    for (const entry of this.sets.list()) {
      if ([...entry.indices].some((index) => index >= count)) this.sets.delete(entry.id);
    }
    this.#applyView(value.view);
    this.notes = Array.isArray(value.notes)
      ? value.notes.filter((note) => typeof note?.text === 'string').slice(-200)
      : [];
    this.#noteCounter = highestNoteId(this.notes);
    this.changes = Array.isArray(value.changes) ? value.changes.slice(-MAX_CHANGES) : [];
    this.revision = this.changes.reduce((max, event) => Math.max(max, event.rev || 0), 0);
    this.record(actor, 'load', 'restored a workspace file');
    this.#persist();
    this.#emit();
    return { warnings };
  }

  restoreView(view: Partial<Snapshot>, actor: Actor = 'user'): void {
    this.#pushUndo();
    this.#applyView(view);
    this.record(actor, 'load', 'restored a shared view');
    this.#persist();
    this.#emit();
  }

  #applyView(view: Partial<Snapshot>): void {
    const data = this.dataset;
    if (!data) return;
    if (view.filter && typeof view.filter === 'object') {
      const candidate = { ...DEFAULT_FILTER, ...view.filter } as Filter;
      const textKeys = [
        'population', 'locality', 'publication', 'dateMethod',
        'mtHaplogroup', 'yHaplogroup', 'molecularSex',
      ] as const;
      for (const key of textKeys) {
        if (candidate[key] !== null && typeof candidate[key] !== 'string') candidate[key] = null;
      }
      if (!['ancient', 'present', 'both'].includes(candidate.era)) candidate.era = 'both';
      if (!['point', 'overlap', 'contained'].includes(candidate.dateMode)) candidate.dateMode = 'point';
      if (
        !Array.isArray(candidate.dateBP)
        || candidate.dateBP.length !== 2
        || !candidate.dateBP.every(Number.isFinite)
      ) candidate.dateBP = null;
      else candidate.dateBP = [
        Math.max(0, Math.min(candidate.dateBP[0], candidate.dateBP[1])),
        Math.max(0, Math.max(candidate.dateBP[0], candidate.dateBP[1])),
      ];
      if (candidate.minSnps !== null && !Number.isFinite(candidate.minSnps)) candidate.minSnps = null;
      if (candidate.bbox && !Object.values(candidate.bbox).every(Number.isFinite)) candidate.bbox = null;
      else if (candidate.bbox) candidate.bbox = {
        west: Math.max(-180, Math.min(180, candidate.bbox.west)),
        east: Math.max(-180, Math.min(180, candidate.bbox.east)),
        south: Math.max(-90, Math.min(90, Math.min(candidate.bbox.south, candidate.bbox.north))),
        north: Math.max(-90, Math.min(90, Math.max(candidate.bbox.south, candidate.bbox.north))),
      };
      candidate.passOnly = candidate.passOnly === true;
      this.filter = candidate;
    }
    if (typeof view.basis === 'string' && data.pca.bases.includes(view.basis)) this.basis = view.basis;
    if (Array.isArray(view.selection)) {
      this.selection = new Set(view.selection.filter((i) => Number.isInteger(i) && i >= 0 && i < data.count));
      this.selectionSource = 'restore';
    }
    this.focused = typeof view.focused === 'number' && view.focused >= 0 && view.focused < data.count
      ? view.focused
      : null;
    this.comparison = view.comparison && this.resolve(view.comparison.a) && this.resolve(view.comparison.b)
      ? { ...view.comparison }
      : null;
    this.recompute();
  }

  get importedCount(): number {
    return this.#importedSamples.length;
  }

  importSamples(
    samples: ImportedSample[],
    actor: Actor = 'user',
    announce = true,
  ): { added: number; skipped: number } {
    const data = this.dataset;
    if (!data) throw new Error('The reference dataset is not loaded.');
    const known = new Set(data.geneticId.map((id) => id.toLowerCase()));
    const accepted: ImportedSample[] = [];
    for (const raw of samples.slice(0, 10_000)) {
      const geneticId = typeof raw?.geneticId === 'string' ? raw.geneticId.trim() : '';
      if (!geneticId || known.has(geneticId.toLowerCase())) continue;
      known.add(geneticId.toLowerCase());
      accepted.push({ ...raw, geneticId });
    }
    if (accepted.length === 0) return { added: 0, skipped: samples.length };

    // One index per dictionary, built once: `indexOf` here would be a linear scan per sample
    // per column, which an import of ten thousand rows feels.
    const lookups = {} as Record<DictKey, Map<string, number>>;
    for (const key of DICT_KEYS) {
      lookups[key] = new Map(data.dict[key].map((label, index) => [label, index]));
    }
    const codeFor = (key: DictKey, value: string | undefined): number => {
      const label = value?.trim() ?? '';
      const existing = lookups[key].get(label);
      if (existing !== undefined) return existing;
      // Check before appending: a dictionary grown past the Uint16 range would be corrupt
      // for every later read, and the throw leaves no chance to trim it back.
      const index = data.dict[key].length;
      if (index > 65_535) throw new Error(`Too many distinct values in ${key}.`);
      data.dict[key].push(label);
      lookups[key].set(label, index);
      return index;
    };
    data.geneticId.push(...accepted.map((sample) => sample.geneticId));
    data.fullDate.push(...accepted.map((sample) =>
      numeric(sample.dateBP, 0) > 0 ? `${Math.round(numeric(sample.dateBP, 0))} BP (local import)` : 'present-day',
    ));
    data.lat = appendFloat(data.lat, accepted.map((s) => numeric(s.lat, Number.NaN)));
    data.lon = appendFloat(data.lon, accepted.map((s) => numeric(s.lon, Number.NaN)));
    data.dateBP = appendInt(data.dateBP, accepted.map((s) => Math.round(numeric(s.dateBP, 0))));
    data.dateSD = appendInt(data.dateSD, accepted.map((s) => Math.round(numeric(s.dateSD, -1))));
    data.snpsHit = appendInt(data.snpsHit, accepted.map((s) => Math.round(numeric(s.snpsHit, -1))));
    data.isAncient = appendUint8(data.isAncient, accepted.map((s) => numeric(s.dateBP, 0) > 0 ? 1 : 0));

    const dictValues: Record<DictKey, (sample: ImportedSample) => string | undefined> = {
      group: (s) => s.population ?? 'Local import',
      polity: (s) => s.region,
      publication: (s) => s.publication ?? 'Local import',
      doi: (s) => s.doi,
      dateMethod: () => 'Local import',
      locality: (s) => s.locality,
      yHaplogroup: (s) => s.yHaplogroup,
      mtHaplogroup: (s) => s.mtHaplogroup,
      molecularSex: (s) => s.molecularSex,
      assessment: (s) => s.assessment ?? 'Unreviewed local import',
    };
    for (const key of DICT_KEYS) {
      data.code[key] = appendUint16(
        data.code[key],
        accepted.map((sample) => codeFor(key, dictValues[key](sample))),
      );
    }
    for (const basis of data.pca.bases) {
      const axes = data.pcs[basis];
      axes[0] = appendFloat(
        axes[0],
        accepted.map((s) => (s.basis ?? this.basis) === basis ? numeric(s.pc1, Number.NaN) : Number.NaN),
      );
      axes[1] = appendFloat(
        axes[1],
        accepted.map((s) => (s.basis ?? this.basis) === basis ? numeric(s.pc2, Number.NaN) : Number.NaN),
      );
    }
    data.count += accepted.length;
    this.#importedSamples.push(...accepted);
    this.#rebuildGroups();
    this.recompute();
    if (announce) this.record(actor, 'load', `imported ${accepted.length} local samples`);
    this.#emit();
    return { added: accepted.length, skipped: samples.length - accepted.length };
  }

  clearImportedSamples(actor: Actor = 'user', announce = true): number {
    const data = this.dataset;
    const removed = this.#importedSamples.length;
    if (!data || removed === 0) return 0;
    const n = this.#baseCount;
    data.geneticId.length = n;
    data.fullDate.length = n;
    data.lat = data.lat.slice(0, n);
    data.lon = data.lon.slice(0, n);
    data.dateBP = data.dateBP.slice(0, n);
    data.dateSD = data.dateSD.slice(0, n);
    data.snpsHit = data.snpsHit.slice(0, n);
    data.isAncient = data.isAncient.slice(0, n);
    for (const key of DICT_KEYS) data.code[key] = data.code[key].slice(0, n);
    for (const basis of data.pca.bases) {
      data.pcs[basis][0] = data.pcs[basis][0].slice(0, n);
      data.pcs[basis][1] = data.pcs[basis][1].slice(0, n);
    }
    data.count = n;
    this.#rebuildGroups();
    for (const entry of this.sets.list()) {
      if ([...entry.indices].some((index) => index >= n)) this.sets.delete(entry.id);
    }
    this.selection = new Set([...this.selection].filter((index) => index < n));
    if (this.focused !== null && this.focused >= n) this.focused = null;
    this.#importedSamples = [];
    this.recompute();
    if (announce) {
      this.record(actor, 'load', `removed ${removed} local samples`);
      this.#persist();
      this.#emit();
    }
    return removed;
  }

  #rebuildGroups(): void {
    const data = this.dataset;
    if (!data) return;
    data.byGroup.clear();
    for (let i = 0; i < data.count; i++) {
      const group = data.code.group[i];
      const bucket = data.byGroup.get(group);
      if (bucket) bucket.push(i);
      else data.byGroup.set(group, [i]);
    }
  }

  // --- misc -----------------------------------------------------------------

  focus(index: number | null, actor: Actor = 'user'): void {
    this.focused = index;
    if (index !== null && this.dataset) {
      this.record(actor, 'focus', `focused ${this.dataset.geneticId[index]}`);
    }
    this.#emit();
  }

  pc(component: number): Float32Array | null {
    return this.dataset?.pcs[this.basis]?.[component] ?? null;
  }

  label(key: DictKey, index: number): string {
    const data = this.dataset;
    if (!data) return '';
    return data.dict[key][data.code[key][index]] ?? '';
  }

  findByGeneticId(geneticId: string): number {
    const data = this.dataset;
    if (!data) return -1;
    const wanted = geneticId.trim().toLowerCase();
    return data.geneticId.findIndex((id) => id.toLowerCase() === wanted);
  }
}

/**
 * Returning null is load-bearing: it makes mutations idempotent-aware, so re-applying a filter
 * already in force neither pushes a pointless undo entry nor claims to have done something —
 * and it tells an agent it is looping.
 */
export function describeFilterPatch(
  current: Filter,
  patch: Partial<Filter>,
): string | null {
  const parts: string[] = [];

  if (patch.dateBP !== undefined && !sameRange(current.dateBP, patch.dateBP)) {
    parts.push(
      patch.dateBP === null
        ? 'cleared the time range'
        : `time range → ${patch.dateBP[0].toLocaleString()}-${patch.dateBP[1].toLocaleString()} BP`,
    );
  }
  if (patch.bbox !== undefined && !sameBox(current.bbox, patch.bbox)) {
    parts.push(patch.bbox === null ? 'cleared the region' : 'region → a new bounding box');
  }
  if (patch.population !== undefined && patch.population !== current.population) {
    parts.push(
      patch.population === null
        ? 'cleared the population filter'
        : `population contains "${patch.population}"`,
    );
  }
  const textFields: [keyof Filter, string][] = [
    ['locality', 'locality'],
    ['publication', 'publication'],
    ['dateMethod', 'date method'],
    ['mtHaplogroup', 'mtDNA haplogroup'],
    ['yHaplogroup', 'Y haplogroup'],
    ['molecularSex', 'molecular sex'],
  ];
  for (const [key, label] of textFields) {
    const value = patch[key] as string | null | undefined;
    if (value !== undefined && value !== current[key]) {
      parts.push(value === null || value === '' ? `cleared the ${label} filter` : `${label} contains "${value}"`);
    }
  }
  if (patch.minSnps !== undefined && patch.minSnps !== current.minSnps) {
    parts.push(
      patch.minSnps === null
        ? 'cleared the coverage floor'
        : `coverage floor → ${patch.minSnps.toLocaleString()} SNPs`,
    );
  }
  if (patch.passOnly !== undefined && patch.passOnly !== current.passOnly) {
    parts.push(patch.passOnly ? 'kept only quality-passing individuals' : 'allowed all quality flags');
  }
  if (patch.era !== undefined && patch.era !== current.era) {
    parts.push(`era → ${patch.era}`);
  }
  if (patch.dateMode !== undefined && patch.dateMode !== current.dateMode) {
    parts.push(`date uncertainty mode → ${patch.dateMode}`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

function sameRange(a: [number, number] | null, b: [number, number] | null): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1];
}

function sameBox(a: BoundingBox | null, b: BoundingBox | null): boolean {
  if (a === null || b === null) return a === b;
  return a.west === b.west && a.east === b.east && a.south === b.south && a.north === b.north;
}
