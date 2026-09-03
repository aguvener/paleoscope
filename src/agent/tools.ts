import {
  centroid,
  compareSetSummaries,
  describeSample,
  nearestPopulations,
  nearestSamples,
  populationOutliers,
  populationProfile,
  summarise,
  timelineBins,
} from '../analysis.ts';
import { renderPlot, structuralReading } from '../digest.ts';
import { combine } from '../sets.ts';
import { DEFAULT_FILTER, describeFilterPatch } from '../store.ts';
import type { ResolvedSet, Store } from '../store.ts';
import type { BoundingBox, Filter } from '../types.ts';
import type { NextAction, ToolDefinition, ToolOutcome } from './webmcp.ts';
import { fail, ok } from './webmcp.ts';

/** Row caps. A tool result is a prompt, not a data export: structure and counts beat volume. */
const MAX_ROWS = 25;
const MAX_SET_ROWS = 40;

export interface PanelBridge {
  centreMapOn(lon: number, lat: number): void;
  resetPcaView(): void;
  showTab(tab: 'selection' | 'table' | 'compare' | 'agent'): void;
}

/** Named regions, so the agent never has to guess at coordinates. */
const REGIONS: Record<string, BoundingBox> = {
  'west-eurasia': { west: -25, east: 80, south: 12, north: 72 },
  anatolia: { west: 25.5, east: 45, south: 35.5, north: 42.5 },
  'the-levant': { west: 33.5, east: 39.5, south: 29, north: 37.5 },
  europe: { west: -11, east: 40, south: 34, north: 71 },
  'south-east-europe': { west: 18, east: 30, south: 34.5, north: 48 },
  'the-caucasus': { west: 38, east: 51, south: 38, north: 45 },
  'the-pontic-caspian-steppe': { west: 28, east: 62, south: 43, north: 55 },
  'central-asia': { west: 50, east: 80, south: 35, north: 50 },
  'the-iranian-plateau': { west: 44, east: 63, south: 25, north: 40 },
  'north-africa': { west: -17, east: 35, south: 20, north: 37 },
  'the-british-isles': { west: -11, east: 2, south: 49.5, north: 61 },
  'the-iberian-peninsula': { west: -10, east: 3.5, south: 36, north: 44 },
  world: { west: -180, east: 180, south: -60, north: 84 },
};

/**
 * A little session memory, so suggestions stop repeating advice already taken.
 * Deliberately tiny: anything worth keeping belongs in the store's journal instead.
 */
const session = { plotRead: false, explained: false, noted: false };

// --- shared helpers --------------------------------------------------------

type SetLookup = { ok: true; set: ResolvedSet } | { ok: false; outcome: ToolOutcome };

function lookup(store: Store, handle: unknown, fallback = 'visible'): SetLookup {
  const id = typeof handle === 'string' && handle.trim() !== '' ? handle.trim() : fallback;
  const set = store.resolve(id);
  if (!set) {
    return {
      ok: false,
      outcome: fail(
        'unknown_set',
        `No set named "${id}". Live handles: ${store.handles.join(', ')}.`,
        { call: 'read_state' },
      ),
    };
  }
  return { ok: true, set };
}

function rows(store: Store, indices: Int32Array | number[], limit: number): unknown {
  const list = [...indices];
  return {
    total: list.length,
    truncated: list.length > limit || undefined,
    individuals: list.slice(0, limit).map((i) => describeSample(store, i)),
  };
}

function publish(
  store: Store,
  indices: number[],
  label: string,
): { set: string; n: number } {
  const minted = store.createResultSet(indices, label, 'agent');
  return { set: minted.id, n: minted.indices.length };
}

// --- suggestions -----------------------------------------------------------

/**
 * The page proposes; the agent disposes.
 *
 * These are the things the page knows and the agent cannot cheaply derive: that a filter has
 * left too few individuals to conclude anything, that two saved sets have never been compared,
 * that the scatter has never been looked at. Kept deliberately cheap — this runs on every
 * result — so it reasons from counts already to hand, never from a fresh scan.
 */
export function suggestNext(store: Store): NextAction[] {
  const out: NextAction[] = [];
  if (store.load !== 'ready') return out;

  if (store.visible.length === 0) {
    out.push({
      why: 'nothing passes the current filters, so no tool can say anything useful',
      call: 'clear_filters',
    });
    return out;
  }
  if (store.visible.length < 5) {
    out.push({
      why: `only ${store.visible.length} individuals are visible, too few to support a conclusion`,
      call: 'set_filter',
      args: { dryRun: true, minSnps: 0 },
    });
  }
  if (store.selection.size > 0 && !session.explained) {
    out.push({
      why: `the user has ${store.selection.size} individuals selected and has not been told what they are`,
      call: 'explain_set',
      args: { set: 'selection' },
    });
  }
  if (!session.plotRead) {
    out.push({
      why: 'the scatter has not been read yet; its shape is what the user is looking at',
      call: 'read_plot',
      args: { panel: 'pca', mark: 'selection' },
    });
  }
  const named = store.sets.named;
  if (named.length >= 2) {
    out.push({
      why: `two saved sets exist (${named.map((s) => s.id).join(', ')}) and have not been compared`,
      call: 'compare_sets',
      args: { a: named[0].id, b: named[1].id },
    });
  }
  if (session.explained && !session.noted) {
    out.push({
      why: 'a finding has been worked out but nothing is written down for the user to keep',
      call: 'note',
      args: { about: 'selection', text: '…' },
    });
  }
  return out.slice(0, 3);
}

type PatchResult =
  | { ok: true; patch: Partial<Filter> }
  | { ok: false; outcome: ToolOutcome };

const FILTER_TEXT_KEYS = [
  'locality', 'publication', 'dateMethod', 'mtHaplogroup', 'yHaplogroup', 'molecularSex',
] as const;

function filterPatchFrom(
  args: Record<string, unknown>,
  current: Filter,
  openRange: [number, number] = [0, 50_000],
): PatchResult {
  const patch: Partial<Filter> = {};

  if (args.fromBP !== undefined || args.toBP !== undefined) {
    const range = current.dateBP ?? openRange;
    const from = (args.fromBP as number | undefined) ?? range[0];
    const to = (args.toBP as number | undefined) ?? range[1];
    // Agents commonly reverse bounds; normalising them keeps the call recoverable.
    patch.dateBP = [Math.min(from, to), Math.max(from, to)];
  }

  if (args.region !== undefined && args.bbox !== undefined) {
    return {
      ok: false,
      outcome: fail('conflicting_arguments', 'Pass either "region" or "bbox", not both.', {
        call: 'set_filter',
        args: { region: args.region },
      }),
    };
  }
  if (args.region !== undefined) patch.bbox = REGIONS[args.region as string] ?? null;
  else if (args.bbox !== undefined) {
    const box = args.bbox as Partial<BoundingBox>;
    if (
      box.west === undefined || box.east === undefined
      || box.south === undefined || box.north === undefined
    ) {
      return {
        ok: false,
        outcome: fail('incomplete_bbox', 'A bbox needs all four of west, east, south, north.'),
      };
    }
    patch.bbox = {
      west: box.west,
      east: box.east,
      south: Math.min(box.south, box.north),
      north: Math.max(box.south, box.north),
    };
  }

  // An empty string clears a text filter; that is how an agent undoes one without `undo`.
  if (args.population !== undefined) {
    const value = (args.population as string).trim();
    patch.population = value.length === 0 ? null : value;
  }
  for (const key of FILTER_TEXT_KEYS) {
    if (args[key] === undefined) continue;
    const value = String(args[key]).trim();
    patch[key] = value.length === 0 ? null : value;
  }

  if (args.dateMode !== undefined) patch.dateMode = args.dateMode as Filter['dateMode'];
  if (args.minSnps !== undefined) patch.minSnps = args.minSnps as number;
  if (args.passOnly !== undefined) patch.passOnly = args.passOnly as boolean;
  if (args.era !== undefined) patch.era = args.era as Filter['era'];

  return { ok: true, patch };
}

// --- the surface -----------------------------------------------------------

export function buildTools(store: Store, panels: PanelBridge): ToolDefinition[] {
  const ready = store.load === 'ready' && store.dataset !== null;

  const readState: ToolDefinition = {
    name: 'read_state',
    title: 'Orient · read the whole workspace',
    description:
      'Report everything about the workspace in one call: the dataset, the active PCA basis, '
      + 'every filter in force, how many individuals are visible, what the user has selected, '
      + 'the live set handles, saved findings, the recent history of what both of you did, and '
      + 'which tools are dormant and why.\n'
      + 'Returns: dataset, view, sets, notes, history, tools.\n'
      + 'Use when: starting cold, or after losing track of what changed.\n'
      + 'Changes: nothing.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: () => {
      const data = store.dataset;
      if (!data) {
        return ok({
          status: store.load,
          error: store.error,
          note: 'The dataset is still loading, so the analysis tools are not registered yet.',
        });
      }
      return ok(
        {
          dataset: {
            source: `${data.source.name} ${data.source.release}`,
            panel: data.source.panel,
            license: data.source.license,
            individuals: data.count,
            imported: store.importedCount || undefined,
            bases: data.pca.bases.map((b) => `${b} (${data.pca.basisLabels[b] ?? b})`),
          },
          sets: [
            { set: 'selection', n: store.selection.size, live: true },
            { set: 'visible', n: store.visible.length, live: true },
            { set: 'all', n: data.count, live: true },
            ...store.sets.list().map((entry) => ({
              set: entry.id,
              label: entry.label,
              n: entry.indices.length,
              origin: entry.origin,
              saved: entry.saved || undefined,
            })),
          ],
          notes: store.notes.map((n) => ({
            id: n.id, about: n.about, by: n.actor, kind: n.kind, tags: n.tags, text: n.text,
          })),
          comparison: store.comparison ?? undefined,
          history: store.changes.slice(-12).map((e) => `${e.rev} ${e.actor}: ${e.what}`),
          tools: {
            dormant: dormantTools(store),
          },
          caveat:
            'Ancient individuals are projected onto a present-day reference panel and are '
            + 'shrunk slightly toward the origin, so distances to present-day populations are '
            + 'indicative rather than exact.',
        },
        { scanned: 0 },
      );
    },
  };

  if (!ready) return [readState];
  const data = store.dataset!;

  const tools: ToolDefinition[] = [
    readState,

    // --- read ---------------------------------------------------------------
    {
      name: 'read_plot',
      title: 'Read · see the plot',
      description:
        'Render a panel as an ASCII density grid so you can see the shape the user is looking '
        + 'at: where the mass sits, where the empty corridors are, and where a set sits '
        + 'relative to both. Roughly 250 tokens.\n'
        + 'Returns: a character grid, the density key, the frame, and lettered landmark populations.\n'
        + 'Use when: you need the structure of the scatter rather than statistics about it — '
        + 'especially before explaining why a selection looks unusual.\n'
        + 'Changes: nothing.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          panel: {
            type: 'string',
            description: 'Which panel to render. "pca" for ancestry structure, "map" for geography.',
            enum: ['pca', 'map'],
            default: 'pca',
          },
          mark: {
            type: 'string',
            description: 'A set handle to stamp onto the grid with "O", e.g. "selection" or "s3".',
            default: 'selection',
          },
          width: {
            type: 'integer',
            description: 'Grid width in characters. 24-96, default 56.',
            minimum: 24,
            maximum: 96,
            default: 56,
          },
          height: {
            type: 'integer',
            description: 'Grid height in characters. 8-32, default 20.',
            minimum: 8,
            maximum: 32,
            default: 20,
          },
          frame: {
            type: 'string',
            description:
              '"auto" (default) zooms in once the visible set has collapsed into a corner; '
              + '"basis" keeps the fixed frame so coordinates are comparable across calls; '
              + '"fit" always zooms to what is visible.',
            enum: ['auto', 'basis', 'fit'],
            default: 'auto',
          },
        },
      },
      execute: (args) => {
        session.plotRead = true;
        const mark = lookup(store, args.mark, 'selection');
        const digest = renderPlot(store, {
          panel: args.panel as 'pca' | 'map',
          width: args.width as number,
          height: args.height as number,
          markIndices: mark.ok ? mark.set.indices : undefined,
          markLabel: mark.ok ? mark.set.label : undefined,
          landmarks: 6,
          frame: args.frame as 'auto' | 'basis' | 'fit',
        });
        if (!digest) return fail('no_plot', 'There is nothing to plot yet.', { call: 'read_state' });
        return ok(digest, { scanned: store.visible.length });
      },
    },

    {
      name: 'read_timeline',
      title: 'Read · inspect the time distribution',
      description:
        'Summarize a cohort as evenly spaced time bins, including its date uncertainty and age summary. '
        + 'Use this when the shape or gaps in a temporal distribution matter. Changes nothing.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          set: { type: 'string', description: 'Cohort handle. Defaults to visible.' },
          bins: { type: 'integer', description: 'Number of bins, 4-60. Default 16.', minimum: 4, maximum: 60, default: 16 },
          fromBP: { type: 'integer', description: 'Optional youngest bound in BP.', minimum: 0, maximum: 100_000 },
          toBP: { type: 'integer', description: 'Optional oldest bound in BP.', minimum: 0, maximum: 100_000 },
        },
      },
      execute: (args) => {
        const scope = lookup(store, args.set);
        if (!scope.ok) return scope.outcome;
        return ok({
          set: scope.set.id,
          summary: summarise(store, scope.set.indices, { topN: 5 }),
          bins: timelineBins(store, scope.set.indices, {
            bins: args.bins as number,
            fromBP: args.fromBP as number | undefined,
            toBP: args.toBP as number | undefined,
          }),
        }, { scanned: scope.set.indices.length });
      },
    },

    {
      name: 'read_population_profile',
      title: 'Read · profile one population',
      description:
        'Return the dates, localities, publications, haplogroups, quality assessments and PCA summary '
        + 'for one exact population label in a cohort. Use after find_populations resolves the label. Changes nothing.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          population: { type: 'string', description: 'Exact population label, such as Turkey_N.' },
          set: { type: 'string', description: 'Cohort to search. Defaults to visible.' },
        },
        required: ['population'],
      },
      execute: (args) => {
        const scope = lookup(store, args.set);
        if (!scope.ok) return scope.outcome;
        const profile = populationProfile(store, args.population as string, scope.set.indices);
        if (!profile) {
          return fail('population_not_found', `No exact population "${String(args.population)}" exists in ${scope.set.id}.`, {
            call: 'find_populations', args: { query: args.population },
          });
        }
        return ok(profile, { scanned: scope.set.indices.length });
      },
    },

    {
      name: 'read_sample',
      title: 'Read · one individual',
      description:
        'Return the full record for one individual by AADR genetic ID: population, locality, '
        + 'radiocarbon or contextual date, coordinates, PCA position, SNP coverage, uniparental '
        + 'haplogroups, quality assessment and the publication that reported it.\n'
        + 'Returns: one individual record.\n'
        + 'Use when: you have an exact ID and need its details.\n'
        + 'Changes: nothing.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          geneticId: {
            type: 'string',
            description: 'AADR genetic ID, e.g. "Loschbour.AG" or "Tep006.WGC.SG".',
          },
        },
        required: ['geneticId'],
      },
      execute: (args) => {
        const index = store.findByGeneticId(args.geneticId as string);
        if (index < 0) {
          return fail(
            'unknown_individual',
            `No individual with genetic ID "${String(args.geneticId)}".`,
            { call: 'find_populations', args: { query: String(args.geneticId).slice(0, 6) } },
          );
        }
        return ok(describeSample(store, index), { scanned: data.count });
      },
    },

    // --- find (produce sets) -------------------------------------------------
    {
      name: 'find_populations',
      title: 'Find · search population labels',
      description:
        'Search population labels by substring, returning matches with sample counts, date '
        + 'ranges and PCA centroids, plus a set handle covering all of them.\n'
        + 'Returns: matching populations and a set handle.\n'
        + 'Use when: turning a vague name ("Anatolian Neolithic") into the exact labels the '
        + 'data uses ("Turkey_N"). Do this before filtering by population.\n'
        + 'Changes: nothing.',
      annotations: { untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Case-insensitive substring of the label, e.g. "Yamnaya" or "Natufian".',
          },
          limit: {
            type: 'integer',
            description: 'Maximum matches to return. 1-40, default 15.',
            minimum: 1,
            maximum: 40,
            default: 15,
          },
        },
        required: ['query'],
      },
      execute: (args) => {
        const query = (args.query as string).trim().toLowerCase();
        if (query.length < 2) {
          return fail('query_too_short', 'The query must be at least two characters long.', {
            call: 'find_populations',
            args: { query: 'neolithic' },
          });
        }
        const limit = args.limit as number;
        const matches: Record<string, unknown>[] = [];
        const members: number[] = [];
        for (const [code, label] of data.dict.group.entries()) {
          if (!label.toLowerCase().includes(query)) continue;
          const group = data.byGroup.get(code);
          if (!group || group.length === 0) continue;
          members.push(...group);
          const at = centroid(store, group);
          const ages = group.filter((i) => data.isAncient[i] === 1).map((i) => data.dateBP[i]);
          matches.push({
            population: label,
            n: group.length,
            era: ages.length === 0 ? 'present-day' : ages.length === group.length ? 'ancient' : 'mixed',
            dateBP: ages.length === 0 ? undefined : [Math.min(...ages), Math.max(...ages)],
            pc: at ? [Number(at.pc1.toFixed(1)), Number(at.pc2.toFixed(1))] : undefined,
          });
        }
        if (matches.length === 0) {
          return fail('no_match', `No population label contains "${args.query}".`, {
            call: 'find_populations',
            args: { query: query.slice(0, 4) },
          });
        }
        matches.sort((a, b) => (b.n as number) - (a.n as number));
        return ok(
          {
            query: args.query,
            matched: matches.length,
            truncated: matches.length > limit || undefined,
            populations: matches.slice(0, limit),
            ...publish(store, members, `populations matching "${args.query}"`),
          },
          { scanned: data.dict.group.length },
        );
      },
    },

    {
      name: 'find_publications',
      title: 'Find · search publications',
      description:
        'Search publication titles and DOI values, returning source counts and a reusable cohort of their samples. '
        + 'Use when tracing evidence or building a publication-specific cohort. Changes nothing.',
      annotations: { untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'At least two characters from a title or DOI.' },
          limit: { type: 'integer', description: 'Maximum sources, 1-30. Default 12.', minimum: 1, maximum: 30, default: 12 },
        },
        required: ['query'],
      },
      execute: (args) => {
        const query = (args.query as string).trim().toLowerCase();
        if (query.length < 2) return fail('query_too_short', 'The publication query must be at least two characters.');
        const groups = new Map<string, { publication: string; doi: string | null; indices: number[] }>();
        for (let i = 0; i < data.count; i++) {
          const publication = store.label('publication', i);
          const doi = store.label('doi', i) || null;
          if (!publication.toLowerCase().includes(query) && !doi?.toLowerCase().includes(query)) continue;
          const key = `${publication}\u0000${doi ?? ''}`;
          const entry = groups.get(key) ?? { publication, doi, indices: [] };
          entry.indices.push(i);
          groups.set(key, entry);
        }
        const matches = [...groups.values()].toSorted((a, b) => b.indices.length - a.indices.length);
        if (matches.length === 0) return fail('no_match', `No publication or DOI contains "${String(args.query)}".`);
        const members = matches.flatMap((entry) => entry.indices);
        return ok({
          matched: matches.length,
          sources: matches.slice(0, args.limit as number).map((entry) => ({
            publication: entry.publication,
            doi: entry.doi,
            n: entry.indices.length,
          })),
          ...publish(store, members, `publications matching "${String(args.query)}"`),
        }, { scanned: data.count });
      },
    },

    {
      name: 'build_cohort',
      title: 'Sets · build a reusable cohort',
      description:
        'Create a cohort from explicit metadata criteria without changing the visible filters. '
        + 'Use when an analysis needs a reusable group while preserving the user\'s current view. Changes only the visible cohort list.',
      annotations: { untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          within: { type: 'string', description: 'Optional set to restrict. Defaults to all.' },
          region: {
            type: 'string',
            description: 'Named region, as in set_filter.',
            enum: Object.keys(REGIONS),
          },
          bbox: {
            type: 'object',
            description: 'Explicit bounding box, as an alternative to region.',
            properties: {
              west: { type: 'number', description: 'Western longitude.', minimum: -180, maximum: 180 },
              east: { type: 'number', description: 'Eastern longitude.', minimum: -180, maximum: 180 },
              south: { type: 'number', description: 'Southern latitude.', minimum: -90, maximum: 90 },
              north: { type: 'number', description: 'Northern latitude.', minimum: -90, maximum: 90 },
            },
          },
          population: { type: 'string', description: 'Population label substring.' },
          locality: { type: 'string', description: 'Locality substring.' },
          publication: { type: 'string', description: 'Publication substring.' },
          dateMethod: { type: 'string', description: 'Dating method substring.' },
          mtHaplogroup: { type: 'string', description: 'mtDNA haplogroup prefix or substring.' },
          yHaplogroup: { type: 'string', description: 'Y haplogroup prefix or substring.' },
          molecularSex: { type: 'string', description: 'Recorded molecular sex substring.' },
          fromBP: { type: 'integer', description: 'Youngest age in BP.', minimum: 0, maximum: 100_000 },
          toBP: { type: 'integer', description: 'Oldest age in BP.', minimum: 0, maximum: 100_000 },
          dateMode: { type: 'string', description: 'How date uncertainty matches.', enum: ['point', 'overlap', 'contained'], default: 'point' },
          minSnps: { type: 'integer', description: 'Minimum SNPs hit.', minimum: 0 },
          passOnly: { type: 'boolean', description: 'Keep only quality-passing samples.' },
          era: { type: 'string', description: 'Ancient, present, or both.', enum: ['ancient', 'present', 'both'], default: 'both' },
          name: { type: 'string', description: 'Short label for the resulting cohort.' },
        },
        required: ['name'],
      },
      execute: (args) => {
        // The same translation `set_filter` uses, so a criterion an agent has learned there
        // means exactly the same thing here. `name` is this tool's own and is not a filter.
        const { name: _name, within: _within, ...criteria } = args;
        const translated = filterPatchFrom(criteria, DEFAULT_FILTER, [0, 100_000]);
        if (!translated.ok) return translated.outcome;
        const patch = translated.patch;
        let indices = [...store.previewFilter(patch, true)];
        if (args.within !== undefined) {
          const scope = lookup(store, args.within, 'all');
          if (!scope.ok) return scope.outcome;
          indices = combine(indices, scope.set.indices, 'intersect');
        }
        if (indices.length === 0) {
          // Offer the same criteria as a dry run, minus this tool's own arguments: `set_filter`
          // rejects anything it does not declare, so forwarding `name` would break the repair.
          return fail('empty_cohort', 'Those criteria produce an empty cohort.', {
            call: 'set_filter', args: { ...criteria, dryRun: true },
          });
        }
        const minted = store.createResultSet(indices, String(args.name).trim().slice(0, 60), 'agent');
        return ok({ set: minted.id, label: minted.label, summary: summarise(store, minted.indices, { topN: 6 }) }, {
          did: [`built cohort ${minted.id} with ${minted.indices.length} samples`],
          scanned: data.count,
        });
      },
    },

    {
      name: 'find_outliers',
      title: 'Find · individuals far from their own population',
      description:
        'Rank individuals by how far each sits from the centre of its OWN population cluster, '
        + 'in units of that population\'s own spread. This is the standard first pass for '
        + 'spotting contamination, mislabelled samples, relatives or genuine migrants.\n'
        + 'Returns: a ranked list and a set handle for the hits.\n'
        + 'Use when: asked what is unusual, or before concluding that a group is homogeneous.\n'
        + 'Changes: nothing, unless "select" is true, which highlights the hits for the user.',
      annotations: { untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          set: {
            type: 'string',
            description: 'Set handle to search within. Default "visible".',
            default: 'visible',
          },
          limit: {
            type: 'integer',
            description: 'How many to return. 1-25, default 10.',
            minimum: 1,
            maximum: MAX_ROWS,
            default: 10,
          },
          minPopulationSize: {
            type: 'integer',
            description:
              'Ignore populations with fewer members than this, since spread is meaningless in '
              + 'tiny groups. 3-50, default 6.',
            minimum: 3,
            maximum: 50,
            default: 6,
          },
          select: {
            type: 'boolean',
            description: 'Also highlight the hits in every panel so the user can look at them.',
            default: false,
          },
        },
      },
      execute: (args) => {
        const scope = lookup(store, args.set);
        if (!scope.ok) return scope.outcome;
        const found = populationOutliers(store, scope.set.indices, {
          limit: args.limit as number,
          minPopulationSize: args.minPopulationSize as number,
        });
        if (found.length === 0) {
          return ok(
            {
              outliers: [],
              note:
                'No population in that set has enough members to measure spread. Widen the '
                + 'filters or lower minPopulationSize.',
            },
            { scanned: scope.set.indices.length },
          );
        }
        const did: string[] = [];
        if (args.select === true) {
          store.setSelection(found.map((o) => o.index), 'agent', 'agent');
          did.push(`highlighted ${found.length} outliers for the user`);
        }
        return ok(
          {
            method:
              'distance to own population centroid ÷ that population\'s mean radius, '
              + `in the ${store.basis} basis`,
            outliers: found.map((o) => ({
              geneticId: o.geneticId,
              population: o.population,
              spreads: Number(o.ratio.toFixed(2)),
            })),
            ...publish(store, found.map((o) => o.index), 'population outliers'),
          },
          { did, scanned: scope.set.indices.length },
        );
      },
    },

    {
      name: 'find_neighbours',
      title: 'Find · nearest individuals in PCA space',
      description:
        'Find the individuals sitting closest to one individual in the current PCA basis, '
        + 'searching within a set.\n'
        + 'Returns: ranked neighbours and a set handle.\n'
        + 'Use when: answering "who does this sample cluster with", which is usually the real '
        + 'question behind "what is this".\n'
        + 'Changes: nothing.',
      annotations: { untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          geneticId: { type: 'string', description: 'The individual to search around.' },
          set: {
            type: 'string',
            description: 'Set handle to search within. Default "visible".',
            default: 'visible',
          },
          limit: {
            type: 'integer',
            description: 'How many neighbours. 1-25, default 10.',
            minimum: 1,
            maximum: MAX_ROWS,
            default: 10,
          },
        },
        required: ['geneticId'],
      },
      execute: (args) => {
        const index = store.findByGeneticId(args.geneticId as string);
        if (index < 0) {
          return fail('unknown_individual', `No individual with genetic ID "${String(args.geneticId)}".`);
        }
        const x = store.pc(0);
        const y = store.pc(1);
        if (!x || Number.isNaN(x[index])) {
          return fail(
            'not_projected',
            `"${data.geneticId[index]}" is not projected onto the "${store.basis}" basis.`,
            { call: 'set_basis', args: { basis: 'global' } },
          );
        }
        const scope = lookup(store, args.set);
        if (!scope.ok) return scope.outcome;
        const found = nearestSamples(store, { pc1: x[index], pc2: y![index] }, {
          limit: args.limit as number,
          scope: scope.set.indices,
          exclude: new Set([index]),
        });
        return ok(
          {
            around: data.geneticId[index],
            basis: store.basis,
            neighbours: found.map((n) => ({
              geneticId: data.geneticId[n.index],
              population: store.label('group', n.index),
              dateBP: data.isAncient[n.index] === 1 ? data.dateBP[n.index] : 0,
              distance: Number(n.distance.toFixed(2)),
            })),
            ...publish(store, found.map((n) => n.index), `neighbours of ${data.geneticId[index]}`),
          },
          { scanned: scope.set.indices.length },
        );
      },
    },

    // --- change the view ------------------------------------------------------
    {
      name: 'set_filter',
      title: 'View · filter (supports dryRun)',
      description:
        'Apply filters. Every argument is optional and merges into the filters already in '
        + 'force, so this can be called repeatedly to narrow down. The user can undo it.\n'
        + 'Returns: the resulting count and a summary of what is left.\n'
        + 'Use when: narrowing to a time, place, population or quality band. Pass dryRun to '
        + 'see what a filter would yield without changing the screen — prefer that while you '
        + 'are still deciding.\n'
        + 'Changes: the visible set in all three panels, unless dryRun.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: {
            type: 'boolean',
            description: 'Compute the result without touching the user\'s view.',
            default: false,
          },
          fromBP: {
            type: 'integer',
            description: 'Youngest age to include, years before present. e.g. 6000.',
            minimum: 0,
            maximum: 50_000,
          },
          toBP: {
            type: 'integer',
            description: 'Oldest age to include, years before present. e.g. 9000.',
            minimum: 0,
            maximum: 50_000,
          },
          region: {
            type: 'string',
            description: `A named region: ${Object.keys(REGIONS).join(', ')}.`,
            enum: Object.keys(REGIONS),
          },
          bbox: {
            type: 'object',
            description: 'An explicit geographic box in degrees. Use "region" if one fits.',
            properties: {
              west: { type: 'number', description: 'e.g. 25.5', minimum: -180, maximum: 180 },
              east: { type: 'number', description: 'e.g. 45', minimum: -180, maximum: 180 },
              south: { type: 'number', description: 'e.g. 35.5', minimum: -90, maximum: 90 },
              north: { type: 'number', description: 'e.g. 42.5', minimum: -90, maximum: 90 },
            },
          },
          population: {
            type: 'string',
            description: 'Substring of the population label, e.g. "Yamnaya". Case-insensitive.',
          },
          locality: { type: 'string', description: 'Substring of the archaeological locality.' },
          publication: { type: 'string', description: 'Substring of a publication title.' },
          dateMethod: { type: 'string', description: 'Substring of the recorded dating method.' },
          mtHaplogroup: { type: 'string', description: 'mtDNA haplogroup prefix or substring.' },
          yHaplogroup: { type: 'string', description: 'Y haplogroup prefix or substring.' },
          molecularSex: { type: 'string', description: 'Recorded molecular sex substring.' },
          dateMode: {
            type: 'string',
            description: 'Match the central date, any uncertainty overlap, or a contained interval.',
            enum: ['point', 'overlap', 'contained'],
          },
          minSnps: {
            type: 'integer',
            description: 'Minimum SNPs hit on the compatibility_HO panel, e.g. 20000.',
            minimum: 0,
            maximum: 276_725,
          },
          passOnly: {
            type: 'boolean',
            description: 'Keep only individuals whose AADR assessment begins "Pass".',
          },
          era: {
            type: 'string',
            description: 'Restrict to ancient, present-day, or both.',
            enum: ['ancient', 'present', 'both'],
          },
        },
      },
      execute: (args) => {
        const translated = filterPatchFrom(args, store.filter);
        if (!translated.ok) return translated.outcome;
        const patch = translated.patch;

        if (Object.keys(patch).length === 0) {
          return fail(
            'no_arguments',
            'No filter arguments were given, so nothing would change.',
            { call: 'set_filter', args: { dryRun: true, region: 'anatolia' } },
          );
        }

        const description = describeFilterPatch(store.filter, patch);
        if (description === null) {
          return ok(
            { unchanged: true, visible: store.visible.length },
            {
              did: [],
              next: [
                {
                  why: 'that filter is already in force, so repeating it will not change anything',
                  call: 'read_plot',
                  args: { panel: 'pca' },
                },
              ],
            },
          );
        }

        if (args.dryRun === true) {
          const preview = store.previewFilter(patch);
          return ok(
            {
              dryRun: true,
              would: description,
              wouldLeave: preview.length,
              summary: preview.length > 0 ? summarise(store, preview, { topN: 5 }) : undefined,
            },
            { did: [], scanned: data.count },
          );
        }

        store.setFilter(patch, { actor: 'agent' });
        if (patch.bbox) {
          panels.centreMapOn(
            (patch.bbox.west + patch.bbox.east) / 2,
            (patch.bbox.south + patch.bbox.north) / 2,
          );
        }
        return ok(
          {
            visible: store.visible.length,
            summary: store.visible.length > 0 ? summarise(store, store.visible, { topN: 5 }) : undefined,
          },
          { did: [description], scanned: data.count },
        );
      },
    },

    {
      name: 'set_basis',
      title: 'View · switch PCA basis',
      description:
        'Switch which principal-component basis the scatter shows. "we" is computed on '
        + 'present-day West Eurasian individuals and is the conventional frame for reading '
        + 'European and Near Eastern ancestry. "global" is computed on a worldwide panel and '
        + 'separates continental ancestries.\n'
        + 'Returns: the new basis.\n'
        + 'Use when: individuals are not projected onto the current basis, or the question is '
        + 'continental rather than regional.\n'
        + 'Changes: the scatter plot redraws; axis extents are fixed per basis.',
      inputSchema: {
        type: 'object',
        properties: {
          basis: {
            type: 'string',
            description: 'Which basis to show.',
            enum: data.pca.bases as string[],
          },
        },
        required: ['basis'],
      },
      execute: (args) => {
        const basis = args.basis as string;
        const event = store.setBasis(basis, 'agent');
        if (!event) {
          return ok({ unchanged: true, basis: store.basis }, { did: [] });
        }
        panels.resetPcaView();
        return ok(
          { basis, label: data.pca.basisLabels[basis] ?? basis },
          { did: [event.what] },
        );
      },
    },

    {
      name: 'clear_filters',
      title: 'View · clear all filters',
      description:
        'Remove every filter and show the whole dataset again. Does not touch the selection.\n'
        + 'Returns: the resulting count.\n'
        + 'Use when: a filter combination has emptied the view, or you are starting a new line '
        + 'of enquiry.\n'
        + 'Changes: all three panels.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const event = store.clearFilters('agent');
        return ok(
          { visible: store.visible.length },
          { did: event ? [event.what] : [] },
        );
      },
    },

    {
      name: 'focus_sample',
      title: 'View · point the user at one individual',
      description:
        'Ring one individual in all three panels, centre the map on its site and scroll the '
        + 'detail list to it.\n'
        + 'Returns: the focused individual.\n'
        + 'Use when: you want the human to look at something specific. This is how you point.\n'
        + 'Changes: a highlight ring and the map centre. Filters and selection are untouched.',
      inputSchema: {
        type: 'object',
        properties: {
          geneticId: { type: 'string', description: 'AADR genetic ID to ring.' },
        },
        required: ['geneticId'],
      },
      execute: (args) => {
        const index = store.findByGeneticId(args.geneticId as string);
        if (index < 0) {
          return fail('unknown_individual', `No individual with genetic ID "${String(args.geneticId)}".`);
        }
        store.focus(index, 'agent');
        if (!Number.isNaN(data.lat[index])) panels.centreMapOn(data.lon[index], data.lat[index]);
        return ok(describeSample(store, index), {
          did: [`pointed the user at ${data.geneticId[index]}`],
        });
      },
    },

    // --- sets -----------------------------------------------------------------
    {
      name: 'select',
      title: 'Sets · highlight a set for the user',
      description:
        'Replace the user\'s selection, highlighting those individuals in orange across the '
        + 'map, the scatter and the detail list. The human sees exactly what was selected and '
        + 'can undo it or redraw it by hand.\n'
        + 'Returns: the new selection size and summary.\n'
        + 'Use when: you have found something and want it on screen rather than in prose.\n'
        + 'Changes: the selection in all three panels.',
      inputSchema: {
        type: 'object',
        properties: {
          set: { type: 'string', description: 'Set handle to select, e.g. "s3".' },
          geneticIds: {
            type: 'array',
            description: 'Explicit AADR genetic IDs, as an alternative to a set handle.',
            items: { type: 'string' },
          },
          population: {
            type: 'string',
            description: 'Select every visible individual whose population contains this substring.',
          },
        },
      },
      execute: (args) => {
        const chosen: number[] = [];
        const missing: string[] = [];
        if (args.set !== undefined) {
          const resolved = lookup(store, args.set);
          if (!resolved.ok) return resolved.outcome;
          chosen.push(...resolved.set.indices);
        }
        for (const id of (args.geneticIds as string[] | undefined) ?? []) {
          const index = store.findByGeneticId(id);
          if (index < 0) missing.push(id);
          else chosen.push(index);
        }
        const population = (args.population as string | undefined)?.trim().toLowerCase();
        if (population) {
          for (const i of store.visible) {
            if (store.label('group', i).toLowerCase().includes(population)) chosen.push(i);
          }
        }
        if (chosen.length === 0) {
          return fail(
            'nothing_to_select',
            missing.length > 0
              ? `None of those IDs exist: ${missing.slice(0, 6).join(', ')}.`
              : 'Pass a set handle, explicit geneticIds, or a population substring.',
            { call: 'read_state' },
          );
        }
        store.setSelection(chosen, 'agent', 'agent');
        return ok(
          {
            selected: store.selection.size,
            unknownIds: missing.slice(0, 6),
            summary: summarise(store, store.selection, { topN: 5 }),
          },
          { did: [`selected ${store.selection.size} individuals for the user`] },
        );
      },
    },

    {
      name: 'save_set',
      title: 'Sets · give a set a durable name',
      description:
        'Name a set so it survives and can be compared later. Named sets appear in the '
        + 'sidebar, persist across reloads, and unlock compare_sets once two exist.\n'
        + 'Returns: the saved set.\n'
        + 'Use when: a group is worth returning to — before moving on to a different one.\n'
        + 'Changes: the saved-sets list in the sidebar.',
      inputSchema: {
        type: 'object',
        properties: {
          set: {
            type: 'string',
            description: 'Handle to save. Default "selection".',
            default: 'selection',
          },
          name: { type: 'string', description: 'Short name, e.g. "Anatolian outliers".' },
        },
        required: ['name'],
      },
      execute: (args) => {
        const handle = (args.set as string) ?? 'selection';
        const saved = store.saveSet(handle, args.name as string, 'agent');
        if (!saved) {
          return fail(
            'empty_or_unknown_set',
            `"${handle}" is unknown or empty, so there was nothing to save.`,
            { call: 'read_state' },
          );
        }
        return ok(
          { set: saved.id, label: saved.label, n: saved.indices.length },
          { did: [`saved ${saved.indices.length} individuals as "${saved.label}"`] },
        );
      },
    },

    {
      name: 'combine_sets',
      title: 'Sets · union, intersect, minus',
      description:
        'Build a new set from two existing ones.\n'
        + 'Returns: a new set handle and its size.\n'
        + 'Use when: you need "the outliers that are also Neolithic", or "everything visible '
        + 'except what I already saved". Cheaper and more exact than re-filtering.\n'
        + 'Changes: nothing on screen; the new set appears in the sidebar list.',
      inputSchema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            description: 'union = in either; intersect = in both; minus = in a but not b.',
            enum: ['union', 'intersect', 'minus'],
          },
          a: { type: 'string', description: 'First set handle, e.g. "visible".' },
          b: { type: 'string', description: 'Second set handle, e.g. "selection".' },
        },
        required: ['op', 'a', 'b'],
      },
      execute: (args) => {
        const left = lookup(store, args.a);
        if (!left.ok) return left.outcome;
        const right = lookup(store, args.b);
        if (!right.ok) return right.outcome;
        const result = combine(left.set.indices, right.set.indices, args.op as 'union');
        return ok(
          {
            op: args.op,
            from: [left.set.id, right.set.id],
            ...publish(store, result, `${left.set.id} ${String(args.op)} ${right.set.id}`),
            reading: structuralReading(store, result) ?? undefined,
          },
          { scanned: left.set.indices.length + right.set.indices.length },
        );
      },
    },

    // --- explain and accrete ---------------------------------------------------
    {
      name: 'explain_set',
      title: 'Explain · what is this group',
      description:
        'Work out what a set of individuals is: which populations they belong to, when and '
        + 'where they come from, which reference populations they sit nearest in the current '
        + 'PCA basis, and whether any is an outlier within its own population.\n'
        + 'Returns: composition, date and geography summary, nearest populations, outlier '
        + 'status, and optionally the individual records.\n'
        + 'Use when: the user selects points by eye and asks "what are these?". This is the '
        + 'main analytical tool.\n'
        + 'Changes: nothing.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          set: {
            type: 'string',
            description: 'Set handle to explain. Default "selection".',
            default: 'selection',
          },
          nearest: {
            type: 'integer',
            description: 'How many nearby reference populations to name. 1-15, default 6.',
            minimum: 1,
            maximum: 15,
            default: 6,
          },
          era: {
            type: 'string',
            description:
              'Compare against present-day populations for a familiar frame, ancient ones for '
              + 'an archaeological one.',
            enum: ['ancient', 'present', 'both'],
            default: 'both',
          },
          rows: {
            type: 'integer',
            description: `Include this many individual records. 0-${MAX_SET_ROWS}, default 0.`,
            minimum: 0,
            maximum: MAX_SET_ROWS,
            default: 0,
          },
        },
      },
      execute: (args) => {
        const scope = lookup(store, args.set, 'selection');
        if (!scope.ok) return scope.outcome;
        const indices = scope.set.indices;
        if (indices.length === 0) {
          return fail(
            'empty_set',
            `"${scope.set.id}" is empty. Ask the user to lasso some points, or call select first.`,
            { call: 'read_state' },
          );
        }
        session.explained = true;
        const at = centroid(store, indices);
        if (!at) {
          return fail(
            'not_projected',
            `None of those individuals are projected onto the "${store.basis}" basis.`,
            { call: 'set_basis', args: { basis: 'global' } },
          );
        }
        const outliers = populationOutliers(store, indices, {
          limit: 10,
          minPopulationSize: 3,
        });
        const rowCount = args.rows as number;
        return ok(
          {
            set: scope.set.id,
            n: indices.length,
            selectedBy: scope.set.id === 'selection' ? store.selectionSource : undefined,
            basis: store.basis,
            summary: summarise(store, indices, { topN: 6 }),
            centroid: [Number(at.pc1.toFixed(2)), Number(at.pc2.toFixed(2))],
            nearestPopulations: nearestPopulations(store, at, {
              limit: args.nearest as number,
              minSamples: 3,
              era: args.era as 'ancient' | 'present' | 'both',
            }).map((p) => ({
              population: p.population,
              era: p.era,
              n: p.sampleCount,
              distance: Number(p.distance.toFixed(2)),
            })),
            outliersWithin: outliers.map((o) => ({
              geneticId: o.geneticId,
              population: o.population,
              spreads: Number(o.ratio.toFixed(2)),
            })),
            ...(rowCount > 0 ? (rows(store, indices, rowCount) as object) : {}),
          },
          { scanned: indices.length },
        );
      },
    },

    {
      name: 'note',
      title: 'Accrete · write a finding down',
      description:
        'Write a finding into the shared journal, optionally attached to a set. It appears in '
        + 'the sidebar, survives reload, is returned by read_state, and goes into the CSV '
        + 'export.\n'
        + 'Returns: the stored note.\n'
        + 'Use when: you and the user have worked something out. A session that leaves no '
        + 'record was half wasted — write the conclusion down before moving on.\n'
        + 'Changes: the notes list in the sidebar.',
      annotations: { untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The finding, in one or two sentences, e.g. "Tep006 sits 4.3 spreads from the '
              + 'Turkey_N centroid, toward the Iranian cline."',
          },
          about: {
            type: 'string',
            description: 'A set handle the finding is about, e.g. "selection" or "s3".',
          },
          kind: {
            type: 'string',
            description: 'Classify the finding.',
            enum: ['observation', 'hypothesis', 'caveat'],
            default: 'observation',
          },
          status: {
            type: 'string',
            description: 'Research status for the finding.',
            enum: ['open', 'supported', 'rejected'],
            default: 'open',
          },
          tags: {
            type: 'array',
            description: 'Up to eight short search tags.',
            items: { type: 'string' },
            maxItems: 8,
          },
        },
        required: ['text'],
      },
      execute: (args) => {
        const text = (args.text as string).trim();
        if (text.length < 3) return fail('empty_note', 'The note text is empty.');
        session.noted = true;
        const about = args.about === undefined ? null : String(args.about);
        const note = store.addNote(text, about, 'agent', {
          kind: args.kind as 'observation' | 'hypothesis' | 'caveat',
          status: args.status as 'open' | 'supported' | 'rejected',
          tags: args.tags as string[] | undefined,
        });
        panels.showTab('agent');
        return ok(
          { id: note.id, about: note.about, text: note.text, total: store.notes.length },
          { did: ['wrote a note into the shared journal'] },
        );
      },
    },
  ];

  // --- dynamically scoped ---------------------------------------------------
  // The surface itself is state. A tool that is registered says something is possible now.

  if (store.canUndo) {
    tools.push({
      name: 'undo',
      title: 'View · undo the last change',
      description:
        'Reverse the last change to the view or selection, whoever made it.\n'
        + 'Returns: the restored state.\n'
        + 'Use when: a filter you applied was wrong. Prefer set_filter with dryRun so you do '
        + 'not need this.\n'
        + 'Changes: restores the previous filters, basis and selection.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const done = store.undo('agent');
        return ok(
          { undone: done, visible: store.visible.length },
          { did: done ? ['undid the last change'] : [] },
        );
      },
    });
  }

  if (store.selection.size > 0) {
    tools.push({
      name: 'read_selection',
      title: 'Read · what the user is pointing at',
      description:
        'Return the individuals the user has selected by lasso, click or map box. This '
        + 'selection exists only in the browser — it is a gesture, not a query any server '
        + 'could answer — which is why it has to be handed over as a tool.\n'
        + 'Returns: the individual records plus a summary.\n'
        + 'Use when: the user says "these", "those" or "this one". Prefer explain_set for the '
        + 'analysis; use this when you need the raw records.\n'
        + 'Changes: nothing.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: `How many records to include. 1-${MAX_SET_ROWS}, default 20.`,
            minimum: 1,
            maximum: MAX_SET_ROWS,
            default: 20,
          },
        },
      },
      execute: (args) => {
        const indices = [...store.selection];
        return ok(
          {
            selectedBy: store.selectionSource,
            summary: summarise(store, indices, { topN: 5 }),
            ...(rows(store, indices, args.limit as number) as object),
          },
          { scanned: indices.length },
        );
      },
    });
  }

  if (store.sets.named.length >= 2) {
    tools.push({
      name: 'compare_sets',
      title: 'Explain · two saved sets against each other',
      description:
        'Compare two named sets descriptively: PCA centroids and spread, time, quality, overlap, '
        + 'and the largest population-share differences. Optionally show the A/B overlay in every panel. '
        + 'Use when testing how two saved cohorts differ; results are exploratory, not a significance test.',
      annotations: { untrustedContentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'string', description: 'First saved set handle.' },
          b: { type: 'string', description: 'Second saved set handle.' },
          show: { type: 'boolean', description: 'Show the A/B overlay and comparison tab.', default: false },
        },
        required: ['a', 'b'],
      },
      execute: (args) => {
        const left = lookup(store, args.a);
        if (!left.ok) return left.outcome;
        const right = lookup(store, args.b);
        if (!right.ok) return right.outcome;
        const comparison = compareSetSummaries(store, left.set.indices, right.set.indices);
        const pooled = comparison.a.pca && comparison.b.pca
          ? (comparison.a.pca.spread + comparison.b.pca.spread) / 2 || 1
          : null;
        const did: string[] = [];
        if (args.show === true) {
          store.setComparison(left.set.id, right.set.id, 'agent');
          panels.showTab('compare');
          did.push(`showed ${left.set.label} as A and ${right.set.label} as B`);
        }
        return ok(
          {
            basis: store.basis,
            a: { set: left.set.id, label: left.set.label, ...comparison.a },
            b: { set: right.set.id, label: right.set.label, ...comparison.b },
            overlap: comparison.overlap,
            pca: comparison.pca
              ? {
                  ...comparison.pca,
                  inPooledSpreads: pooled ? comparison.pca.centroidDistance / pooled : null,
                }
              : null,
            date: comparison.date,
            populationDifferences: comparison.populationDifferences,
            caveat: 'Descriptive comparison only; PCA distance is not an ancestry proportion or significance test.',
          },
          { did, scanned: left.set.indices.length + right.set.indices.length },
        );
      },
    });
  }

  return tools;
}

/** Dormant tools are signposts, not absences: they say what exists and how to unlock it. */
function dormantTools(store: Store): { tool: string; availableWhen: string }[] {
  const out: { tool: string; availableWhen: string }[] = [];
  if (!store.canUndo) out.push({ tool: 'undo', availableWhen: 'anything has been changed' });
  if (store.selection.size === 0) {
    out.push({ tool: 'read_selection', availableWhen: 'the user has selected individuals' });
  }
  if (store.sets.named.length < 2) {
    out.push({ tool: 'compare_sets', availableWhen: 'two or more sets have been saved by name' });
  }
  return out;
}

export { REGIONS };
