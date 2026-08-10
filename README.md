# Noordzee-temperatuur

De zeewatertemperatuur van de Noordzee, dag per dag. De laatste vijf jaar
liggen als gekleurde lijnen over elkaar, met het daggemiddelde van 1991–2020
als grijze stippellijn ernaast, zodat je meteen ziet of een jaar warm of koud
uitvalt.

Statische site, geen build-stap, geen dependencies. De data staat als JSON in
[`data/`](data/) en wordt elke ochtend door een GitHub Action ververst.

## Bron

Overal NOAA **OISST v2.1** (Optimum Interpolation SST) — een satelliet­analyse
op een rooster van 0,25° (ongeveer 25 bij 25 km), één waarde per dag. Dat is
open water, geen strandmeting: aan de kust ligt de echte temperatuur in de
zomer meestal wat hoger en in de winter wat lager.

De cijfers komen van twee servers, omdat geen van beide alles levert:

| Wat | Waar vandaan |
|---|---|
| De gekleurde jaarlijnen | [NCEI ERDDAP](https://www.ncei.noaa.gov/erddap/) — archief vanaf eind februari 2020, plus de `preliminary`-dataset voor de laatste weken |
| De grijze stippellijn | [NOAA PSL](https://psl.noaa.gov/data/gridded/data.noaa.oisst.v2.highres.html) — NOAA's eigen daggemiddelde over 1991–2020 |

Beide servers rekenen per **dag**, niet per roostercel: één cel over 30 dagen
duurt even lang als 432 cellen over 30 dagen. Het script haalt daarom in één
keer een rechthoek op die alle locaties omvat en knipt die lokaal uit — zeven
keer sneller dan punt voor punt. De PSL-proxy geeft bovendien een 502 op grote
requests, dus die reeks gaat er in stukken van 92 dagen door.

## Plekken

| Plek | Roostercel |
|---|---|
| Belgische kust, voor Oostende | 51,375 °N 2,875 °O |
| Zeeuwse kust, voor Westkapelle | 51,625 °N 3,375 °O |
| Hollandse kust, voor Scheveningen | 52,125 °N 4,125 °O |
| Waddenkust, voor Texel | 53,125 °N 4,375 °O |
| Nauw van Calais | 51,125 °N 1,625 °O |
| Doggersbank, centrale Noordzee | 54,875 °N 2,875 °O |
| Noordelijke Noordzee, ten oosten van Shetland | 59,875 °N 1,625 °O |

## Zelf draaien

Alleen Python 3.12 of nieuwer, geen pip-pakketten.

```bash
python scripts/fetch_sst.py --probe   # controleer of de punten op zee liggen
python scripts/fetch_sst.py --full    # alles ophalen, inclusief klimatologie
python scripts/fetch_sst.py           # alleen het lopende jaar verversen
```

De klimatologie verandert niet en staat in de repo; `--full` is dus eenmalig.
De dagelijkse Action draait zonder vlag en haalt alleen het lopende jaar op.

Site lokaal bekijken:

```bash
python -m http.server 8000
```

## Kleuren

De jaren zijn geordend, dus ze krijgen een ordinale ramp in één tint — oudste
jaar het zwakst, nieuwste het sterkst — in plaats van willekeurige kleuren.
Het lopende jaar staat er in een accentkleur bovenop. Licht en donker zijn
apart gekozen, niet omgeklapt, en beide zijn nagerekend op leesbaarheid voor
kleurenblinde lezers (slechtste paar ΔE 9,8 bij een drempel van 8; de grijze
lijn is bovendien gestippeld, dus die leunt niet op kleur alleen).

## Licentie

MIT, zie [LICENSE](LICENSE). De OISST-data is publiek domein (NOAA).
