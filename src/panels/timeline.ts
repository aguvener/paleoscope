import { ageBand } from '../analysis.ts';
import type { Store } from '../store.ts';
import { palette } from '../theme.ts';
import { Layer, ScreenIndex, capture, release, wheelFactor } from './canvas.ts';

/**
 * It used to be a histogram, which read the distribution well but could not show a selection —
 * a bar is an aggregate, and the whole point of this workbench is that a selection made in one
 * panel shows up in the others. So every individual is a dot here too, exactly as in the map
 * and the scatter, and density reads as crowding in all three.
 *
 * A stacked dot-histogram was the obvious alternative, but the densest bins dwarf the sparse
 * ones until the latter become sub-pixel marks. Instead the dots are spread over the full
 * height with a deterministic vertical offset, and the count profile is preserved as a
 * recessive silhouette behind them.
 *
 * Ages run 0 to 12000 BP in the main axis. The older tail is sparse, so giving it equal axis
 * space would squash the Holocene where nearly all the data lives. Those get a separated
 * gutter on the right, and present-day individuals — who have no age at all — get one on the
 * left, so that whatever the user selects is visible somewhere.
 */
const DOMAIN_MAX = 12_000;
const BUCKET = 150;
const BUCKETS = DOMAIN_MAX / BUCKET;

const AXIS_HEIGHT = 22;
const PAD_LEFT = 12;
const PAD_RIGHT = 26;
const GUTTER = 20;
const GUTTER_GAP = 16;
const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 4;

const DOT_RADIUS = 1.8;
const SELECTED_RADIUS = 3.3;
const HOVER_RADIUS_PX = 12;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_SLOP_PX = 8;
/** Below this the axis says more about rounding than about time. */
const MIN_SPAN_YEARS = 100;
/**
 * Ages are years before 1950 CE, so an individual sampled after that is legitimately
 * negative — `Khwit.SG` (Georgia_Tkhina_20thCentury) sits at -4. Clamping to zero keeps them
 * on the axis; without it they fell outside the domain and were silently dropped, and the
 * bucket index went negative, which a typed array ignores without complaint.
 */
const clampAge = (age: number): number => Math.max(0, age);
const TICK_STEPS = [25, 50, 100, 250, 500, 1000, 2000, 5000] as const;

/**
 * Deterministic on purpose. Real jitter would make every dot jump on each repaint, so a point
 * would move when the data around it changed and the user would lose track of what they were
 * looking at — the same reason the scatter's axes are fixed.
 */
function offsetFor(index: number): number {
  const scrambled = Math.imul(index ^ 0x9e37_79b9, 0x85eb_ca6b) >>> 0;
  return ((scrambled ^ (scrambled >>> 15)) >>> 0) / 4_294_967_296;
}

type Lane = 'present' | 'main' | 'older';

export class TimelinePanel {
  readonly layer: Layer;

  #store: Store;
  #tooltip: HTMLElement;
  #counts = new Int32Array(BUCKETS);
  #peak = 1;
  #dated = 0;
  #brush: { x0: number; x1: number } | null = null;
  #dragging: 'brush' | 'pan' | null = null;
  #lastPointer: { x: number; y: number } | null = null;
  #lastUpAt = 0;
  #lastUpPoint = { x: 0, y: 0 };
  #viewFrom = 0;
  #viewTo = DOMAIN_MAX;
  #hovered: number | null = null;
  #index = new ScreenIndex(22);
  #hoverPending: { x: number; y: number } | null = null;
  #hoverQueued = false;
  #onRange: (range: [number, number] | null) => void;
  #onClearSelection: () => void;

  constructor(
    host: HTMLElement,
    store: Store,
    handlers: {
      onRange: (range: [number, number] | null) => void;
      onClearSelection: () => void;
    },
  ) {
    this.#store = store;
    this.#onRange = handlers.onRange;
    this.#onClearSelection = handlers.onClearSelection;
    this.layer = new Layer(host);
    this.#tooltip = document.createElement('div');
    this.#tooltip.className = 'tooltip';
    this.#tooltip.hidden = true;
    host.append(this.#tooltip);
    this.layer.onDraw(() => this.#render());
    this.#bind();
  }

  refresh(): void {
    const data = this.#store.dataset;
    this.#counts.fill(0);
    this.#peak = 1;
    this.#dated = 0;
    if (data) {
      for (const i of this.#store.visible) {
        if (data.isAncient[i] === 0) continue;
        this.#dated++;
        const age = clampAge(data.dateBP[i]);
        if (age >= DOMAIN_MAX) continue;
        this.#counts[Math.min(BUCKETS - 1, Math.floor(age / BUCKET))]++;
      }
      for (const count of this.#counts) if (count > this.#peak) this.#peak = count;
    }
    this.layer.schedule();
  }

  // --- geometry -------------------------------------------------------------

  get #plotHeight(): number {
    return Math.max(1, this.layer.height - AXIS_HEIGHT);
  }

  get #mainX(): number {
    return PAD_LEFT + GUTTER + GUTTER_GAP;
  }

  get #mainWidth(): number {
    return Math.max(1, this.layer.width - PAD_RIGHT - GUTTER - GUTTER_GAP - this.#mainX);
  }

  get #olderX(): number {
    return this.#mainX + this.#mainWidth + GUTTER_GAP;
  }

  get #span(): number {
    return Math.max(1, this.#viewTo - this.#viewFrom);
  }

  #ageToX(age: number): number {
    return this.#mainX + ((age - this.#viewFrom) / this.#span) * this.#mainWidth;
  }

  #xToAge(px: number): number {
    const ratio = (px - this.#mainX) / this.#mainWidth;
    return Math.max(this.#viewFrom, Math.min(this.#viewTo, this.#viewFrom + ratio * this.#span));
  }

  resetView(): void {
    this.#viewFrom = 0;
    this.#viewTo = DOMAIN_MAX;
    this.layer.schedule();
  }

  get viewState(): { fromBP: number; toBP: number } {
    return { fromBP: this.#viewFrom, toBP: this.#viewTo };
  }

  restoreView(state: Partial<{ fromBP: number; toBP: number }>): void {
    const from = Number(state.fromBP);
    const to = Number(state.toBP);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    this.#setView(from, to - from);
  }

  #setView(from: number, span: number): void {
    const width = Math.max(MIN_SPAN_YEARS, Math.min(DOMAIN_MAX, span));
    let start = from;
    if (start < 0) start = 0;
    if (start + width > DOMAIN_MAX) start = DOMAIN_MAX - width;
    this.#viewFrom = start;
    this.#viewTo = start + width;
    this.layer.schedule();
  }

  /**
   * Individuals outside the visible slice must not be drawn: the gutters sit either side of
   * the main lane, and an out-of-range age projects straight onto them.
   */
  #isDrawable(index: number): boolean {
    const data = this.#store.dataset;
    if (!data) return false;
    if (data.isAncient[index] === 0) return true;
    const age = clampAge(data.dateBP[index]);
    if (age >= DOMAIN_MAX) return true;
    return age >= this.#viewFrom && age <= this.#viewTo;
  }

  #laneFor(index: number): Lane {
    const data = this.#store.dataset!;
    if (data.isAncient[index] === 0) return 'present';
    return data.dateBP[index] >= DOMAIN_MAX ? 'older' : 'main';
  }

  #positionOf(index: number): { x: number; y: number } {
    const data = this.#store.dataset!;
    const lane = this.#laneFor(index);
    const spread = offsetFor(index);
    const x = lane === 'main'
      ? this.#ageToX(clampAge(data.dateBP[index]))
      : (lane === 'present' ? PAD_LEFT : this.#olderX) + 2 + spread * (GUTTER - 4);
    const vertical = offsetFor(index * 2 + 1);
    const top = TOP_MARGIN;
    const usable = Math.max(1, this.#plotHeight - top - BOTTOM_MARGIN);
    return { x, y: top + vertical * usable };
  }

  // --- interaction ----------------------------------------------------------

  #bind(): void {
    const canvas = this.layer.canvas;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      capture(canvas, event.pointerId);
      const point = this.#local(event);
      if (this.#isSecondClick(point) || event.shiftKey || event.button === 1) {
        this.#dragging = 'pan';
        this.#lastPointer = point;
        canvas.style.cursor = 'grabbing';
      } else {
        this.#dragging = 'brush';
        this.#brush = { x0: point.x, x1: point.x };
      }
      this.#tooltip.hidden = true;
      this.layer.schedule();
    });

    canvas.addEventListener('pointermove', (event) => {
      const point = this.#local(event);
      if (this.#dragging === 'brush' && this.#brush) {
        this.#brush.x1 = point.x;
        this.layer.schedule();
        return;
      }
      if (this.#dragging === 'pan' && this.#lastPointer) {
        const perPx = this.#span / this.#mainWidth;
        this.#setView(this.#viewFrom - (point.x - this.#lastPointer.x) * perPx, this.#span);
        this.#lastPointer = point;
        return;
      }
      this.#queueHover(point);
    });

    canvas.addEventListener('pointerup', (event) => {
      release(canvas, event.pointerId);
      this.#rememberClick(this.#local(event));
      canvas.style.cursor = 'crosshair';
      const wasPanning = this.#dragging === 'pan';
      this.#dragging = null;
      this.#lastPointer = null;
      const brush = this.#brush;
      this.#brush = null;
      if (wasPanning || !brush) return;
      if (Math.abs(brush.x1 - brush.x0) < 5) {
        this.#onRange(null);
      } else {
        const a = this.#xToAge(Math.min(brush.x0, brush.x1));
        const b = this.#xToAge(Math.max(brush.x0, brush.x1));
        this.#onRange([Math.round(a), Math.round(b)]);
      }
      this.layer.schedule();
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const point = this.#local(event);
        const anchor = this.#xToAge(point.x);
        const before = this.#span;
        const span = before / wheelFactor(event);
        const fraction = (anchor - this.#viewFrom) / before;
        this.#setView(anchor - fraction * span, span);
      },
      { passive: false },
    );

    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.#onClearSelection();
    });

    canvas.addEventListener('pointerleave', () => {
      this.#hovered = null;
      this.#tooltip.hidden = true;
      this.layer.schedule();
    });
  }

  #local(event: MouseEvent): { x: number; y: number } {
    const box = this.layer.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  #rememberClick(point: { x: number; y: number }): void {
    this.#lastUpAt = performance.now();
    this.#lastUpPoint = point;
  }

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

  #nearest(point: { x: number; y: number }): number | null {
    return this.#index.nearest(point.x, point.y, HOVER_RADIUS_PX);
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
      const data = store.dataset!;
      this.#tooltip.innerHTML = '';
      const id = document.createElement('strong');
      id.textContent = data.geneticId[hit];
      const meta = document.createElement('span');
      const age = data.isAncient[hit] === 1
        ? data.fullDate[hit] || `${data.dateBP[hit].toLocaleString()} BP`
        : 'present-day';
      meta.textContent = `${store.label('group', hit)} · ${age}`;
      this.#tooltip.append(id, meta);
      this.#tooltip.hidden = false;
      this.#placeTooltip(point);
    }
    this.layer.schedule();
  }

  #placeTooltip(point: { x: number; y: number }): void {
    const flip = point.x > this.layer.width - 240;
    this.#tooltip.style.left = `${flip ? point.x - 12 : point.x + 14}px`;
    this.#tooltip.style.top = '4px';
    this.#tooltip.style.transform = flip ? 'translateX(-100%)' : 'none';
  }

  // --- rendering ------------------------------------------------------------

  #render(): void {
    const colours = palette();
    const context = this.layer.context;
    const store = this.#store;
    this.layer.clear(colours.surface);

    const height = this.#plotHeight;
    const data = store.dataset;
    if (!data) return;

    // The active time filter, shaded so an agent-applied range is as visible as a hand-drawn one.
    const range = store.filter.dateBP;
    if (range) {
      context.fillStyle = colours.gridline;
      const from = this.#ageToX(range[0]);
      const to = this.#ageToX(range[1]);
      context.fillRect(from, 0, Math.max(2, to - from), height);
    }

    this.#drawGutters(context, colours, height);
    this.#drawDots(context, colours);
    // Drawing behind a dense cloud would make the overlay disappear.
    this.#drawProfile(context, colours, height);
    this.#drawAxis(context, colours, height);

    if (this.#brush) {
      const from = Math.min(this.#brush.x0, this.#brush.x1);
      const width = Math.abs(this.#brush.x1 - this.#brush.x0);
      context.fillStyle = colours.accent;
      context.globalAlpha = 0.16;
      context.fillRect(from, 0, width, height);
      context.globalAlpha = 1;
      context.strokeStyle = colours.accent;
      context.lineWidth = 1.5;
      context.strokeRect(from, 0, width, height);
    }
  }

  /**
   * Spreading individuals across the full height means crowding carries density horizontally
   * but not vertically, and in the dense Holocene the band simply saturates. This line puts
   * the exact profile the old histogram showed back on screen, without hiding a single dot.
   */
  #drawProfile(
    context: CanvasRenderingContext2D,
    colours: ReturnType<typeof palette>,
    height: number,
  ): void {
    const first = Math.max(0, Math.floor(this.#viewFrom / BUCKET));
    const last = Math.min(BUCKETS - 1, Math.ceil(this.#viewTo / BUCKET));

    // Scale to the tallest bucket *in view*, so zooming into a quiet stretch of the axis
    // still fills the panel instead of flattening against the Holocene peak.
    let peak = 1;
    for (let bucket = first; bucket <= last; bucket++) {
      if (this.#counts[bucket] > peak) peak = this.#counts[bucket];
    }

    context.beginPath();
    for (let bucket = first; bucket <= last; bucket++) {
      const y = height - (this.#counts[bucket] / peak) * (height - TOP_MARGIN);
      const x = this.#ageToX(bucket * BUCKET + BUCKET / 2);
      if (bucket === first) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = colours.textPrimary;
    context.globalAlpha = 0.5;
    context.lineWidth = 1.5;
    context.lineJoin = 'round';
    context.stroke();
    context.globalAlpha = 1;
  }

  #drawGutters(
    context: CanvasRenderingContext2D,
    colours: ReturnType<typeof palette>,
    height: number,
  ): void {
    context.strokeStyle = colours.gridline;
    context.lineWidth = 1;
    context.setLineDash([2, 3]);
    for (const x of [PAD_LEFT + GUTTER + GUTTER_GAP / 2, this.#olderX - GUTTER_GAP / 2]) {
      context.beginPath();
      context.moveTo(x, 2);
      context.lineTo(x, height - 2);
      context.stroke();
    }
    context.setLineDash([]);
  }

  #drawDots(context: CanvasRenderingContext2D, colours: ReturnType<typeof palette>): void {
    const store = this.#store;
    const data = store.dataset!;
    const selection = store.selection;
    const comparison = store.comparisonSets;
    const compared = (index: number): boolean =>
      comparison?.a.has(index) === true || comparison?.b.has(index) === true;

    // Present-day individuals first and recessive, then ancient batched by age band so each
    // fill style is set a handful of times rather than once per dot.
    const bands: number[][] = colours.age.map(() => []);
    const present: number[] = [];
    for (const i of store.visible) {
      if (selection.has(i) || compared(i) || !this.#isDrawable(i)) continue;
      if (data.isAncient[i] === 0) present.push(i);
      else bands[ageBand(data.dateBP[i])].push(i);
    }

    // Partial alpha so overlapping dots accumulate into visible density rather than a flat
    // block of colour. The selection below is drawn at full opacity.
    this.#index.begin(this.layer.width, this.layer.height, store.visible.length);

    context.globalAlpha = 0.62;
    context.fillStyle = colours.present;
    for (const i of present) this.#dot(context, i, DOT_RADIUS);

    for (const [band, members] of bands.entries()) {
      context.fillStyle = colours.age[band];
      for (const i of members) this.#dot(context, i, DOT_RADIUS);
    }
    context.globalAlpha = 1;

    if (comparison) {
      const drawComparison = (members: Set<number>, colour: string, radius: number): void => {
        context.fillStyle = colour;
        context.strokeStyle = colours.surface;
        context.lineWidth = 1.5;
        for (const i of members) {
          if (!this.#isDrawable(i)) continue;
          const at = this.#positionOf(i);
          this.#index.add(i, at.x, at.y);
          context.beginPath();
          context.arc(at.x, at.y, radius, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      };
      drawComparison(comparison.b, colours.compareB, SELECTED_RADIUS + 1.4);
      drawComparison(comparison.a, colours.compareA, SELECTED_RADIUS);
    }

    context.strokeStyle = colours.accent;
    context.lineWidth = 1;
    for (const i of selection) {
      if (data.isAncient[i] === 0 || data.dateSD[i] < 0) continue;
      const age = data.dateBP[i];
      if (age < this.#viewFrom || age > this.#viewTo) continue;
      const at = this.#positionOf(i);
      context.beginPath();
      context.moveTo(this.#ageToX(Math.max(this.#viewFrom, age - data.dateSD[i])), at.y);
      context.lineTo(this.#ageToX(Math.min(this.#viewTo, age + data.dateSD[i])), at.y);
      context.stroke();
    }

    // The selection last, larger, and ringed in the surface colour — this is the whole reason
    // the panel draws individuals rather than bars.
    if (selection.size > 0) {
      context.lineWidth = 2;
      context.strokeStyle = colours.surface;
      context.fillStyle = colours.accent;
      for (const i of selection) {
        if (!this.#isDrawable(i)) continue;
        const at = this.#positionOf(i);
        this.#index.add(i, at.x, at.y);
        context.beginPath();
        context.arc(at.x, at.y, SELECTED_RADIUS, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }

    if (store.focused !== null && this.#isDrawable(store.focused)) {
      const at = this.#positionOf(store.focused);
      context.strokeStyle = colours.focus;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(at.x, at.y, 8, 0, Math.PI * 2);
      context.stroke();
    }

    if (this.#hovered !== null && this.#isDrawable(this.#hovered)) {
      const at = this.#positionOf(this.#hovered);
      context.strokeStyle = colours.textPrimary;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(at.x, at.y, 6, 0, Math.PI * 2);
      context.stroke();
    }
  }

  #dot(context: CanvasRenderingContext2D, index: number, radius: number): void {
    const at = this.#positionOf(index);
    if (!this.#index.add(index, at.x, at.y)) return;
    context.beginPath();
    context.arc(at.x, at.y, radius, 0, Math.PI * 2);
    context.fill();
  }

  #drawAxis(
    context: CanvasRenderingContext2D,
    colours: ReturnType<typeof palette>,
    height: number,
  ): void {
    context.strokeStyle = colours.axis;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height + 0.5);
    context.lineTo(this.layer.width, height + 0.5);
    context.stroke();

    context.fillStyle = colours.textMuted;
    context.font = '11px ui-sans-serif, system-ui, sans-serif';
    context.textBaseline = 'top';
    context.textAlign = 'center';

    // The gutter labels own the ends of the axis; a gridline label within reach is dropped
    // rather than allowed to collide with them.
    const nowCentre = PAD_LEFT + GUTTER / 2;
    const olderCentre = this.#olderX + GUTTER / 2;

    const target = this.#span / 6;
    const step = TICK_STEPS.find((candidate) => candidate >= target) ?? 5000;
    const start = Math.ceil(this.#viewFrom / step) * step;
    for (let age = start; age <= this.#viewTo; age += step) {
      const x = this.#ageToX(age);
      context.beginPath();
      context.moveTo(x, height);
      context.lineTo(x, height + 4);
      context.stroke();
      if (Math.abs(x - olderCentre) < 26 || Math.abs(x - nowCentre) < 26) continue;
      const label = age === 0
        ? '0'
        : step >= 1000 ? `${age / 1000}k` : age.toLocaleString();
      context.fillText(label, x, height + 6);
    }
    context.fillText('now', nowCentre, height + 6);
    context.fillText('older', olderCentre, height + 6);

    context.textAlign = 'left';
    const zoomed = this.#viewFrom > 0 || this.#viewTo < DOMAIN_MAX;
    context.fillText(
      zoomed
        ? `${Math.round(this.#viewFrom).toLocaleString()}-${Math.round(this.#viewTo).toLocaleString()} BP`
        : `${this.#dated.toLocaleString()} dated · years BP`,
      4,
      2,
    );
  }
}
