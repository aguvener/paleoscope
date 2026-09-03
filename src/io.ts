import type { ImportedSample } from './store.ts';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n') {
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

const COLUMN_ALIASES: Record<string, keyof ImportedSample> = {
  geneticid: 'geneticId', id: 'geneticId', iid: 'geneticId', sample: 'geneticId', sampleid: 'geneticId',
  population: 'population', group: 'population', region: 'region', polity: 'region',
  locality: 'locality', site: 'locality', datebp: 'dateBP', datesd: 'dateSD',
  lat: 'lat', latitude: 'lat', lon: 'lon', longitude: 'lon', pc1: 'pc1', pc2: 'pc2',
  basis: 'basis', snpshit: 'snpsHit', snps: 'snpsHit', molecularsex: 'molecularSex',
  sex: 'molecularSex', yhaplogroup: 'yHaplogroup', yhap: 'yHaplogroup',
  mthaplogroup: 'mtHaplogroup', mthap: 'mtHaplogroup', assessment: 'assessment',
  publication: 'publication', doi: 'doi',
};

/**
 * Decide the delimiter from the header alone.
 *
 * Scanning the whole file for a comma misreads a whitespace-delimited or tab-delimited export
 * the moment one data cell contains one — a population label such as `Yamnaya, Samara` is
 * enough — and every column after it lands in the wrong field.
 */
function isCommaDelimited(text: string): boolean {
  const header = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return header.includes(',');
}

export function parseImportedSamples(text: string): ImportedSample[] {
  const rows = isCommaDelimited(text)
    ? parseCsv(text)
    : text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/));
  if (rows.length < 2) throw new Error('The CSV must contain a header and at least one sample.');
  const headers = rows[0].map((value) =>
    COLUMN_ALIASES[value.toLowerCase().replace(/^#/, '').replaceAll(/[^a-z0-9]/g, '')],
  );
  if (!headers.includes('geneticId')) {
    throw new Error('The CSV needs a geneticId, id, sample, or sampleId column.');
  }
  const numeric = new Set<keyof ImportedSample>([
    'dateBP', 'dateSD', 'lat', 'lon', 'pc1', 'pc2', 'snpsHit',
  ]);
  const samples: ImportedSample[] = [];
  for (const values of rows.slice(1)) {
    const record: Partial<ImportedSample> = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i];
      const value = values[i]?.trim();
      if (!key || !value) continue;
      if (numeric.has(key)) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid number "${value}" in column ${rows[0][i]}.`);
        }
        (record as Record<string, unknown>)[key] = parsed;
      } else (record as Record<string, unknown>)[key] = value;
    }
    if (record.geneticId) samples.push(record as ImportedSample);
  }
  if (samples.length === 0) throw new Error('No samples with an ID were found.');
  return samples;
}

export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
