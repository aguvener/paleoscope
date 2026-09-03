import type { Store } from './store.ts';
import type { Dataset } from './types.ts';

export const AGE_BANDS = [
  { max: 3000, label: 'younger than 3000 BP' },
  { max: 5000, label: '3000-5000 BP' },
  { max: 8000, label: '5000-8000 BP' },
  { max: 12_000, label: '8000-12000 BP' },
  { max: Number.POSITIVE_INFINITY, label: 'older than 12000 BP' },
] as const;

export function ageBand(dateBP: number): number {
  for (let b = 0; b < AGE_BANDS.length; b++) {
    if (dateBP < AGE_BANDS[b].max) return b;
  }
  return AGE_BANDS.length - 1;
}

export interface Point {
  pc1: number;
  pc2: number;
}

export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function quantile(sorted: number[], q: number): number {
  const slot = Math.round(q * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, slot))];
}

/**
 * Absolute min/max is useless here. A handful of individuals sit enormously far off a West
 * Eurasian frame — North African and Central Asian samples carrying Sub-Saharan or East Asian
 * ancestry project hundreds of units away, which is correct but stretches the box until the
 * main structure collapses into a thin band. Percentile bounds keep the structure readable,
 * and callers report how many individuals that leaves outside.
 *
 * This lives in the analysis layer, not in a panel, because the frame is a property of the
 * data and the basis. The canvas panel and the agent's ASCII digest must agree on it or
 * "where the selection sits" means two different things to the two parties.
 */
export function robustExtent(
  xs: Float32Array,
  ys: Float32Array,
  options: { quantile?: number; pad?: number; scope?: Iterable<number> } = {},
): Extent {
  const q = options.quantile ?? 0.01;
  const pad = options.pad ?? 0.12;
  const xv: number[] = [];
  const yv: number[] = [];
  const scope = options.scope ?? xs.keys();
  for (const i of scope) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    xv.push(x);
    yv.push(y);
  }
  if (xv.length === 0) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  xv.sort((a, b) => a - b);
  yv.sort((a, b) => a - b);
  const minX = quantile(xv, q);
  const maxX = quantile(xv, 1 - q);
  const minY = quantile(yv, q);
  const maxY = quantile(yv, 1 - q);
  const padX = (maxX - minX) * pad || 1;
  const padY = (maxY - minY) * pad || 1;
  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

export function countOutside(
  xs: Float32Array,
  ys: Float32Array,
  extent: Extent,
  scope: Iterable<number>,
): number {
  let outside = 0;
  for (const i of scope) {
    const x = xs[i];
    if (Number.isNaN(x)) continue;
    const y = ys[i];
    if (x < extent.minX || x > extent.maxX || y < extent.minY || y > extent.maxY) outside++;
  }
  return outside;
}

export function centroid(store: Store, indices: Iterable<number>): Point | null {
  const x = store.pc(0);
  const y = store.pc(1);
  if (!x || !y) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const i of indices) {
    const a = x[i];
    const b = y[i];
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    sx += a;
    sy += b;
    n++;
  }
  return n === 0 ? null : { pc1: sx / n, pc2: sy / n };
}

export function spread(store: Store, indices: Iterable<number>, at: Point): number {
  const x = store.pc(0);
  const y = store.pc(1);
  if (!x || !y) return 0;
  let total = 0;
  let n = 0;
  for (const i of indices) {
    const a = x[i];
    const b = y[i];
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    total += Math.hypot(a - at.pc1, b - at.pc2);
    n++;
  }
  return n === 0 ? 0 : total / n;
}

export interface RankedPopulation {
  population: string;
  distance: number;
  sampleCount: number;
  era: 'present-day' | 'ancient' | 'mixed';
}

/**
 * This is the question an archaeogeneticist actually asks of a point on a PCA: not "what are
 * its coordinates" but "who does it sit with".
 */
export function nearestPopulations(
  store: Store,
  at: Point,
  options: { limit: number; minSamples: number; era: 'ancient' | 'present' | 'both' },
): RankedPopulation[] {
  const data = store.dataset;
  const x = store.pc(0);
  const y = store.pc(1);
  if (!data || !x || !y) return [];

  const ranked: RankedPopulation[] = [];
  for (const [groupCode, members] of data.byGroup) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    let ancient = 0;
    for (const i of members) {
      if (options.era === 'ancient' && data.isAncient[i] === 0) continue;
      if (options.era === 'present' && data.isAncient[i] === 1) continue;
      const a = x[i];
      const b = y[i];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      sx += a;
      sy += b;
      n++;
      ancient += data.isAncient[i];
    }
    if (n < options.minSamples) continue;
    ranked.push({
      population: data.dict.group[groupCode],
      distance: Math.hypot(sx / n - at.pc1, sy / n - at.pc2),
      sampleCount: n,
      era: ancient === 0 ? 'present-day' : ancient === n ? 'ancient' : 'mixed',
    });
  }
  ranked.sort((a, b) => a.distance - b.distance);
  return ranked.slice(0, options.limit);
}

export interface Outlier {
  index: number;
  geneticId: string;
  population: string;
  distance: number;
  populationSpread: number;
  /** Distance divided by the population's mean radial spread. */
  ratio: number;
}

/**
 * This is the standard first pass in the field: an outlier is either contamination, a
 * mislabelled sample, a relative of somebody else, or a genuinely interesting migrant. The
 * tool surfaces the candidates; a human decides which.
 */
export function populationOutliers(
  store: Store,
  scope: Iterable<number>,
  options: { limit: number; minPopulationSize: number },
): Outlier[] {
  const data = store.dataset;
  const x = store.pc(0);
  const y = store.pc(1);
  if (!data || !x || !y) return [];

  const buckets = new Map<number, number[]>();
  for (const i of scope) {
    if (Number.isNaN(x[i]) || Number.isNaN(y[i])) continue;
    const group = data.code.group[i];
    const bucket = buckets.get(group);
    if (bucket) bucket.push(i);
    else buckets.set(group, [i]);
  }

  const found: Outlier[] = [];
  for (const [group, members] of buckets) {
    if (members.length < options.minPopulationSize) continue;
    const at = centroid(store, members);
    if (!at) continue;
    const dispersion = spread(store, members, at);
    if (dispersion <= 0) continue;
    for (const i of members) {
      const distance = Math.hypot(x[i] - at.pc1, y[i] - at.pc2);
      found.push({
        index: i,
        geneticId: data.geneticId[i],
        population: data.dict.group[group],
        distance,
        populationSpread: dispersion,
        ratio: distance / dispersion,
      });
    }
  }
  found.sort((a, b) => b.ratio - a.ratio);
  return found.slice(0, options.limit);
}

export function nearestSamples(
  store: Store,
  at: Point,
  options: { limit: number; scope: Iterable<number>; exclude?: Set<number> },
): { index: number; distance: number }[] {
  const x = store.pc(0);
  const y = store.pc(1);
  if (!x || !y) return [];
  const found: { index: number; distance: number }[] = [];
  for (const i of options.scope) {
    if (options.exclude?.has(i)) continue;
    const a = x[i];
    const b = y[i];
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    found.push({ index: i, distance: Math.hypot(a - at.pc1, b - at.pc2) });
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.slice(0, options.limit);
}

export interface GroupSummary {
  n: number;
  ancient: number;
  presentDay: number;
  dateBP: { min: number; max: number; median: number } | null;
  topPopulations: { population: string; n: number }[];
  topRegions: { region: string; n: number }[];
  ageBands: { band: string; n: number }[];
  pca: { centroid: Point; spread: number } | null;
  medianSnpsHit: number | null;
  medianDateUncertainty: number | null;
}

function tally(counts: Map<number, number>, dictionary: string[], limit: number) {
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([code, n]) => ({ label: dictionary[code], n }));
}

export function summarise(
  store: Store,
  indices: Iterable<number>,
  options: { topN?: number } = {},
): GroupSummary {
  const data = store.dataset as Dataset;
  const topN = options.topN ?? 6;
  const groups = new Map<number, number>();
  const regions = new Map<number, number>();
  const bands: number[] = Array.from({ length: AGE_BANDS.length }, () => 0);
  const ages: number[] = [];
  const snps: number[] = [];
  const dateUncertainty: number[] = [];
  let n = 0;
  let ancient = 0;
  const list: number[] = [];

  for (const i of indices) {
    n++;
    list.push(i);
    ancient += data.isAncient[i];
    const group = data.code.group[i];
    groups.set(group, (groups.get(group) ?? 0) + 1);
    const region = data.code.polity[i];
    regions.set(region, (regions.get(region) ?? 0) + 1);
    if (data.isAncient[i] === 1) {
      ages.push(data.dateBP[i]);
      if (data.dateSD[i] >= 0) dateUncertainty.push(data.dateSD[i]);
      bands[ageBand(data.dateBP[i])]++;
    }
    if (data.snpsHit[i] > 0) snps.push(data.snpsHit[i]);
  }

  ages.sort((a, b) => a - b);
  snps.sort((a, b) => a - b);
  dateUncertainty.sort((a, b) => a - b);
  const at = centroid(store, list);

  return {
    n,
    ancient,
    presentDay: n - ancient,
    dateBP:
      ages.length === 0
        ? null
        : {
            min: ages[0],
            max: ages[ages.length - 1],
            median: ages[Math.floor(ages.length / 2)],
          },
    topPopulations: tally(groups, data.dict.group, topN).map((e) => ({
      population: e.label,
      n: e.n,
    })),
    topRegions: tally(regions, data.dict.polity, topN).map((e) => ({
      region: e.label || 'unrecorded',
      n: e.n,
    })),
    ageBands: bands
      .map((count, b) => ({ band: AGE_BANDS[b].label, n: count }))
      .filter((e) => e.n > 0),
    pca: at ? { centroid: at, spread: spread(store, list, at) } : null,
    medianSnpsHit: snps.length === 0 ? null : snps[Math.floor(snps.length / 2)],
    medianDateUncertainty:
      dateUncertainty.length === 0
        ? null
        : dateUncertainty[Math.floor(dateUncertainty.length / 2)],
  };
}

export interface SetComparison {
  a: GroupSummary;
  b: GroupSummary;
  overlap: { n: number; jaccard: number };
  pca: { centroidDistance: number; spreadRatio: number | null } | null;
  date: { medianDifferenceBP: number } | null;
  populationDifferences: { population: string; a: number; b: number; deltaShare: number }[];
}

/** Descriptive A/B comparison. It deliberately makes no ancestry or causality claim. */
export function compareSetSummaries(
  store: Store,
  aIndices: Iterable<number>,
  bIndices: Iterable<number>,
): SetComparison {
  const aList = [...aIndices];
  const bList = [...bIndices];
  const a = summarise(store, aList, { topN: 8 });
  const b = summarise(store, bList, { topN: 8 });
  const bMembership = new Set(bList);
  const intersection = aList.filter((index) => bMembership.has(index)).length;
  const union = new Set([...aList, ...bList]).size;
  const counts = (indices: number[]): Map<string, number> => {
    const found = new Map<string, number>();
    for (const index of indices) {
      const label = store.label('group', index) || 'unrecorded';
      found.set(label, (found.get(label) ?? 0) + 1);
    }
    return found;
  };
  const aCounts = counts(aList);
  const bCounts = counts(bList);
  const populations = new Set([...aCounts.keys(), ...bCounts.keys()]);
  const populationDifferences = [...populations]
    .map((population) => {
      const ca = aCounts.get(population) ?? 0;
      const cb = bCounts.get(population) ?? 0;
      return {
        population,
        a: ca,
        b: cb,
        deltaShare: (aList.length === 0 ? 0 : ca / aList.length)
          - (bList.length === 0 ? 0 : cb / bList.length),
      };
    })
    .toSorted((x, y) => Math.abs(y.deltaShare) - Math.abs(x.deltaShare))
    .slice(0, 10);
  return {
    a,
    b,
    overlap: { n: intersection, jaccard: union === 0 ? 0 : intersection / union },
    pca: a.pca && b.pca
      ? {
          centroidDistance: Math.hypot(
            a.pca.centroid.pc1 - b.pca.centroid.pc1,
            a.pca.centroid.pc2 - b.pca.centroid.pc2,
          ),
          spreadRatio: b.pca.spread === 0 ? null : a.pca.spread / b.pca.spread,
        }
      : null,
    date: a.dateBP && b.dateBP
      ? { medianDifferenceBP: a.dateBP.median - b.dateBP.median }
      : null,
    populationDifferences,
  };
}

export interface TimelineBin {
  fromBP: number;
  toBP: number;
  n: number;
}

export function timelineBins(
  store: Store,
  indices: Iterable<number>,
  options: { bins?: number; fromBP?: number; toBP?: number } = {},
): TimelineBin[] {
  const data = store.dataset as Dataset;
  const bins = Math.max(4, Math.min(60, Math.round(options.bins ?? 16)));
  const ages = [...indices]
    .filter((index) => data.isAncient[index] === 1)
    .map((index) => data.dateBP[index]);
  // Reduced rather than spread: `Math.min(...ages)` passes one argument per individual, and
  // a cohort large enough to exceed the engine's argument limit would throw a RangeError
  // inside a tool handler — which reaches the agent as an opaque UnknownError.
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const age of ages) {
    if (age < lowest) lowest = age;
    if (age > highest) highest = age;
  }
  const from = options.fromBP ?? (ages.length ? lowest : 0);
  const to = Math.max(from + 1, options.toBP ?? (ages.length ? highest : 12_000));
  const width = (to - from) / bins;
  const result = Array.from({ length: bins }, (_, i) => ({
    fromBP: Math.round(from + i * width),
    toBP: Math.round(from + (i + 1) * width),
    n: 0,
  }));
  for (const age of ages) {
    if (age < from || age > to) continue;
    const slot = Math.min(bins - 1, Math.floor((age - from) / width));
    result[slot].n++;
  }
  return result;
}

export interface PopulationProfile {
  population: string;
  summary: GroupSummary;
  localities: { label: string; n: number }[];
  publications: { label: string; doi: string | null; n: number }[];
  mtHaplogroups: { label: string; n: number }[];
  yHaplogroups: { label: string; n: number }[];
  assessments: { label: string; n: number }[];
}

export function populationProfile(
  store: Store,
  population: string,
  scope: Iterable<number> = store.visible,
): PopulationProfile | null {
  const needle = population.trim().toLowerCase();
  const indices = [...scope].filter((index) => store.label('group', index).toLowerCase() === needle);
  if (indices.length === 0) return null;
  const tallyLabel = (key: 'locality' | 'mtHaplogroup' | 'yHaplogroup' | 'assessment', limit = 10) => {
    const counts = new Map<string, number>();
    for (const index of indices) {
      const label = store.label(key, index) || 'unrecorded';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, n]) => ({ label, n })).toSorted((a, b) => b.n - a.n).slice(0, limit);
  };
  const pubs = new Map<string, { label: string; doi: string | null; n: number }>();
  for (const index of indices) {
    const label = store.label('publication', index) || 'unrecorded';
    const doi = store.label('doi', index) || null;
    const key = `${label}\u0000${doi ?? ''}`;
    const previous = pubs.get(key);
    pubs.set(key, { label, doi, n: (previous?.n ?? 0) + 1 });
  }
  return {
    population: store.label('group', indices[0]),
    summary: summarise(store, indices, { topN: 8 }),
    localities: tallyLabel('locality'),
    publications: [...pubs.values()].toSorted((a, b) => b.n - a.n).slice(0, 12),
    mtHaplogroups: tallyLabel('mtHaplogroup'),
    yHaplogroups: tallyLabel('yHaplogroup'),
    assessments: tallyLabel('assessment'),
  };
}

export function describeSample(store: Store, index: number): Record<string, unknown> {
  const data = store.dataset as Dataset;
  const x = store.pc(0);
  const y = store.pc(1);
  const ancient = data.isAncient[index] === 1;
  return {
    geneticId: data.geneticId[index],
    population: store.label('group', index),
    region: store.label('polity', index) || null,
    locality: store.label('locality', index) || null,
    dateBP: ancient ? data.dateBP[index] : 0,
    dateSD: ancient && data.dateSD[index] >= 0 ? data.dateSD[index] : null,
    date: ancient ? data.fullDate[index] || null : 'present-day',
    dateMethod: ancient ? store.label('dateMethod', index) || null : null,
    lat: Number.isNaN(data.lat[index]) ? null : Number(data.lat[index].toFixed(3)),
    lon: Number.isNaN(data.lon[index]) ? null : Number(data.lon[index].toFixed(3)),
    pc1: x && !Number.isNaN(x[index]) ? Number(x[index].toFixed(2)) : null,
    pc2: y && !Number.isNaN(y[index]) ? Number(y[index].toFixed(2)) : null,
    snpsHit: data.snpsHit[index],
    molecularSex: store.label('molecularSex', index) || null,
    yHaplogroup: store.label('yHaplogroup', index) || null,
    mtHaplogroup: store.label('mtHaplogroup', index) || null,
    assessment: store.label('assessment', index) || null,
    publication: store.label('publication', index) || null,
    doi: store.label('doi', index) || null,
  };
}
