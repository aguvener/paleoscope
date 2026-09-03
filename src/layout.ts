import { capture, release } from './panels/canvas.ts';

/**
 * Four slots on one CSS grid, with real splitter tracks between them. Panels are placed by
 * writing `grid-area`, so rearranging is just swapping two strings — no reparenting, no
 * remounting, and the canvases keep their state. Sizes and placement persist.
 *
 * Everything is driven through CSS custom properties rather than inline geometry so a drag
 * costs one style write and the browser does the layout.
 */

type Slot = 'slot1' | 'slot2' | 'slot3' | 'slot4';

const SLOTS: Slot[] = ['slot1', 'slot2', 'slot3', 'slot4'];
const PANEL_IDS = ['panel-map', 'panel-pca', 'panel-timeline', 'panel-side'] as const;
const STORAGE_KEY = 'paleoscope.layout.v1';

const DEFAULTS = {
  frA: 1,
  frB: 1.15,
  sideWidth: 380,
  frTop: 1,
  frBottom: 0.42,
};

export interface LayoutState {
  assignment: Record<string, string>;
  frA: number;
  frB: number;
  sideWidth: number;
  frTop: number;
  frBottom: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export class Layout {
  #grid: HTMLElement;
  #assignment = new Map<Slot, string>();
  #geometry = { ...DEFAULTS };
  #dragPanel: HTMLElement | null = null;
  #dropTarget: HTMLElement | null = null;
  #inspectorExpanded = false;

  constructor(grid: HTMLElement) {
    this.#grid = grid;
    for (const [i, id] of PANEL_IDS.entries()) this.#assignment.set(SLOTS[i], id);
    this.#restore();
    this.#injectGrips();
    this.#bindSplitters();
    this.apply();
  }

  apply(): void {
    const style = this.#grid.style;
    style.setProperty('--fr-a', `${this.#geometry.frA}fr`);
    style.setProperty('--fr-b', `${this.#geometry.frB}fr`);
    style.setProperty('--side-w', `${this.#geometry.sideWidth}px`);
    style.setProperty('--fr-top', `${this.#geometry.frTop}fr`);
    style.setProperty('--fr-bottom', `${this.#geometry.frBottom}fr`);
    for (const [slot, id] of this.#assignment) {
      const panel = document.getElementById(id);
      if (panel) panel.style.gridArea = slot;
    }
  }

  reset(): void {
    this.setInspectorExpanded(false);
    this.#geometry = { ...DEFAULTS };
    this.#assignment.clear();
    for (const [i, id] of PANEL_IDS.entries()) this.#assignment.set(SLOTS[i], id);
    this.apply();
    this.#persist();
  }

  setInspectorExpanded(expanded: boolean): void {
    this.#inspectorExpanded = expanded;
    this.#grid.classList.toggle('is-inspector-expanded', expanded);
  }

  toggleInspectorExpanded(): boolean {
    this.setInspectorExpanded(!this.#inspectorExpanded);
    return this.#inspectorExpanded;
  }

  // --- persistence ----------------------------------------------------------

  #persist(): void {
    try {
      const assignment: Record<string, string> = {};
      for (const [slot, id] of this.#assignment) assignment[slot] = id;
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ assignment, ...this.#geometry } satisfies LayoutState),
      );
    } catch {
      // Layout memory is a convenience, never a requirement.
    }
  }

  #restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<LayoutState>;
      if (saved.assignment) {
        const placed = new Set<string>();
        const next = new Map<Slot, string>();
        for (const slot of SLOTS) {
          const id = saved.assignment[slot];
          if (typeof id === 'string' && (PANEL_IDS as readonly string[]).includes(id)
            && !placed.has(id)) {
            next.set(slot, id);
            placed.add(id);
          }
        }
        // Only adopt a complete, non-overlapping assignment; anything else falls back.
        if (next.size === SLOTS.length) this.#assignment = next;
      }
      this.#geometry = {
        frA: clamp(Number(saved.frA) || DEFAULTS.frA, 0.2, 4),
        frB: clamp(Number(saved.frB) || DEFAULTS.frB, 0.2, 4),
        sideWidth: clamp(Number(saved.sideWidth) || DEFAULTS.sideWidth, 260, 720),
        frTop: clamp(Number(saved.frTop) || DEFAULTS.frTop, 0.2, 4),
        frBottom: clamp(Number(saved.frBottom) || DEFAULTS.frBottom, 0.15, 4),
      };
    } catch {
      // Corrupt or stale layout: use the defaults.
    }
  }

  exportState(): LayoutState {
    const assignment: Record<string, string> = {};
    for (const [slot, id] of this.#assignment) assignment[slot] = id;
    return { assignment, ...this.#geometry };
  }

  importState(saved: Partial<LayoutState>): void {
    if (saved.assignment) {
      const placed = new Set<string>();
      const next = new Map<Slot, string>();
      for (const slot of SLOTS) {
        const id = saved.assignment[slot];
        if (typeof id === 'string' && (PANEL_IDS as readonly string[]).includes(id) && !placed.has(id)) {
          next.set(slot, id);
          placed.add(id);
        }
      }
      if (next.size === SLOTS.length) this.#assignment = next;
    }
    this.#geometry = {
      frA: clamp(Number(saved.frA) || DEFAULTS.frA, 0.2, 4),
      frB: clamp(Number(saved.frB) || DEFAULTS.frB, 0.2, 4),
      sideWidth: clamp(Number(saved.sideWidth) || DEFAULTS.sideWidth, 260, 720),
      frTop: clamp(Number(saved.frTop) || DEFAULTS.frTop, 0.2, 4),
      frBottom: clamp(Number(saved.frBottom) || DEFAULTS.frBottom, 0.15, 4),
    };
    this.apply();
    this.#persist();
  }

  // --- resizing -------------------------------------------------------------

  #bindSplitters(): void {
    this.#dragSplitter('split-v1', (event, rect) => {
      const available = rect.width - this.#geometry.sideWidth - this.#splitterWidth * 2;
      const fraction = clamp((event.clientX - rect.left) / Math.max(1, available), 0.18, 0.82);
      this.#geometry.frA = Number((fraction * 2).toFixed(3));
      this.#geometry.frB = Number(((1 - fraction) * 2).toFixed(3));
    });

    this.#dragSplitter('split-v2', (event, rect) => {
      this.#geometry.sideWidth = Math.round(
        clamp(rect.right - event.clientX - this.#splitterWidth / 2, 260, 720),
      );
    });

    this.#dragSplitter('split-h', (event, rect) => {
      const available = rect.height - this.#splitterWidth;
      const fraction = clamp((event.clientY - rect.top) / Math.max(1, available), 0.2, 0.88);
      this.#geometry.frTop = Number((fraction * 2).toFixed(3));
      this.#geometry.frBottom = Number(((1 - fraction) * 2).toFixed(3));
    });
  }

  get #splitterWidth(): number {
    const raw = getComputedStyle(this.#grid).getPropertyValue('--split');
    return Number.parseFloat(raw) || 10;
  }

  #dragSplitter(id: string, update: (event: PointerEvent, rect: DOMRect) => void): void {
    const handle = document.getElementById(id);
    if (!handle) return;

    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      // Best-effort capture, but the drag listeners live on the window: capture can be refused,
      // and a drag must keep tracking once the pointer leaves the ten-pixel handle anyway.
      capture(handle, event.pointerId);
      handle.classList.add('is-active');
      // The grid rect is read once; reading it per move would force layout on every frame.
      const rect = this.#grid.getBoundingClientRect();

      const move = (moveEvent: PointerEvent): void => {
        update(moveEvent, rect);
        this.apply();
      };
      const finish = (upEvent: PointerEvent): void => {
        release(handle, upEvent.pointerId);
        handle.classList.remove('is-active');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        this.#persist();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });

    handle.addEventListener('dblclick', () => this.reset());
  }

  // --- rearranging ----------------------------------------------------------

  /**
   * A dedicated grip rather than a draggable header: the headers carry actions and the sidebar
   * carries tabs, and a drag that starts on those would fight with clicking them.
   */
  #injectGrips(): void {
    for (const id of PANEL_IDS) {
      const panel = document.getElementById(id);
      if (!panel) continue;
      const host = panel.querySelector('.panel-head') ?? panel.querySelector('.tabs');
      if (!host) continue;
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'grip';
      grip.title = 'Drag to move this panel · double-click a divider to reset the layout';
      grip.setAttribute('aria-label', 'Move this panel');
      grip.textContent = '⠿';
      host.prepend(grip);
      this.#bindGrip(grip, panel);
    }
  }

  #bindGrip(grip: HTMLElement, panel: HTMLElement): void {
    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      capture(grip, event.pointerId);
      this.#dragPanel = panel;
      panel.classList.add('is-dragging');
      document.body.classList.add('is-rearranging');

      const move = (moveEvent: PointerEvent): void => {
        const target = this.#panelUnder(moveEvent.clientX, moveEvent.clientY);
        if (target === this.#dropTarget) return;
        this.#dropTarget?.classList.remove('is-drop-target');
        this.#dropTarget = target && target !== panel ? target : null;
        this.#dropTarget?.classList.add('is-drop-target');
      };
      const finish = (upEvent: PointerEvent): void => {
        release(grip, upEvent.pointerId);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        panel.classList.remove('is-dragging');
        document.body.classList.remove('is-rearranging');
        this.#dropTarget?.classList.remove('is-drop-target');
        if (this.#dropTarget) this.#swap(panel.id, this.#dropTarget.id);
        this.#dropTarget = null;
        this.#dragPanel = null;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
  }

  #panelUnder(x: number, y: number): HTMLElement | null {
    for (const element of document.elementsFromPoint(x, y)) {
      const panel = (element as HTMLElement).closest?.('.panel');
      if (panel instanceof HTMLElement && panel !== this.#dragPanel) return panel;
    }
    return null;
  }

  #swap(a: string, b: string): void {
    let slotA: Slot | null = null;
    let slotB: Slot | null = null;
    for (const [slot, id] of this.#assignment) {
      if (id === a) slotA = slot;
      if (id === b) slotB = slot;
    }
    if (!slotA || !slotB) return;
    this.#assignment.set(slotA, b);
    this.#assignment.set(slotB, a);
    this.apply();
    this.#persist();
  }
}
