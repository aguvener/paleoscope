import { compareSetSummaries, describeSample, summarise } from './analysis.ts';
import type { Store } from './store.ts';

function line(label: string, value: unknown): string {
  return `- **${label}:** ${value ?? 'not recorded'}`;
}

export function buildMarkdownReport(store: Store, title = 'PaleoScope research report'): string {
  const data = store.dataset;
  if (!data) throw new Error('The dataset is not loaded.');
  const visible = summarise(store, store.visible, { topN: 8 });
  const parts = [
    `# ${title.trim() || 'PaleoScope research report'}`,
    '',
    `Generated ${new Date().toISOString()} from ${data.source.name} ${data.source.release}.`,
    '',
    '## Scope',
    '',
    line('Visible samples', `${visible.n.toLocaleString()} of ${data.count.toLocaleString()}`),
    line('PCA basis', data.pca.basisLabels[store.basis] ?? store.basis),
    line('Active filter', JSON.stringify(store.filter)),
    line('Median age', visible.dateBP ? `${visible.dateBP.median.toLocaleString()} BP` : 'present-day only'),
    line('Median SNP count', visible.medianSnpsHit?.toLocaleString() ?? 'not recorded'),
    '',
  ];

  const named = store.sets.named;
  if (named.length > 0) {
    parts.push('## Saved cohorts', '');
    for (const entry of named) {
      const summary = summarise(store, entry.indices, { topN: 5 });
      parts.push(
        `### ${entry.label}`,
        '',
        line('Handle', entry.id),
        line('Samples', summary.n),
        line('Top populations', summary.topPopulations.map((item) => `${item.population} (${item.n})`).join(', ')),
        line('Top regions', summary.topRegions.map((item) => `${item.region} (${item.n})`).join(', ')),
        line('Median age', summary.dateBP ? `${summary.dateBP.median} BP` : 'present-day only'),
        '',
      );
    }
  }

  if (store.comparison) {
    const a = store.resolve(store.comparison.a);
    const b = store.resolve(store.comparison.b);
    if (a && b) {
      const comparison = compareSetSummaries(store, a.indices, b.indices);
      parts.push(
        '## Active comparison',
        '',
        `**${a.label}** versus **${b.label}**`,
        '',
        line('Shared samples', comparison.overlap.n),
        line('Jaccard overlap', comparison.overlap.jaccard.toFixed(3)),
        line('PCA centroid distance', comparison.pca?.centroidDistance.toFixed(2) ?? 'not projected'),
        line('Median date difference', comparison.date ? `${comparison.date.medianDifferenceBP} BP` : 'not comparable'),
        '',
      );
    }
  }

  if (store.notes.length > 0) {
    parts.push('## Findings', '');
    for (const note of store.notes) {
      const tags = note.tags?.length ? ` [${note.tags.join(', ')}]` : '';
      parts.push(`- **${note.kind ?? 'observation'} · ${note.status ?? 'open'}${tags}:** ${note.text}${note.about ? ` _(about ${note.about})_` : ''}`);
    }
    parts.push('');
  }

  if (store.selection.size > 0) {
    parts.push('## Current selection', '', '| ID | Population | Date | Locality | Publication | DOI |', '|---|---|---:|---|---|---|');
    for (const index of [...store.selection].slice(0, 100)) {
      const sample = describeSample(store, index);
      parts.push(`| ${sample.geneticId} | ${sample.population} | ${sample.date ?? ''} | ${sample.locality ?? ''} | ${sample.publication ?? ''} | ${sample.doi ?? ''} |`);
    }
    if (store.selection.size > 100) parts.push('', `_First 100 of ${store.selection.size} selected samples shown._`);
    parts.push('');
  }

  parts.push(
    '## Source and interpretation boundary',
    '',
    `${data.source.citation} License: ${data.source.license}. ${data.source.url}`,
    '',
    '> PCA proximity and descriptive cohort differences are exploratory signals, not direct ancestry estimates or causal conclusions.',
    '',
  );
  return parts.join('\n');
}
