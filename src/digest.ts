import { AGE_BANDS, ageBand, centroid, countOutside, robustExtent, spread } from './analysis.ts';
import type { Extent } from './analysis.ts';
import type { Store } from './store.ts';
import type { Dataset } from './types.ts';

/**
 * The state digest is the block every tool result carries in the same place. The plot digest
 * is the more interesting half: the project's premise is that an agent cannot see the scatter
 * plot, which is true of a bitmap and true of tens of thousands of raw coordinates — but the
 * gap between those two is where an agent's useful perception lives. An ASCII density grid
 * uses a small token budget and conveys the *shape*: where the mass is, where the empty
 * corridors are, and where the human's selection sits relative to both.
 *
 * It does not replace the human's eye. It stops the agent being blind between the moments the
 * human uses theirs, which is when most of its reasoning happens.
 */

/** Density ramp, sparse to dense. Chosen so the eye — and a tokeniser — can rank them. */
const RAMP = ['.', ':', ';', '*', '#', '@'] as const;
const THRESHOLDS = [1, 2, 4, 9, 21, 51] as const;
const MARK_CHAR = 'O';
const LANDMARK_LETTERS = 'ABCDEFGHIJKL';

function densityChar(count: number): string {
  if (count <= 0) return ' ';
  let symbol: string = RAMP[0];
  for (let k = 0; k < THRESHOLDS.length; k++) {
    if (count >= THRESHOLDS[k]) symbol = RAMP[k];
  }
  return symbol;
}

export interface PlotDigest {
  panel: 'pca' | 'map';
  basis?: string;
  /**
   * 'basis' means the frame is the fixed one the human's canvas uses, so positions are
   * comparable with earlier calls. 'fit' means it was zoomed to the visible set, so the
   * resolution is finer but the coordinates are not comparable.
   */
  frameMode: 'basis' | 'fit';
  frame: Record<string, [number, number]>;
  cell: string;
  grid: string[];
  density: string;
  plotted: number;
  outsideFrame: number;
  marks?: Record<string, string>;
  landmarks?: string[];
  note?: string;
}

interface PlotOptions {
  panel: 'pca' | 'map';
  width: number;
  height: number;
  markIndices?: Iterable<number>;
  markLabel?: string;
  landmarks: number;
  /**
   * 'basis' keeps the frame fixed so coordinates are comparable across calls; 'fit' zooms to
   * whatever is visible; 'auto' picks 'fit' once the visible set has collapsed into a corner.
   */
  frame?: 'auto' | 'basis' | 'fit';
}

/** Below this share of the frame's area, a fixed frame wastes most of the grid. */
const FIT_THRESHOLD = 0.12;

function area(extent: Extent): number {
  return Math.max(1e-9, (extent.maxX - extent.minX) * (extent.maxY - extent.minY));
}

/**
 * 'basis' keeps coordinates comparable between calls; 'fit' is worth the incomparability once
 * the visible set has collapsed into a corner of the fixed frame and most of the grid is empty.
 */
function chooseFrame(
  xs: Float32Array,
  ys: Float32Array,
  scope: Int32Array,
  isPca: boolean,
  mode: 'auto' | 'basis' | 'fit',
): { frameMode: 'basis' | 'fit'; extent: Extent } {
  const basisExtent: Extent = isPca
    ? robustExtent(xs, ys)
    : robustExtent(xs, ys, { quantile: 0.005, pad: 0.06 });
  const fitExtent: Extent = robustExtent(xs, ys, { quantile: 0.005, pad: 0.08, scope });

  let frameMode: 'basis' | 'fit';
  if (mode === 'basis') frameMode = 'basis';
  else if (mode === 'fit') frameMode = 'fit';
  else frameMode = area(fitExtent) / area(basisExtent) < FIT_THRESHOLD ? 'fit' : 'basis';

  return { frameMode, extent: frameMode === 'fit' ? fitExtent : basisExtent };
}

interface Canvas {
  grid: string[];
  width: number;
  xs: Float32Array;
  ys: Float32Array;
  cellOf: (x: number, y: number) => number;
}

function write(canvas: Canvas, cell: number, character: string, overMark: boolean): void {
  const row = Math.floor(cell / canvas.width);
  const column = cell % canvas.width;
  if (!overMark && canvas.grid[row][column] === MARK_CHAR) return;
  canvas.grid[row] = canvas.grid[row].slice(0, column) + character + canvas.grid[row].slice(column + 1);
}

function stampMarks(
  canvas: Canvas,
  indices: Iterable<number> | undefined,
  label: string | undefined,
): Record<string, string> {
  if (!indices) return {};
  let marked = 0;
  for (const i of indices) {
    const x = canvas.xs[i];
    if (Number.isNaN(x)) continue;
    const cell = canvas.cellOf(x, canvas.ys[i]);
    if (cell < 0) continue;
    write(canvas, cell, MARK_CHAR, true);
    marked++;
  }
  return marked > 0 ? { [MARK_CHAR]: `${label ?? 'selection'} (${marked} in frame)` } : {};
}

function stampLandmarks(
  canvas: Canvas,
  data: Dataset,
  scope: Int32Array,
  limit: number,
): string[] {
  if (limit <= 0) return [];
  const sizes = new Map<number, number>();
  for (const i of scope) sizes.set(data.code.group[i], (sizes.get(data.code.group[i]) ?? 0) + 1);
  const top = [...sizes.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, Math.min(limit, LANDMARK_LETTERS.length));

  const landmarks: string[] = [];
  for (const [order, [group, n]] of top.entries()) {
    const members = (data.byGroup.get(group) ?? []).filter((i) => !Number.isNaN(canvas.xs[i]));
    if (members.length === 0) continue;
    let sx = 0;
    let sy = 0;
    for (const i of members) {
      sx += canvas.xs[i];
      sy += canvas.ys[i];
    }
    const cell = canvas.cellOf(sx / members.length, sy / members.length);
    if (cell < 0) continue;
    const letter = LANDMARK_LETTERS[order];
    // A landmark never overwrites a mark: the selection is the thing being asked about.
    write(canvas, cell, letter, false);
    landmarks.push(`${letter} ${data.dict.group[group]} (n=${n})`);
  }
  return landmarks;
}

export function renderPlot(store: Store, options: PlotOptions): PlotDigest | null {
  const data = store.dataset;
  if (!data) return null;

  const isPca = options.panel === 'pca';
  const xs = isPca ? store.pc(0) : data.lon;
  const ys = isPca ? store.pc(1) : data.lat;
  if (!xs || !ys) return null;

  const scope = store.visible;
  const { frameMode, extent } = chooseFrame(xs, ys, scope, isPca, options.frame ?? 'auto');

  const { width, height } = options;
  const counts = new Int32Array(width * height);
  let plotted = 0;

  const cellOf = (x: number, y: number): number => {
    const cx = Math.floor(((x - extent.minX) / (extent.maxX - extent.minX)) * width);
    const cy = Math.floor(((extent.maxY - y) / (extent.maxY - extent.minY)) * height);
    if (cx < 0 || cx >= width || cy < 0 || cy >= height) return -1;
    return cy * width + cx;
  };

  for (const i of scope) {
    const x = xs[i];
    if (Number.isNaN(x)) continue;
    const cell = cellOf(x, ys[i]);
    if (cell < 0) continue;
    counts[cell]++;
    plotted++;
  }

  const grid: string[] = [];
  for (let row = 0; row < height; row++) {
    let line = '';
    for (let column = 0; column < width; column++) {
      line += densityChar(counts[row * width + column]);
    }
    grid.push(line);
  }

  const canvas: Canvas = { grid, width, xs, ys, cellOf };
  const marks = stampMarks(canvas, options.markIndices, options.markLabel);
  const landmarks = stampLandmarks(canvas, data, scope, options.landmarks);

  const cellWidth = (extent.maxX - extent.minX) / width;
  const cellHeight = (extent.maxY - extent.minY) / height;

  return {
    panel: options.panel,
    basis: isPca ? store.basis : undefined,
    frameMode,
    frame: isPca
      ? { pc1: [round(extent.minX), round(extent.maxX)], pc2: [round(extent.minY), round(extent.maxY)] }
      : { lon: [round(extent.minX), round(extent.maxX)], lat: [round(extent.minY), round(extent.maxY)] },
    cell: isPca
      ? `one character ~ ${round(cellWidth)} x ${round(cellHeight)} PC units`
      : `one character ~ ${round(cellWidth)} x ${round(cellHeight)} degrees`,
    grid,
    density: RAMP.map((symbol, k) => {
      const from = THRESHOLDS[k];
      const to = THRESHOLDS[k + 1];
      return `${symbol}=${to === undefined ? `${from}+` : from === to - 1 ? `${from}` : `${from}-${to - 1}`}`;
    }).join(' '),
    plotted,
    outsideFrame: countOutside(xs, ys, extent, scope),
    note:
      frameMode === 'fit'
        ? 'The frame is zoomed to the visible set, so these coordinates are not comparable '
          + 'with a call made under a different filter. Pass frame:"basis" for a fixed frame.'
        : undefined,
    marks: Object.keys(marks).length > 0 ? marks : undefined,
    landmarks: landmarks.length > 0 ? landmarks : undefined,
  };
}

function round(value: number): number {
  return Number(value.toFixed(Math.abs(value) >= 100 ? 0 : 2));
}

export function describeView(store: Store): Record<string, unknown> {
  const data = store.dataset;
  if (!data) {
    return { status: store.load, error: store.error ?? undefined };
  }
  const filters = activeFilters(store);
  return {
    basis: store.basis,
    basisLabel: data.pca.basisLabels[store.basis] ?? store.basis,
    visible: store.visible.length,
    total: data.count,
    filters,
    selection:
      store.selection.size === 0
        ? undefined
        : { set: 'selection', n: store.selection.size, by: store.selectionSource },
    comparison: store.comparison ?? undefined,
    imported: store.importedCount || undefined,
    canUndo: store.canUndo || undefined,
  };
}

export function activeFilters(store: Store): Record<string, unknown> | 'none' {
  const filter = store.filter;
  const out: Record<string, unknown> = {};
  if (filter.dateBP) out.dateBP = filter.dateBP;
  if (filter.bbox) {
    out.bbox = [
      round(filter.bbox.west),
      round(filter.bbox.south),
      round(filter.bbox.east),
      round(filter.bbox.north),
    ];
  }
  if (filter.population) out.population = filter.population;
  if (filter.locality) out.locality = filter.locality;
  if (filter.publication) out.publication = filter.publication;
  if (filter.dateMethod) out.dateMethod = filter.dateMethod;
  if (filter.mtHaplogroup) out.mtHaplogroup = filter.mtHaplogroup;
  if (filter.yHaplogroup) out.yHaplogroup = filter.yHaplogroup;
  if (filter.molecularSex) out.molecularSex = filter.molecularSex;
  if (filter.dateBP && filter.dateMode !== 'point') out.dateMode = filter.dateMode;
  if (filter.minSnps !== null) out.minSnps = filter.minSnps;
  if (filter.passOnly) out.passOnly = true;
  if (filter.era !== 'both') out.era = filter.era;
  return Object.keys(out).length === 0 ? 'none' : out;
}

export function structuralReading(store: Store, indices: Int32Array | number[]): string | null {
  const list = [...indices];
  if (list.length < 3) return null;
  const at = centroid(store, list);
  if (!at) return null;
  const dispersion = spread(store, list, at);
  const data = store.dataset;
  if (!data) return null;

  const bands = new Map<number, number>();
  let ancient = 0;
  for (const i of list) {
    if (data.isAncient[i] === 0) continue;
    ancient++;
    const band = ageBand(data.dateBP[i]);
    bands.set(band, (bands.get(band) ?? 0) + 1);
  }
  const dominant = [...bands.entries()].toSorted((a, b) => b[1] - a[1])[0];
  const era =
    ancient === 0
      ? 'all present-day'
      : dominant
        ? `mostly ${AGE_BANDS[dominant[0]].label}`
        : 'mixed ages';
  return `${list.length} individuals, ${era}, centred at (${round(at.pc1)}, ${round(at.pc2)}) with mean radius ${round(dispersion)}`;
}
