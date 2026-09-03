import type { PlotDigest } from '../digest.ts';
import type { ChangeEvent } from '../store.ts';
import type { ToolCallRecord } from './webmcp.ts';

const MAX_ENTRIES = 60;
const MAX_HISTORY = 40;

/**
 * The history is the important one. There is not an agent log and a human log — there is one
 * history of one shared session, attributed. The human reads it here; the agent reads exactly
 * the same entries as the `since` field of every tool result. Making the collaboration legible
 * to both parties from the same source is the whole design.
 */
export class ActivityPanel {
  #agentView: HTMLElement;
  #history: HTMLElement;
  #list: HTMLElement;
  #surface: HTMLElement;
  #count: HTMLElement;
  #empty: HTMLElement;
  #entries = 0;

  constructor(host: HTMLElement) {
    host.innerHTML = '';

    const viewHead = document.createElement('div');
    viewHead.className = 'panel-subhead';
    const viewTitle = document.createElement('h3');
    viewTitle.textContent = 'What the agent sees';
    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.id = 'render-agent-view';
    viewButton.textContent = 'Render';
    viewHead.append(viewTitle, viewButton);

    this.#agentView = document.createElement('div');
    this.#agentView.className = 'agent-view';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent =
      'The agent cannot look at the scatter plot, so it asks for a density grid instead. '
      + 'This is the same render it receives.';
    this.#agentView.append(hint);

    const historyHead = document.createElement('div');
    historyHead.className = 'panel-subhead';
    const historyTitle = document.createElement('h3');
    historyTitle.textContent = 'Session history';
    const historyNote = document.createElement('span');
    historyNote.className = 'muted';
    historyNote.textContent = 'you and the agent';
    historyHead.append(historyTitle, historyNote);

    this.#history = document.createElement('ol');
    this.#history.className = 'history';

    const surfaceHead = document.createElement('div');
    surfaceHead.className = 'panel-subhead';
    const surfaceTitle = document.createElement('h3');
    surfaceTitle.textContent = 'Tools offered right now';
    this.#count = document.createElement('span');
    this.#count.className = 'pill';
    this.#count.textContent = '0';
    surfaceHead.append(surfaceTitle, this.#count);

    this.#surface = document.createElement('ul');
    this.#surface.className = 'tool-surface';

    const logHead = document.createElement('div');
    logHead.className = 'panel-subhead';
    const logTitle = document.createElement('h3');
    logTitle.textContent = 'Tool calls';
    logHead.append(logTitle);

    this.#empty = document.createElement('p');
    this.#empty.className = 'muted';
    this.#empty.textContent = 'No tool calls yet. Every call the agent makes will appear here.';

    this.#list = document.createElement('ol');
    this.#list.className = 'activity';
    this.#list.setAttribute('aria-live', 'polite');

    host.append(
      viewHead, this.#agentView,
      historyHead, this.#history,
      surfaceHead, this.#surface,
      logHead, this.#empty, this.#list,
    );
  }

  /**
   * Not a debugging affordance: it is the clearest statement of what this project is. The
   * human and the agent are looking at the same scatter through different apertures, and
   * putting both on screen at once makes the division of labour obvious.
   */
  setAgentView(digest: PlotDigest): void {
    this.#agentView.innerHTML = '';
    const meta = document.createElement('p');
    meta.className = 'muted';
    const marks = digest.marks ? ` · ${Object.values(digest.marks).join(', ')}` : '';
    meta.textContent =
      `${digest.panel}${digest.basis ? ` (${digest.basis})` : ''} · `
      + `${digest.plotted.toLocaleString()} plotted${marks} · ${digest.density}`;
    const pre = document.createElement('pre');
    pre.className = 'grid';
    pre.textContent = digest.grid.join('\n');
    this.#agentView.append(meta, pre);
    if (digest.landmarks) {
      const key = document.createElement('p');
      key.className = 'muted';
      key.textContent = digest.landmarks.join(' · ');
      this.#agentView.append(key);
    }
  }

  setHistory(events: ChangeEvent[]): void {
    this.#history.innerHTML = '';
    const recent = events.slice(-MAX_HISTORY).toReversed();
    if (recent.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'Nothing has happened yet.';
      this.#history.append(empty);
      return;
    }
    for (const event of recent) {
      const item = document.createElement('li');
      item.dataset.actor = event.actor;
      const badge = document.createElement('span');
      badge.className = 'actor';
      badge.textContent = event.actor === 'agent' ? 'agent' : 'you';
      const what = document.createElement('span');
      what.textContent = event.what;
      item.append(badge, what);
      this.#history.append(item);
    }
  }

  setSurface(names: string[]): void {
    this.#count.textContent = String(names.length);
    this.#surface.innerHTML = '';
    if (names.length === 0) {
      const item = document.createElement('li');
      item.className = 'muted';
      item.textContent = 'none yet';
      this.#surface.append(item);
      return;
    }
    for (const name of names) {
      const item = document.createElement('li');
      item.dataset.layer = layerOf(name);
      item.textContent = name;
      this.#surface.append(item);
    }
  }

  #highlight(name: string): void {
    for (const item of this.#surface.children) {
      if (item.textContent !== name) continue;
      item.classList.remove('flash');
      // Force a reflow so the animation restarts on repeated calls.
      void (item as HTMLElement).offsetWidth;
      item.classList.add('flash');
    }
  }

  append(record: ToolCallRecord): void {
    this.#empty.hidden = true;
    this.#highlight(record.name);

    const item = document.createElement('li');
    item.className = record.isError ? 'call error' : 'call';

    const head = document.createElement('div');
    head.className = 'call-head';
    const name = document.createElement('code');
    name.textContent = record.name;
    const timing = document.createElement('span');
    timing.className = 'muted';
    timing.textContent = `${record.durationMs.toFixed(0)} ms`;
    head.append(name, timing);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const argText = JSON.stringify(record.args);
    summary.textContent = argText === '{}' ? 'no arguments' : argText.slice(0, 90);
    const payload = document.createElement('pre');
    payload.textContent = prettify(record.result);
    details.append(summary, payload);

    item.append(head, details);
    this.#list.prepend(item);

    this.#entries++;
    while (this.#entries > MAX_ENTRIES && this.#list.lastElementChild) {
      this.#list.lastElementChild.remove();
      this.#entries--;
    }
  }
}

function layerOf(name: string): string {
  const prefix = name.split('_')[0];
  if (prefix === 'read') return 'read';
  if (prefix === 'find') return 'find';
  if (prefix === 'set' || prefix === 'clear' || prefix === 'focus' || prefix === 'undo') return 'view';
  if (prefix === 'select' || prefix === 'save' || prefix === 'combine' || prefix === 'build') return 'sets';
  return 'explain';
}

function prettify(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
