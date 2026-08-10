/* Zeewatertemperatuur Noordzee — grafiek zonder externe libraries.
   Alle reeksen liggen op een vaste 366-daagse kalender, zodat 1 maart van een
   schrikkeljaar boven 1 maart van een gewoon jaar valt. Niet-schrikkeljaren
   hebben daardoor één gat op index 59; de lijn loopt daar gewoon door. */

const DAYS = 366;
const CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MONTH_LEN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun",
                     "jul", "aug", "sep", "okt", "nov", "dec"];
const MONTH_LONG = ["januari", "februari", "maart", "april", "mei", "juni",
                    "juli", "augustus", "september", "oktober", "november", "december"];
/* Ordinale ramp: oudste jaar het zwakst, nieuwste het sterkst. */
const RAMP = ["--y0", "--y1", "--y2", "--y3", "--y4"];

const W = 960, H = 440;
const M = { t: 14, r: 56, b: 30, l: 42 };
const IW = W - M.l - M.r;
const IH = H - M.t - M.b;

const el = (id) => document.getElementById(id);
const nf1 = new Intl.NumberFormat("nl-BE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const state = { data: null, series: [], hidden: new Set(), scale: null, hover: null };

/* ── hulpjes ─────────────────────────────────────────────────────────── */

function monthOf(index) {
  let m = 11;
  while (m > 0 && index < CUM[m]) m--;
  return m;
}

function dayLabel(index, long = false) {
  const m = monthOf(index);
  return `${index - CUM[m] + 1} ${long ? MONTH_LONG[m] : MONTH_SHORT[m]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function lastFilled(values) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
}

/* ── reeksen ─────────────────────────────────────────────────────────── */

function buildSeries(data) {
  const years = Object.keys(data.years).sort();
  const past = years.slice(0, -1);
  const current = years[years.length - 1];
  const [from, to] = data.climatology.period;

  const out = [{
    key: "clim",
    label: `gemiddelde ${from}–${to}`,
    short: "gemiddelde",
    values: data.climatology.mean,
    cls: "clim",
    color: "var(--clim)",
    dashed: true,
  }];

  past.forEach((year, i) => {
    const slot = past.length < 2
      ? RAMP.length - 1
      : Math.round((i * (RAMP.length - 1)) / (past.length - 1));
    out.push({
      key: year, label: year, short: year,
      values: data.years[year], cls: "year", color: `var(${RAMP[slot]})`,
    });
  });

  if (current) {
    out.push({
      key: current, label: `${current} (dit jaar)`, short: current,
      values: data.years[current], cls: "current", color: "var(--accent)",
    });
  }
  return out;
}

function niceScale(series) {
  let min = Infinity, max = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!isFinite(min)) return { min: 0, max: 20, step: 5 };
  const span = max - min;
  const step = [0.5, 1, 2, 2.5, 5, 10].find((s) => span / s <= 7) ?? 10;
  return {
    min: Math.floor(min / step) * step,
    max: Math.ceil(max / step) * step,
    step,
  };
}

const xAt = (i) => M.l + (i * IW) / (DAYS - 1);
const yAt = (v) => M.t + ((state.scale.max - v) / (state.scale.max - state.scale.min)) * IH;

function pathOf(values) {
  let d = "", pen = false;
  for (let i = 0; i < DAYS; i++) {
    const v = values[i];
    if (v == null) continue;
    d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/* ── tekenen ─────────────────────────────────────────────────────────── */

function renderChart() {
  const visible = state.series.filter((s) => !state.hidden.has(s.key));
  state.scale = niceScale(state.series);
  const { min, max, step } = state.scale;

  let svg = `<title id="chart-title">Zeewatertemperatuur per dag van het jaar, ` +
    `${escapeHtml(state.data.location.name)}</title>`;

  for (let v = min; v <= max + 1e-9; v += step) {
    svg += `<line class="grid-line" x1="${M.l}" y1="${yAt(v).toFixed(1)}" ` +
      `x2="${M.l + IW}" y2="${yAt(v).toFixed(1)}"/>` +
      `<text class="tick-text" x="${M.l - 8}" y="${(yAt(v) + 4).toFixed(1)}" ` +
      `text-anchor="end">${nf1.format(v)}</text>`;
  }
  svg += `<text class="axis-title" x="${M.l - 8}" y="${M.t - 2}" text-anchor="end">&deg;C</text>`;
  svg += `<line class="axis-line" x1="${M.l}" y1="${M.t + IH}" x2="${M.l + IW}" y2="${M.t + IH}"/>`;

  MONTH_SHORT.forEach((name, m) => {
    const mid = xAt(CUM[m] + MONTH_LEN[m] / 2);
    svg += `<text class="tick-text" x="${mid.toFixed(1)}" y="${M.t + IH + 18}" ` +
      `text-anchor="middle">${name}</text>`;
  });

  for (const s of visible) {
    svg += `<path class="series ${s.cls}" d="${pathOf(s.values)}" stroke="${s.color}"/>`;
  }

  // Het lopende jaar krijgt een naamlabel aan het uiteinde; de rest staat in
  // de legende. Meer dan één direct label wordt een kluwen op deze schaal.
  const current = visible.find((s) => s.cls === "current");
  if (current) {
    const i = lastFilled(current.values);
    if (i >= 0) {
      svg += `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(current.values[i]).toFixed(1)}" ` +
        `r="3.5" fill="${current.color}"/>` +
        `<text class="end-label" x="${(xAt(i) + 7).toFixed(1)}" ` +
        `y="${(yAt(current.values[i]) + 4).toFixed(1)}">${escapeHtml(current.short)}</text>`;
    }
  }

  svg += `<g id="hover"></g>`;
  svg += `<rect x="${M.l}" y="${M.t}" width="${IW}" height="${IH}" fill="transparent"/>`;
  el("chart").innerHTML = svg;
  if (state.hover != null) drawHover(state.hover);
}

function renderLegend() {
  el("legend").innerHTML = state.series.map((s) => {
    const on = !state.hidden.has(s.key);
    const swatch = s.dashed
      ? `<span class="swatch dashed"></span>`
      : `<span class="swatch" style="background:${s.color}"></span>`;
    return `<button type="button" data-key="${escapeHtml(s.key)}" aria-pressed="${on}">` +
      `${swatch}${escapeHtml(s.label)}</button>`;
  }).join("");
}

/* ── aanwijzen ───────────────────────────────────────────────────────── */

function drawHover(index) {
  const visible = state.series.filter((s) => !state.hidden.has(s.key));
  const rows = visible
    .map((s) => ({ s, v: s.values[index] }))
    .filter((r) => r.v != null)
    .sort((a, b) => b.v - a.v);

  let g = `<line class="crosshair" x1="${xAt(index).toFixed(1)}" y1="${M.t}" ` +
    `x2="${xAt(index).toFixed(1)}" y2="${M.t + IH}"/>`;
  for (const { s, v } of rows) {
    g += `<circle class="hover-dot" cx="${xAt(index).toFixed(1)}" cy="${yAt(v).toFixed(1)}" ` +
      `r="${s.cls === "current" ? 5 : 4}" fill="${s.color}"/>`;
  }
  const hover = el("chart").querySelector("#hover");
  if (hover) hover.innerHTML = g;

  const tip = el("tooltip");
  if (!rows.length) { tip.dataset.show = "0"; return; }
  tip.innerHTML = `<div class="tt-date">${escapeHtml(dayLabel(index, true))}</div>` +
    rows.map(({ s, v }) => {
      const swatch = s.dashed
        ? `<span class="swatch" style="border-top:3px dashed var(--clim)"></span>`
        : `<span class="swatch" style="background:${s.color}"></span>`;
      return `<div class="tt-row">${swatch}<span class="lbl">${escapeHtml(s.short)}</span>` +
        `<span class="val">${nf1.format(v)} &deg;C</span></div>`;
    }).join("");
  tip.dataset.show = "1";

  const holder = el("holder").getBoundingClientRect();
  const px = (xAt(index) / W) * holder.width;
  const width = tip.offsetWidth;
  tip.style.left = `${Math.max(0, Math.min(holder.width - width, px + 16))}px`;
  tip.style.top = "8px";
}

function indexFromEvent(ev) {
  const r = el("chart").getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * W;
  const i = Math.round(((px - M.l) / IW) * (DAYS - 1));
  return Math.max(0, Math.min(DAYS - 1, i));
}

function setHover(index) {
  state.hover = index;
  drawHover(index);
}

function clearHover() {
  state.hover = null;
  const hover = el("chart").querySelector("#hover");
  if (hover) hover.innerHTML = "";
  el("tooltip").dataset.show = "0";
}

/* ── kop en tabel ────────────────────────────────────────────────────── */

function renderHeadline() {
  const current = state.series.find((s) => s.cls === "current");
  const clim = state.series.find((s) => s.key === "clim");
  const i = current ? lastFilled(current.values) : -1;
  if (i < 0) {
    el("figure").textContent = "—";
    el("context").textContent = "nog geen meting voor dit jaar";
    return;
  }
  const value = current.values[i];
  el("figure").textContent = nf1.format(value);

  const normal = clim ? clim.values[i] : null;
  let text = `op ${dayLabel(i, true)} ${current.short} · ${state.data.location.name}`;
  if (normal != null) {
    const d = value - normal;
    const word = Math.abs(d) < 0.05 ? "gelijk aan"
      : `${nf1.format(Math.abs(d))} °C ${d > 0 ? "boven" : "onder"}`;
    text += ` · <span class="delta">${word} ` +
      `het gemiddelde van ${state.data.climatology.period.join("–")}</span>`;
  }
  el("context").innerHTML = text;
}

function monthlyMean(values, m) {
  let sum = 0, n = 0;
  for (let i = CUM[m]; i < CUM[m] + MONTH_LEN[m]; i++) {
    if (values[i] != null) { sum += values[i]; n++; }
  }
  return n ? sum / n : null;
}

function renderTable() {
  const cols = state.series;
  let html = `<table><caption>Maandgemiddelden in &deg;C — ` +
    `${escapeHtml(state.data.location.name)}</caption><thead><tr><th scope="col">Maand</th>` +
    cols.map((s) => `<th scope="col">${escapeHtml(s.short)}</th>`).join("") +
    `</tr></thead><tbody>`;
  MONTH_LONG.forEach((name, m) => {
    html += `<tr><th scope="row">${name}</th>` + cols.map((s) => {
      const v = monthlyMean(s.values, m);
      return `<td>${v == null ? "–" : nf1.format(v)}</td>`;
    }).join("") + `</tr>`;
  });
  el("table-wrap").innerHTML = html + `</tbody></table>`;
}

/* ── laden ───────────────────────────────────────────────────────────── */

async function load(slug) {
  const res = await fetch(`data/${slug}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`kon data/${slug}.json niet laden (${res.status})`);
  state.data = await res.json();
  state.series = buildSeries(state.data);
  state.hidden.clear();
  clearHover();

  renderHeadline();
  renderChart();
  renderLegend();
  renderTable();

  const s = state.data.source;
  const stamp = new Date(state.data.updated).toLocaleString("nl-BE",
    { dateStyle: "long", timeStyle: "short" });
  el("bron").innerHTML =
    `Bron: ${escapeHtml(s.dataset)}, ${escapeHtml(s.grid)} ` +
    `(${escapeHtml(s.recent)}; ${escapeHtml(s.climatology)}). ` +
    `Roostercel ${nf1.format(state.data.location.lat)}&deg;N ` +
    `${nf1.format(state.data.location.lon)}&deg;O. Bijgewerkt ${escapeHtml(stamp)}.`;

  el("status").hidden = true;
  el("card").hidden = false;
}

async function init() {
  const index = await (await fetch("data/index.json", { cache: "no-cache" })).json();
  const select = el("plek");
  select.innerHTML = index.locations
    .map((l) => `<option value="${escapeHtml(l.slug)}">${escapeHtml(l.name)} — ${escapeHtml(l.sub)}</option>`)
    .join("");

  const wanted = new URLSearchParams(location.search).get("plek");
  const start = index.locations.some((l) => l.slug === wanted) ? wanted : index.locations[0].slug;
  select.value = start;

  select.addEventListener("change", () => {
    const params = new URLSearchParams(location.search);
    params.set("plek", select.value);
    history.replaceState(null, "", `?${params}`);
    load(select.value).catch(showError);
  });

  el("legend").addEventListener("click", (ev) => {
    const button = ev.target.closest("button[data-key]");
    if (!button) return;
    const key = button.dataset.key;
    if (state.hidden.has(key)) state.hidden.delete(key); else state.hidden.add(key);
    renderChart();
    renderLegend();
  });

  const chart = el("chart");
  chart.addEventListener("pointermove", (ev) => setHover(indexFromEvent(ev)));
  chart.addEventListener("pointerdown", (ev) => setHover(indexFromEvent(ev)));
  chart.addEventListener("pointerleave", clearHover);
  chart.addEventListener("keydown", (ev) => {
    const step = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    ev.preventDefault();
    const base = state.hover ?? Math.round(DAYS / 2);
    setHover(Math.max(0, Math.min(DAYS - 1, base + step * (ev.shiftKey ? 7 : 1))));
  });
  chart.addEventListener("blur", clearHover);
  addEventListener("resize", () => { if (state.hover != null) drawHover(state.hover); });

  const table = el("table-wrap"), toggle = el("toggle-table");
  toggle.addEventListener("click", () => {
    const show = table.hidden;
    table.hidden = !show;
    toggle.textContent = show ? "Verberg tabel" : "Toon tabel";
    toggle.setAttribute("aria-expanded", String(show));
  });

  const theme = el("theme");
  const apply = (mode) => {
    document.documentElement.dataset.theme = mode;
    theme.textContent = mode === "dark" ? "Licht" : "Donker";
    try { localStorage.setItem("thema", mode); } catch { /* privémodus */ }
  };
  const saved = (() => { try { return localStorage.getItem("thema"); } catch { return null; } })();
  apply(saved ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  theme.addEventListener("click", () => {
    apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    renderChart();
  });

  await load(start);
}

function showError(err) {
  el("status").hidden = false;
  el("status").textContent = `Er ging iets mis: ${err.message}`;
  el("card").hidden = true;
}

init().catch(showError);
