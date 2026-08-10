#!/usr/bin/env python3
"""Haalt maandgemiddelde zeewatertemperatuur op voor een aantal Noordzee-punten.

Bron is NOAA OISST v2.1 (Optimum Interpolation SST, 0,25 graden). NOAA
publiceert de maandgemiddelden kant-en-klaar, dus we halen die op in plaats
van tweeduizend dagwaarden zelf te middelen:

  * sst.mon.mean.nc      — maandgemiddelden vanaf september 1981
  * sst.mon.ltm.1991-2020.nc — het normaal per maand over 1991-2020

Beide staan op de OPeNDAP-server van NOAA PSL. Die rekent per *tijdstap* en
niet per roostercel: één cel over twaalf maanden duurt even lang als 432
cellen over twaalf maanden. We halen daarom in één keer een rechthoek op die
alle locaties omvat en knippen die lokaal uit. De proxy geeft wel een 502 op
te grote requests, dus de reeks gaat er in stukken door.

De lopende maand staat nog niet in het maandbestand. Die vullen we aan met de
dagwaarden tot nu toe, van NCEI ERDDAP, en markeren we als onvolledig.

Alleen standaardbibliotheek, geen API-sleutel.

Gebruik:
    python fetch_sst.py            # alles ophalen
    python fetch_sst.py --probe    # controleer of de punten op zee liggen
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time as _time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

PSL = "https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres"
MONTHLY_FILE = "sst.mon.mean.nc"
LTM_FILE = "sst.mon.ltm.1991-2020.nc"
PSL_EPOCH = date(1800, 1, 1)  # de tijd-as telt dagen vanaf hier
CHUNK = 36  # tijdstappen per request; groter geeft de PSL-proxy een 502

ERDDAP = "https://www.ncei.noaa.gov/erddap"
DS_FINAL = "ncdc_oisst_v2_avhrr_by_time_zlev_lat_lon"
DS_PRELIM = "ncdc_oisst_v2_avhrr_prelim_by_time_zlev_lat_lon"

CLIM_PERIOD = [1991, 2020]
PLOT_YEARS = 5  # zoveel afgelopen jaren krijgen een eigen gekleurde lijn

# OISST-rooster: lat vanaf -89,875 / lon vanaf 0,125, stap 0,25 graden.
GRID_STEP = 0.25
LAT0, LON0 = -89.875, 0.125
FILL = -900.0  # alles daaronder is de vulwaarde voor land

LOCATIONS = [
    {"slug": "belgische-kust", "name": "Belgische kust",
     "sub": "voor Oostende", "lat": 51.375, "lon": 2.875},
    {"slug": "zeeuwse-kust", "name": "Zeeuwse kust",
     "sub": "voor Westkapelle", "lat": 51.625, "lon": 3.375},
    {"slug": "hollandse-kust", "name": "Hollandse kust",
     "sub": "voor Scheveningen", "lat": 52.125, "lon": 4.125},
    {"slug": "waddenkust", "name": "Waddenkust",
     "sub": "voor Texel", "lat": 53.125, "lon": 4.375},
    {"slug": "nauw-van-calais", "name": "Nauw van Calais",
     "sub": "tussen Calais en Dover", "lat": 51.125, "lon": 1.625},
    {"slug": "doggersbank", "name": "Doggersbank",
     "sub": "centrale Noordzee", "lat": 54.875, "lon": 2.875},
    {"slug": "noordelijke-noordzee", "name": "Noordelijke Noordzee",
     "sub": "ten oosten van Shetland", "lat": 59.875, "lon": 1.625},
]

Cell = tuple[int, int]


def lat_index(lat: float) -> int:
    return round((lat - LAT0) / GRID_STEP)


def lon_index(lon: float) -> int:
    return round((lon % 360.0 - LON0) / GRID_STEP)


def cell_of(loc: dict) -> Cell:
    """Rooster-index als sleutel: floats uit twee servers matchen anders niet."""
    return lat_index(loc["lat"]), lon_index(loc["lon"])


def box() -> tuple[int, int, int, int]:
    lats = [lat_index(l["lat"]) for l in LOCATIONS]
    lons = [lon_index(l["lon"]) for l in LOCATIONS]
    return min(lats), max(lats), min(lons), max(lons)


def fetch(url: str, attempts: int = 4) -> str:
    last: Exception | None = None
    for n in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "noordzee-sst/1.0"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            if n < attempts - 1:
                _time.sleep(4 * (n + 1))
    raise RuntimeError(f"ophalen mislukt na {attempts} pogingen: {url}") from last


# ── NOAA PSL: maandgemiddelden en normaal ────────────────────────────────────

def parse_ascii(body: str, n_lat: int, n_lon: int) -> list[list[float]]:
    """Geeft per tijdstap een vlakke lijst van n_lat*n_lon waarden."""
    if body.lstrip().startswith("Error") or "<html" in body[:200].lower():
        raise RuntimeError(body.strip()[:200])

    steps: list[list[float]] = []
    started = False
    for raw in body.splitlines():
        line = raw.strip()
        if not started:
            started = line.startswith("sst.sst[")
            continue
        if not line or "," not in line or not line.startswith("["):
            break  # lege regel sluit het datablok af; daarna volgen time/lat/lon
        head, _, tail = line.partition(",")
        t = int(head[1:head.index("]")])
        while len(steps) <= t:
            steps.append([])
        steps[t].extend(float(v) for v in tail.split(","))

    if not steps:
        raise RuntimeError("geen waarden in OPeNDAP-antwoord")
    for t, values in enumerate(steps):
        if len(values) != n_lat * n_lon:
            raise RuntimeError(f"tijdstap {t}: {len(values)} waarden, verwacht {n_lat * n_lon}")
    return steps


def psl_box(filename: str, first: int, last: int) -> list[dict[Cell, float]]:
    """Per tijdstap een {cel: waarde}, voor de rechthoek om alle locaties."""
    i0, i1, j0, j1 = box()
    n_lat, n_lon = i1 - i0 + 1, j1 - j0 + 1

    out: list[dict[Cell, float]] = []
    for begin in range(first, last + 1, CHUNK):
        stop = min(begin + CHUNK - 1, last)
        url = (f"{PSL}/{filename}.ascii"
               f"?sst%5B{begin}:1:{stop}%5D%5B{i0}:1:{i1}%5D%5B{j0}:1:{j1}%5D")
        for flat in parse_ascii(fetch(url), n_lat, n_lon):
            out.append({
                (i0 + a, j0 + b): round(flat[a * n_lon + b], 2)
                for a in range(n_lat) for b in range(n_lon)
                if flat[a * n_lon + b] > FILL
            })
        print(f"  {filename}: {len(out)}/{last - first + 1}", flush=True)
    return out


def monthly_axis() -> list[date]:
    """De tijd-as van het maandbestand, als eerste-van-de-maand-datums."""
    body = fetch(f"{PSL}/{MONTHLY_FILE}.ascii?time")
    _, sep, tail = body.partition("---------")
    numbers: list[float] = []
    for line in (tail if sep else body).splitlines():
        line = line.strip()
        if not line or line.startswith("time["):
            continue  # de kopregel met de lengte van de as
        for token in line.split(","):
            try:
                numbers.append(float(token.strip()))
            except ValueError:
                pass
    if not numbers:
        raise RuntimeError("kon de tijd-as van het maandbestand niet lezen")
    return [PSL_EPOCH + timedelta(days=n) for n in numbers]


# ── NCEI ERDDAP: de lopende maand ────────────────────────────────────────────

def erddap_coverage(dataset: str) -> tuple[date, date]:
    span: dict[str, date] = {}
    for row in csv.reader(io.StringIO(fetch(f"{ERDDAP}/info/{dataset}/index.csv"))):
        if len(row) >= 5 and row[2] in ("time_coverage_start", "time_coverage_end"):
            span[row[2]] = datetime.strptime(row[4][:10], "%Y-%m-%d").date()
    if len(span) != 2:
        raise RuntimeError(f"kon de periode van {dataset} niet lezen")
    return span["time_coverage_start"], span["time_coverage_end"]


def erddap_days(dataset: str, start: date, end: date) -> dict[Cell, dict[date, float]]:
    i0, i1, j0, j1 = box()
    lat_lo, lat_hi = LAT0 + i0 * GRID_STEP, LAT0 + i1 * GRID_STEP
    lon_lo, lon_hi = LON0 + j0 * GRID_STEP, LON0 + j1 * GRID_STEP
    query = (f"sst%5B({start}):1:({end})%5D%5B(0.0):1:(0.0)%5D"
             f"%5B({lat_lo}):1:({lat_hi})%5D%5B({lon_lo}):1:({lon_hi})%5D")
    body = fetch(f"{ERDDAP}/griddap/{dataset}.csv?{query}")
    if body.lstrip().startswith("Error"):
        raise RuntimeError(body.strip()[:300])

    out: dict[Cell, dict[date, float]] = {}
    rows = csv.reader(io.StringIO(body))
    next(rows, None)  # kolomnamen
    next(rows, None)  # eenheden
    for row in rows:
        if len(row) < 5 or not row[4] or row[4] == "NaN":
            continue  # NaN = land
        key = (lat_index(float(row[2])), lon_index(float(row[3])))
        day = datetime.strptime(row[0][:10], "%Y-%m-%d").date()
        out.setdefault(key, {})[day] = float(row[4])
    return out


def running_month(first_of_month: date) -> tuple[dict[Cell, float], int]:
    """Gemiddelde per cel over de dagen van de lopende maand, plus het aantal."""
    days: dict[Cell, dict[date, float]] = {}
    for dataset in (DS_FINAL, DS_PRELIM):
        try:
            start, end = erddap_coverage(dataset)
            if end < first_of_month:
                continue
            got = erddap_days(dataset, max(start, first_of_month), end)
        except RuntimeError as exc:
            print(f"  lopende maand: {dataset} overgeslagen ({exc})", file=sys.stderr)
            continue
        for key, values in got.items():
            days.setdefault(key, {}).update(values)

    means = {key: round(sum(v.values()) / len(v), 2) for key, v in days.items() if v}
    count = max((len(v) for v in days.values()), default=0)
    return means, count


# ── opbouw ───────────────────────────────────────────────────────────────────

def write_if_changed(path: Path, payload: dict, text: str) -> None:
    """Schrijft alleen als de cijfers zelf veranderd zijn.

    Het veld `updated` verschilt per definitie elke run. Zou dat meetellen, dan
    zou de dagelijkse workflow elke dag een commit maken zonder nieuws.
    """
    if path.exists():
        try:
            old = json.loads(path.read_text("utf-8"))
        except json.JSONDecodeError:
            old = None
        if isinstance(old, dict) and {k: v for k, v in old.items() if k != "updated"} \
                == {k: v for k, v in payload.items() if k != "updated"}:
            print(f"  {path.name} ongewijzigd", flush=True)
            return
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"  {path.name} ({path.stat().st_size} bytes)", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--probe", action="store_true", help="alleen de punten controleren")
    args = ap.parse_args()

    today = datetime.now(timezone.utc).date()
    years = list(range(today.year - PLOT_YEARS, today.year + 1))

    print("tijd-as lezen", flush=True)
    axis = monthly_axis()
    wanted = [n for n, d in enumerate(axis) if d.year in years]
    if not wanted:
        print("geen maanden gevonden in het maandbestand", file=sys.stderr)
        return 1
    first, last = wanted[0], wanted[-1]
    print(f"maanden {axis[first]:%Y-%m} t/m {axis[last]:%Y-%m}", flush=True)

    steps = psl_box(MONTHLY_FILE, first, last)
    normals = psl_box(LTM_FILE, 0, 11)

    # De maand die nu loopt staat nog niet in het maandbestand.
    running_start = date(today.year, today.month, 1)
    partial: dict | None = None
    if axis[last] < running_start:
        print("lopende maand aanvullen uit dagwaarden", flush=True)
        means, count = running_month(running_start)
        if count:
            steps.append(means)
            axis = axis[:last + 1] + [running_start]
            last += 1
            partial = {"year": today.year, "month": today.month, "days": count}
            print(f"  {count} dagen in {running_start:%Y-%m}", flush=True)

    if args.probe:
        bad = 0
        for loc in LOCATIONS:
            key = cell_of(loc)
            got = sum(1 for s in steps if key in s)
            if got < len(steps) - 1 or key not in normals[0]:
                print(f"LAND? {loc['slug']}: {got}/{len(steps)} maanden")
                bad += 1
            else:
                values = [s[key] for s in steps if key in s]
                print(f"OK    {loc['slug']:<22} {loc['lat']}N {loc['lon']}E  "
                      f"{min(values):.1f} tot {max(values):.1f} °C ({got} maanden)")
        return 1 if bad else 0

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    for loc in LOCATIONS:
        key = cell_of(loc)
        series = {str(y): [None] * 12 for y in years}
        for n, values in enumerate(steps):
            d = axis[first + n]
            if str(d.year) in series and key in values:
                series[str(d.year)][d.month - 1] = values[key]

        payload = {
            "location": {k: loc[k] for k in ("slug", "name", "sub", "lat", "lon")},
            "source": {
                "dataset": "NOAA OISST v2.1 (AVHRR)",
                "detail": "maandgemiddelden op een rooster van 0,25°",
                "via": "NOAA PSL, met de lopende maand uit NCEI ERDDAP",
            },
            "climatology": {
                "period": CLIM_PERIOD,
                "mean": [normals[m].get(key) for m in range(12)],
            },
            "years": series,
            "partial": partial,
            "updated": stamp,
        }
        write_if_changed(DATA_DIR / f"{loc['slug']}.json", payload,
                         json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    index = {
        "locations": [{k: l[k] for k in ("slug", "name", "sub", "lat", "lon")}
                      for l in LOCATIONS],
        "climatology_period": CLIM_PERIOD,
        "years": years,
        "updated": stamp,
    }
    write_if_changed(DATA_DIR / "index.json", index,
                     json.dumps(index, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
