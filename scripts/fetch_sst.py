#!/usr/bin/env python3
"""Haalt dagelijkse zeewatertemperatuur op voor een aantal Noordzee-punten.

Bron is overal NOAA OISST v2.1 (Optimum Interpolation SST, 0,25 graden,
dagelijks), maar via twee servers, omdat geen van beide alles levert:

  * de gekleurde jaarlijnen komen van NCEI ERDDAP. Het archief daar loopt tot
    begin 2020 terug; de laatste weken zitten in een aparte "preliminary"
    dataset, die we eroverheen leggen.
  * de grijze stippellijn is NOAA's eigen daggemiddelde over 1991-2020, uit
    het long-term-mean-bestand op de OPeNDAP-server van NOAA PSL.

Bij beide servers kost een request tijd per *dag*, niet per roostercel: een
enkele cel over 30 dagen duurt even lang als 432 cellen over 30 dagen. Daarom
halen we één rechthoek op die alle locaties omvat en knippen we die lokaal uit.
Dat scheelt een factor zeven. De PSL-proxy geeft bovendien een 502 op grote
requests, dus die reeks gaat er in stukken door.

Alleen standaardbibliotheek, geen API-sleutel.

Gebruik:
    python fetch_sst.py --full     # inclusief klimatologie (eenmalig)
    python fetch_sst.py            # alleen het lopende jaar verversen
    python fetch_sst.py --probe    # controleer of de punten op zee liggen
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

ERDDAP = "https://www.ncei.noaa.gov/erddap"
DS_FINAL = "ncdc_oisst_v2_avhrr_by_time_zlev_lat_lon"
DS_PRELIM = "ncdc_oisst_v2_avhrr_prelim_by_time_zlev_lat_lon"

PSL = "https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres"
LTM_FILE = "sst.day.mean.ltm.1991-2020.nc"
LTM_DAYS = 365  # het normaalbestand kent geen 29 februari
LTM_CHUNK = 92  # grotere brokken geeft de PSL-proxy een 502

CLIM_PERIOD = [1991, 2020]
PLOT_YEARS = 5  # zoveel afgelopen jaren krijgen een eigen gekleurde lijn
FIRST_YEAR = 2021  # het ERDDAP-archief begint eind februari 2020

# OISST-rooster: lat vanaf -89,875 / lon vanaf 0,125, stap 0,25 graden.
GRID_STEP = 0.25
LAT0, LON0 = -89.875, 0.125

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

# Cumulatieve dagen in een schrikkeljaar; index 0 = 1 januari.
_LEAP_CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
DAYS = 366
FEB29 = _LEAP_CUM[1] + 29 - 1  # index 59


def doy_index(month: int, day: int) -> int:
    """Positie op een vaste 366-daagse kalender, zodat alle jaren uitlijnen."""
    return _LEAP_CUM[month - 1] + day - 1


def lat_index(lat: float) -> int:
    return round((lat - LAT0) / GRID_STEP)


def lon_index(lon: float) -> int:
    return round((lon % 360.0 - LON0) / GRID_STEP)


def bounding_box() -> tuple[float, float, float, float]:
    lats = [l["lat"] for l in LOCATIONS]
    lons = [l["lon"] for l in LOCATIONS]
    return min(lats), max(lats), min(lons), max(lons)


def cell_key(lat: float, lon: float) -> tuple[int, int]:
    """Rooster-index als sleutel: floats uit twee servers matchen anders niet."""
    return lat_index(lat), lon_index(lon)


def fetch(url: str, attempts: int = 4) -> str:
    last: Exception | None = None
    for n in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "noordzee-sst/1.0"})
            with urllib.request.urlopen(req, timeout=300) as resp:
                return resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            if n < attempts - 1:
                time.sleep(5 * (n + 1))
    raise RuntimeError(f"ophalen mislukt na {attempts} pogingen: {url}") from last


# ── NCEI ERDDAP: de gekleurde jaarlijnen ─────────────────────────────────────

def erddap_coverage(dataset: str) -> tuple[date, date]:
    """Leest uit welke periode een dataset dekt, zodat we niet buiten de as vragen."""
    span: dict[str, date] = {}
    for row in csv.reader(io.StringIO(fetch(f"{ERDDAP}/info/{dataset}/index.csv"))):
        if len(row) >= 5 and row[2] in ("time_coverage_start", "time_coverage_end"):
            span[row[2]] = datetime.strptime(row[4][:10], "%Y-%m-%d").date()
    if len(span) != 2:
        raise RuntimeError(f"kon periode van {dataset} niet lezen")
    return span["time_coverage_start"], span["time_coverage_end"]


def erddap_box(dataset: str, start: date, end: date) -> dict[tuple[int, int], dict[date, float]]:
    """Alle cellen in de rechthoek, als {(lat_idx, lon_idx): {datum: temp}}."""
    lat_lo, lat_hi, lon_lo, lon_hi = bounding_box()
    query = (
        f"sst%5B({start}):1:({end})%5D%5B(0.0):1:(0.0)%5D"
        f"%5B({lat_lo}):1:({lat_hi})%5D%5B({lon_lo % 360.0}):1:({lon_hi % 360.0})%5D"
    )
    body = fetch(f"{ERDDAP}/griddap/{dataset}.csv?{query}")
    if body.lstrip().startswith("Error"):
        raise RuntimeError(body.strip()[:300])

    out: dict[tuple[int, int], dict[date, float]] = {}
    rows = csv.reader(io.StringIO(body))
    next(rows, None)  # kolomnamen
    next(rows, None)  # eenheden
    for row in rows:
        if len(row) < 5 or not row[4] or row[4] == "NaN":
            continue  # NaN = land
        key = cell_key(float(row[2]), float(row[3]))
        day = datetime.strptime(row[0][:10], "%Y-%m-%d").date()
        out.setdefault(key, {})[day] = round(float(row[4]), 2)
    return out


def recent_days(years: list[int]) -> dict[tuple[int, int], dict[date, float]]:
    """Dagwaarden voor alle cellen over de gevraagde jaren, definitief + voorlopig."""
    f_start, f_end = erddap_coverage(DS_FINAL)
    start = max(f_start, date(min(years), 1, 1))
    end = min(f_end, date(max(years), 12, 31))
    print(f"  ERDDAP definitief {start} t/m {end}", flush=True)
    cells = erddap_box(DS_FINAL, start, end)

    # De definitieve reeks loopt zo'n twee weken achter; de voorlopige dataset
    # vult het gat tot gisteren.
    try:
        p_start, p_end = erddap_coverage(DS_PRELIM)
        if p_end > end:
            p_from = max(p_start, end)
            print(f"  ERDDAP voorlopig  {p_from} t/m {p_end}", flush=True)
            for key, days in erddap_box(DS_PRELIM, p_from, p_end).items():
                for d, v in days.items():
                    cells.setdefault(key, {}).setdefault(d, v)  # definitief wint
    except RuntimeError as exc:
        print(f"  let op: voorlopige dataset overgeslagen ({exc})", file=sys.stderr)
    return cells


# ── NOAA PSL: de grijze stippellijn (normaal 1991-2020) ──────────────────────

def parse_opendap_ascii(body: str, n_lat: int, n_lon: int) -> list[list[float]]:
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
        if not line or "," not in line:
            break  # lege regel sluit het datablok af; daarna volgen time/lat/lon
        # Regelvorm: "[t][lat], v, v, v, ..." — één regel per (tijdstap, breedte).
        head, _, tail = line.partition(",")
        if not head.startswith("["):
            break
        t = int(head[1:head.index("]")])
        while len(steps) <= t:
            steps.append([])
        steps[t].extend(float(v) for v in tail.split(","))

    for t, values in enumerate(steps):
        if len(values) != n_lat * n_lon:
            raise RuntimeError(f"tijdstap {t}: {len(values)} waarden, verwacht {n_lat * n_lon}")
    if not steps:
        raise RuntimeError("geen waarden in OPeNDAP-antwoord")
    return steps


def climatology_box() -> dict[tuple[int, int], list[float | None]]:
    """NOAA's daggemiddelde 1991-2020 per cel, op de 366-daagse kalender."""
    lat_lo, lat_hi, lon_lo, lon_hi = bounding_box()
    i0, i1 = lat_index(lat_lo), lat_index(lat_hi)
    j0, j1 = lon_index(lon_lo), lon_index(lon_hi)
    n_lat, n_lon = i1 - i0 + 1, j1 - j0 + 1

    by_day: list[list[float]] = []
    for begin in range(0, LTM_DAYS, LTM_CHUNK):
        stop = min(begin + LTM_CHUNK, LTM_DAYS) - 1
        url = (f"{PSL}/{LTM_FILE}.ascii"
               f"?sst%5B{begin}:1:{stop}%5D%5B{i0}:1:{i1}%5D%5B{j0}:1:{j1}%5D")
        by_day.extend(parse_opendap_ascii(fetch(url), n_lat, n_lon))
        print(f"  klimatologie {len(by_day)}/{LTM_DAYS}", flush=True)
    if len(by_day) != LTM_DAYS:
        raise RuntimeError(f"verwachtte {LTM_DAYS} dagen, kreeg {len(by_day)}")

    out: dict[tuple[int, int], list[float | None]] = {
        (i0 + a, j0 + b): [None] * DAYS for a in range(n_lat) for b in range(n_lon)
    }
    ref_start = date(2001, 1, 1).toordinal()  # niet-schrikkeljaar als kalender
    for n, flat in enumerate(by_day):
        d = date.fromordinal(ref_start + n)
        slot = doy_index(d.month, d.day)
        for a in range(n_lat):
            for b in range(n_lon):
                v = flat[a * n_lon + b]
                if v > -900.0:  # alles daaronder is de fill-waarde voor land
                    out[(i0 + a, j0 + b)][slot] = round(v, 2)

    # 29 februari bestaat niet in het normaalbestand: interpoleer de buurdagen.
    for series in out.values():
        a, b = series[FEB29 - 1], series[FEB29 + 1]
        if a is not None and b is not None:
            series[FEB29] = round((a + b) / 2, 2)
    return out


# ── opbouw ───────────────────────────────────────────────────────────────────

def to_year_series(days: dict[date, float], years: list[int]) -> dict[str, list]:
    series: dict[str, list] = {str(y): [None] * DAYS for y in years}
    for d, v in days.items():
        if str(d.year) in series:
            series[str(d.year)][doy_index(d.month, d.day)] = v
    return series


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--full", action="store_true",
                    help="ook de klimatologie en alle jaren opnieuw ophalen")
    ap.add_argument("--probe", action="store_true", help="alleen punten controleren")
    args = ap.parse_args()

    today = datetime.now(timezone.utc).date()
    first = max(FIRST_YEAR, today.year - PLOT_YEARS)
    all_years = list(range(first, today.year + 1))

    if args.probe:
        cells = erddap_box(DS_FINAL, date(today.year - 1, 1, 1), date(today.year - 1, 12, 31))
        bad = 0
        for loc in LOCATIONS:
            got = cells.get(cell_key(loc["lat"], loc["lon"]), {})
            if len(got) < 300:
                print(f"LAND? {loc['slug']}: maar {len(got)} waarden")
                bad += 1
            else:
                print(f"OK    {loc['slug']:<22} {loc['lat']}N {loc['lon']}E  "
                      f"{min(got.values()):.1f} tot {max(got.values()):.1f} °C "
                      f"({len(got)} dagen)")
        return 1 if bad else 0

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing = {}
    for loc in LOCATIONS:
        path = DATA_DIR / f"{loc['slug']}.json"
        if path.exists():
            existing[loc["slug"]] = json.loads(path.read_text("utf-8"))

    need_clim = args.full or any(
        "mean" not in existing.get(l["slug"], {}).get("climatology", {}) for l in LOCATIONS)
    clim_cells = climatology_box() if need_clim else {}

    # Zonder --full verversen we alleen het lopende jaar; in januari ook het
    # vorige, omdat de definitieve reeks een paar weken achterloopt.
    fetch_years = all_years if args.full or not existing else (
        [today.year] + ([today.year - 1] if today.month == 1 else []))
    day_cells = recent_days(fetch_years)

    for loc in LOCATIONS:
        key = cell_key(loc["lat"], loc["lon"])
        prev = existing.get(loc["slug"], {})

        clim = ({"period": CLIM_PERIOD, "mean": clim_cells[key]} if need_clim
                else prev["climatology"])
        years = {y: s for y, s in prev.get("years", {}).items() if int(y) in all_years}
        years.update(to_year_series(day_cells.get(key, {}), fetch_years))
        years = {str(y): years[str(y)] for y in all_years if str(y) in years}

        current = years.get(str(today.year), [])
        payload = {
            "location": {k: loc[k] for k in ("slug", "name", "sub", "lat", "lon")},
            "source": {
                "dataset": "NOAA OISST v2.1 (AVHRR)",
                "grid": "0,25° · dagelijks",
                "recent": "NCEI ERDDAP",
                "climatology": "NOAA PSL, daggemiddelde 1991-2020",
            },
            "climatology": clim,
            "years": years,
            "last_day_index": max((d for d, v in enumerate(current) if v is not None),
                                  default=-1),
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        path = DATA_DIR / f"{loc['slug']}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
                        encoding="utf-8")
        print(f"  {path.name} ({path.stat().st_size // 1024} kB)", flush=True)

    (DATA_DIR / "index.json").write_text(
        json.dumps({
            "locations": [{k: l[k] for k in ("slug", "name", "sub", "lat", "lon")}
                          for l in LOCATIONS],
            "climatology_period": CLIM_PERIOD,
            "years": all_years,
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")
    print("  index.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
