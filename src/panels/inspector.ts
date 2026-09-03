import { describeSample } from '../analysis.ts';
import type { Store } from '../store.ts';

const MAX_CARDS = 60;
const TABLE_PAGE = 300;

const TABLE_COLUMNS = [
  { key: 'geneticId', label: 'Genetic ID' },
  { key: 'population', label: 'Population' },
  { key: 'dateBP', label: 'Age (BP)' },
  { key: 'dateSD', label: 'Age ±' },
  { key: 'dateMethod', label: 'Date method' },
  { key: 'region', label: 'Region' },
  { key: 'locality', label: 'Locality' },
  { key: 'lat', label: 'Lat' },
  { key: 'lon', label: 'Lon' },
  { key: 'pc1', label: 'PC1' },
  { key: 'pc2', label: 'PC2' },
  { key: 'snpsHit', label: 'SNPs' },
  { key: 'mtHaplogroup', label: 'mtDNA' },
  { key: 'yHaplogroup', label: 'Y' },
  { key: 'publication', label: 'Publication' },
  { key: 'doi', label: 'DOI' },
] as const;

type TableColumnKey = (typeof TABLE_COLUMNS)[number]['key'];

const DEFAULT_COLUMN_WIDTHS: Record<TableColumnKey, number> = {
  geneticId: 125,
  population: 180,
  dateBP: 95,
  dateSD: 85,
  dateMethod: 150,
  region: 120,
  locality: 160,
  lat: 80,
  lon: 80,
  pc1: 85,
  pc2: 85,
  snpsHit: 95,
  yHaplogroup: 115,
  mtHaplogroup: 115,
  publication: 210,
  doi: 220,
};

/**
 * The table is not decoration. A chart that encodes anything in colour needs a text
 * alternative, and it doubles as the thing a researcher actually wants to copy out.
 */
export class Inspector {
  #store: Store;
  #host: HTMLElement;
  #mode: 'selection' | 'table' = 'selection';
  #onFocus: (index: number) => void;
  #query = '';
  #sort: { key: TableColumnKey; direction: 1 | -1 } = {
    key: 'geneticId',
    direction: 1,
  };
  #tableLimit = TABLE_PAGE;
  #visibleColumns = new Set<TableColumnKey>(TABLE_COLUMNS.map((column) => column.key));
  #columnWidths = new Map<TableColumnKey, number>();

  constructor(host: HTMLElement, store: Store, onFocus: (index: number) => void) {
    this.#host = host;
    this.#store = store;
    this.#onFocus = onFocus;
  }

  setMode(mode: 'selection' | 'table'): void {
    this.#mode = mode;
    this.render();
  }

  get mode(): 'selection' | 'table' {
    return this.#mode;
  }

  render(): void {
    this.#host.innerHTML = '';
    if (this.#mode === 'table') this.#renderTable();
    else this.#renderSelection();
  }

  #renderSelection(): void {
    const store = this.#store;
    const indices = [...store.selection];

    if (indices.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const heading = document.createElement('p');
      heading.textContent = 'Nothing selected.';
      const help = document.createElement('p');
      help.className = 'muted';
      help.textContent =
        'Drag on the PCA plot to lasso points, drag on the map to pick a region, or click a '
        + 'single point. Then ask the agent what they are.';
      empty.append(heading, help);
      this.#host.append(empty);
      return;
    }

    const head = document.createElement('div');
    head.className = 'panel-subhead';
    const title = document.createElement('h3');
    title.textContent = `${indices.length} selected`;
    const origin = document.createElement('span');
    origin.className = 'pill';
    origin.textContent =
      store.selectionSource === 'agent' ? 'selected by the agent' : `by ${store.selectionSource}`;
    head.append(title, origin);
    this.#host.append(head);

    const list = document.createElement('ul');
    list.className = 'cards';
    for (const index of indices.slice(0, MAX_CARDS)) {
      list.append(this.#card(index));
    }
    this.#host.append(list);

    if (indices.length > MAX_CARDS) {
      const more = document.createElement('p');
      more.className = 'muted';
      more.textContent = `and ${indices.length - MAX_CARDS} more — switch to the table view to see all of them.`;
      this.#host.append(more);
    }
  }

  #card(index: number): HTMLElement {
    const store = this.#store;
    const record = describeSample(store, index);
    const item = document.createElement('li');
    item.className = 'card';
    if (store.focused === index) item.classList.add('is-focused');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card-id';
    button.textContent = String(record.geneticId);
    button.addEventListener('click', () => this.#onFocus(index));
    item.append(button);

    const population = document.createElement('div');
    population.className = 'card-population';
    population.textContent = String(record.population);
    item.append(population);

    const facts = document.createElement('dl');
    const add = (label: string, value: unknown, wide = false, href?: string): void => {
      if (value === null || value === undefined || value === '') return;
      const fact = document.createElement('div');
      fact.className = 'card-fact';
      if (wide) fact.classList.add('is-wide');
      const key = document.createElement('dt');
      key.textContent = label;
      const val = document.createElement('dd');
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = String(value);
        link.title = `Open publication · ${href}`;
        val.append(link);
      } else {
        val.textContent = String(value);
      }
      fact.append(key, val);
      facts.append(fact);
    };
    add('Date', record.date);
    add('Date uncertainty', typeof record.dateSD === 'number' ? `±${record.dateSD} years` : null);
    add('Date method', record.dateMethod, true);
    add('Site', withoutParentheticalDetails(record.locality), true);
    add('Region', record.region);
    add('PC1, PC2', record.pc1 === null ? null : `${record.pc1}, ${record.pc2}`);
    add('SNPs', typeof record.snpsHit === 'number' ? record.snpsHit.toLocaleString() : null);
    add('mtDNA', record.mtHaplogroup);
    add('Y', record.yHaplogroup);
    add('Assessment', record.assessment);
    add(
      'Published',
      record.publication,
      true,
      record.doi ? doiUrl(String(record.doi)) : undefined,
    );
    item.append(facts);
    return item;
  }

  #renderTable(): void {
    const store = this.#store;
    const source = store.selection.size > 0 ? [...store.selection] : [...store.visible];
    const records = new Map<number, Record<string, unknown>>();
    const recordFor = (index: number): Record<string, unknown> => {
      const cached = records.get(index);
      if (cached) return cached;
      const record = describeSample(store, index);
      records.set(index, record);
      return record;
    };
    const needle = this.#query.trim().toLowerCase();
    const indices = source
      .filter((index) => {
        if (!needle) return true;
        const record = recordFor(index);
        return TABLE_COLUMNS.some((column) =>
          this.#visibleColumns.has(column.key)
          && String(record[column.key] ?? '').toLowerCase().includes(needle),
        );
      })
      .toSorted((a, b) => {
        const left = recordFor(a)[this.#sort.key];
        const right = recordFor(b)[this.#sort.key];
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * this.#sort.direction;
        return String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true }) * this.#sort.direction;
      });

    const head = document.createElement('div');
    head.className = 'panel-subhead';
    const title = document.createElement('h3');
    title.textContent =
      store.selection.size > 0
        ? `Selection · ${indices.length} rows`
        : `Visible · ${indices.length} rows`;
    head.append(title);
    this.#host.append(head);

    const tools = document.createElement('div');
    tools.className = 'table-tools';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search every visible column';
    search.value = this.#query;
    search.setAttribute('aria-label', 'Search table');
    search.addEventListener('input', () => {
      const position = search.selectionStart;
      this.#query = search.value;
      this.#tableLimit = TABLE_PAGE;
      this.render();
      const replacement = this.#host.querySelector<HTMLInputElement>('.table-tools input');
      replacement?.focus();
      replacement?.setSelectionRange(position, position);
    });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy IDs';
    copy.addEventListener('click', () => void navigator.clipboard.writeText(
      indices.map((index) => store.dataset!.geneticId[index]).join('\n'),
    ));
    const selectResults = document.createElement('button');
    selectResults.type = 'button';
    selectResults.textContent = 'Select results';
    selectResults.addEventListener('click', () => store.setSelection(indices, 'restore', 'user'));
    const columns = document.createElement('details');
    columns.className = 'column-picker';
    const columnsTitle = document.createElement('summary');
    columnsTitle.textContent = 'Columns';
    const choices = document.createElement('div');
    for (const column of TABLE_COLUMNS) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this.#visibleColumns.has(column.key);
      checkbox.disabled = column.key === 'geneticId';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.#visibleColumns.add(column.key);
        else this.#visibleColumns.delete(column.key);
        this.render();
      });
      label.append(checkbox, document.createTextNode(column.label));
      choices.append(label);
    }
    columns.append(columnsTitle, choices);
    tools.append(search, columns, copy, selectResults);
    this.#host.append(tools);

    if (indices.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No individuals pass the current filters.';
      this.#host.append(empty);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    const table = document.createElement('table');
    const visibleTableColumns = TABLE_COLUMNS.filter((column) => this.#visibleColumns.has(column.key));
    const colgroup = document.createElement('colgroup');
    const colElements = new Map<TableColumnKey, HTMLTableColElement>();
    const columnWidth = (key: TableColumnKey): number =>
      this.#columnWidths.get(key) ?? DEFAULT_COLUMN_WIDTHS[key];
    const syncTableWidth = (): void => {
      table.style.width = `${visibleTableColumns.reduce((sum, column) => sum + columnWidth(column.key), 0)}px`;
    };
    for (const column of visibleTableColumns) {
      const col = document.createElement('col');
      col.style.width = `${columnWidth(column.key)}px`;
      colElements.set(column.key, col);
      colgroup.append(col);
    }
    syncTableWidth();
    table.append(colgroup);
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const column of visibleTableColumns) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-button';
      button.textContent = `${column.label}${this.#sort.key === column.key ? (this.#sort.direction === 1 ? ' ↑' : ' ↓') : ''}`;
      button.addEventListener('click', () => {
        this.#sort = this.#sort.key === column.key
          ? { key: column.key, direction: this.#sort.direction === 1 ? -1 : 1 }
          : { key: column.key, direction: 1 };
        this.render();
      });
      const resizer = document.createElement('button');
      resizer.type = 'button';
      resizer.className = 'column-resizer';
      resizer.setAttribute('aria-label', `Resize ${column.label} column`);
      const setWidth = (width: number): void => {
        const next = Math.round(Math.max(64, Math.min(480, width)));
        this.#columnWidths.set(column.key, next);
        const col = colElements.get(column.key);
        if (col) col.style.width = `${next}px`;
        syncTableWidth();
      };
      resizer.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startWidth = columnWidth(column.key);
        const move = (moveEvent: PointerEvent): void => setWidth(startWidth + moveEvent.clientX - startX);
        const finish = (): void => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      });
      resizer.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setWidth(columnWidth(column.key) + (event.key === 'ArrowRight' ? 16 : -16));
      });
      cell.append(button, resizer);
      headerRow.append(cell);
    }
    thead.append(headerRow);
    table.append(thead);

    const body = document.createElement('tbody');
    for (const index of indices.slice(0, this.#tableLimit)) {
      const record = recordFor(index);
      const row = document.createElement('tr');
      if (store.focused === index) row.classList.add('is-focused');
      for (const column of TABLE_COLUMNS) {
        if (!this.#visibleColumns.has(column.key)) continue;
        const cell = document.createElement('td');
        const value = record[column.key];
        cell.title = value === null || value === undefined ? '' : String(value);
        if (column.key === 'doi' && value) {
          const link = document.createElement('a');
          link.href = doiUrl(String(value));
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = String(value);
          link.addEventListener('click', (event) => event.stopPropagation());
          cell.append(link);
        } else cell.textContent = value === null || value === undefined ? '—' : String(value);
        row.append(cell);
      }
      row.addEventListener('click', () => this.#onFocus(index));
      body.append(row);
    }
    table.append(body);
    wrapper.append(table);
    this.#host.append(wrapper);

    if (indices.length > this.#tableLimit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'load-more';
      more.textContent = `Show ${Math.min(TABLE_PAGE, indices.length - this.#tableLimit)} more of ${indices.length}`;
      more.addEventListener('click', () => {
        this.#tableLimit += TABLE_PAGE;
        this.render();
      });
      this.#host.append(more);
    }
  }
}

function doiUrl(doi: string): string {
  const clean = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return `https://doi.org/${encodeURI(clean)}`;
}

function withoutParentheticalDetails(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim() || null;
}
