import type { Store } from '../store.ts';
import type { Filter } from '../types.ts';

type TextFilterKey =
  | 'population'
  | 'locality'
  | 'publication'
  | 'dateMethod'
  | 'mtHaplogroup'
  | 'yHaplogroup'
  | 'molecularSex';

const TEXT_FILTERS: TextFilterKey[] = [
  'population', 'locality', 'publication', 'dateMethod',
  'mtHaplogroup', 'yHaplogroup', 'molecularSex',
];

export class FiltersPanel {
  #store: Store;
  #form: HTMLFormElement;

  constructor(form: HTMLFormElement, store: Store) {
    this.#store = store;
    this.#form = form;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.apply();
    });
    form.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
      store.clearFilters('user');
      this.sync();
    });
  }

  populateSuggestions(force = false): void {
    const data = this.#store.dataset;
    if (!data) return;
    const mapping: [TextFilterKey, keyof typeof data.dict][] = [
      ['population', 'group'],
      ['locality', 'locality'],
      ['publication', 'publication'],
      ['dateMethod', 'dateMethod'],
      ['mtHaplogroup', 'mtHaplogroup'],
      ['yHaplogroup', 'yHaplogroup'],
      ['molecularSex', 'molecularSex'],
    ];
    for (const [name, key] of mapping) {
      const field = this.#form.elements.namedItem(name);
      if (!(field instanceof HTMLSelectElement)) continue;
      if (force) field.querySelectorAll('option:not(:first-child)').forEach((option) => option.remove());
      if (field.options.length > 1) continue;
      for (const value of data.dict[key].filter(Boolean).toSorted().slice(0, 1500)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        field.append(option);
      }
    }

    const populationSuggestions = document.getElementById('population-options');
    if (populationSuggestions instanceof HTMLDataListElement) {
      if (force) populationSuggestions.innerHTML = '';
      if (populationSuggestions.children.length === 0) {
        for (const value of data.dict.group.filter(Boolean).toSorted().slice(0, 1500)) {
          const option = document.createElement('option');
          option.value = value;
          populationSuggestions.append(option);
        }
      }
    }
  }

  apply(): void {
    const fields = new FormData(this.#form);
    const text = (key: string): string | null => {
      const value = String(fields.get(key) ?? '').trim();
      return value || null;
    };
    const number = (key: string): number | null => {
      const value = text(key);
      if (value === null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const from = number('fromBP');
    const to = number('toBP');
    const patch: Partial<Filter> = {
      population: text('population'),
      locality: text('locality'),
      publication: text('publication'),
      dateMethod: text('dateMethod'),
      mtHaplogroup: text('mtHaplogroup'),
      yHaplogroup: text('yHaplogroup'),
      molecularSex: text('molecularSex'),
      minSnps: number('minSnps'),
      passOnly: fields.get('passOnly') === 'on',
      era: String(fields.get('era') ?? 'both') as Filter['era'],
      dateMode: String(fields.get('dateMode') ?? 'point') as Filter['dateMode'],
      dateBP: from === null && to === null
        ? null
        : [Math.min(from ?? 0, to ?? 50_000), Math.max(from ?? 0, to ?? 50_000)],
    };
    this.#store.setFilter(patch, { actor: 'user' });
  }

  sync(): void {
    const filter = this.#store.filter;
    const set = (name: string, value: string | number | null): void => {
      const input = this.#form.elements.namedItem(name);
      if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        input.value = value === null ? '' : String(value);
      }
    };
    for (const key of TEXT_FILTERS) set(key, filter[key]);
    set('fromBP', filter.dateBP?.[0] ?? null);
    set('toBP', filter.dateBP?.[1] ?? null);
    set('minSnps', filter.minSnps);
    set('era', filter.era);
    set('dateMode', filter.dateMode);
    const pass = this.#form.elements.namedItem('passOnly');
    if (pass instanceof HTMLInputElement) pass.checked = filter.passOnly;
  }
}
