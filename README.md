# PaleoScope

PaleoScope is a local-first workbench for exploring 22,202 ancient and present-day individuals
from the Allen Ancient DNA Resource (AADR) v66.p1. Its map, PCA plots, timeline, table, cohorts
and research notes share one state. A person can work visually while a browser agent reads and
continues from the same visible context through WebMCP.

There is no backend and no runtime package dependency. Imported data stays in the current
browser tab unless the user exports a workspace.

## What it does

- Filters samples by population, place, date, coverage, haplogroup, sex, assessment and source.
- Compares cohorts across the map, two PCA bases and the timeline.
- Finds samples, populations, publications, neighbours and outliers.
- Saves cohorts and structured findings, then exports data, workspaces or Markdown reports.
- Overlays local CSV, TSV or EIGENVEC-style samples without uploading them.

## WebMCP

WebMCP is a progressive enhancement: the full interface still works when
`document.modelContext` is unavailable. PaleoScope exposes 22 imperative tools and three
declarative export forms.

| Purpose | Tools |
| --- | --- |
| Inspect | `read_state`, `read_plot`, `read_timeline`, `read_population_profile`, `read_sample`, `read_selection` |
| Find and build | `find_populations`, `find_publications`, `build_cohort`, `find_outliers`, `find_neighbours` |
| Change the shared view | `set_filter`, `set_basis`, `clear_filters`, `focus_sample`, `select`, `undo` |
| Research | `save_set`, `combine_sets`, `explain_set`, `compare_sets`, `note` |
| Visible exports | `export_data`, `export_workspace`, `export_research_report` |

The tool set changes with page state: for example, `undo`, `read_selection` and `compare_sets`
appear only when they can be used. Imperative tools are removed with `AbortController` cleanup.
The export tools reuse visible HTML forms and do not use `toolautosubmit`, so downloads remain
under user control.

Tool arguments are validated in application code, including rejection of undeclared fields.
Read-only and externally sourced results are annotated, outputs are compact, and tools are not
shared with cross-origin frames. Deployment headers keep the surface same-origin:

```text
Origin-Agent-Cluster: ?1
Permissions-Policy: tools=(self)
```

Local file selection is never exposed as a tool.

## Run

Requires Node.js 22.6 or newer, because the test runner relies on
`--experimental-strip-types`. Any of npm, pnpm or yarn works; the commands below use pnpm
only because `pnpm-lock.yaml` is the committed lockfile.

```sh
pnpm install   # or: npm install
pnpm dev       # or: npm run dev
```

WebMCP is experimental. For local testing, enable
`chrome://flags/#enable-webmcp-testing` in Chrome and relaunch the browser. A public deployment
can use an origin-bound trial token during the build:

```sh
VITE_ORIGIN_TRIAL_TOKEN=your-token pnpm build
```

## Test

```sh
pnpm test    # node:test suites under tests/
pnpm lint    # oxlint alone
pnpm check   # oxlint plus tsc --noEmit
pnpm build
```

The 25-case WebMCP eval set covers direct requests, ambiguous intent and multi-tool sequences.
Start the built app, then run the evals from another terminal:

```sh
pnpm preview
pnpm evals
```

## Data and limits

The bundled dataset is AADR v66.p1 (`compatibility_HO`, 276,725 SNPs), released under CC0 1.0:
[doi:10.7910/DVN/FFIDCW](https://doi.org/10.7910/DVN/FFIDCW). The build pipeline and expected raw
filenames are documented in [`pipeline/build_dataset.py`](pipeline/build_dataset.py); run it
through `pnpm data`. That step is the only one that needs Python and
[uv](https://docs.astral.sh/uv/) — day-to-day development uses the committed
`public/data/aadr.json` and needs neither.

PCA proximity and cohort summaries are exploratory descriptions. They are not ancestry
estimates, continuity tests or causal claims. Individual samples must be cited to their original
publications.

Application code is licensed under the [MIT License](LICENSE).
