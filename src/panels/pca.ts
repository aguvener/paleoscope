import { AGE_BANDS, ageBand, robustExtent } from '../analysis.ts';
import type { Extent } from '../analysis.ts';
import type { Store } from '../store.ts';
import { palette } from '../theme.ts';
import {
  MIN_SCALE, Layer, ScreenIndex, View, capture, insidePolygon, release, wheelFactor,
} from './canvas.ts';

const POINT_RADIUS = 2.1;
const SELECTED_RADIUS = 3.4;
const HOVER_RADIUS_PX = 14;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_SLOP_PX = 8;

/**
 * An agent cannot look at a scatter plot, and a human cannot type a filter query as fast as
 * they can spot three points sitting outside a cluster. So the human lassoes, and the tools
 * hand that selection to the agent as structured data. Neither side could do this alone.
 */
export class PcaPanel {
  readonly layer: Layer;
  readonly view: View;

  #store: Store;
  #tooltip: HTMLElement;
  #lasso: number[] = [];
  #dragging: 'lasso' | 'pan' | null = null;
  #lastPointer: { x: number; y: number } | null = null;
  #hovered: number | null = null;
  #extents = new Map<string, Extent>();
  #onLasso: (indices: number[]) => void;
  #onClearSelection: () => void;
  #lastUpAt = 0;
  #lastUpPoint = { x: 0, y: 0 };
  #offFrame = 0;
  #unprojected = 0;
  #afterRender: (() => void) | null = null;
  #index = new ScreenIndex(26);
  #hoverPending: { x: number; y: number } | null = null;
  #hoverQueued = false;

  constructor(
    host: HTMLElement,
    store: Store,
    handlers: { onLasso: (indices: number[]) => void; onClearSelection: () => void },
  ) {
    this.#store = store;
    this.#onLasso = handlers.onLasso;
    this.#onClearSelection = handlers.onClearSelection;
    this.layer = new Layer(host);
    this.view = new View({ minX: -1, maxX: 1, minY: -1, maxY: 1 });

    this.#tooltip = document.createElement('div');
    this.#tooltip.className = 'tooltip';
    this.#tooltip.hidden = true;
    host.append(this.#tooltip);

    this.layer.onDraw(() => this.#render());
    this.#bind();
  }

  /**
   * The off-view and unprojected counts are produced by the render pass, and the view can
   * change without the store changing — zooming, panning, resetting. Anything displaying those
   * counts has to be told by the renderer, or it goes stale the moment the user scrolls.
   */
  onAfterRender(callback: () => void): void {
    this.#afterRender = callback;
  }

  /**
   * Fixed per basis, so filtering never rescales the axes, and robust rather than absolute.
   *
   * The frame comes from the analysis layer, not from this panel, because the agent's ASCII
   * digest of the same scatter must use the identical frame. If the two disagreed, "where the
   * selection sits" would mean two different things to the two parties looking at it.
   */
  extentFor(basis: string): Extent {
    const cached = this.#extents.get(basis);
    if (cached) return cached;
    const data = this.#store.dataset;
    const axes = data?.pcs[basis];
    if (!data || !axes) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    const extent = robustExtent(axes[0], axes[1]);
    this.#extents.set(basis, extent);
    return extent;
  }

  /**
   * Counted from the render pass rather than against the extent, so it is the number actually
   * not on screen — which is the number the user is being told about.
   */
  get offFrameCount(): number {
    return this.#offFrame;
  }

  get unprojectedCount(): number {
    return this.#unprojected;
  }

  /**
   * This is what "165 outside this frame" has to offer, because panning cannot get there: the
   * frame is pinned to the canvas, so reaching outside it means shrinking it.
   */
  fitAll(): void {
    const store = this.#store;
    const x = store.pc(0);
    const y = store.pc(1);
    if (!x || !y) return;
    this.view.width = this.layer.width;
    this.view.height = this.layer.height;
    this.view.extent = this.extentFor(store.basis);
    this.view.reset();

    const cx = this.layer.width / 2;
    const cy = this.layer.height / 2;
    let worst = 1;
    for (const i of store.visible) {
      if (Number.isNaN(x[i])) continue;
      const dx = Math.abs(this.view.toScreenX(x[i]) - cx) / Math.max(1, cx - 8);
      const dy = Math.abs(this.view.toScreenY(y[i]) - cy) / Math.max(1, cy - 8);
      if (dx > worst) worst = dx;
      if (dy > worst) worst = dy;
    }
    this.view.scale = Math.max(MIN_SCALE, 1 / worst);
    this.view.offsetX = 0;
    this.view.offsetY = 0;
    this.layer.schedule();
  }

  refresh(): void {
    this.view.extent = this.extentFor(this.#store.basis);
    this.layer.schedule();
  }

  invalidateData(): void {
    this.#extents.clear();
    this.refresh();
  }

  resetView(): void {
    this.view.reset();
    this.layer.schedule();
  }

  get viewState(): { scale: number; offsetX: number; offsetY: number } {
    return { scale: this.view.scale, offsetX: this.view.offsetX, offsetY: this.view.offsetY };
  }

  restoreView(state: Partial<{ scale: number; offsetX: number; offsetY: number }>): void {
    if (Number.isFinite(state.scale)) this.view.scale = Math.max(MIN_SCALE, Math.min(40, Number(state.scale)));
    if (Number.isFinite(state.offsetX)) this.view.offsetX = Number(state.offsetX);
    if (Number.isFinite(state.offsetY)) this.view.offsetY = Number(state.offsetY);
    this.view.clamp();
    this.layer.schedule();
  }

  #bind(): void {
    const canvas = this.layer.canvas;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (event) => {
      // Secondary buttons are for the context menu; without this guard a right-click starts a
      // drag, and its release is then read as a click that re-selects whatever sits under the
      // cursor — which is exactly why right-click appeared not to clear anything.
      if (event.button !== 0 && event.button !== 1) return;
      capture(canvas, event.pointerId);
      const point = this.#local(event);
      if (this.#isSecondClick(point) || event.shiftKey || event.button === 1) {
        this.#dragging = 'pan';
        this.#lastPointer = point;
        canvas.style.cursor = 'grabbing';
      } else {
        this.#dragging = 'lasso';
        this.#lasso = [point.x, point.y];
      }
      this.#tooltip.hidden = true;
    });

    canvas.addEventListener('pointermove', (event) => {
      const point = this.#local(event);
      if (this.#dragging === 'lasso') {
        const n = this.#lasso.length;
        // Thin the path: a freehand lasso emits far more points than the hit test needs.
        if (
          n < 2 ||
          Math.hypot(point.x - this.#lasso[n - 2], point.y - this.#lasso[n - 1]) > 3
        ) {
          this.#lasso.push(point.x, point.y);
          this.layer.schedule();
        }
        return;
      }
      if (this.#dragging === 'pan' && this.#lastPointer) {
        this.view.panBy(point.x - this.#lastPointer.x, point.y - this.#lastPointer.y);
        this.#lastPointer = point;
        this.layer.schedule();
        return;
      }
      this.#queueHover(point);
    });

    canvas.addEventListener('pointerup', (event) => {
      release(canvas, event.pointerId);
      this.#rememberClick(this.#local(event));
      if (this.#dragging === 'lasso') {
        const path = this.#lasso;
        this.#lasso = [];
        this.#dragging = null;
        if (path.length >= 8) this.#onLasso(this.#hitTest(path));
        else this.#clickSelect(this.#local(event));
        this.layer.schedule();
        return;
      }
      this.#dragging = null;
      this.#lastPointer = null;
      canvas.style.cursor = 'crosshair';
    });

    // Right-click is the explicit way to drop a selection. Clicking empty space deliberately
    // does not: with pan latched onto double-click, that would throw the selection away on
    // the first half of the gesture.
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.#onClearSelection();
    });

    canvas.addEventListener('pointerleave', () => {
      this.#hovered = null;
      this.#tooltip.hidden = true;
      this.layer.schedule();
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const point = this.#local(event);
        // The view only learns the canvas size during a render, and a wheel can arrive first.
        this.view.width = this.layer.width;
        this.view.height = this.layer.height;
        this.view.zoomAt(point.x, point.y, wheelFactor(event));
        this.layer.schedule();
      },
      { passive: false },
    );

  }

  #local(event: MouseEvent): { x: number; y: number } {
    const box = this.layer.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  #rememberClick(point: { x: number; y: number }): void {
    this.#lastUpAt = performance.now();
    this.#lastUpPoint = point;
  }

  /**
   * Panning is double-click-and-hold rather than a latched mode: holding shift through a long
   * exploration is tiring, but a mode the user has to enter and leave is worse — it has to be
   * announced, remembered and escaped. This gesture needs none of that.
   */
  #isSecondClick(point: { x: number; y: number }): boolean {
    if (performance.now() - this.#lastUpAt > DOUBLE_CLICK_MS) return false;
    return Math.hypot(point.x - this.#lastUpPoint.x, point.y - this.#lastUpPoint.y)
      < DOUBLE_CLICK_SLOP_PX;
  }

  /** Coalesce hover onto one animation frame; pointermove fires far more often than that. */
  #queueHover(point: { x: number; y: number }): void {
    this.#hoverPending = point;
    if (this.#hoverQueued) return;
    this.#hoverQueued = true;
    requestAnimationFrame(() => {
      this.#hoverQueued = false;
      const pending = this.#hoverPending;
      if (pending) this.#updateHover(pending);
    });
  }

  #hitTest(path: number[]): number[] {
    const store = this.#store;
    const x = store.pc(0);
    const y = store.pc(1);
    if (!x || !y) return [];
    this.view.width = this.layer.width;
    this.view.height = this.layer.height;
    const found: number[] = [];
    for (const i of store.visible) {
      const px = x[i];
      const py = y[i];
      if (Number.isNaN(px) || Number.isNaN(py)) continue;
      if (insidePolygon(path, this.view.toScreenX(px), this.view.toScreenY(py))) found.push(i);
    }
    return found;
  }

  /** A larger hit target keeps small canvas marks usable. */
  #nearest(point: { x: number; y: number }): number | null {
    return this.#index.nearest(point.x, point.y, HOVER_RADIUS_PX);
  }

  #clickSelect(point: { x: number; y: number }): void {
    const hit = this.#nearest(point);
    if (hit !== null) this.#onLasso([hit]);
  }

  #updateHover(point: { x: number; y: number }): void {
    const hit = this.#nearest(point);
    if (hit === this.#hovered) {
      if (hit !== null) this.#placeTooltip(point);
      return;
    }
    this.#hovered = hit;
    if (hit === null) {
      this.#tooltip.hidden = true;
    } else {
      const store = this.#store;
      const ancient = store.dataset?.isAncient[hit] === 1;
      const age = ancient ? `${store.dataset?.dateBP[hit]} BP` : 'present-day';
      this.#tooltip.innerHTML = '';
      const id = document.createElement('strong');
      id.textContent = store.dataset?.geneticId[hit] ?? '';
      const meta = document.createElement('span');
      meta.textContent = `${store.label('group', hit)} · ${age}`;
      this.#tooltip.append(id, meta);
      this.#tooltip.hidden = false;
      this.#placeTooltip(point);
    }
    this.layer.schedule();
  }

  #placeTooltip(point: { x: number; y: number }): void {
    const flip = point.x > this.layer.width - 220;
    this.#tooltip.style.left = `${flip ? point.x - 12 : point.x + 14}px`;
    this.#tooltip.style.top = `${Math.max(6, point.y - 12)}px`;
    this.#tooltip.style.transform = flip ? 'translateX(-100%)' : 'none';
  }

  #render(): void {
    const store = this.#store;
    const colours = palette();
    const context = this.layer.context;
    this.view.width = this.layer.width;
    this.view.height = this.layer.height;
    this.view.extent = this.extentFor(store.basis);
    this.layer.clear(colours.surface);

    const x = store.pc(0);
    const y = store.pc(1);
    if (!x || !y) return;

    this.#drawAxes(context, colours);

    const data = store.dataset;
    if (!data) return;
    const selection = store.selection;
    const comparison = store.comparisonSets;
    const compared = (index: number): boolean =>
      comparison?.a.has(index) === true || comparison?.b.has(index) === true;

    // Present-day reference individuals first and recessive: they are the frame the ancient
    // samples are read against, not a series competing for attention.
    this.#index.begin(this.layer.width, this.layer.height, store.visible.length);
    this.#offFrame = 0;
    this.#unprojected = 0;

    context.fillStyle = colours.present;
    for (const i of store.visible) {
      if (data.isAncient[i] === 1 || selection.has(i) || compared(i)) continue;
      const px = x[i];
      if (Number.isNaN(px)) {
        this.#unprojected++;
        continue;
      }
      const sx = this.view.toScreenX(px);
      const sy = this.view.toScreenY(y[i]);
      if (!this.#index.add(i, sx, sy)) {
        this.#offFrame++;
        continue;
      }
      context.beginPath();
      context.arc(sx, sy, POINT_RADIUS, 0, Math.PI * 2);
      context.fill();
    }

    // Batching by age band avoids changing canvas state once per point.

    const banded: number[][] = AGE_BANDS.map(() => []);
    for (const i of store.visible) {
      if (data.isAncient[i] === 0 || selection.has(i) || compared(i)) continue;
      if (Number.isNaN(x[i])) {
        this.#unprojected++;
        continue;
      }
      banded[ageBand(data.dateBP[i])].push(i);
    }
    for (const [band, members] of banded.entries()) {
      context.fillStyle = colours.age[band];
      for (const i of members) {
        const sx = this.view.toScreenX(x[i]);
        const sy = this.view.toScreenY(y[i]);
        if (!this.#index.add(i, sx, sy)) {
          this.#offFrame++;
          continue;
        }
        context.beginPath();
        context.arc(sx, sy, POINT_RADIUS, 0, Math.PI * 2);
        context.fill();
      }
    }

    if (comparison) {
      const drawComparison = (members: Set<number>, colour: string, radius: number): void => {
        context.fillStyle = colour;
        context.strokeStyle = colours.surface;
        context.lineWidth = 1.5;
        for (const i of members) {
          if (Number.isNaN(x[i])) continue;
          const sx = this.view.toScreenX(x[i]);
          const sy = this.view.toScreenY(y[i]);
          this.#index.add(i, sx, sy);
          context.beginPath();
          context.arc(sx, sy, radius, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      };
      drawComparison(comparison.b, colours.compareB, SELECTED_RADIUS + 1.4);
      drawComparison(comparison.a, colours.compareA, SELECTED_RADIUS);
    }

    // The selection last, larger, and ringed in the surface colour so it separates from the
    // cloud it sits inside.
    if (selection.size > 0) {
      context.lineWidth = 2;
      context.strokeStyle = colours.surface;
      context.fillStyle = colours.accent;
      for (const i of selection) {
        const px = x[i];
        if (Number.isNaN(px)) continue;
        const sx = this.view.toScreenX(px);
        const sy = this.view.toScreenY(y[i]);
        this.#index.add(i, sx, sy);
        context.beginPath();
        context.arc(sx, sy, SELECTED_RADIUS, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }

    if (store.focused !== null && !Number.isNaN(x[store.focused])) {
      const sx = this.view.toScreenX(x[store.focused]);
      const sy = this.view.toScreenY(y[store.focused]);
      context.strokeStyle = colours.focus;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(sx, sy, 9, 0, Math.PI * 2);
      context.stroke();
    }

    if (this.#hovered !== null && !Number.isNaN(x[this.#hovered])) {
      context.strokeStyle = colours.textPrimary;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(
        this.view.toScreenX(x[this.#hovered]),
        this.view.toScreenY(y[this.#hovered]),
        6,
        0,
        Math.PI * 2,
      );
      context.stroke();
    }

    if (this.#lasso.length >= 4) {
      context.strokeStyle = colours.accent;
      context.lineWidth = 1.5;
      context.setLineDash([5, 4]);
      context.beginPath();
      context.moveTo(this.#lasso[0], this.#lasso[1]);
      for (let p = 2; p < this.#lasso.length; p += 2) {
        context.lineTo(this.#lasso[p], this.#lasso[p + 1]);
      }
      context.closePath();
      context.stroke();
      context.setLineDash([]);
    }

    this.#afterRender?.();
  }

  #drawAxes(context: CanvasRenderingContext2D, colours: ReturnType<typeof palette>): void {
    const zeroX = this.view.toScreenX(0);
    const zeroY = this.view.toScreenY(0);
    context.strokeStyle = colours.gridline;
    context.lineWidth = 1;
    context.beginPath();
    if (zeroX > 0 && zeroX < this.layer.width) {
      context.moveTo(zeroX, 0);
      context.lineTo(zeroX, this.layer.height);
    }
    if (zeroY > 0 && zeroY < this.layer.height) {
      context.moveTo(0, zeroY);
      context.lineTo(this.layer.width, zeroY);
    }
    context.stroke();

    context.fillStyle = colours.textMuted;
    context.font = '11px ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'right';
    context.fillText('PC1', this.layer.width - 8, this.layer.height - 8);
    context.save();
    context.translate(10, 8);
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText('PC2', 0, 0);
    context.restore();
  }
}
