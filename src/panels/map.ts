import { ageBand } from '../analysis.ts';
import type { Store } from '../store.ts';
import { palette } from '../theme.ts';
import type { BoundingBox } from '../types.ts';
import { Layer, ScreenIndex, capture, insidePolygon, release, wheelFactor } from './canvas.ts';

const POINT_RADIUS = 2.2;
const SELECTED_RADIUS = 3.6;
const HOVER_RADIUS_PX = 14;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_SLOP_PX = 8;

const MIN_DEG_PER_PX = 0.002;
const MAX_DEG_PER_PX = 1.2;

export interface LandOutline {
  rings: number[][];
}

interface RingBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/**
 * The land outline is unwrapped at build time so no ring contains a 360-degree jump, which
 * would otherwise smear a band across the map. The cost of unwrapping is that a ring circling
 * the globe — Eurasia and Africa are a single ring reaching the antimeridian and continuing
 * from the other side — ends up shifted out of the window. Drawing each ring at -360, 0 and
 * +360 puts it back, and copies that cannot intersect the window are skipped before any path
 * is built.
 */
const LON_OFFSETS = [-360, 0, 360] as const;

/**
 * No tiles and no map library on purpose: a live demo must not be able to stall on somebody
 * else's tile server, and the whole panel needs to work with the network switched off.
 *
 * The view is stored as a centre plus a degrees-per-pixel scale rather than as a lon/lat
 * window. That distinction is not cosmetic — a stored window has to be squeezed onto whatever
 * aspect ratio the panel happens to have, so resizing the panel stretched the continents.
 * One scale for both axes keeps pixels square at every size.
 */
export class MapPanel {
  readonly layer: Layer;

  #store: Store;
  #land: LandOutline | null = null;
  #landBounds: RingBounds[] = [];
  #tooltip: HTMLElement;
  #index = new ScreenIndex(26);
  #box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  #lasso: number[] = [];
  #dragging: 'box' | 'lasso' | 'pan' | null = null;
  #lastPointer: { x: number; y: number } | null = null;
  #hovered: number | null = null;
  #hoverPending: { x: number; y: number } | null = null;
  #hoverQueued = false;
  #onRegion: (bbox: BoundingBox | null) => void;
  #onPick: (index: number) => void;
  #onLasso: (indices: number[]) => void;
  #onClearSelection: () => void;
  #lastUpAt = 0;
  #lastUpPoint = { x: 0, y: 0 };

  #centreLon = 27.5;
  #centreLat = 42;
  #degPerPx = 0.16;

  constructor(
    host: HTMLElement,
    store: Store,
    handlers: {
      onRegion: (bbox: BoundingBox | null) => void;
      onPick: (index: number) => void;
      onLasso: (indices: number[]) => void;
      onClearSelection: () => void;
    },
  ) {
    this.#store = store;
    this.#onRegion = handlers.onRegion;
    this.#onPick = handlers.onPick;
    this.#onLasso = handlers.onLasso;
    this.#onClearSelection = handlers.onClearSelection;
    this.layer = new Layer(host);
    this.#tooltip = document.createElement('div');
    this.#tooltip.className = 'tooltip';
    this.#tooltip.hidden = true;
    host.append(this.#tooltip);
    this.layer.onDraw(() => this.#render());
    this.#bind();
  }

  setLand(land: LandOutline): void {
    this.#land = land;
    this.#landBounds = land.rings.map((ring) => {
      let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;
      for (let p = 0; p < ring.length; p += 2) {
        const lon = ring[p];
        const lat = ring[p + 1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      return { minLon, maxLon, minLat, maxLat };
    });
    this.layer.schedule();
  }

  // --- view -----------------------------------------------------------------

  get window(): BoundingBox {
    const halfLon = (this.layer.width / 2) * this.#degPerPx;
    const halfLat = (this.layer.height / 2) * this.#degPerPx;
    return {
      west: this.#centreLon - halfLon,
      east: this.#centreLon + halfLon,
      south: this.#centreLat - halfLat,
      north: this.#centreLat + halfLat,
    };
  }

  get viewState(): { centreLon: number; centreLat: number; degPerPx: number } {
    return { centreLon: this.#centreLon, centreLat: this.#centreLat, degPerPx: this.#degPerPx };
  }

  restoreView(state: Partial<{ centreLon: number; centreLat: number; degPerPx: number }>): void {
    if (Number.isFinite(state.centreLon)) this.#centreLon = Number(state.centreLon);
    if (Number.isFinite(state.centreLat)) this.#centreLat = Math.max(-85, Math.min(85, Number(state.centreLat)));
    if (Number.isFinite(state.degPerPx)) this.#setScale(Number(state.degPerPx));
    this.layer.schedule();
  }

  /**
   * Containing the whole box instead would leave the map showing pole-to-equator whenever the
   * panel is roughly square, because square pixels mean a square panel shows a square window.
   * Filling keeps the region the panel is about at a useful size; the trimmed edges are one
   * scroll away.
   */
  fitBox(bbox: BoundingBox): void {
    this.#centreLon = (bbox.west + bbox.east) / 2;
    this.#centreLat = (bbox.south + bbox.north) / 2;
    const lonSpan = Math.abs(bbox.east - bbox.west) || 1;
    const latSpan = Math.abs(bbox.north - bbox.south) || 1;
    const width = Math.max(1, this.layer.width);
    const height = Math.max(1, this.layer.height);
    this.#setScale(Math.min(lonSpan / width, latSpan / height));
    this.layer.schedule();
  }

  fitWorld(): void {
    this.fitBox({ west: -180, east: 180, south: -60, north: 84 });
  }

  fitWestEurasia(): void {
    this.fitBox({ west: -25, east: 80, south: 12, north: 72 });
  }

  centreOn(lon: number, lat: number): void {
    this.#centreLon = lon;
    this.#centreLat = Math.max(-85, Math.min(85, lat));
    this.layer.schedule();
  }

  #setScale(value: number): void {
    this.#degPerPx = Math.max(MIN_DEG_PER_PX, Math.min(MAX_DEG_PER_PX, value));
  }

  #x(lon: number): number {
    return (lon - this.#centreLon) / this.#degPerPx + this.layer.width / 2;
  }

  #y(lat: number): number {
    return this.layer.height / 2 - (lat - this.#centreLat) / this.#degPerPx;
  }

  #lon(px: number): number {
    return this.#centreLon + (px - this.layer.width / 2) * this.#degPerPx;
  }

  #lat(py: number): number {
    return this.#centreLat - (py - this.layer.height / 2) * this.#degPerPx;
  }

  // --- interaction ----------------------------------------------------------

  #bind(): void {
    const canvas = this.layer.canvas;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (event) => {
      // See the PCA panel: without this guard a right-click starts a drag whose release reads
      // as a click, which re-selects instead of letting the context menu clear.
      if (event.button !== 0 && event.button !== 1) return;
      capture(canvas, event.pointerId);
      const point = this.#local(event);
      if (this.#isSecondClick(point) || event.shiftKey || event.button === 1) {
        this.#dragging = 'pan';
        this.#lastPointer = point;
        canvas.style.cursor = 'grabbing';
      } else if (event.altKey) {
        this.#dragging = 'box';
        this.#box = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
      } else {
        this.#dragging = 'lasso';
        this.#lasso = [point.x, point.y];
      }
      this.#tooltip.hidden = true;
      this.#hovered = null;
    });

    canvas.addEventListener('pointermove', (event) => {
      const point = this.#local(event);
      if (this.#dragging === 'box' && this.#box) {
        this.#box.x1 = point.x;
        this.#box.y1 = point.y;
        this.layer.schedule();
        return;
      }
      if (this.#dragging === 'lasso') {
        const n = this.#lasso.length;
        // Thin the path: a freehand lasso emits far more points than the hit test needs.
        if (n < 2 || Math.hypot(point.x - this.#lasso[n - 2], point.y - this.#lasso[n - 1]) > 3) {
          this.#lasso.push(point.x, point.y);
          this.layer.schedule();
        }
        return;
      }
      if (this.#dragging === 'pan' && this.#lastPointer) {
        this.#centreLon -= (point.x - this.#lastPointer.x) * this.#degPerPx;
        this.#centreLat += (point.y - this.#lastPointer.y) * this.#degPerPx;
        this.#centreLat = Math.max(-85, Math.min(85, this.#centreLat));
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
        else {
          const point = this.#local(event);
          const hit = this.#index.nearest(point.x, point.y, HOVER_RADIUS_PX);
          if (hit !== null) this.#onPick(hit);
        }
        this.layer.schedule();
        return;
      }

      if (this.#dragging === 'box' && this.#box) {
        const { x0, y0, x1, y1 } = this.#box;
        this.#box = null;
        this.#dragging = null;
        if (Math.abs(x1 - x0) < 6 && Math.abs(y1 - y0) < 6) {
          const hit = this.#index.nearest(x1, y1, HOVER_RADIUS_PX);
          if (hit !== null) this.#onPick(hit);
        } else {
          this.#onRegion({
            west: Math.min(this.#lon(x0), this.#lon(x1)),
            east: Math.max(this.#lon(x0), this.#lon(x1)),
            south: Math.min(this.#lat(y0), this.#lat(y1)),
            north: Math.max(this.#lat(y0), this.#lat(y1)),
          });
        }
        this.layer.schedule();
        return;
      }
      this.#dragging = null;
      this.#lastPointer = null;
      canvas.style.cursor = 'crosshair';
    });

    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.#onClearSelection();
    });

    canvas.addEventListener('pointerleave', () => {
      this.#hovered = null;
      this.#hoverPending = null;
      this.#tooltip.hidden = true;
      this.layer.schedule();
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const point = this.#local(event);
        const anchorLon = this.#lon(point.x);
        const anchorLat = this.#lat(point.y);
        this.#setScale(this.#degPerPx / wheelFactor(event));
        // Zooming around the pointer prevents the map from drifting away from the target.
        this.#centreLon = anchorLon - (point.x - this.layer.width / 2) * this.#degPerPx;
        this.#centreLat = anchorLat + (point.y - this.layer.height / 2) * this.#degPerPx;
        this.#centreLat = Math.max(-85, Math.min(85, this.#centreLat));
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

  #isSecondClick(point: { x: number; y: number }): boolean {
    if (performance.now() - this.#lastUpAt > DOUBLE_CLICK_MS) return false;
    return Math.hypot(point.x - this.#lastUpPoint.x, point.y - this.#lastUpPoint.y)
      < DOUBLE_CLICK_SLOP_PX;
  }

  #hitTest(path: number[]): number[] {
    const data = this.#store.dataset;
    if (!data) return [];
    const found: number[] = [];
    for (const i of this.#store.visible) {
      const lat = data.lat[i];
      if (Number.isNaN(lat)) continue;
      if (insidePolygon(path, this.#x(data.lon[i]), this.#y(lat))) found.push(i);
    }
    return found;
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

  #updateHover(point: { x: number; y: number }): void {
    const hit = this.#index.nearest(point.x, point.y, HOVER_RADIUS_PX);
    if (hit === this.#hovered) {
      if (hit !== null) this.#placeTooltip(point);
      return;
    }
    this.#hovered = hit;
    if (hit === null) {
      this.#tooltip.hidden = true;
    } else {
      const store = this.#store;
      this.#tooltip.innerHTML = '';
      const id = document.createElement('strong');
      id.textContent = store.dataset?.geneticId[hit] ?? '';
      const meta = document.createElement('span');
      const locality = store.label('locality', hit) || store.label('polity', hit);
      meta.textContent = `${store.label('group', hit)}${locality ? ` · ${locality}` : ''}`;
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

  // --- rendering ------------------------------------------------------------

  #render(): void {
    const colours = palette();
    const context = this.layer.context;
    const store = this.#store;
    this.layer.clear(colours.surface);

    if (this.#land) {
      const view = this.window;
      context.fillStyle = colours.land;
      context.strokeStyle = colours.landEdge;
      context.lineWidth = 0.6;
      for (const [index, ring] of this.#land.rings.entries()) {
        const bounds = this.#landBounds[index];
        if (bounds.maxLat < view.south || bounds.minLat > view.north) continue;
        for (const offset of LON_OFFSETS) {
          if (bounds.minLon + offset > view.east || bounds.maxLon + offset < view.west) continue;
          context.beginPath();
          context.moveTo(this.#x(ring[0] + offset), this.#y(ring[1]));
          for (let p = 2; p < ring.length; p += 2) {
            context.lineTo(this.#x(ring[p] + offset), this.#y(ring[p + 1]));
          }
          context.closePath();
          context.fill();
          context.stroke();
        }
      }
    }

    const data = store.dataset;
    if (!data) return;
    const selection = store.selection;
    const comparison = store.comparisonSets;
    const compared = (index: number): boolean =>
      comparison?.a.has(index) === true || comparison?.b.has(index) === true;
    this.#index.begin(this.layer.width, this.layer.height, store.visible.length);

    context.fillStyle = colours.present;
    for (const i of store.visible) {
      if (data.isAncient[i] === 1 || selection.has(i) || compared(i)) continue;
      const lat = data.lat[i];
      if (Number.isNaN(lat)) continue;
      const x = this.#x(data.lon[i]);
      const y = this.#y(lat);
      if (!this.#index.add(i, x, y)) continue;
      context.beginPath();
      context.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
      context.fill();
    }

    const banded: number[][] = colours.age.map(() => []);
    for (const i of store.visible) {
      if (data.isAncient[i] === 0 || selection.has(i) || compared(i)) continue;
      if (Number.isNaN(data.lat[i])) continue;
      banded[ageBand(data.dateBP[i])].push(i);
    }
    for (const [band, members] of banded.entries()) {
      context.fillStyle = colours.age[band];
      for (const i of members) {
        const x = this.#x(data.lon[i]);
        const y = this.#y(data.lat[i]);
        if (!this.#index.add(i, x, y)) continue;
        context.beginPath();
        context.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
        context.fill();
      }
    }

    if (comparison) {
      const drawComparison = (members: Set<number>, colour: string, radius: number): void => {
        context.fillStyle = colour;
        context.strokeStyle = colours.surface;
        context.lineWidth = 1.5;
        for (const i of members) {
          if (Number.isNaN(data.lat[i])) continue;
          const x = this.#x(data.lon[i]);
          const y = this.#y(data.lat[i]);
          this.#index.add(i, x, y);
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      };
      drawComparison(comparison.b, colours.compareB, SELECTED_RADIUS + 1.4);
      drawComparison(comparison.a, colours.compareA, SELECTED_RADIUS);
    }

    if (selection.size > 0) {
      context.lineWidth = 2;
      context.strokeStyle = colours.surface;
      context.fillStyle = colours.accent;
      for (const i of selection) {
        const lat = data.lat[i];
        if (Number.isNaN(lat)) continue;
        const x = this.#x(data.lon[i]);
        const y = this.#y(lat);
        this.#index.add(i, x, y);
        context.beginPath();
        context.arc(x, y, SELECTED_RADIUS, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }

    if (store.focused !== null && !Number.isNaN(data.lat[store.focused])) {
      context.strokeStyle = colours.focus;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(
        this.#x(data.lon[store.focused]),
        this.#y(data.lat[store.focused]),
        10,
        0,
        Math.PI * 2,
      );
      context.stroke();
    }

    // The geographic filter, drawn so an agent-applied region is as visible as a hand-drawn one.
    const filterBox = store.filter.bbox;
    if (filterBox) {
      context.strokeStyle = colours.accent;
      context.lineWidth = 1.5;
      context.setLineDash([6, 4]);
      context.strokeRect(
        this.#x(filterBox.west),
        this.#y(filterBox.north),
        this.#x(filterBox.east) - this.#x(filterBox.west),
        this.#y(filterBox.south) - this.#y(filterBox.north),
      );
      context.setLineDash([]);
    }

    if (this.#hovered !== null && !Number.isNaN(data.lat[this.#hovered])) {
      context.strokeStyle = colours.textPrimary;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(
        this.#x(data.lon[this.#hovered]),
        this.#y(data.lat[this.#hovered]),
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

    if (this.#box) {
      context.strokeStyle = colours.textPrimary;
      context.lineWidth = 1;
      context.setLineDash([4, 3]);
      context.strokeRect(
        Math.min(this.#box.x0, this.#box.x1),
        Math.min(this.#box.y0, this.#box.y1),
        Math.abs(this.#box.x1 - this.#box.x0),
        Math.abs(this.#box.y1 - this.#box.y0),
      );
      context.setLineDash([]);
    }
  }
}
