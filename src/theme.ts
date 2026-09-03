/**
 * Canvas cannot read CSS custom properties, so the palette is defined once in CSS and pulled
 * into JS here. Every colour below was validated with the data-viz palette validator:
 * the age ramp is a single blue hue, monotone in lightness and stepped separately for each
 * surface; the selection accent is orange, which clears CVD and contrast gates against the
 * ramp in both modes; present-day reference individuals are a deliberately recessive neutral,
 * since they are context rather than a series.
 */

export interface Palette {
  surface: string;
  gridline: string;
  axis: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  land: string;
  landEdge: string;
  present: string;
  accent: string;
  compareA: string;
  compareB: string;
  focus: string;
  age: string[];
}

const VARIABLES = {
  surface: '--surface-1',
  gridline: '--gridline',
  axis: '--axis',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  land: '--land',
  landEdge: '--land-edge',
  present: '--present',
  accent: '--accent',
  compareA: '--compare-a',
  compareB: '--compare-b',
  focus: '--focus',
} as const;

let cached: Palette | null = null;

export function palette(): Palette {
  if (cached) return cached;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => style.getPropertyValue(name).trim();
  cached = {
    ...(Object.fromEntries(
      Object.entries(VARIABLES).map(([key, name]) => [key, read(name)]),
    ) as Omit<Palette, 'age'>),
    age: [1, 2, 3, 4, 5].map((step) => read(`--age-${step}`)),
  };
  return cached;
}

export function invalidatePalette(): void {
  cached = null;
}

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'paleoscope.theme';

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // Private windows and blocked site data both throw here; the default is fine.
  }
  return 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // A blocked storage write must not prevent the in-memory theme change.
  }
  invalidatePalette();
}
