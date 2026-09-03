# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""
Build PaleoScope's browser dataset from the Allen Ancient DNA Resource (AADR).

Source data (CC0 1.0, Harvard Dataverse doi:10.7910/DVN/FFIDCW, release v66.p1):
  v66.p1_compatibility_HO.aadr.PUB.anno         individual annotations
  v66.p1_compatibility_HO.aadr.patch.PUB.ind    individual order matching .geno rows
  v66.p1_compatibility_HO.aadr.patch.PUB.geno   genotypes, 'transpose_packed' (TGENO)

What this does
--------------
1. Parses the .anno file and selects
     (a) a present-day reference panel that defines the PCA basis, capped per
         population so no single over-sampled group dominates the axes, and
     (b) the ancient individuals to project onto that basis.
2. Reads only the needed rows out of the TGENO file. TGENO is individual-major:
     48-byte ASCII header, then one fixed-length row per individual holding
     2 bits per SNP, so a single seek yields one individual's whole genotype
     vector. Verified: 48 + 27594 * 69182 == 1909008156 bytes exactly.
3. Computes a PCA on the reference panel using Patterson et al. (2006)
     normalisation, streaming the SNPs in blocks and accumulating a Gram
     matrix, then derives per-SNP loadings and projects every ancient
     individual onto them.
4. Emits a compact columnar dataset for the web app.

Projection caveat, stated plainly: ancient individuals are projected with
per-sample rescaling for missing genotypes (score * nSnpsUsed_total /
nSnpsObserved), not smartpca's least-squares `lsqproject`. Projected samples
are therefore shrunk slightly toward the origin relative to the reference
panel. This is a visualisation, not a substitute for a published analysis.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# --- .anno column indices (v66.p1 compatibility_HO) --------------------------
COL = {
    "genetic_id": 0,
    "persistent_id": 1,
    "individual_id": 2,
    "publication": 6,
    "doi": 7,
    "date_method": 9,
    "date_mean_bp": 10,
    "date_sd_bp": 11,
    "full_date": 12,
    "group_id": 14,
    "locality": 15,
    "polity": 16,
    "latitude": 17,
    "longitude": 18,
    "data_type": 21,
    "snps_hit": 29,
    "molecular_sex": 30,
    "y_haplogroup": 35,
    "mt_haplogroup": 38,
    "assessment": 47,
}

MISSING = {"", "..", "...", "n/a", "N/A", "NA", "-", ".."}

# Non-human / ancestral reference sequences bundled in the AADR.
REF_GROUP_MARKERS = ("Chimp", "Gorilla", "Ancestor", "Href", "Denisov", "Neander")

# The conventional "West Eurasian" PCA frame.
WEST_EURASIA = dict(lon=(-25.0, 80.0), lat=(20.0, 75.0))


def clean(value: str) -> str:
    value = value.strip()
    return "" if value in MISSING else value


def as_float(value: str) -> float | None:
    value = clean(value)
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def as_int(value: str) -> int | None:
    f = as_float(value)
    return None if f is None else int(round(f))


@dataclass
class Sample:
    row: int              # row index in the .geno file
    genetic_id: str
    group_id: str
    locality: str
    polity: str
    publication: str
    doi: str
    full_date: str
    date_method: str
    y_haplogroup: str
    mt_haplogroup: str
    molecular_sex: str
    assessment: str
    lat: float | None
    lon: float | None
    date_bp: int | None
    date_sd: int | None
    snps_hit: int
    is_ancient: bool
    in_west_eurasia: bool
    pcs: dict[str, list[float]] = field(default_factory=dict)
    in_panel: dict[str, bool] = field(default_factory=dict)


# --- TGENO reader ------------------------------------------------------------

class TGeno:
    """Reader for the AADR 'transpose_packed' genotype format."""

    HEADER_BYTES = 48

    def __init__(self, path: Path):
        self.path = path
        self.handle = path.open("rb")
        header = self.handle.read(self.HEADER_BYTES)
        # e.g. b"TGENO   27594  276725 8c17d6d1 e42ba255" -- magic, counts, then two hashes.
        tokens = header.split()
        if not tokens or tokens[0] != b"TGENO":
            raise ValueError(f"{path.name}: expected a TGENO header, found {header[:16]!r}")
        self.n_individuals = int(tokens[1])
        self.n_snps = int(tokens[2])
        self.row_bytes = max(self.HEADER_BYTES, (self.n_snps * 2 + 7) // 8)
        expected = self.HEADER_BYTES + self.n_individuals * self.row_bytes
        actual = path.stat().st_size
        if actual != expected:
            raise ValueError(
                f"{path.name}: size {actual} != expected {expected} "
                f"({self.n_individuals} individuals x {self.row_bytes} bytes + header). "
                "The download is probably incomplete."
            )
        # Lookup table unpacking one byte into its four 2-bit genotype codes,
        # most significant bits first.
        table = np.empty((256, 4), dtype=np.uint8)
        codes = np.arange(256, dtype=np.uint8)
        for k in range(4):
            table[:, k] = (codes >> (6 - 2 * k)) & 0b11
        self._table = table

    def read_packed(self, rows: np.ndarray) -> np.ndarray:
        out = np.empty((len(rows), self.row_bytes), dtype=np.uint8)
        for i, row in enumerate(rows):
            self.handle.seek(self.HEADER_BYTES + int(row) * self.row_bytes)
            chunk = self.handle.read(self.row_bytes)
            if len(chunk) != self.row_bytes:
                raise EOFError(f"short read at row {row}")
            out[i] = np.frombuffer(chunk, dtype=np.uint8)
        return out

    def unpack(self, packed: np.ndarray, snp_start: int, snp_stop: int) -> np.ndarray:
        """Unpack SNPs [snp_start, snp_stop) for every row in `packed`.

        Returns int8, values 0/1/2 for allele counts and 3 for missing.
        """
        byte_start, byte_stop = snp_start // 4, (snp_stop + 3) // 4
        window = packed[:, byte_start:byte_stop]
        codes = self._table[window].reshape(window.shape[0], -1)
        offset = snp_start - byte_start * 4
        return codes[:, offset : offset + (snp_stop - snp_start)].astype(np.int8)

    def close(self) -> None:
        self.handle.close()


# --- selection ---------------------------------------------------------------

def load_samples(anno: Path, ind: Path, min_snps: int) -> list[Sample]:
    order = {}
    with ind.open(encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh):
            parts = line.split()
            if parts:
                order[parts[0]] = i

    samples: list[Sample] = []
    seen_individual: set[str] = set()
    with anno.open(newline="", encoding="utf-8", errors="replace") as fh:
        reader = csv.reader(fh, delimiter="\t")
        next(reader, None)
        for record in reader:
            def get(key: str) -> str:
                idx = COL[key]
                return clean(record[idx]) if idx < len(record) else ""

            genetic_id = get("genetic_id")
            row = order.get(genetic_id)
            if row is None:
                continue

            group_id = get("group_id")
            if any(marker in group_id for marker in REF_GROUP_MARKERS):
                continue
            if group_id.startswith("Ignore_"):
                continue
            # The AADR README asks that individuals it has flagged be filtered out of primary
            # analyses. "QCremove" is an explicit quality-control removal flag, and leaving
            # those individuals in lets samples the curators rejected set the axis limits.
            # Groups suffixed "-o" (outliers within their cluster) are deliberately KEPT:
            # finding those is what this workbench is for.
            if "QCremove" in group_id:
                continue

            snps_hit = as_int(record[COL["snps_hit"]]) or 0
            if snps_hit < min_snps:
                continue

            # One representative per physical individual: keep the best covered.
            individual_id = get("individual_id") or genetic_id
            if individual_id in seen_individual:
                continue

            date_bp = as_int(record[COL["date_mean_bp"]])
            lat = as_float(record[COL["latitude"]])
            lon = as_float(record[COL["longitude"]])
            in_we = (
                lat is not None
                and lon is not None
                and WEST_EURASIA["lon"][0] <= lon <= WEST_EURASIA["lon"][1]
                and WEST_EURASIA["lat"][0] <= lat <= WEST_EURASIA["lat"][1]
            )
            seen_individual.add(individual_id)
            samples.append(
                Sample(
                    row=row,
                    genetic_id=genetic_id,
                    group_id=group_id,
                    locality=get("locality"),
                    polity=get("polity"),
                    publication=get("publication"),
                    doi=get("doi"),
                    full_date=get("full_date"),
                    date_method=get("date_method"),
                    y_haplogroup=get("y_haplogroup"),
                    mt_haplogroup=get("mt_haplogroup"),
                    molecular_sex=get("molecular_sex"),
                    assessment=get("assessment"),
                    lat=lat,
                    lon=lon,
                    date_bp=date_bp,
                    date_sd=as_int(record[COL["date_sd_bp"]]),
                    snps_hit=snps_hit,
                    is_ancient=bool(date_bp),
                    in_west_eurasia=bool(in_we),
                )
            )
    return samples


def pick_reference_panel(
    samples: list[Sample], cap_per_group: int, west_eurasia_only: bool
) -> list[Sample]:
    candidates = [s for s in samples if not s.is_ancient and s.lat is not None]
    if west_eurasia_only:
        candidates = [s for s in candidates if s.in_west_eurasia]
    # Best-covered individuals first, so the cap keeps the most informative ones.
    candidates.sort(key=lambda s: -s.snps_hit)
    kept: list[Sample] = []
    per_group: Counter[str] = Counter()
    for s in candidates:
        if per_group[s.group_id] >= cap_per_group:
            continue
        per_group[s.group_id] += 1
        kept.append(s)
    kept.sort(key=lambda s: s.row)
    return kept


# --- PCA ---------------------------------------------------------------------

def normalise_block(block: np.ndarray, freq: np.ndarray) -> np.ndarray:
    """Patterson normalisation. `block` is int8 (0/1/2/3), missing -> 0."""
    observed = block != 3
    counts = np.where(observed, block, 0).astype(np.float32)
    scale = np.sqrt(freq * (1.0 - freq), dtype=np.float32)
    centred = (counts - 2.0 * freq) / scale
    centred[~observed] = 0.0
    return centred, observed


def compute_basis(
    geno: TGeno,
    panel: list[Sample],
    n_components: int,
    block_size: int,
    label: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rows = np.array([s.row for s in panel], dtype=np.int64)
    log(f"[{label}] reading {len(rows)} reference rows ({len(rows) * geno.row_bytes / 1e6:.0f} MB)")
    packed = geno.read_packed(rows)

    freq = np.empty(geno.n_snps, dtype=np.float32)
    n_obs = np.empty(geno.n_snps, dtype=np.int32)
    for start in range(0, geno.n_snps, block_size):
        stop = min(start + block_size, geno.n_snps)
        block = geno.unpack(packed, start, stop)
        observed = block != 3
        counts = np.where(observed, block, 0).astype(np.float32)
        obs = observed.sum(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            freq[start:stop] = counts.sum(axis=0) / (2.0 * np.maximum(obs, 1))
        n_obs[start:stop] = obs
    usable = (n_obs >= max(10, len(rows) // 10)) & (freq > 0.01) & (freq < 0.99)
    log(f"[{label}] usable SNPs: {int(usable.sum())} / {geno.n_snps}")

    n = len(rows)
    gram = np.zeros((n, n), dtype=np.float32)
    for start in range(0, geno.n_snps, block_size):
        stop = min(start + block_size, geno.n_snps)
        mask = usable[start:stop]
        if not mask.any():
            continue
        block = geno.unpack(packed, start, stop)[:, mask]
        z, _ = normalise_block(block, freq[start:stop][mask])
        gram += z @ z.T
    total_usable = int(usable.sum())
    gram /= float(total_usable)

    eigenvalues, eigenvectors = np.linalg.eigh(gram.astype(np.float64))
    order = np.argsort(eigenvalues)[::-1][:n_components]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]
    # Scale matters, and getting it wrong is silent. Projection computes z @ V where
    # V = Z^T U / sqrt(m*lambda), so for a panel member it yields U * sqrt(m*lambda). The
    # panel's own scores must use the same convention or projected and reference individuals
    # land on scales that differ by sqrt(m) -- about 445x here -- and every centroid mixing
    # the two becomes meaningless. `verify_structure` exists to catch exactly this.
    scores = eigenvectors * np.sqrt(np.maximum(eigenvalues * total_usable, 1e-12))
    variance = eigenvalues / max(float(np.trace(gram.astype(np.float64))), 1e-12)
    log(f"[{label}] variance explained: "
        + ", ".join(f"PC{i+1}={v*100:.2f}%" for i, v in enumerate(variance[:6])))

    inv_sigma = 1.0 / np.sqrt(np.maximum(eigenvalues * total_usable, 1e-12))
    loadings = np.zeros((geno.n_snps, n_components), dtype=np.float32)
    u = eigenvectors.astype(np.float32)
    for start in range(0, geno.n_snps, block_size):
        stop = min(start + block_size, geno.n_snps)
        mask = usable[start:stop]
        if not mask.any():
            continue
        block = geno.unpack(packed, start, stop)[:, mask]
        z, _ = normalise_block(block, freq[start:stop][mask])
        idx = np.nonzero(mask)[0] + start
        loadings[idx] = (z.T @ u) * inv_sigma.astype(np.float32)

    del packed
    return scores, loadings, freq, usable


def project(
    geno: TGeno,
    targets: list[Sample],
    loadings: np.ndarray,
    freq: np.ndarray,
    usable: np.ndarray,
    block_size: int,
    chunk: int,
    label: str,
) -> np.ndarray:
    n_components = loadings.shape[1]
    out = np.zeros((len(targets), n_components), dtype=np.float32)
    total_usable = int(usable.sum())
    rows = np.array([s.row for s in targets], dtype=np.int64)
    started = time.time()
    for offset in range(0, len(rows), chunk):
        piece = rows[offset : offset + chunk]
        packed = geno.read_packed(piece)
        acc = np.zeros((len(piece), n_components), dtype=np.float32)
        seen = np.zeros(len(piece), dtype=np.float32)
        for start in range(0, geno.n_snps, block_size):
            stop = min(start + block_size, geno.n_snps)
            mask = usable[start:stop]
            if not mask.any():
                continue
            block = geno.unpack(packed, start, stop)[:, mask]
            z, observed = normalise_block(block, freq[start:stop][mask])
            acc += z @ loadings[start:stop][mask]
            seen += observed.sum(axis=1).astype(np.float32)
        # Missing calls would otherwise shrink projected scores toward zero.
        out[offset : offset + len(piece)] = acc * (total_usable / np.maximum(seen, 1.0))[:, None]
        done = offset + len(piece)
        rate = done / max(time.time() - started, 1e-6)
        log(f"[{label}] projected {done}/{len(rows)} ({rate:.0f}/s)")
    return out


# --- output ------------------------------------------------------------------

DICT_COLUMNS = {
    "group": lambda s: s.group_id,
    "polity": lambda s: s.polity,
    "publication": lambda s: s.publication,
    "doi": lambda s: s.doi,
    "dateMethod": lambda s: s.date_method,
    "locality": lambda s: s.locality,
    "yHaplogroup": lambda s: s.y_haplogroup,
    "mtHaplogroup": lambda s: s.mt_haplogroup,
    "molecularSex": lambda s: s.molecular_sex,
    "assessment": lambda s: s.assessment,
}


def encode(values: list[str]) -> tuple[list[str], list[int]]:
    index: dict[str, int] = {}
    out: list[int] = []
    for value in values:
        slot = index.get(value)
        if slot is None:
            slot = index[value] = len(index)
        out.append(slot)
    return list(index), out


LANDMARKS = {
    "global": [
        "Yoruba", "Mbuti", "Han", "Papuan", "French", "Sardinian", "Karitiana", "Onge",
    ],
    "we": [
        "Sardinian", "Basque", "Finnish", "Russian", "BedouinA", "Druze", "Armenian",
        "Luxembourg_Loschbour_Mesolithic", "Israel_Natufian", "Iran_GanjDareh_N",
        "Turkey_N", "Russia_Samara_EBA_Yamnaya",
    ],
}

# Qualitative relationships that hold in every published human PCA. They are deliberately
# coarse: the point is to catch a broken pipeline, not to re-derive population history.
EXPECTED = [
    ("global", "Yoruba", "Han", "French", "Sardinian",
     "Africa-to-East-Asia spans further than two European populations"),
    ("we", "Luxembourg_Loschbour_Mesolithic", "Israel_Natufian", "Sardinian", "Basque",
     "Western hunter-gatherer to Natufian spans further than Sardinian to Basque"),
]


def centroids(samples: list[Sample], basis: str, labels: list[str]) -> dict[str, tuple[int, float, float]]:
    out: dict[str, tuple[int, float, float]] = {}
    for label in labels:
        points = [s.pcs[basis] for s in samples if s.group_id == label and basis in s.pcs]
        if not points:
            continue
        array = np.array(points, dtype=np.float64)
        out[label] = (len(points), float(array[:, 0].mean()), float(array[:, 1].mean()))
    return out


def verify_structure(samples: list[Sample], bases: list[str]) -> bool:
    """Check the PCA against population structure that is not in dispute.

    A scale mismatch between reference and projected individuals is invisible in the variance
    numbers and obvious here, so this runs on every build.
    """
    ok = True
    table: dict[str, dict[str, tuple[int, float, float]]] = {}
    for basis in bases:
        table[basis] = centroids(samples, basis, LANDMARKS.get(basis, []))
        log(f"[verify] {basis} basis landmark centroids (PC1, PC2):")
        for label, (n, pc1, pc2) in table[basis].items():
            log(f"[verify]   {label:34s} n={n:5d}  {pc1:+10.3f}  {pc2:+10.3f}")
        missing = [l for l in LANDMARKS.get(basis, []) if l not in table[basis]]
        if missing:
            log(f"[verify]   absent from this basis: {', '.join(missing)}")

    def distance(basis: str, a: str, b: str) -> float | None:
        pair = table[basis]
        if a not in pair or b not in pair:
            return None
        _, ax, ay = pair[a]
        _, bx, by = pair[b]
        return float(np.hypot(ax - bx, ay - by))

    for basis, a, b, c, d, why in EXPECTED:
        if basis not in table:
            continue
        far, near = distance(basis, a, b), distance(basis, c, d)
        if far is None or near is None:
            log(f"[verify] SKIP  ({basis}) {why}: a landmark is missing")
            continue
        if far > near:
            log(f"[verify] PASS  ({basis}) {why}  [{far:.1f} > {near:.1f}]")
        else:
            log(f"[verify] FAIL  ({basis}) {why}  [{far:.1f} <= {near:.1f}]")
            ok = False

    # A large median-spread ratio reveals the otherwise silent reference/projection scale bug.
    for basis in bases:
        panel, projected = [], []
        for s in samples:
            if s.is_ancient or basis not in s.pcs:
                continue
            (panel if s.in_panel.get(basis) else projected).append(abs(s.pcs[basis][0]))
        if len(panel) > 30 and len(projected) > 30:
            a, b = float(np.median(panel)), float(np.median(projected))
            ratio = max(a, b) / max(min(a, b), 1e-9)
            verdict = "PASS" if ratio < 3.0 else "FAIL"
            if verdict == "FAIL":
                ok = False
            log(f"[verify] {verdict}  ({basis}) reference/projected |PC1| medians agree: "
                f"{a:.3f} vs {b:.3f} (ratio {ratio:.2f}, want < 3)")
    return ok


def write_dataset(samples: list[Sample], bases: list[str], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    dictionaries: dict[str, list[str]] = {}
    columns: dict[str, object] = {}
    for name, accessor in DICT_COLUMNS.items():
        vocabulary, indices = encode([accessor(s) for s in samples])
        dictionaries[name] = vocabulary
        columns[name] = indices

    def rounded(values, digits):
        return [None if v is None else round(float(v), digits) for v in values]

    columns["geneticId"] = [s.genetic_id for s in samples]
    columns["fullDate"] = [s.full_date for s in samples]
    columns["lat"] = rounded([s.lat for s in samples], 4)
    columns["lon"] = rounded([s.lon for s in samples], 4)
    columns["dateBP"] = [s.date_bp for s in samples]
    columns["dateSD"] = [s.date_sd for s in samples]
    columns["snpsHit"] = [s.snps_hit for s in samples]
    columns["isAncient"] = [1 if s.is_ancient else 0 for s in samples]
    for basis in bases:
        columns[basis] = [
            rounded([(s.pcs.get(basis) or [None] * 4)[k] for s in samples], 3)
            for k in range(4)
        ]

    payload = {
        "source": {
            "name": "Allen Ancient DNA Resource (AADR)",
            "release": "v66.p1",
            "panel": "compatibility_HO (276,725 SNPs)",
            "doi": "10.7910/DVN/FFIDCW",
            "license": "CC0 1.0",
            "url": "https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/FFIDCW",
            "citation": (
                "Mallick S, Micco A, Mah M, et al. The Allen Ancient DNA Resource (AADR): "
                "a curated compendium of ancient human genomes. Scientific Data 11, 182 (2024). "
                "Individual samples must additionally be cited to their original publications, "
                "which are recorded per sample in this dataset."
            ),
        },
        "pca": {
            "method": (
                "Patterson et al. (2006) normalisation. PCA computed on a present-day reference "
                "panel capped per population; ancient individuals projected onto the resulting "
                "SNP loadings with per-sample rescaling for missing genotypes. Projected samples "
                "are shrunk slightly toward the origin relative to the reference panel, and this "
                "is a visualisation rather than a substitute for a published analysis."
            ),
            "bases": bases,
            "basisLabels": {"we": "West Eurasian", "global": "Worldwide"},
        },
        "count": len(samples),
        "dictionaries": dictionaries,
        "columns": columns,
    }

    target = out_dir / "aadr.json"
    target.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {target} ({target.stat().st_size / 1e6:.1f} MB, {len(samples)} samples)")


def log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True, help="directory holding the AADR files")
    parser.add_argument("--out", type=Path, default=Path("public/data"))
    parser.add_argument("--anno", default="compatHO.anno")
    parser.add_argument("--ind", default="compatHO.ind")
    parser.add_argument("--geno", default="compatHO.geno")
    parser.add_argument("--min-snps", type=int, default=15000)
    parser.add_argument("--panel-min", type=int, default=50,
                        help="minimum reference-panel size before a basis is skipped")
    parser.add_argument("--components", type=int, default=4)
    parser.add_argument("--block-size", type=int, default=16384)
    parser.add_argument("--chunk", type=int, default=400)
    parser.add_argument("--cap-west", type=int, default=20)
    parser.add_argument("--cap-global", type=int, default=12)
    parser.add_argument("--max-targets", type=int, default=0,
                        help="cap the number of projected individuals (0 = all); for smoke tests")
    args = parser.parse_args()

    samples = load_samples(args.raw / args.anno, args.raw / args.ind, args.min_snps)
    ancient = sum(s.is_ancient for s in samples)
    log(f"selected {len(samples)} individuals ({ancient} ancient, {len(samples) - ancient} present-day)")

    geno = TGeno(args.raw / args.geno)
    log(f"TGENO: {geno.n_individuals} individuals x {geno.n_snps} SNPs, row {geno.row_bytes} B")

    bases = []
    for label, cap, we_only in (("we", args.cap_west, True), ("global", args.cap_global, False)):
        panel = pick_reference_panel(samples, cap, we_only)
        if len(panel) < args.panel_min:
            log(f"[{label}] skipped: only {len(panel)} reference individuals")
            continue
        log(f"[{label}] reference panel: {len(panel)} present-day individuals, "
            f"{len({s.group_id for s in panel})} populations")
        scores, loadings, freq, usable = compute_basis(
            geno, panel, args.components, args.block_size, label
        )
        for s, score in zip(panel, scores):
            s.pcs[label] = [float(x) for x in score]
            s.in_panel[label] = True

        targets = [s for s in samples if label not in s.pcs]
        if label == "we":
            targets = [s for s in targets if s.in_west_eurasia]
        if args.max_targets:
            targets = targets[: args.max_targets]
        projected = project(
            geno, targets, loadings, freq, usable, args.block_size, args.chunk, label
        )
        for s, score in zip(targets, projected):
            s.pcs[label] = [float(x) for x in score]
        bases.append(label)

    geno.close()
    healthy = verify_structure(samples, bases)
    write_dataset(samples, bases, args.out)
    if not healthy:
        log('[verify] one or more structural checks FAILED -- do not ship this dataset')
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
