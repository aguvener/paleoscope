export interface SourceInfo {
  name: string;
  release: string;
  panel: string;
  doi: string;
  license: string;
  url: string;
  citation: string;
}

export interface PcaInfo {
  method: string;
  bases: string[];
  basisLabels: Record<string, string>;
}

export const DICT_KEYS = [
  'group',
  'polity',
  'publication',
  'doi',
  'dateMethod',
  'locality',
  'yHaplogroup',
  'mtHaplogroup',
  'molecularSex',
  'assessment',
] as const;

export type DictKey = (typeof DICT_KEYS)[number];

export interface RawDataset {
  source: SourceInfo;
  pca: PcaInfo;
  count: number;
  dictionaries: Record<DictKey, string[]>;
  columns: Record<string, unknown>;
}

export interface Dataset {
  source: SourceInfo;
  pca: PcaInfo;
  count: number;
  dict: Record<DictKey, string[]>;
  code: Record<DictKey, Uint16Array>;
  geneticId: string[];
  fullDate: string[];
  lat: Float32Array;
  lon: Float32Array;
  /** Years before 1950 CE. 0 means present-day. */
  dateBP: Int32Array;
  dateSD: Int32Array;
  snpsHit: Int32Array;
  isAncient: Uint8Array;
  /** `pcs[basis][component]` -> one value per sample. NaN where not projected. */
  pcs: Record<string, Float32Array[]>;
  byGroup: Map<number, number[]>;
}

export interface BoundingBox {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface Filter {
  /** Inclusive range in years before present. */
  dateBP: [number, number] | null;
  bbox: BoundingBox | null;
  /** Case-insensitive substring match against the population label. */
  population: string | null;
  locality: string | null;
  publication: string | null;
  dateMethod: string | null;
  mtHaplogroup: string | null;
  yHaplogroup: string | null;
  molecularSex: string | null;
  minSnps: number | null;
  /** Restrict to samples whose AADR assessment starts with "Pass". */
  passOnly: boolean;
  era: 'ancient' | 'present' | 'both';
  /** How a dated sample's age estimate is matched to dateBP. */
  dateMode: 'point' | 'overlap' | 'contained';
}

export type SelectionSource = 'lasso' | 'click' | 'agent' | 'restore';
