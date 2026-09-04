import { AGE_BANDS, describeSample } from './analysis.ts';
import { ActivityPanel } from './agent/activity.ts';
import { buildTools, suggestNext } from './agent/tools.ts';
import type { PanelBridge } from './agent/tools.ts';
import { ToolRegistry, webmcpAvailable } from './agent/webmcp.ts';
import { describeView, renderPlot } from './digest.ts';
import type { PlotDigest } from './digest.ts';
import { MapPanel } from './panels/map.ts';
import type { LandOutline } from './panels/map.ts';
import { PcaPanel } from './panels/pca.ts';
import { TimelinePanel } from './panels/timeline.ts';
import { Inspector } from './panels/inspector.ts';
import { Layout } from './layout.ts';
import type { LayoutState } from './layout.ts';
import { downloadText, parseImportedSamples } from './io.ts';
import { buildMarkdownReport } from './report.ts';
import { Store } from './store.ts';
import type { Note } from './store.ts';
import { applyTheme, storedTheme } from './theme.ts';
import type { ThemeChoice } from './theme.ts';
import { ComparePanel } from './panels/compare.ts';
import { FiltersPanel } from './panels/filters.ts';

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The document is missing #${id}.`);
  return found as T;
};

const store = new Store();
const registry = new ToolRegistry();
const layout = new Layout(element('app-grid'));

// --- theme -----------------------------------------------------------------

const themeToggle = element<HTMLButtonElement>('theme');
let themeChoice: ThemeChoice = storedTheme();

function resolvedTheme(): 'light' | 'dark' {
  if (themeChoice !== 'system') return themeChoice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function renderThemeToggle(): void {
  const current = resolvedTheme();
  const next = current === 'light' ? 'dark' : 'light';
  themeToggle.dataset.theme = current;
  themeToggle.ariaLabel = `Switch to ${next} theme`;
  themeToggle.title = `Switch to ${next} theme`;
}

applyTheme(themeChoice);
renderThemeToggle();
themeToggle.addEventListener('click', () => {
  themeChoice = resolvedTheme() === 'light' ? 'dark' : 'light';
  applyTheme(themeChoice);
  renderThemeToggle();
  requestRedraw();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeChoice !== 'system') return;
  renderThemeToggle();
  requestRedraw();
});

// --- panels ----------------------------------------------------------------

const clearSelection = (): void => store.clearSelection('user');

const pca = new PcaPanel(element('pca-plot'), store, {
  onLasso: (indices) => {
    store.setSelection(indices, indices.length === 1 ? 'click' : 'lasso', 'user');
  },
  onClearSelection: clearSelection,
});

const map = new MapPanel(element('map-plot'), store, {
  onRegion: (bbox) => void store.setFilter({ bbox }, { actor: 'user' }),
  onPick: (index: number) => void store.setSelection([index], 'click', 'user'),
  onLasso: (indices) => void store.setSelection(indices, 'lasso', 'user'),
  onClearSelection: clearSelection,
});

const timeline = new TimelinePanel(element('timeline-plot'), store, {
  onRange: (range) => void store.setFilter({ dateBP: range }, { actor: 'user' }),
  onClearSelection: clearSelection,
});

const inspector = new Inspector(element('pane-inspector'), store, (index) => {
  store.focus(index, 'user');
  const data = store.dataset;
  if (data && !Number.isNaN(data.lat[index])) map.centreOn(data.lon[index], data.lat[index]);
});

const activity = new ActivityPanel(element('pane-agent'));
const compare = new ComparePanel(element('pane-compare'), store);
const filters = new FiltersPanel(
  element<HTMLFormElement>('filters-form'),
  store,
);

const panelBridge: PanelBridge = {
  centreMapOn: (lon, lat) => map.centreOn(lon, lat),
  resetPcaView: () => pca.resetView(),
  showTab: (tab) => selectTab(tab),
};

function requestRedraw(): void {
  pca.layer.schedule();
  map.layer.schedule();
  timeline.layer.schedule();
}

// --- the envelope context --------------------------------------------------
// Injection keeps the WebMCP transport independent of domain state.

registry.setContext({
  revision: () => store.revision,
  view: () => describeView(store),
  since: (from, to) =>
    store.changes
      .filter((event) => event.rev > from && event.rev <= to)
      .map((event) => ({ rev: event.rev, by: event.actor, what: event.what })),
  suggest: () => suggestNext(store),
});

// --- tabs ------------------------------------------------------------------

type Tab = 'selection' | 'table' | 'compare' | 'filters' | 'findings' | 'agent';

const tabs: Record<Tab, HTMLButtonElement> = {
  selection: element<HTMLButtonElement>('tab-selection'),
  table: element<HTMLButtonElement>('tab-table'),
  compare: element<HTMLButtonElement>('tab-compare'),
  filters: element<HTMLButtonElement>('tab-filters'),
  findings: element<HTMLButtonElement>('tab-findings'),
  agent: element<HTMLButtonElement>('tab-agent'),
};

function selectTab(tab: Tab): void {
  for (const [name, button] of Object.entries(tabs)) {
    const active = name === tab;
    button.setAttribute('aria-selected', String(active));
    // Roving tabindex: one stop for the whole strip, then arrow keys inside it.
    button.tabIndex = active ? 0 : -1;
  }
  // Two tabs share one panel, so the panel names whichever of them is current.
  element('pane-inspector').setAttribute('aria-labelledby', `tab-${tab === 'table' ? 'table' : 'selection'}`);
  element('pane-inspector').hidden = tab !== 'selection' && tab !== 'table';
  element('pane-agent').hidden = tab !== 'agent';
  element('pane-compare').hidden = tab !== 'compare';
  element('pane-filters').hidden = tab !== 'filters';
  element('pane-findings').hidden = tab !== 'findings';
  if (tab === 'selection' || tab === 'table') inspector.setMode(tab);
  if (tab === 'compare') compare.render();
}

const TAB_ORDER = Object.keys(tabs) as Tab[];

for (const [name, button] of Object.entries(tabs)) {
  button.addEventListener('click', () => selectTab(name as Tab));
}

/**
 * A tablist is one tab stop. Without arrow keys the six views are only reachable by
 * pointer, and the strip scrolls horizontally once the sidebar is narrow.
 */
element('panel-side').querySelector('.tabs')?.addEventListener('keydown', (event) => {
  const key = (event as KeyboardEvent).key;
  const current = TAB_ORDER.findIndex((name) => tabs[name].getAttribute('aria-selected') === 'true');
  if (current < 0) return;
  const next =
    key === 'ArrowRight' ? (current + 1) % TAB_ORDER.length
    : key === 'ArrowLeft' ? (current - 1 + TAB_ORDER.length) % TAB_ORDER.length
    : key === 'Home' ? 0
    : key === 'End' ? TAB_ORDER.length - 1
    : -1;
  if (next < 0) return;
  event.preventDefault();
  const name = TAB_ORDER[next]!;
  selectTab(name);
  tabs[name].focus();
  tabs[name].scrollIntoView({ block: 'nearest', inline: 'nearest' });
});

// --- header controls -------------------------------------------------------

const basisSelect = element<HTMLSelectElement>('basis');
basisSelect.addEventListener('change', () => {
  store.setBasis(basisSelect.value, 'user');
  pca.resetView();
});

element('reset-map').addEventListener('click', () => map.fitWestEurasia());
element('reset-pca').addEventListener('click', () => pca.resetView());
element('reset-timeline').addEventListener('click', () => timeline.resetView());

const expandInspector = element<HTMLButtonElement>('expand-inspector');

function renderInspectorExpansion(expanded: boolean): void {
  expandInspector.setAttribute('aria-pressed', String(expanded));
  expandInspector.ariaLabel = expanded ? 'Restore panel layout' : 'Expand inspector panel';
  expandInspector.title = expanded ? 'Restore layout' : 'Expand panel';
}

expandInspector.addEventListener('click', () => {
  const expanded = layout.toggleInspectorExpanded();
  renderInspectorExpansion(expanded);
});
element('reset-layout').addEventListener('click', () => {
  layout.reset();
  renderInspectorExpansion(false);
});

element('undo').addEventListener('click', () => store.undo('user'));
element('clear').addEventListener('click', () => store.clearFilters('user'));

const infoDialog = element<HTMLDialogElement>('info-dialog');
element('info-button').addEventListener('click', () => infoDialog.showModal());
element('info-close').addEventListener('click', () => infoDialog.close());
infoDialog.addEventListener('click', (event) => {
  if (event.target === infoDialog) infoDialog.close();
});

const workspaceDialog = element<HTMLDialogElement>('workspace-dialog');
const workspaceStatus = element('workspace-status');
element('workspace-button').addEventListener('click', () => workspaceDialog.showModal());
element('workspace-close').addEventListener('click', () => workspaceDialog.close());
workspaceDialog.addEventListener('click', (event) => {
  if (event.target === workspaceDialog) workspaceDialog.close();
});

// --- WebMCP status ---------------------------------------------------------

const statusBadge = element('agent-status');
const statusText = statusBadge.querySelector('.agent-status-text');

function reportAgentStatus(): void {
  const live = webmcpAvailable();
  statusBadge.hidden = live;
  statusBadge.dataset.state = live ? 'live' : 'absent';
  if (statusText && !live) statusText.textContent = 'WebMCP not available in this browser';
  if (!live) renderWebmcpHelp();
}

function renderWebmcpHelp(): void {
  const notice = document.createElement('div');
  notice.className = 'notice';
  const heading = document.createElement('strong');
  heading.textContent = 'This browser is not exposing WebMCP';
  const body = document.createElement('p');
  body.className = 'muted';
  body.textContent =
    'Every panel still works by hand. To let an agent drive the page, open it in the ChatGPT '
    + 'desktop app’s browser, or in Chrome 149 or newer with the WebMCP flag enabled at:';
  const flag = document.createElement('code');
  flag.textContent = 'chrome://flags/#enable-webmcp-testing';
  notice.append(heading, body, flag);
  element('pane-agent').prepend(notice);
}

// --- legend ----------------------------------------------------------------

function legendSwatch(colour: string, label: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'legend-item';
  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  swatch.style.background = colour;
  const text = document.createElement('span');
  text.textContent = label;
  item.append(swatch, text);
  return item;
}

function renderLegend(): void {
  const host = element('legend');
  host.innerHTML = '';

  const ramp = document.createElement('div');
  ramp.className = 'legend-item legend-ramp';
  const rampLabel = document.createElement('span');
  rampLabel.textContent = 'Age';
  ramp.append(rampLabel);
  for (const [band, definition] of AGE_BANDS.entries()) {
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = `var(--age-${band + 1})`;
    swatch.title = definition.label;
    ramp.append(swatch);
  }
  const rampRange = document.createElement('span');
  rampRange.textContent = 'recent → 12k BP and older';
  ramp.append(rampRange);
  host.append(
    ramp,
    legendSwatch('var(--present)', 'present-day reference'),
    legendSwatch('var(--accent)', 'selection'),
  );
}

// --- sets and findings -----------------------------------------------------

function renderSets(): void {
  const host = element('sets-list');
  host.innerHTML = '';
  const entries = store.sets.list().filter((entry) => entry.saved || entry.origin === 'result');
  const exportScope = element<HTMLSelectElement>('export-scope');
  const previousScope = exportScope.value;
  exportScope.querySelectorAll('option[data-saved]').forEach((option) => option.remove());
  for (const entry of store.sets.named) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.dataset.saved = 'true';
    option.textContent = entry.label;
    exportScope.append(option);
  }
  if ([...exportScope.options].some((option) => option.value === previousScope)) {
    exportScope.value = previousScope;
  }
  const saveButton = element<HTMLButtonElement>('save-set-form').querySelector('button');
  if (saveButton) saveButton.disabled = store.selection.size === 0;
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = store.selection.size > 0
      ? 'No cohorts yet. Name the current selection to keep it.'
      : 'No cohorts yet. Select individuals on a plot, then name the selection to keep it.';
    host.append(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'saved-list';
  for (const entry of entries.slice(-8)) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'saved-name';
    const handle = document.createElement('code');
    handle.textContent = entry.id;
    name.append(handle, document.createTextNode(` ${entry.label} · ${entry.indices.length}`));
    const show = document.createElement('button');
    show.type = 'button';
    show.textContent = 'Show';
    show.addEventListener('click', () => store.setSelection(entry.indices, 'restore', 'user'));
    item.append(name, show);
    if (entry.saved) {
      const compareButton = document.createElement('button');
      compareButton.type = 'button';
      compareButton.textContent = 'Compare';
      compareButton.addEventListener('click', () => {
        const other = store.sets.named.find((candidate) => candidate.id !== entry.id);
        if (other) store.setComparison(entry.id, other.id, 'user');
        selectTab('compare');
      });
      item.append(compareButton);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => store.deleteSet(entry.id, 'user'));
    item.append(remove);
    list.append(item);
  }
  host.append(list);
}

let noteQuery = '';
let editingNote: string | null = null;

/**
 * The search box outlives the list.
 *
 * Rebuilding it on every render dropped focus and caret whenever anything else touched the
 * store — an agent call, a filter change — in the middle of typing.
 */
const noteSearch = document.createElement('input');
noteSearch.type = 'search';
noteSearch.className = 'notes-search';
noteSearch.placeholder = 'Search findings';
noteSearch.setAttribute('aria-label', 'Search findings');
noteSearch.addEventListener('input', () => {
  noteQuery = noteSearch.value;
  renderNoteList();
});

function noteEditor(note: Note): HTMLElement {
  const form = document.createElement('form');
  form.className = 'note-editor';
  const field = document.createElement('input');
  field.type = 'text';
  field.name = 'text';
  field.value = note.text;
  field.maxLength = 600;
  field.setAttribute('aria-label', 'Finding text');
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const close = (): void => {
    editingNote = null;
    renderNoteList();
  };
  cancel.addEventListener('click', close);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = field.value.trim();
    editingNote = null;
    // `updateNote` re-renders through the store; an empty edit is a no-op, not a delete.
    if (value) store.updateNote(note.id, { text: value }, 'user');
    else renderNoteList();
  });
  form.append(field, save, cancel);
  queueMicrotask(() => field.focus());
  return form;
}

function noteItem(note: Note): HTMLElement {
  const item = document.createElement('li');
  const badge = document.createElement('span');
  badge.className = 'actor';
  badge.textContent = `${note.kind ?? (note.actor === 'agent' ? 'agent' : 'you')} · ${note.status ?? 'open'}`;
  item.append(badge);

  if (editingNote === note.id) {
    item.append(noteEditor(note));
    return item;
  }

  const text = document.createElement('span');
  text.textContent = `${note.text}${note.tags?.length ? ` · ${note.tags.join(', ')}` : ''}`;
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.title = 'Edit this finding';
  edit.addEventListener('click', () => {
    editingNote = note.id;
    renderNoteList();
  });
  const status = document.createElement('button');
  status.type = 'button';
  status.textContent = 'Status';
  status.title = 'Cycle open, supported, and rejected';
  status.addEventListener('click', () => {
    const next = note.status === 'supported' ? 'rejected' : note.status === 'rejected' ? 'open' : 'supported';
    store.updateNote(note.id, { status: next }, 'user');
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = 'Delete this finding';
  remove.addEventListener('click', () => store.deleteNote(note.id, 'user'));
  item.append(text, edit, status, remove);
  return item;
}

function matchesNoteQuery(note: Note, needle: string): boolean {
  if (!needle) return true;
  return [note.text, note.about, note.kind, note.status, ...(note.tags ?? [])]
    .some((value) => value?.toLowerCase().includes(needle));
}

function renderNoteList(): void {
  const host = element('notes-list');
  const previous = host.querySelector('.notes');
  if (store.notes.length === 0) {
    host.innerHTML = '';
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent =
      'No findings yet. Write down what you notice; the agent writes into the same list.';
    host.append(empty);
    return;
  }
  if (!host.contains(noteSearch)) {
    host.innerHTML = '';
    noteSearch.value = noteQuery;
    host.append(noteSearch);
  }
  const list = document.createElement('ul');
  list.className = 'notes';
  const needle = noteQuery.trim().toLowerCase();
  const notes = store.notes.filter((note) => matchesNoteQuery(note, needle));
  for (const note of notes.slice(-20)) list.append(noteItem(note));
  if (notes.length === 0) {
    const none = document.createElement('li');
    none.className = 'notes-empty';
    none.textContent = `No finding matches “${noteQuery.trim()}”.`;
    list.append(none);
  }
  if (previous) previous.replaceWith(list);
  else host.append(list);
}

function renderNotes(): void {
  if (editingNote !== null && !store.notes.some((note) => note.id === editingNote)) {
    editingNote = null;
  }
  renderNoteList();
}

const saveSetForm = element<HTMLFormElement>('save-set-form');
saveSetForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const field = saveSetForm.elements.namedItem('name');
  if (!(field instanceof HTMLInputElement) || !field.value.trim()) return;
  const saved = store.saveSet('selection', field.value, 'user');
  if (saved) {
    setStatus(`Saved ${saved.indices.length} individuals as ${saved.label}.`);
    field.value = '';
  }
});

const noteForm = element<HTMLFormElement>('note-form');
noteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = new FormData(noteForm);
  const value = String(fields.get('text') ?? '').trim();
  if (!value) return;
  store.addNote(
    value,
    store.selection.size > 0 ? 'selection' : null,
    'user',
    {
      kind: String(fields.get('kind') ?? 'observation') as 'observation' | 'hypothesis' | 'caveat',
      status: String(fields.get('status') ?? 'open') as 'open' | 'supported' | 'rejected',
      tags: String(fields.get('tags') ?? '').split(','),
    },
  );
  noteForm.reset();
});

// --- CSV export (the declarative-API flow) ---------------------------------

const CSV_COLUMNS = [
  'geneticId', 'population', 'region', 'locality', 'dateBP', 'date', 'lat', 'lon',
  'pc1', 'pc2', 'snpsHit', 'molecularSex', 'yHaplogroup', 'mtHaplogroup', 'assessment',
  'publication', 'doi',
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportData(scope: string, rawName: string, format: string): string {
  const resolved = store.resolve(scope);
  if (!resolved || resolved.indices.length === 0) return `The ${scope} cohort is empty, so there was nothing to export.`;
  const indices = [...resolved.indices];
  const safeName = (rawName.trim() || 'paleoscope-selection')
    .replaceAll(/[^\w.-]+/g, '-')
    .slice(0, 60);

  if (format === 'json') {
    downloadText(
      `${safeName}.json`,
      JSON.stringify({
        dataset: store.dataset?.source,
        cohort: { handle: resolved.id, label: resolved.label },
        findings: store.notes,
        samples: indices.map((index) => describeSample(store, index)),
      }, null, 2),
      'application/json',
    );
  } else {
    const lines: string[] = [];
    // Findings ride along with the data, so an exported file carries the session's conclusions
    // rather than just its rows.
    for (const note of store.notes) {
      lines.push(`# finding (${note.actor}): ${note.text.replaceAll('\n', ' ')}`);
    }
    lines.push(CSV_COLUMNS.join(','));
    for (const index of indices) {
      const record = describeSample(store, index);
      lines.push(CSV_COLUMNS.map((key) => csvCell(record[key])).join(','));
    }
    downloadText(`${safeName}.csv`, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  }

  return `Exported ${indices.length} individuals and ${store.notes.length} findings to ${safeName}.${format === 'json' ? 'json' : 'csv'}.`;
}

const exportForm = element<HTMLFormElement>('export-form');
exportForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = new FormData(exportForm);
  const filename = fields.get('filename');
  const message = exportData(
    String(fields.get('scope') ?? 'selection'),
    typeof filename === 'string' ? filename : '',
    String(fields.get('format') ?? 'csv'),
  );
  // The same form serves a person clicking the button and the agent calling the tool;
  // `agentInvoked` is how the handler tells the two apart.
  if (event.agentInvoked && event.respondWith) event.respondWith(message);
  else setStatus(message);
});

interface FullWorkspace {
  schema: 'paleoscope-workspace';
  version: 1;
  ui?: {
    layout?: Partial<LayoutState>;
    map?: Partial<ReturnType<typeof mapViewState>>;
    pca?: Partial<ReturnType<typeof pcaViewState>>;
    timeline?: Partial<ReturnType<typeof timelineViewState>>;
  };
  [key: string]: unknown;
}

function mapViewState() { return map.viewState; }
function pcaViewState() { return pca.viewState; }
function timelineViewState() { return timeline.viewState; }

const workspaceExportForm = element<HTMLFormElement>('workspace-export-form');
workspaceExportForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const workspace = {
    ...store.exportWorkspace(),
    ui: {
      layout: layout.exportState(),
      map: map.viewState,
      pca: pca.viewState,
      timeline: timeline.viewState,
    },
  };
  downloadText(
    `paleoscope-${store.dataset?.source.release ?? 'workspace'}.json`,
    JSON.stringify(workspace, null, 2),
    'application/json',
  );
  workspaceStatus.textContent = 'Workspace downloaded.';
  if (event.agentInvoked && event.respondWith) event.respondWith('Workspace downloaded as JSON.');
});

element<HTMLInputElement>('workspace-file').addEventListener('change', async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const workspace = JSON.parse(await file.text()) as FullWorkspace;
    const result = store.importWorkspace(workspace, 'user');
    pca.invalidateData();
    if (workspace.ui?.layout) layout.importState(workspace.ui.layout);
    if (workspace.ui?.map) map.restoreView(workspace.ui.map);
    if (workspace.ui?.pca) pca.restoreView(workspace.ui.pca);
    if (workspace.ui?.timeline) timeline.restoreView(workspace.ui.timeline);
    workspaceStatus.textContent = result.warnings.length
      ? `Workspace restored. ${result.warnings.join(' ')}`
      : 'Workspace restored.';
  } catch (error) {
    workspaceStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    input.value = '';
  }
});

element<HTMLInputElement>('samples-file').addEventListener('change', async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = store.importSamples(parseImportedSamples(await file.text()), 'user');
    pca.invalidateData();
    workspaceStatus.textContent = `Imported ${result.added} local samples${result.skipped ? `; skipped ${result.skipped} duplicate or invalid IDs` : ''}.`;
  } catch (error) {
    workspaceStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    input.value = '';
  }
});

element<HTMLInputElement>('dataset-file').addEventListener('change', async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    store.replaceDataset(JSON.parse(await file.text()), 'user');
    registry.reset();
    pca.invalidateData();
    syncDatasetControls();
    filters.populateSuggestions(true);
    map.fitWestEurasia();
    workspaceStatus.textContent = `Loaded ${store.dataset?.source.release ?? 'the local dataset'} with ${store.dataset?.count.toLocaleString()} samples.`;
  } catch (error) {
    workspaceStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    input.value = '';
  }
});

element('samples-clear').addEventListener('click', () => {
  const removed = store.clearImportedSamples('user');
  pca.invalidateData();
  workspaceStatus.textContent = removed ? `Removed ${removed} local samples.` : 'No local samples to remove.';
});

element('copy-view-link').addEventListener('click', async () => {
  const snapshot = store.snapshot();
  const omittedSelection = snapshot.selection.length > 100;
  if (omittedSelection) snapshot.selection = [];
  const url = new URL(window.location.href);
  url.searchParams.set('view', encodeURIComponent(JSON.stringify(snapshot)));
  try {
    await navigator.clipboard.writeText(url.toString());
    workspaceStatus.textContent = omittedSelection
      ? 'Copied the view link; the selection was omitted because it exceeds 100 samples.'
      : 'Copied a link to this view.';
  } catch {
    workspaceStatus.textContent = 'Clipboard access was denied; copy the current URL manually.';
  }
});

const reportForm = element<HTMLFormElement>('report-form');
reportForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = String(new FormData(reportForm).get('title') ?? 'PaleoScope research report');
  downloadText('paleoscope-report.md', buildMarkdownReport(store, title), 'text/markdown;charset=utf-8');
  const message = 'Exported the current research report as paleoscope-report.md.';
  if (event.agentInvoked && event.respondWith) event.respondWith(message);
  else workspaceStatus.textContent = message;
});

// --- status line -----------------------------------------------------------

let statusOverride: string | null = null;

function setStatus(message: string): void {
  statusOverride = message;
  element('status-line').textContent = message;
  setTimeout(() => {
    if (statusOverride === message) {
      statusOverride = null;
      renderStatus();
    }
  }, 4000);
}

function renderStatus(): void {
  if (statusOverride !== null) return;
  const data = store.dataset;
  if (!data) {
    element('status-line').textContent =
      store.load === 'error' ? `Could not load the dataset: ${store.error}` : 'Loading…';
    return;
  }
  const parts = [
    `${store.visible.length.toLocaleString()} of ${data.count.toLocaleString()} individuals visible`,
  ];
  if (store.selection.size > 0) parts.push(`${store.selection.size.toLocaleString()} selected`);
  parts.push(`${data.pca.basisLabels[store.basis] ?? store.basis} PCA basis`);
  element('status-line').textContent = parts.join(' · ');
}

// --- reactions -------------------------------------------------------------

/** The local registry omits declarative form tools, so the browser surface is authoritative. */
async function refreshSurface(): Promise<void> {
  const context = document.modelContext;
  if (!context) {
    activity.setSurface(registry.liveToolNames);
    return;
  }
  try {
    const tools = await context.getTools();
    activity.setSurface(tools.map((tool) => tool.name).toSorted());
  } catch {
    activity.setSurface(registry.liveToolNames);
  }
}

/**
 * The frame is pinned to the canvas, so individuals outside it cannot be panned to — they can
 * only be reached by zooming out. The note used to advise dragging, which never worked.
 */
function renderPcaNote(): void {
  const note = element('pca-note');
  note.innerHTML = '';
  const off = pca.offFrameCount;
  if (off === 0) return;

  if (off > 0) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inline-action';
    button.textContent = `${off.toLocaleString()} off view — show all`;
    button.addEventListener('click', () => {
      pca.fitAll();
      requestAnimationFrame(() => renderPcaNote());
    });
    note.append(button);
  }
}

function renderAgentView(): void {
  const digest = renderPlot(store, {
    panel: 'pca',
    width: 56,
    height: 18,
    markIndices: store.selection.size > 0 ? store.selection : undefined,
    markLabel: 'selection',
    landmarks: 6,
  });
  if (digest) activity.setAgentView(digest);
}

registry.onCall((record) => {
  activity.append(record);
  setStatus(`Agent called ${record.name}${record.isError ? ' — returned an error' : ''}`);
  if (record.name === 'read_plot' && !record.isError) {
    try {
      const digest = (JSON.parse(record.result) as { data?: PlotDigest }).data;
      if (digest?.grid) activity.setAgentView(digest);
    } catch {
      // The log entry is enough; a failed mirror is not worth reporting.
    }
  }
});

let syncQueued = false;

function onStoreChange(): void {
  element<HTMLButtonElement>('undo').disabled = !store.canUndo;
  if (store.dataset) basisSelect.value = store.basis;
  pca.refresh();
  timeline.refresh();
  map.layer.schedule();
  inspector.render();
  compare.render();
  filters.sync();
  renderSets();
  renderNotes();
  activity.setHistory(store.changes);
  renderStatus();
  element<HTMLButtonElement>('samples-clear').disabled = store.importedCount === 0;


  if (!syncQueued) {
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      void registry.sync(buildTools(store, panelBridge));
    });
  }
}

store.subscribe(onStoreChange);

// --- boot ------------------------------------------------------------------

function syncDatasetControls(): void {
  const data = store.dataset;
  if (!data) return;
  basisSelect.innerHTML = '';
  for (const basis of data.pca.bases) {
    const option = document.createElement('option');
    option.value = basis;
    option.textContent = data.pca.basisLabels[basis] ?? basis;
    basisSelect.append(option);
  }
  basisSelect.value = store.basis;
  element('citation').textContent = `${data.source.citation} Data released under ${data.source.license}.`;
}

async function boot(): Promise<void> {
  reportAgentStatus();
  renderLegend();
  selectTab('selection');

  pca.onAfterRender(renderPcaNote);
  document.getElementById('render-agent-view')?.addEventListener('click', renderAgentView);
  const context = document.modelContext;
  if (typeof context?.addEventListener === 'function') {
    context.addEventListener('toolchange', () => void refreshSurface());
  }
  void refreshSurface();

  const landPromise = fetch('data/land.json')
    .then((response) => (response.ok ? (response.json() as Promise<LandOutline>) : null))
    .catch(() => null);

  await store.fetchDataset('data/aadr.json');

  const sharedView = new URL(window.location.href).searchParams.get('view');
  if (sharedView) {
    try {
      const view = JSON.parse(decodeURIComponent(sharedView));
      store.restoreView(view, 'user');
      setStatus('Restored the shared view from this link.');
    } catch {
      setStatus('The shared view link is invalid; the default view was loaded.');
    }
  }

  const land = await landPromise;
  if (land) map.setLand(land);

  const data = store.dataset;
  if (data) {
    filters.populateSuggestions();
    syncDatasetControls();
    map.fitWestEurasia();
    pca.refresh();
  }

  onStoreChange();
}

void boot();
