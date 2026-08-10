# Noordzee-temperatuur

De zeewatertemperatuur van de Noordzee per maand. De laatste vijf jaar liggen
als gekleurde lijnen over elkaar, met het maandgemiddelde van 1991–2020 als
grijze stippellijn ernaast, zodat je meteen ziet of een jaar warm of koud
uitvalt.

Statische site, geen build-stap, geen dependencies. De data staat als JSON in
[`data/`](data/) — een kleine kilobyte per plek — en wordt elke ochtend door
een GitHub Action ververst.

## Bron

Overal NOAA **OISST v2.1** (Optimum Interpolation SST) — een satelliet­analyse
op een rooster van 0,25°, ongeveer 25 bij 25 km. Dat is open water, geen
strandmeting: aan de kust ligt de echte temperatuur in de zomer meestal wat
hoger en in de winter wat lager.

NOAA publiceert de maandgemiddelden kant-en-klaar, dus die halen we op in
plaats van tweeduizend dagwaarden zelf te middelen:

| Wat | Waar vandaan |
|---|---|
| De gekleurde jaarlijnen | `sst.mon.mean.nc` op [NOAA PSL](https://psl.noaa.gov/data/gridded/data.noaa.oisst.v2.highres.html) — maandgemiddelden vanaf september 1981 |
| De grijze stippellijn | `sst.mon.ltm.1991-2020.nc` — het maandnormaal over 1991–2020 |
| De maand die nu loopt | [NCEI ERDDAP](https://www.ncei.noaa.gov/erddap/), dagwaarden tot nu toe, apart gemarkeerd als onvolledig |

De OPeNDAP-server rekent per **tijdstap**, niet per roostercel: één cel over
twaalf maanden duurt even lang als 432 cellen over twaalf maanden. Het script
haalt daarom in één keer een rechthoek op die alle locaties omvat en knipt die
lokaal uit — zeven keer sneller dan punt voor punt. De proxy geeft wel een 502
op te grote requests, dus de reeks gaat er in stukken van 36 stappen door.

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
python scripts/fetch_sst.py           # alles ophalen
```

Eén volledige ronde duurt ongeveer een halve minuut, dus de dagelijkse Action
haalt gewoon alles opnieuw op en commit alleen als er iets veranderd is.

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
