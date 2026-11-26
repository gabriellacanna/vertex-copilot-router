// @ts-check
// Vertex Costs dashboard. Renders only data posted by the extension; every string goes in via textContent.
(() => {
  const vscode = acquireVsCodeApi();
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const RANGES = [['session', 'This session'], ['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']];
  const SOURCES = { picker: 'Copilot model picker', '@vertex': '@vertex chat', ping: 'Availability checks' };
  const SLOTS = 7; // categorical slots; later models fold into "Other"
  /** @type {{range:string, project:string, sessionPick:string|null}} */
  const state = Object.assign({ range: 'session', project: 'all', sessionPick: null }, vscode.getState() || {});
  /** @type {any} */ let data = null;

  // ---------- helpers ----------
  const SVG = 'http://www.w3.org/2000/svg';
  // The webview CSP forbids style="" attributes; CSSOM writes are allowed.
  const css = (el, decl) => { for (const d of String(decl).split(';')) { const i = d.indexOf(':'); if (i > 0) el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); } };
  /** @returns {HTMLElement} */
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'style') css(el, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
    return el;
  }
  function s(tag, attrs = {}, text) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) k === 'style' ? css(el, v) : el.setAttribute(k, String(v));
    if (text != null) el.textContent = text;
    return el;
  }
  const usd = n => (n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);
  const tok = n => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const pct = n => `${Math.round(n * 100)}%`;
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const cost = e => e.c ?? 0;
  const name = id => data.names[id] || id;
  const when = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dur = ms => (ms < 60e3 ? '<1 min' : ms < HOUR ? `${Math.round(ms / 60e3)} min` : `${(ms / HOUR).toFixed(1)} h`);

  /** Color follows the model, never its rank: slot = order of first appearance in the whole history. */
  let colorOf = () => 'var(--other)';
  function assignColors() {
    const order = [];
    for (const e of data.entries) if (!order.includes(e.m)) order.push(e.m);
    colorOf = id => { const i = order.indexOf(id); return i >= 0 && i < SLOTS ? `var(--series-${i + 1})` : 'var(--other)'; };
  }
  const groupOf = id => (colorOf(id) === 'var(--other)' ? 'Other' : id);

  function save() { vscode.setState(state); render(); }
  function inProject(e) { return state.project === 'all' || e.p === state.project; }
  function rangeStart() {
    const now = Date.now();
    return { today: dayStart(now), '7d': dayStart(now) - 6 * DAY, '30d': dayStart(now) - 29 * DAY }[state.range] ?? 0;
  }
  function filtered() {
    const sid = state.sessionPick ?? data.session;
    const from = rangeStart();
    return data.entries.filter(e => inProject(e) && (state.range === 'session' ? e.s === sid : e.t >= from));
  }
  function totals(list) {
    const t = { cost: 0, req: list.length, i: 0, o: 0, cr: 0, cw: 0, unpriced: 0 };
    for (const e of list) { t.cost += cost(e); t.i += e.i; t.o += e.o; t.cr += e.cr; t.cw += e.cw; if (e.c == null) t.unpriced++; }
    return t;
  }

  // ---------- tooltip ----------
  const tip = /** @type {HTMLElement} */ (document.getElementById('tip'));
  function showTip(ev, title, lines, total) {
    tip.replaceChildren(h('div', { class: 't' }, title),
      ...lines.map(([sw, label, value]) => h('div', { class: 'l' }, h('span', {}, sw ? h('i', { class: 'swatch', style: `background:${sw}` }) : null, label), h('span', { class: 'num' }, value))),
      total ? h('div', { class: 'l tot' }, h('span', {}, 'Total'), h('span', { class: 'num' }, total)) : null);
    tip.hidden = false;
    const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- sections ----------
  function header() {
    const projects = [...new Set(data.entries.map(e => e.p))].sort();
    return [
      h('header', {},
        h('div', {}, h('h1', {}, 'Vertex Costs'),
          h('div', { class: 'meta' }, `Project ${data.project || 'not detected'} · ${data.location} · costs are estimates from list prices; Cloud Billing is the source of truth`)),
        h('div', { class: 'actions' },
          h('button', { onclick: () => vscode.postMessage({ type: 'export' }), title: 'Save every recorded request as CSV' }, 'Export CSV'),
          h('button', { onclick: () => vscode.postMessage({ type: 'reset' }), title: 'Erase recorded history' }, 'Reset'))),
      h('div', { class: 'filters', role: 'toolbar', 'aria-label': 'Filters' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' },
          RANGES.map(([id, label]) => h('button', { 'aria-pressed': String(state.range === id), onclick: () => { state.range = id; state.sessionPick = null; save(); } }, label))),
        h('label', {}, 'Project ', h('select', { onchange: e => { state.project = e.target.value; save(); } },
          h('option', { value: 'all', selected: state.project === 'all' }, 'All projects'),
          projects.map(p => h('option', { value: p, selected: state.project === p }, p)))),
        state.sessionPick && state.sessionPick !== data.session
          ? h('span', { class: 'chip' }, `Session from ${when(Math.min(...data.entries.filter(e => e.s === state.sessionPick).map(e => e.t)))}`,
              h('button', { 'aria-label': 'Back to this session', onclick: () => { state.sessionPick = null; save(); } }, '×'))
          : null),
    ];
  }

  function kpis(list) {
    const t = totals(list);
    const inAll = t.i + t.cr + t.cw;
    const tiles = [
      ['Spend', usd(t.cost), t.unpriced ? `+${t.unpriced} requests without a price` : RANGES.find(r => r[0] === state.range)[1]],
      ['Requests', t.req.toLocaleString(), t.req ? `${usd(t.cost / t.req)} average` : '—'],
      ['Input tokens', tok(inAll), `${tok(t.o)} output · input includes cached`],
      ['Cache hit rate', inAll ? pct(t.cr / inAll) : '—', t.cr ? `${tok(t.cr)} tokens read from cache` : 'no cached tokens yet'],
    ].map(([label, value, sub]) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value num' }, value), h('div', { class: 'sub' }, sub)));
    if (data.budget > 0) {
      const spent = data.entries.filter(e => e.p === data.project).reduce((a, e) => a + cost(e), 0);
      const r = spent / data.budget;
      tiles.push(h('div', { class: 'kpi' }, h('div', { class: 'label', title: data.project }, 'Budget (this project)'),
        h('div', { class: 'value num' }, usd(spent)),
        h('div', { class: `bar${r >= 1 ? ' over' : ''}`, role: 'progressbar', 'aria-valuenow': String(Math.round(r * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
          h('span', { style: `width:${Math.min(100, r * 100)}%` })),
        h('div', { class: 'sub' }, `of ${usd(data.budget)} · ${r >= 1 ? 'over budget' : `${pct(1 - r)} left`}`)));
    }
    return h('section', { class: 'kpis', 'aria-label': 'Summary' }, tiles);
  }

  function buckets(list) {
    const now = Date.now();
    const first = list.length ? Math.min(...list.map(e => e.t)) : now;
    const from = state.range === 'session' || state.range === 'all' ? first : rangeStart();
    const sizes = state.range === 'session' || state.range === 'today' ? [15 * 60e3, HOUR, 6 * HOUR] : state.range === 'all' ? [DAY, 7 * DAY] : [DAY];
    const size = sizes.find(sz => (now - from) / sz <= 60) ?? sizes[sizes.length - 1];
    const align = t => (size >= DAY ? dayStart(t) : Math.floor(t / size) * size);
    const out = [];
    for (let t = align(from); t <= now; t += size) out.push({ t, by: new Map(), total: 0 });
    const end = state.range === 'session' ? Math.max(now, ...list.map(e => e.t)) : now;
    while (out.length && out[out.length - 1].t + size < end) out.push({ t: out[out.length - 1].t + size, by: new Map(), total: 0 });
    for (const e of list) {
      const b = out[Math.min(out.length - 1, Math.max(0, Math.floor((align(e.t) - out[0].t) / size)))];
      const g = groupOf(e.m);
      b.by.set(g, (b.by.get(g) ?? 0) + cost(e)); b.total += cost(e);
    }
    const fmt = size >= DAY ? (t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
      : (t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
    return { out, fmt, size };
  }

  /** Axis from 0 with 2–5 round steps; labels get enough decimals for the step. */
  function axis(v) {
    if (v <= 0) v = 0.01;
    const raw = v / 4, p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= raw);
    const max = Math.ceil(v / step - 1e-9) * step;
    const d = Math.max(2, Math.ceil(-Math.log10(step) + (step / p === 2.5 ? 1 : 0)));
    return { max, step, fmt: n => `$${n.toFixed(Math.min(d, 4))}` };
  }

  function spendChart(list) {
    const { out, fmt, size } = buckets(list);
    const series = [...new Set(list.map(e => groupOf(e.m)))];
    series.sort((a, b) => (a === 'Other') - (b === 'Other') || list.filter(e => groupOf(e.m) === b).reduce((x, e) => x + cost(e), 0) - list.filter(e => groupOf(e.m) === a).reduce((x, e) => x + cost(e), 0));
    const color = g => (g === 'Other' ? 'var(--other)' : colorOf(g));
    const label = g => (g === 'Other' ? 'Other' : name(g));
    const W = 760, H = 240, L = 52, R = 8, T = 10, B = 26;
    const ax = axis(Math.max(0, ...out.map(b => b.total)));
    const max = ax.max;
    const y = v => T + (H - T - B) * (1 - v / max);
    const bw = (W - L - R) / out.length, barW = Math.max(2, Math.min(28, bw - 4));
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Spend per ${size >= DAY ? 'day' : 'interval'} by model` });
    for (let v = 0; v <= max + 1e-9; v += ax.step)
      svg.append(s('line', { class: 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }), s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, ax.fmt(v)));
    const every = Math.ceil(out.length / 7);
    out.forEach((b, i) => {
      const cx = L + bw * i + bw / 2;
      if (i % every === 0) svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, fmt(b.t)));
      let top = y(0);
      const segs = series.filter(g => b.by.get(g) > 0);
      segs.forEach((g, j) => {
        const hgt = Math.max(1, y(0) - y(b.by.get(g)));
        const yTop = top - hgt;
        const x = cx - barW / 2;
        // 2px surface gap between stacked segments; rounded data-end only on the top segment.
        const gap = j > 0 ? 2 : 0;
        if (j === segs.length - 1) {
          const r = Math.min(4, barW / 2, hgt - gap);
          svg.append(s('path', { fill: color(g), d: `M${x},${top - gap} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${top - gap} Z` }));
        } else svg.append(s('rect', { fill: color(g), x, y: yTop, width: barW, height: Math.max(0.5, hgt - gap) }));
        top = yTop;
      });
      const hit = s('rect', { class: 'hit', x: L + bw * i, y: T, width: bw, height: H - T - B });
      hit.addEventListener('mousemove', ev => showTip(ev, fmt(b.t) + (size >= DAY ? '' : ` – ${fmt(b.t + size)}`),
        segs.slice().reverse().map(g => [color(g), label(g), usd(b.by.get(g))]), segs.length > 1 ? usd(b.total) : null));
      hit.addEventListener('mouseleave', hideTip);
      svg.append(hit);
    });
    svg.append(s('line', { class: 'gridline', x1: L, x2: W - R, y1: y(0), y2: y(0), style: 'stroke:var(--text-secondary);opacity:.5' }));
    return h('div', { class: 'card' }, h('h2', {}, 'Spend over time'),
      series.length > 1 ? h('div', { class: 'legend' }, series.map(g => h('span', {}, h('i', { style: `background:${color(g)}` }), label(g)))) : null,
      list.length ? svg : h('p', { class: 'muted' }, 'No requests in this range.'));
  }

  function hbars(title, rows, total) {
    const max = Math.max(0, ...rows.map(r => r.value)) || 1;
    return h('div', { class: 'card' }, h('h2', {}, title),
      rows.length ? h('div', { class: 'hbars' }, rows.map(r => h('div', { class: 'hbar' },
        h('div', { class: 'row' }, h('span', {}, r.label), h('span', { class: 'num muted' }, `${usd(r.value)} · ${total ? pct(r.value / total) : '—'}`)),
        h('div', { class: 'track', title: r.detail }, h('div', { class: 'fill', style: `width:${(r.value / max) * 100}%;background:${r.color}` })))))
        : h('p', { class: 'muted' }, 'Nothing yet.'));
  }

  function byModel(list) {
    const m = new Map();
    for (const e of list) { const x = m.get(e.m) ?? { value: 0, req: 0, i: 0, o: 0 }; x.value += cost(e); x.req++; x.i += e.i + e.cr + e.cw; x.o += e.o; m.set(e.m, x); }
    const t = totals(list).cost;
    return hbars('By model', [...m].sort((a, b) => b[1].value - a[1].value).map(([id, x]) =>
      ({ label: name(id), value: x.value, color: colorOf(id), detail: `${x.req} requests · ${tok(x.i)} in · ${tok(x.o)} out` })), t);
  }

  function bySource(list) {
    const m = new Map();
    for (const e of list) m.set(e.src, (m.get(e.src) ?? 0) + cost(e));
    return hbars('By source', [...m].sort((a, b) => b[1] - a[1]).map(([src, v]) => ({ label: SOURCES[src] ?? src, value: v, color: 'var(--series-1)' })), totals(list).cost);
  }

  function sessions() {
    const m = new Map();
    for (const e of data.entries) {
      if (!inProject(e)) continue;
      const x = m.get(e.s) ?? { start: e.t, end: e.t, req: 0, cost: 0, models: new Map() };
      x.start = Math.min(x.start, e.t); x.end = Math.max(x.end, e.t); x.req++; x.cost += cost(e);
      x.models.set(e.m, (x.models.get(e.m) ?? 0) + cost(e)); m.set(e.s, x);
    }
    const rows = [...m].sort((a, b) => b[1].end - a[1].end).slice(0, 100);
    const pick = id => { state.range = 'session'; state.sessionPick = id === data.session ? null : id; save(); };
    const selected = state.range === 'session' ? (state.sessionPick ?? data.session) : null;
    return h('div', { class: 'card' }, h('h2', {}, 'Sessions'), h('p', { class: 'muted', style: 'margin:-6px 0 8px' }, 'One session per VS Code window. Select a row to filter the dashboard.'),
      rows.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Started'), h('th', {}, 'Length'), h('th', {}, 'Top model'), h('th', { class: 'r' }, 'Requests'), h('th', { class: 'r' }, 'Spend'))),
        h('tbody', {}, rows.map(([id, x]) => {
          const top = [...x.models].sort((a, b) => b[1] - a[1])[0][0];
          return h('tr', { class: `click${id === selected ? ' sel' : ''}`, tabindex: '0', 'aria-selected': String(id === selected), onclick: () => pick(id), onkeydown: ev => ev.key === 'Enter' && pick(id) },
            h('td', {}, when(x.start), id === data.session ? h('span', { class: 'badge' }, 'this window') : null),
            h('td', {}, dur(x.end - x.start)),
            h('td', {}, h('i', { class: 'swatch', style: `background:${colorOf(top)}` }), name(top)),
            h('td', { class: 'r num' }, x.req), h('td', { class: 'r num' }, usd(x.cost)));
        }))))
        : h('p', { class: 'muted' }, 'No sessions yet.'));
  }

  function recent(list) {
    const rows = list.slice(-100).reverse();
    return h('div', { class: 'card' }, h('h2', {}, `Requests${list.length > 100 ? ' (latest 100)' : ''}`),
      rows.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Time', 'Model', 'Source'].map(t => h('th', {}, t)), ['Input', 'Output', 'Cached', 'Cost'].map(t => h('th', { class: 'r' }, t)))),
        h('tbody', {}, rows.map(e => h('tr', {},
          h('td', {}, when(e.t)), h('td', {}, h('i', { class: 'swatch', style: `background:${colorOf(e.m)}` }), name(e.m)), h('td', {}, SOURCES[e.src] ?? e.src),
          h('td', { class: 'r num' }, tok(e.i + e.cw)), h('td', { class: 'r num' }, tok(e.o)), h('td', { class: 'r num' }, tok(e.cr)),
          h('td', { class: 'r num' }, e.c == null ? 'n/a' : usd(e.c)))))))
        : h('p', { class: 'muted' }, 'No requests in this range.'));
  }

  function render() {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    hideTip();
    if (!data) { app.replaceChildren(h('p', { class: 'muted' }, 'Loading…')); return; }
    if (!data.entries.length) {
      app.replaceChildren(...header(), h('div', { class: 'card empty' }, h('h2', {}, 'No Vertex requests yet'),
        h('p', {}, 'Pick a model under "Vertex Models" in the Copilot Chat model picker, or type @vertex in a Local chat. Spend shows up here as soon as a request finishes.')));
      return;
    }
    assignColors();
    const list = filtered();
    app.replaceChildren(...header(), kpis(list),
      h('div', { class: 'grid2' }, spendChart(list), h('div', { class: 'stack' }, byModel(list), bySource(list))),
      h('div', { class: 'stack' }, sessions(), recent(list)));
  }

  window.addEventListener('message', e => { if (e.data?.type === 'data') { data = e.data; render(); } });
  render();
  vscode.postMessage({ type: 'ready' });
})();
