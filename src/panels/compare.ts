import { compareSetSummaries, populationOutliers, populationProfile } from '../analysis.ts';
import { combine } from '../sets.ts';
import type { Store } from '../store.ts';

function metric(label: string, value: string): HTMLElement {
  const item = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  item.append(term, description);
  return item;
}

export class ComparePanel {
  #store: Store;
  #a = document.createElement('select');
  #b = document.createElement('select');
  #result = document.createElement('div');
  #profileInput = document.createElement('input');
  #profileResult = document.createElement('div');

  constructor(host: HTMLElement, store: Store) {
    this.#store = store;
    this.#a.setAttribute('aria-label', 'First cohort');
    this.#b.setAttribute('aria-label', 'Second cohort');
    this.#profileInput.type = 'text';
    this.#profileInput.placeholder = 'Exact population label';
    this.#profileInput.setAttribute('list', 'population-options');

    const form = document.createElement('form');
    form.className = 'compare-form';
    const aLabel = document.createElement('label');
    aLabel.className = 'control';
    aLabel.append(Object.assign(document.createElement('span'), { textContent: 'Cohort A' }), this.#a);
    const bLabel = document.createElement('label');
    bLabel.className = 'control';
    bLabel.append(Object.assign(document.createElement('span'), { textContent: 'Cohort B' }), this.#b);
    const compare = document.createElement('button');
    compare.type = 'submit';
    compare.textContent = 'Compare';
    form.append(aLabel, bLabel, compare);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#store.setComparison(this.#a.value, this.#b.value, 'user');
    });

    const actions = document.createElement('div');
    actions.className = 'compare-actions';
    for (const [label, op] of [
      ['Select A ∪ B', 'union'],
      ['Select A ∩ B', 'intersect'],
      ['Select A − B', 'ab'],
      ['Select B − A', 'ba'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => this.#selectDifference(op));
      actions.append(button);
    }
    const outliers = document.createElement('button');
    outliers.type = 'button';
    outliers.textContent = 'Find outliers in A';
    outliers.addEventListener('click', () => this.#selectOutliers());
    actions.append(outliers);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear comparison';
    clear.addEventListener('click', () => this.#store.clearComparison('user'));
    actions.append(clear);

    const profileHead = document.createElement('div');
    profileHead.className = 'panel-subhead';
    const profileTitle = document.createElement('h3');
    profileTitle.textContent = 'Population profile';
    profileHead.append(profileTitle);
    const profileForm = document.createElement('form');
    profileForm.className = 'profile-form';
    const profileButton = document.createElement('button');
    profileButton.type = 'submit';
    profileButton.textContent = 'Open profile';
    profileForm.append(this.#profileInput, profileButton);
    profileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#renderProfile();
    });

    this.#result.className = 'compare-result';
    this.#profileResult.className = 'profile-result';
    host.append(form, actions, this.#result, profileHead, profileForm, this.#profileResult);
  }

  render(): void {
    const previousA = this.#store.comparison?.a ?? this.#a.value;
    const previousB = this.#store.comparison?.b ?? this.#b.value;
    const choices = [
      { id: 'selection', label: 'Current selection', n: this.#store.selection.size },
      { id: 'visible', label: 'Visible samples', n: this.#store.visible.length },
      ...this.#store.sets.named.map((entry) => ({ id: entry.id, label: entry.label, n: entry.indices.length })),
    ];
    const fill = (select: HTMLSelectElement, wanted: string, fallback: number): void => {
      select.innerHTML = '';
      for (const choice of choices) {
        const option = document.createElement('option');
        option.value = choice.id;
        option.textContent = `${choice.label} · ${choice.n.toLocaleString()}`;
        select.append(option);
      }
      select.value = choices.some((choice) => choice.id === wanted)
        ? wanted
        : choices[Math.min(fallback, choices.length - 1)]?.id ?? '';
    };
    fill(this.#a, previousA, 0);
    fill(this.#b, previousB, 1);
    this.#renderComparison();
  }

  #renderComparison(): void {
    this.#result.innerHTML = '';
    const active = this.#store.comparison;
    if (!active) {
      this.#result.append(Object.assign(document.createElement('p'), {
        className: 'muted',
        textContent: 'Choose two cohorts to overlay them across all three panels and compare their distributions.',
      }));
      return;
    }
    const a = this.#store.resolve(active.a);
    const b = this.#store.resolve(active.b);
    if (!a || !b) return;
    const comparison = compareSetSummaries(this.#store, a.indices, b.indices);
    const legend = document.createElement('div');
    legend.className = 'compare-legend';
    const badgeA = document.createElement('span');
    badgeA.dataset.series = 'a';
    badgeA.textContent = 'A';
    const badgeB = document.createElement('span');
    badgeB.dataset.series = 'b';
    badgeB.textContent = 'B';
    legend.append(badgeA, document.createTextNode(` ${a.label} `), badgeB, document.createTextNode(` ${b.label}`));
    const metrics = document.createElement('dl');
    metrics.className = 'metric-grid';
    metrics.append(
      metric('Samples', `${comparison.a.n.toLocaleString()} / ${comparison.b.n.toLocaleString()}`),
      metric('Shared', `${comparison.overlap.n.toLocaleString()} · Jaccard ${comparison.overlap.jaccard.toFixed(3)}`),
      metric('Median age', `${comparison.a.dateBP?.median ?? '—'} / ${comparison.b.dateBP?.median ?? '—'} BP`),
      metric('PCA distance', comparison.pca?.centroidDistance.toFixed(2) ?? 'not projected'),
      metric('Median SNPs', `${comparison.a.medianSnpsHit?.toLocaleString() ?? '—'} / ${comparison.b.medianSnpsHit?.toLocaleString() ?? '—'}`),
      metric('PCA spread A/B', comparison.pca?.spreadRatio?.toFixed(2) ?? '—'),
    );
    const differences = document.createElement('table');
    differences.innerHTML = '<thead><tr><th>Population</th><th>A</th><th>B</th><th>Δ share</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const item of comparison.populationDifferences) {
      const row = document.createElement('tr');
      for (const value of [item.population, item.a, item.b, `${item.deltaShare >= 0 ? '+' : ''}${(item.deltaShare * 100).toFixed(1)} pp`]) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.append(cell);
      }
      body.append(row);
    }
    differences.append(body);
    const caveat = document.createElement('p');
    caveat.className = 'muted';
    caveat.textContent = 'Descriptive comparison only; PCA distance is not an ancestry proportion or significance test.';
    this.#result.append(legend, metrics, differences, caveat);
  }

  #selectDifference(direction: 'union' | 'intersect' | 'ab' | 'ba'): void {
    const left = this.#store.resolve(direction === 'ab' ? this.#a.value : this.#b.value);
    const right = this.#store.resolve(direction === 'ab' ? this.#b.value : this.#a.value);
    if (!left || !right) return;
    const operation = direction === 'union' ? 'union' : direction === 'intersect' ? 'intersect' : 'minus';
    const actualLeft = direction === 'union' || direction === 'intersect' ? this.#store.resolve(this.#a.value) : left;
    const actualRight = direction === 'union' || direction === 'intersect' ? this.#store.resolve(this.#b.value) : right;
    if (!actualLeft || !actualRight) return;
    const indices = combine(actualLeft.indices, actualRight.indices, operation);
    const label = `${actualLeft.label} ${operation} ${actualRight.label}`;
    const set = this.#store.createResultSet(indices, label, 'user');
    this.#store.setSelection(set.indices, 'restore', 'user');
  }

  #selectOutliers(): void {
    const scope = this.#store.resolve(this.#a.value);
    if (!scope) return;
    const found = populationOutliers(this.#store, scope.indices, { limit: 25, minPopulationSize: 6 });
    const set = this.#store.createResultSet(found.map((item) => item.index), `outliers in ${scope.label}`, 'user');
    this.#store.setSelection(set.indices, 'restore', 'user');
  }

  #renderProfile(): void {
    this.#profileResult.innerHTML = '';
    const profile = populationProfile(this.#store, this.#profileInput.value, this.#store.visible);
    if (!profile) {
      this.#profileResult.textContent = 'No exact matching population is visible.';
      return;
    }
    const title = document.createElement('h3');
    title.textContent = `${profile.population} · ${profile.summary.n.toLocaleString()} samples`;
    const list = document.createElement('dl');
    list.className = 'metric-grid';
    list.append(
      metric('Date range', profile.summary.dateBP ? `${profile.summary.dateBP.min}–${profile.summary.dateBP.max} BP` : 'present-day'),
      metric('Median SNPs', profile.summary.medianSnpsHit?.toLocaleString() ?? '—'),
      metric('Localities', profile.localities.map((item) => `${item.label} (${item.n})`).join(', ')),
      metric('mtDNA', profile.mtHaplogroups.map((item) => `${item.label} (${item.n})`).join(', ')),
      metric('Y', profile.yHaplogroups.map((item) => `${item.label} (${item.n})`).join(', ')),
    );
    const publications = document.createElement('ul');
    publications.className = 'publication-list';
    for (const publication of profile.publications) {
      const item = document.createElement('li');
      if (publication.doi) {
        const link = document.createElement('a');
        link.href = `https://doi.org/${publication.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `${publication.label} (${publication.n})`;
        item.append(link);
      } else item.textContent = `${publication.label} (${publication.n})`;
      publications.append(item);
    }
    this.#profileResult.append(title, list, publications);
  }
}
