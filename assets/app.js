/* Zeewatertemperatuur Noordzee — grafiek zonder externe libraries.
   De data zijn maandgemiddelden: twaalf punten per jaar. De lopende maand komt
   uit de dagwaarden tot nu toe en wordt apart gemarkeerd, want een gemiddelde
   over acht dagen is nog geen maandcijfer. */

const MONTH_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun",
                     "jul", "aug", "sep", "okt", "nov", "dec"];
const MONTH_LONG = ["januari", "februari", "maart", "april", "mei", "juni",
                    "juli", "augustus", "september", "oktober", "november", "december"];
/* Ordinale ramp: oudste jaar het zwakst, nieuwste het sterkst. */
const RAMP = ["--y0", "--y1", "--y2", "--y3", "--y4"];

/* De grafiek wordt getekend in schermpixels, niet in een vaste viewBox die
   meeschaalt: anders krimpen de maandlabels op een telefoon mee tot vier pixels
   en is er niets meer te lezen. */
const M = { t: 14, r: 56, b: 30, l: 42 };
let W = 960, H = 420, IW = 862, IH = 376, BAND = IW / 12;

function layout() {
  const width = el("holder").clientWidth;
  W = Math.max(300, Math.round(width || 960));
  H = Math.round(Math.min(440, Math.max(250, W * 0.46)));
  M.r = W < 520 ? 34 : 56;
  IW = W - M.l - M.r;
  IH = H - M.t - M.b;
  BAND = IW / 12;
}

const el = (id) => document.getElementById(id);
const nf1 = new Intl.NumberFormat("nl-BE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const state = { data: null, series: [], hidden: new Set(), scale: null, hover: null };

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const lastFilled = (values) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
};

/* ── reeksen ─────────────────────────────────────────────────────────── */

function buildSeries(data) {
  const years = Object.keys(data.years).sort();
  const past = years.slice(0, -1);
  const current = years[years.length - 1];
  const [from, to] = data.climatology.period;

  const out = [{
    key: "clim", label: `gemiddelde ${from}–${to}`, short: "gemiddelde",
    values: data.climatology.mean, cls: "clim", color: "var(--clim)", dashed: true,
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

/* De maand die nu loopt: wel tonen, maar apart markeren. */
function isPartial(series, m) {
  const p = state.data && state.data.partial;
  return !!p && series.cls === "current" && p.month - 1 === m
    && String(p.year) === series.short;
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
  const step = [0.5, 1, 2, 2.5, 5].find((s) => (max - min) / s <= 7) ?? 5;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

const xAt = (m) => M.l + (m + 0.5) * BAND;
const yAt = (v) => M.t + ((state.scale.max - v) / (state.scale.max - state.scale.min)) * IH;

function pathOf(values) {
  let d = "", pen = false;
  for (let m = 0; m < 12; m++) {
    if (values[m] == null) continue;
    d += `${pen ? "L" : "M"}${xAt(m).toFixed(1)} ${yAt(values[m]).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/* ── tekenen ─────────────────────────────────────────────────────────── */

function renderChart() {
  layout();
  el("chart").setAttribute("viewBox", `0 0 ${W} ${H}`);
  const visible = state.series.filter((s) => !state.hidden.has(s.key));
  state.scale = niceScale(state.series);
  const { min, max, step } = state.scale;

  let svg = `<title id="chart-title">Maandgemiddelde zeewatertemperatuur, ` +
    `${escapeHtml(state.data.location.name)}</title>`;

  for (let v = min; v <= max + 1e-9; v += step) {
    const y = yAt(v).toFixed(1);
    svg += `<line class="grid-line" x1="${M.l}" y1="${y}" x2="${M.l + IW}" y2="${y}"/>` +
      `<text class="tick-text" x="${M.l - 8}" y="${(yAt(v) + 4).toFixed(1)}" ` +
      `text-anchor="end">${nf1.format(v)}</text>`;
  }
  svg += `<text class="axis-title" x="${M.l - 8}" y="${M.t - 2}" text-anchor="end">&deg;C</text>` +
    `<line class="axis-line" x1="${M.l}" y1="${M.t + IH}" x2="${M.l + IW}" y2="${M.t + IH}"/>`;

  // Op een smal scherm passen twaalf maandnamen niet naast elkaar.
  const everyOther = BAND < 26;
  MONTH_SHORT.forEach((name, m) => {
    if (everyOther && m % 2 === 1) return;
    svg += `<text class="tick-text" x="${xAt(m).toFixed(1)}" y="${M.t + IH + 18}" ` +
      `text-anchor="middle">${name}</text>`;
  });

  for (const s of visible) {
    svg += `<path class="series ${s.cls}" d="${pathOf(s.values)}" stroke="${s.color}"/>`;
  }

  // Alleen het lopende jaar krijgt puntmarkeringen en een naamlabel; met zeven
  // reeksen zou meer dan dat een kluwen worden. De rest staat in de legende.
  const current = visible.find((s) => s.cls === "current");
  if (current) {
    for (let m = 0; m < 12; m++) {
      if (current.values[m] == null) continue;
      const partial = isPartial(current, m);
      svg += `<circle cx="${xAt(m).toFixed(1)}" cy="${yAt(current.values[m]).toFixed(1)}" ` +
        `r="4" fill="${partial ? "var(--surface)" : current.color}" ` +
        `stroke="${current.color}" stroke-width="2"/>`;
    }
    const last = lastFilled(current.values);
    if (last >= 0) {
      // Past het label niet meer rechts van het punt, zet het er dan links van.
      const room = W - (xAt(last) + 9) >= 34;
      svg += `<text class="end-label" x="${(xAt(last) + (room ? 9 : -9)).toFixed(1)}" ` +
        `y="${(yAt(current.values[last]) + 4).toFixed(1)}" ` +
        `text-anchor="${room ? "start" : "end"}">${escapeHtml(current.short)}</text>`;
    }
  }

  svg += `<g id="hover"></g>` +
    `<rect x="${M.l}" y="${M.t}" width="${IW}" height="${IH}" fill="transparent"/>`;
  el("chart").innerHTML = svg;
  if (state.hover != null) drawHover(state.hover);
}

function renderLegend() {
  el("legend").innerHTML = state.series.map((s) => {
    const swatch = s.dashed
      ? `<span class="swatch dashed"></span>`
      : `<span class="swatch" style="background:${s.color}"></span>`;
    return `<button type="button" data-key="${escapeHtml(s.key)}" ` +
      `aria-pressed="${!state.hidden.has(s.key)}">${swatch}${escapeHtml(s.label)}</button>`;
  }).join("");
}

/* ── aanwijzen ───────────────────────────────────────────────────────── */

function drawHover(month) {
  const rows = state.series
    .filter((s) => !state.hidden.has(s.key))
    .map((s) => ({ s, v: s.values[month] }))
    .filter((r) => r.v != null)
    .sort((a, b) => b.v - a.v);

  let g = `<rect class="hover-band" x="${(M.l + month * BAND).toFixed(1)}" y="${M.t}" ` +
    `width="${BAND.toFixed(1)}" height="${IH}"/>`;
  for (const { s, v } of rows) {
    g += `<circle class="hover-dot" cx="${xAt(month).toFixed(1)}" cy="${yAt(v).toFixed(1)}" ` +
      `r="${s.cls === "current" ? 5 : 4}" fill="${s.color}"/>`;
  }
  const hover = el("chart").querySelector("#hover");
  if (hover) hover.innerHTML = g;

  const tip = el("tooltip");
  if (!rows.length) { tip.dataset.show = "0"; return; }
  tip.innerHTML = `<div class="tt-date">${MONTH_LONG[month]}</div>` +
    rows.map(({ s, v }) => {
      const swatch = s.dashed
        ? `<span class="swatch" style="border-top:3px dashed var(--clim)"></span>`
        : `<span class="swatch" style="background:${s.color}"></span>`;
      return `<div class="tt-row">${swatch}<span class="lbl">${escapeHtml(s.short)}` +
        `${isPartial(s, month) ? " (deels)" : ""}</span>` +
        `<span class="val">${nf1.format(v)} &deg;C</span></div>`;
    }).join("");
  tip.dataset.show = "1";

  const holder = el("holder").getBoundingClientRect();
  const px = (xAt(month) / W) * holder.width;
  tip.style.left = `${Math.max(0, Math.min(holder.width - tip.offsetWidth, px + 18))}px`;
  tip.style.top = "8px";
}

function monthFromEvent(ev) {
  const r = el("chart").getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * W;
  return Math.max(0, Math.min(11, Math.floor((px - M.l) / BAND)));
}

function setHover(month) {
  state.hover = month;
  drawHover(month);
}

function clearHover() {
  state.hover = null;
  const hover = el("chart").querySelector("#hover");
  if (hover) hover.innerHTML = "";
  const tip = el("tooltip");
  tip.dataset.show = "0";
  // Terug naar links: een verstopte tooltip die op zijn oude plek blijft staan
  // rekt de pagina op zodra het venster smaller wordt.
  tip.style.left = "0px";
}

/* ── kop en tabel ────────────────────────────────────────────────────── */

function renderHeadline() {
  const current = state.series.find((s) => s.cls === "current");
  const clim = state.series.find((s) => s.key === "clim");
  const m = current ? lastFilled(current.values) : -1;
  if (m < 0) {
    el("figure").textContent = "—";
    el("context").textContent = "nog geen cijfers voor dit jaar";
    return;
  }
  const value = current.values[m];
  el("figure").textContent = nf1.format(value);

  const partial = isPartial(current, m)
    ? ` (eerste ${state.data.partial.days} dagen)` : "";
  let text = `${MONTH_LONG[m]} ${current.short}${partial} · ${state.data.location.name}`;

  const normal = clim ? clim.values[m] : null;
  if (normal != null) {
    const d = value - normal;
    const word = Math.abs(d) < 0.05 ? "gelijk aan"
      : `${nf1.format(Math.abs(d))} °C ${d > 0 ? "boven" : "onder"}`;
    text += ` · <span class="delta">${word} het gemiddelde van ` +
      `${state.data.climatology.period.join("–")}</span>`;
  }
  el("context").innerHTML = text;
}

function renderTable() {
  const cols = state.series;
  let html = `<table><caption>Maandgemiddelden in &deg;C — ` +
    `${escapeHtml(state.data.location.name)}</caption><thead><tr><th scope="col">Maand</th>` +
    cols.map((s) => `<th scope="col">${escapeHtml(s.short)}</th>`).join("") +
    `</tr></thead><tbody>`;
  MONTH_LONG.forEach((name, m) => {
    html += `<tr><th scope="row">${name}</th>` + cols.map((s) => {
      const v = s.values[m];
      return `<td>${v == null ? "–" : nf1.format(v) + (isPartial(s, m) ? "*" : "")}</td>`;
    }).join("") + `</tr>`;
  });
  el("table-wrap").innerHTML = html + `</tbody></table>` +
    `<p class="table-note">* maand nog niet voorbij; gemiddelde over de dagen tot nu toe.</p>`;
}

/* ── laden ───────────────────────────────────────────────────────────── */

async function load(slug) {
  const res = await fetch(`data/${slug}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`kon data/${slug}.json niet laden (${res.status})`);
  state.data = await res.json();
  state.series = buildSeries(state.data);
  state.hidden.clear();
  clearHover();

  // Eerst tonen, dan tekenen: de grafiek meet de breedte van zijn container,
  // en een verborgen element is nul pixels breed.
  el("status").hidden = true;
  el("card").hidden = false;

  renderHeadline();
  renderChart();
  renderLegend();
  renderTable();

  const s = state.data.source;
  const stamp = new Date(state.data.updated)
    .toLocaleString("nl-BE", { dateStyle: "long", timeStyle: "short" });
  el("bron").innerHTML =
    `Bron: ${escapeHtml(s.dataset)} &mdash; ${escapeHtml(s.detail)}, ` +
    `via ${escapeHtml(s.via)}. ` +
    `Roostercel ${nf1.format(state.data.location.lat)}&deg;N ` +
    `${nf1.format(state.data.location.lon)}&deg;O. Bijgewerkt ${escapeHtml(stamp)}.`;
}

async function init() {
  const index = await (await fetch("data/index.json", { cache: "no-cache" })).json();
  const select = el("plek");
  select.innerHTML = index.locations.map((l) =>
    `<option value="${escapeHtml(l.slug)}">${escapeHtml(l.name)} — ${escapeHtml(l.sub)}</option>`
  ).join("");

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
  chart.addEventListener("pointermove", (ev) => setHover(monthFromEvent(ev)));
  chart.addEventListener("pointerdown", (ev) => setHover(monthFromEvent(ev)));
  chart.addEventListener("pointerleave", clearHover);
  chart.addEventListener("blur", clearHover);
  chart.addEventListener("keydown", (ev) => {
    const step = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    ev.preventDefault();
    setHover(Math.max(0, Math.min(11, (state.hover ?? 0) + step)));
  });
  let resizeTimer;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { clearHover(); renderChart(); }, 120);
  });

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
  theme.addEventListener("click", () =>
    apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  await load(start);
}

function showError(err) {
  el("status").hidden = false;
  el("status").textContent = `Er ging iets mis: ${err.message}`;
  el("card").hidden = true;
}

init().catch(showError);
