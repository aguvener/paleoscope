import { invalidatePalette } from '../theme.ts';

/** Zooming out below this stops being legible. */
export const MIN_SCALE = 0.05;

export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class View {
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  constructor(
    public extent: Extent,
    public width = 1,
    public height = 1,
    public padding = 26,
  ) {}

  reset(): void {
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  /**
   * The extent is fixed for the lifetime of a basis: if filtering rescaled the axes, a point
   * would move when the data around it changed, and both the human's mental map and the
   * agent's "focus on this sample" would stop meaning anything.
   */
  toScreenX(x: number): number {
    const { minX, maxX } = this.extent;
    const span = maxX - minX || 1;
    const base = this.padding + ((x - minX) / span) * (this.width - this.padding * 2);
    return (base - this.width / 2) * this.scale + this.width / 2 + this.offsetX;
  }

  toScreenY(y: number): number {
    const { minY, maxY } = this.extent;
    const span = maxY - minY || 1;
    const base =
      this.height - this.padding - ((y - minY) / span) * (this.height - this.padding * 2);
    return (base - this.height / 2) * this.scale + this.height / 2 + this.offsetY;
  }

  toDataX(px: number): number {
    const { minX, maxX } = this.extent;
    const span = maxX - minX || 1;
    const base = (px - this.width / 2 - this.offsetX) / this.scale + this.width / 2;
    return minX + ((base - this.padding) / (this.width - this.padding * 2)) * span;
  }

  toDataY(py: number): number {
    const { minY, maxY } = this.extent;
    const span = maxY - minY || 1;
    const base = (py - this.height / 2 - this.offsetY) / this.scale + this.height / 2;
    return minY + ((this.height - this.padding - base) / (this.height - this.padding * 2)) * span;
  }

  zoomAt(px: number, py: number, factor: number): void {
    // Scales below 1 shrink the frame inside the canvas, which is the only way to reach the
    // individuals that sit outside the percentile extent. Clamping the floor at 1 made them
    // permanently unreachable, since the pan slack below is zero at scale 1.
    const next = Math.min(40, Math.max(MIN_SCALE, this.scale * factor));
    if (next === this.scale) return;
    const ratio = next / this.scale;
    // The projection scales about the canvas centre, so the anchor has to be expressed
    // relative to the centre too. Using the raw pointer position instead left an error of
    // (width/2)(1 - ratio) on each axis, which is negative when zooming in — so every zoom
    // crept toward the bottom-right regardless of where the cursor was.
    const anchorX = px - this.width / 2;
    const anchorY = py - this.height / 2;
    this.offsetX = anchorX - (anchorX - this.offsetX) * ratio;
    this.offsetY = anchorY - (anchorY - this.offsetY) * ratio;
    this.scale = next;
    this.clamp();
  }

  panBy(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
    this.clamp();
  }

  /**
   * The slack is floored at zero: when zoomed out past 1 the frame is smaller than the canvas,
   * and a negative slack would invert the clamp and fling the view away.
   */
  clamp(): void {
    const slackX = Math.max(0, ((this.scale - 1) * this.width) / 2);
    const slackY = Math.max(0, ((this.scale - 1) * this.height) / 2);
    this.offsetX = Math.min(slackX, Math.max(-slackX, this.offsetX));
    this.offsetY = Math.min(slackY, Math.max(-slackY, this.offsetY));
  }
}

export class Layer {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  width = 1;
  height = 1;

  #draw: () => void = () => {};
  #queued = false;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'layer';
    host.append(this.canvas);
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('This browser did not provide a 2D canvas context.');
    this.context = context;

    new ResizeObserver(() => this.#resize()).observe(host);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      invalidatePalette();
      this.schedule();
    });
    // A background tab may miss its first scheduled paint, so retry when it becomes visible.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.schedule();
    });
    this.#resize();
  }

  onDraw(draw: () => void): void {
    this.#draw = draw;
    this.schedule();
  }

  /**
   * A hidden tab is served no animation frames, so a page opened in a background tab would
   * request a first paint that never arrives and sit blank until something resized it. Drawing
   * to a canvas works perfectly well while hidden — only the frame callback is throttled — so
   * when the page is not visible the paint is coalesced onto a microtask instead. The visible
   * path still uses `requestAnimationFrame`, which is what keeps panning and zooming smooth.
   */
  schedule(): void {
    if (this.#queued) return;
    this.#queued = true;
    if (document.visibilityState === 'visible') {
      requestAnimationFrame(() => {
        this.#queued = false;
        this.#draw();
      });
    } else {
      queueMicrotask(() => {
        this.#queued = false;
        this.#draw();
      });
    }
  }

  #resize(): void {
    const host = this.canvas.parentElement;
    if (!host) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(host.clientWidth));
    const height = Math.max(1, Math.floor(host.clientHeight));
    this.width = width;
    this.height = height;
    this.canvas.width = Math.floor(width * ratio);
    this.canvas.height = Math.floor(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.schedule();
  }

  clear(fill: string): void {
    this.context.save();
    this.context.fillStyle = fill;
    this.context.fillRect(0, 0, this.width, this.height);
    this.context.restore();
  }
}

export function insidePolygon(polygon: number[], x: number, y: number): boolean {
  let inside = false;
  const n = polygon.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2];
    const yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const yj = polygon[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Pointer capture keeps a drag alive when the cursor leaves the canvas, but it throws
 * `NotFoundError` for a pointer id the browser is not tracking. Losing capture only degrades
 * a drag that runs off the edge; losing the whole gesture to an exception would not do.
 */
export function capture(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
  }
}

export function release(target: Element, pointerId: number): void {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
  }
  }

/**
 * Hover used to scan every visible individual on every `pointermove`, re-projecting each one
 * and calling `Math.hypot` for every visible point at mouse-event frequency. That is what
 * made panning and hovering feel sticky. Panels now record each point's screen position once,
 * while drawing it, and hover consults only the handful of cells around the cursor.
 *
 * Points off-canvas are skipped rather than clamped, so edge cells cannot degenerate into
 * holding everything that scrolled out of view.
 */
export class ScreenIndex {
  #cell: number;
  #cols = 1;
  #rows = 1;
  #buckets: number[][] = [];
  #x = new Float32Array(0);
  #y = new Float32Array(0);
  #id = new Int32Array(0);
  #count = 0;
  #width = 0;
  #height = 0;

  constructor(cell = 28) {
    this.#cell = cell;
  }

  begin(width: number, height: number, capacity: number): void {
    this.#width = width;
    this.#height = height;
    const cols = Math.max(1, Math.ceil(width / this.#cell));
    const rows = Math.max(1, Math.ceil(height / this.#cell));
    if (cols !== this.#cols || rows !== this.#rows || this.#buckets.length === 0) {
      this.#cols = cols;
      this.#rows = rows;
      this.#buckets = Array.from({ length: cols * rows }, () => []);
    } else {
      for (const bucket of this.#buckets) bucket.length = 0;
    }
    if (this.#x.length < capacity) {
      this.#x = new Float32Array(capacity);
      this.#y = new Float32Array(capacity);
      this.#id = new Int32Array(capacity);
    }
    this.#count = 0;
  }

  add(id: number, x: number, y: number): boolean {
    if (x < -8 || y < -8 || x > this.#width + 8 || y > this.#height + 8) return false;
    const slot = this.#count++;
    this.#x[slot] = x;
    this.#y[slot] = y;
    this.#id[slot] = id;
    const cx = Math.min(this.#cols - 1, Math.max(0, Math.floor(x / this.#cell)));
    const cy = Math.min(this.#rows - 1, Math.max(0, Math.floor(y / this.#cell)));
    this.#buckets[cy * this.#cols + cx].push(slot);
    return true;
  }

  nearest(x: number, y: number, maxDistance: number): number | null {
    const reach = Math.ceil(maxDistance / this.#cell);
    const cx = Math.floor(x / this.#cell);
    const cy = Math.floor(y / this.#cell);
    let best: number | null = null;
    let bestDistance = maxDistance;
    for (let gy = cy - reach; gy <= cy + reach; gy++) {
      if (gy < 0 || gy >= this.#rows) continue;
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        if (gx < 0 || gx >= this.#cols) continue;
        for (const slot of this.#buckets[gy * this.#cols + gx]) {
          const dx = this.#x[slot] - x;
          const dy = this.#y[slot] - y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = this.#id[slot];
          }
        }
      }
    }
    return best;
  }
}

/**
 * A fixed step per event is wrong for trackpads: they emit a stream of small deltas, so a
 * constant 1.15 per event zooms explosively, while a mouse notch arrives as one large delta.
 * Scaling exponentially with the delta makes both feel the same — smooth and proportional —
 * and normalising `deltaMode` keeps Firefox's line-based wheel in step with everyone else's
 * pixels. A single event is capped so one violent flick cannot cross the whole zoom range.
 */
export function wheelFactor(event: WheelEvent): number {
  let delta = event.deltaY;
  if (event.deltaMode === 1) delta *= 16;
  else if (event.deltaMode === 2) delta *= 100;
  // A trackpad pinch arrives as a wheel event with ctrlKey set and small deltas.
  if (event.ctrlKey) delta *= 2.5;
  delta = Math.max(-140, Math.min(140, delta));
  return Math.exp(-delta * 0.0025);
}
