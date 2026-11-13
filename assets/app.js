/* พอร์ตลงทุน — หน้าเว็บ static อ่าน data/*.json แล้วคำนวณฝั่งเบราว์เซอร์ */
(() => {
'use strict';

const LS_KEY = 'portfolio.v1';
const TYPES = {
  etf: { label: 'ETF', color: 'var(--c-etf)' },
  stock: { label: 'หุ้นรายตัว', color: 'var(--c-stock)' },
  fund: { label: 'กองทุนรวม', color: 'var(--c-fund)' },
  gold: { label: 'ทองคำ', color: 'var(--c-gold)', darkLabel: true },
  crypto: { label: 'คริปโต', color: 'var(--c-crypto)' },
};
const COMP_LABEL = {
  drawdown: 'ส่วนลดจากจุดสูงสุด', technical: 'เทคนิคอล (oversold)',
  trend: 'ราคาเทียบแนวโน้มระยะยาว', valuation: 'มูลค่าพื้นฐาน',
};
const ZONES = [
  { min: 75, cls: 's3', label: 'โซนซื้อไม้ใหญ่', mult: 1.5 },
  { min: 60, cls: 's2', label: 'ทยอยซื้อ', mult: 1 },
  { min: 45, cls: 's1', label: 'เริ่มน่าสนใจ', mult: 0.5 },
  { min: -1, cls: 's0', label: 'รอ', mult: 0 },
];
const zoneOf = s => ZONES.find(z => (s ?? 0) >= z.min);

const S = { market: null, repoPortfolio: null, portfolio: null, watch: null,
            tab: location.hash.slice(1) || 'overview', cur: 'THB', range: 252 };

/* ---------- helpers ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svgEl = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
};
const SYM = { THB: '฿', USD: '$' };
const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
function money(v, cur = S.cur, d) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  if (d == null) d = a >= 1000 ? 0 : a >= 1 ? 2 : 4;
  return (v < 0 ? '−' : '') + (SYM[cur] || cur + ' ') + nf(d).format(a);
}
function compact(v, cur = S.cur) {
  const a = Math.abs(v);
  if (a >= 1e6) return (SYM[cur] || '') + (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e4) return (SYM[cur] || '') + Math.round(v / 1e3) + 'K';
  return (SYM[cur] || '') + nf(a >= 100 ? 0 : 2).format(v);
}
const pct = (v, d = 1, sign = true) => v == null || !isFinite(v) ? '–'
  : (v > 0 && sign ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(d) + '%';
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const arrow = v => v > 0 ? '▲ ' : v < 0 ? '▼ ' : '';
const dayToDate = d => new Date(d * 864e5);
const fmtDate = (d, long) => dayToDate(d).toLocaleDateString('th-TH',
  long ? { day: 'numeric', month: 'short', year: '2-digit' } : { month: 'short', year: '2-digit' });

/* อัตราแลกเปลี่ยน: ทุกอย่างคิดผ่านบาท */
const fxRate = cur => (S.market.fx[cur] || { rate: 1 }).rate || 1;
const conv = (v, from, to = S.cur) => v == null ? null : v * fxRate(from) / fxRate(to);

/* ราคา ณ วันที่ d (ใช้ค่าล่าสุดก่อนหน้า) จาก series {d:[], c:[]} */
function priceAt(series, day) {
  const ds = series.d; let lo = 0, hi = ds.length - 1;
  if (day < ds[0]) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ds[m] <= day) lo = m; else hi = m - 1; }
  return series.c[lo];
}

/* ---------- portfolio model ---------- */
function loadPortfolio() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* private mode ฯลฯ — ใช้ไฟล์จาก repo แทน */ }
  return JSON.parse(JSON.stringify(S.repoPortfolio));
}
function savePortfolio() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S.portfolio)); } catch (e) { /* ignore */ }
}
const isLocal = () => { try { return !!localStorage.getItem(LS_KEY); } catch (e) { return false; } };

function positions() {
  const rows = S.portfolio.holdings.map(hd => {
    const a = S.market.assets[hd.symbol];
    const cur = (a && a.currency) || hd.currency || 'USD';
    const price = hd.manual_price != null ? hd.manual_price : a ? a.price : null;
    const qty = +hd.qty || 0;
    const value = price != null ? conv(price * qty, cur) : null;
    const cost = hd.avg_cost ? conv(hd.avg_cost * qty, cur) : null;
    return { ...hd, a, cur, price, qty, value, cost,
      pl: value != null && cost != null ? value - cost : null,
      dayChg: a && value != null && a.change_pct != null ? value - value / (1 + a.change_pct) : 0 };
  });
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  rows.forEach(r => { r.weight = total ? (r.value || 0) / total : 0; });
  return { rows, total };
}

/* ขนาดไม้ซื้อ: งบสะสมรายเดือนแบ่ง 3 หน่วย × ตัวคูณตามโซนคะแนน แล้วคุมไม่ให้เกินเพดานน้ำหนัก */
function buyPlan(pos) {
  const budget = conv(+S.portfolio.opportunity_budget || 0, 'THB');
  const unit = budget / 3;
  const plan = new Map();
  let sum = 0;
  for (const r of pos.rows) {
    if (r.mode !== 'accumulate' || !r.a) continue;
    const z = zoneOf(r.a.score);
    let amt = unit * z.mult, capped = false;
    if (r.max_weight) {
      const room = Math.max(0, r.max_weight * (pos.total + budget) - (r.value || 0));
      if (amt > room) { amt = room; capped = true; }
    }
    plan.set(r.symbol, { amt, capped, zone: z });
    sum += amt;
  }
  const scale = sum > budget && sum > 0 ? budget / sum : 1;
  plan.forEach(p => { p.amt *= scale; p.scaled = scale < 1; });
  return { plan, total: sum * scale, budget };
}

/* มูลค่าพอร์ตย้อนหลัง โดยสมมติถือจำนวนเท่าปัจจุบันตลอดช่วง */
function valueHistory(pos, days) {
  const held = pos.rows.filter(r => r.a && r.a.series && r.qty > 0);
  if (!held.length) return null;
  const end = Math.max(...held.map(r => r.a.series.d.at(-1)));
  const start = Math.max(end - Math.round(days * 365 / 252), ...held.map(r => r.a.series.d[0]));
  const xs = [], ys = [];
  for (let d = start; d <= end; d++) {
    const wd = dayToDate(d).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    let v = 0;
    for (const r of held) {
      const fx = S.market.fx[r.cur];
      const rate = fx && fx.series ? (priceAt(fx.series, d) ?? fx.rate) : fxRate(r.cur);
      v += priceAt(r.a.series, d) * r.qty * rate;
    }
    xs.push(d); ys.push(v / fxRate(S.cur));
  }
  return { x: xs, y: ys };
}

/* สหสัมพันธ์ผลตอบแทนรายสัปดาห์ 1 ปี ระหว่างสินทรัพย์กับพอร์ตปัจจุบัน */
function weeklyReturns(getVal, end) {
  const out = []; let prev = null;
  for (let d = end - 364; d <= end; d += 7) {
    const v = getVal(d);
    out.push(prev && v ? v / prev - 1 : null);
    prev = v;
  }
  return out;
}
function corr(a, b) {
  const p = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x != null && y != null);
  if (p.length < 20) return null;
  const mx = p.reduce((s, q) => s + q[0], 0) / p.length, my = p.reduce((s, q) => s + q[1], 0) / p.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/* ---------- charts (SVG) ---------- */
function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}
/* opts: {x:[day], series:[{name,y:[],color,width,area}], hlines:[{y,label}], fmt, height} */
function lineChart(opts) {
  const wrap = h('div', { class: 'chart' });
  let lastW = 0;
  const ro = new ResizeObserver(es => {
    const w = Math.round(es[0].contentRect.width);
    if (w > 0 && Math.abs(w - lastW) > 2) { lastW = w; wrap.replaceChildren(drawLine(opts, w)); }
  });
  ro.observe(wrap);
  return wrap;
}
function drawLine(opts, W) {
  const small = W < 480;
  const H = Math.min(opts.height || 220, small ? 190 : 999), m = { l: 4, r: 52, t: 10, b: 22 };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label || 'กราฟ' });
  const all = opts.series.flatMap(s => s.y).filter(v => v != null)
    .concat((opts.hlines || []).map(l => l.y));
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.06 || hi * 0.02 || 1; lo -= pad; hi += pad;
  const x0 = opts.x[0], x1 = opts.x.at(-1);
  const px = d => m.l + (d - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
  const py = v => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
  const fmt = opts.fmt || (v => nf(0).format(v));

  for (const t of niceTicks(lo, hi)) {
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: py(t), y2: py(t), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const tx = svgEl('text', { x: W - m.r + 6, y: py(t) + 4 }); tx.textContent = opts.tickFmt ? opts.tickFmt(t) : fmt(t);
    svg.append(tx);
  }
  const nT = small ? 2 : 4;
  for (let i = 0; i <= nT; i++) {
    const d = x0 + (x1 - x0) * i / nT;
    const tx = svgEl('text', { x: px(d), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === nT ? 'end' : 'middle' });
    tx.textContent = fmtDate(d); svg.append(tx);
  }
  for (const l of opts.hlines || []) {
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: py(l.y), y2: py(l.y), stroke: 'var(--level)', 'stroke-width': 1, opacity: .75 }));
    const tx = svgEl('text', { x: m.l + 4, y: py(l.y) - 4 }); tx.textContent = l.label; svg.append(tx);
  }
  for (const s of opts.series) {
    let dPath = '', pen = false, first = null, last = null;
    s.y.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      dPath += (pen ? 'L' : 'M') + px(opts.x[i]).toFixed(1) + ' ' + py(v).toFixed(1);
      pen = true; if (first == null) first = i; last = i;
    });
    if (s.area && first != null) {
      svg.append(svgEl('path', { d: `${dPath}L${px(opts.x[last])} ${H - m.b}L${px(opts.x[first])} ${H - m.b}Z`, fill: s.color, opacity: .1 }));
    }
    svg.append(svgEl('path', { d: dPath, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (s.endDot && last != null) {
      svg.append(svgEl('circle', { cx: px(opts.x[last]), cy: py(s.y[last]), r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
    }
  }
  /* crosshair + tooltip */
  const cross = svgEl('line', { y1: m.t, y2: H - m.b, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  const tip = document.getElementById('tip');
  const move = ev => {
    const box = svg.getBoundingClientRect();
    const fx = (ev.clientX - box.left) / box.width * W;
    const target = x0 + (fx - m.l) / (W - m.l - m.r) * (x1 - x0);
    let i = 0, best = Infinity;
    opts.x.forEach((d, k) => { const e = Math.abs(d - target); if (e < best) { best = e; i = k; } });
    cross.setAttribute('x1', px(opts.x[i])); cross.setAttribute('x2', px(opts.x[i])); cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', { class: 'muted' }, fmtDate(opts.x[i], true)),
      ...opts.series.filter(s => s.y[i] != null).map(s => h('div', { class: 't-row' },
        h('span', { class: 'ink2' }, h('span', { class: 'key', style: `background:${s.color}` }), s.name),
        h('strong', { class: 'num' }, fmt(s.y[i])))));
    tip.hidden = false;
    const tw = tip.offsetWidth, left = ev.clientX + 14 + tw > innerWidth ? ev.clientX - tw - 14 : ev.clientX + 14;
    tip.style.left = Math.max(4, left) + 'px'; tip.style.top = Math.max(4, ev.clientY - 50) + 'px';
  };
  const leave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave); svg.addEventListener('pointercancel', leave);
  return svg;
}
function sparkline(series, n = 60) {
  const c = series.c.slice(-n), W = 84, H = 26;
  const lo = Math.min(...c), hi = Math.max(...c);
  const pts = c.map((v, i) => `${(i / (c.length - 1) * W).toFixed(1)},${(H - 2 - (v - lo) / (hi - lo || 1) * (H - 4)).toFixed(1)}`).join(' ');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  svg.append(svgEl('polyline', { points: pts, fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  return svg;
}
function meter(v, thin) {
  const el = h('div', { class: 'meter' + (thin ? ' thin' : ''), role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(v ?? 0) },
    h('b', { style: `width:${Math.max(0, Math.min(100, v ?? 0))}%` }));
  if (!thin) for (const t of [45, 60, 75]) el.append(h('s', { style: `left:${t}%` }));
  return el;
}
const chip = score => { const z = zoneOf(score); return h('span', { class: 'chip ' + z.cls }, h('i'), z.label); };

/* ---------- views ---------- */
function viewOverview() {
  const pos = positions(), out = [];
  if (!pos.rows.length) return [h('div', { class: 'card empty' }, 'ยังไม่มีสินทรัพย์ในพอร์ต — เพิ่มได้ที่แท็บ "จัดการพอร์ต"')];
  const cost = pos.rows.reduce((s, r) => s + (r.cost || 0), 0);
  const pl = pos.rows.reduce((s, r) => s + (r.pl || 0), 0);
  const day = pos.rows.reduce((s, r) => s + r.dayChg, 0);
  const plan = buyPlan(pos);
  const nBuy = [...plan.plan.values()].filter(p => p.amt > 0).length;

  out.push(h('section', { class: 'card' },
    h('p', { class: 'muted small' }, 'มูลค่าพอร์ตรวม'),
    h('div', { class: 'hero' }, money(pos.total, S.cur, 0)),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('p', { class: 'muted small' }, 'เปลี่ยนแปลงวันล่าสุด'),
        h('div', { class: 'v ' + cls(day) }, arrow(day) + money(Math.abs(day), S.cur, 0)),
        h('p', { class: 'small ' + cls(day) }, pct(day / (pos.total - day)))),
      h('div', { class: 'tile' }, h('p', { class: 'muted small' }, 'กำไร/ขาดทุนที่ยังไม่รับรู้'),
        h('div', { class: 'v ' + cls(pl) }, arrow(pl) + money(Math.abs(pl), S.cur, 0)),
        h('p', { class: 'small ' + cls(pl) }, cost ? pct(pl / cost) : '–')),
      h('div', { class: 'tile' }, h('p', { class: 'muted small' }, 'ต้นทุนรวม'),
        h('div', { class: 'v' }, money(cost, S.cur, 0)),
        h('p', { class: 'small muted' }, pos.rows.length + ' สินทรัพย์')),
      h('div', { class: 'tile' }, h('p', { class: 'muted small' }, 'ควรซื้อเพิ่มรอบนี้'),
        h('div', { class: 'v' }, money(plan.total, S.cur, 0)),
        h('p', { class: 'small muted' }, nBuy ? `${nBuy} ตัวเข้าโซนซื้อ` : 'ยังไม่มีตัวเข้าโซน')))));

  const hist = valueHistory(pos, S.range);
  if (hist && hist.x.length > 5) {
    const chg = hist.y.at(-1) / hist.y[0] - 1;
    const ranges = [[21, '1 เดือน'], [63, '3 เดือน'], [126, '6 เดือน'], [252, '1 ปี'], [504, '2 ปี']];
    out.push(h('section', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', {}, h('h2', {}, 'มูลค่าพอร์ตย้อนหลัง'),
          h('p', { class: 'small muted' }, 'สมมติถือจำนวนเท่าปัจจุบันตลอดช่วง · ',
            h('span', { class: cls(chg) }, pct(chg)), ' ในช่วงนี้')),
        h('div', { class: 'seg' }, ranges.map(([d, l]) => h('button', { 'aria-pressed': String(S.range === d),
          onclick: () => { S.range = d; render(); } }, l)))),
      lineChart({ x: hist.x, series: [{ name: 'มูลค่าพอร์ต', y: hist.y, color: 'var(--accent)', area: true, endDot: true }],
        fmt: v => money(v, S.cur, 0), tickFmt: v => compact(v), label: 'กราฟมูลค่าพอร์ตย้อนหลัง' })));
  }

  /* สัดส่วนตามประเภทสินทรัพย์ */
  const byType = {};
  pos.rows.forEach(r => { byType[r.type] = (byType[r.type] || 0) + (r.value || 0); });
  const parts = Object.keys(TYPES).filter(t => byType[t] > 0).map(t => ({ t, w: byType[t] / pos.total }));
  const byCur = {};
  pos.rows.forEach(r => { byCur[r.cur] = (byCur[r.cur] || 0) + r.weight; });
  out.push(h('section', { class: 'card' },
    h('h2', {}, 'สัดส่วนสินทรัพย์'),
    h('p', { class: 'small muted' }, 'สกุลเงิน: ' + Object.entries(byCur).map(([c, w]) => `${c} ${pct(w, 0, false)}`).join(' · ')),
    h('div', { class: 'segbar', role: 'img', 'aria-label': parts.map(p => `${TYPES[p.t].label} ${pct(p.w, 0, false)}`).join(', ') },
      parts.map(p => h('div', { class: TYPES[p.t].darkLabel ? 'dark-label' : '', style: `flex:${p.w} 0 0;background:${TYPES[p.t].color}`,
        title: `${TYPES[p.t].label} ${pct(p.w, 1, false)}` }, p.w >= 0.09 ? pct(p.w, 0, false) : ''))),
    h('div', { class: 'legend' }, parts.map(p => h('span', {},
      h('span', { class: 'sw', style: `background:${TYPES[p.t].color}` }), `${TYPES[p.t].label} ${pct(p.w, 1, false)}`)))));

  /* ตารางสินทรัพย์ */
  const sorted = [...pos.rows].sort((a, b) => (b.value || 0) - (a.value || 0));
  out.push(h('section', { class: 'card' },
    h('h2', {}, 'สินทรัพย์ที่ถือ'),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'สินทรัพย์'), h('th', { class: 'hide-sm' }, '60 วัน'), h('th', {}, 'ราคา'),
        h('th', {}, 'มูลค่า'), h('th', {}, 'กำไร/ขาดทุน'), h('th', { class: 'hide-sm' }, 'สัญญาณ'))),
      h('tbody', {}, sorted.map(r => h('tr', {},
        h('td', {}, h('span', { class: 'sw', style: `background:${(TYPES[r.type] || TYPES.stock).color}`, title: (TYPES[r.type] || TYPES.stock).label }),
          h('strong', {}, r.symbol.replace('.BK', '')), h('span', { class: 'sub name' }, r.name || '')),
        h('td', { class: 'hide-sm' }, r.a && r.a.series ? sparkline(r.a.series) : ''),
        h('td', { class: 'num' }, r.price != null ? money(r.price, r.cur) : 'ไม่มีราคา',
          h('span', { class: 'sub ' + cls(r.a && r.a.change_pct) }, r.a ? pct(r.a.change_pct, 2) : '')),
        h('td', { class: 'num' }, money(r.value, S.cur, 0), h('span', { class: 'sub' }, pct(r.weight, 1, false), h('span', { class: 'hide-sm' }, ' ของพอร์ต'))),
        h('td', { class: 'num ' + cls(r.pl) }, r.pl != null ? money(r.pl, S.cur, 0) : '–',
          h('span', { class: 'sub ' + cls(r.pl) }, r.cost ? pct(r.pl / r.cost) : '')),
        h('td', { class: 'hide-sm' }, r.a ? chip(r.a.score) : ''))))))));
  return out;
}

function signalCard(r, p, opts = {}) {
  const a = r.a, z = zoneOf(a.score);
  const notes = [];
  if (a.flags.includes('falling_knife')) notes.push(['warn', 'ราคาลงแรงผิดปกติในเดือนที่ผ่านมา — แบ่งไม้ซื้อ อย่าเข้าครั้งเดียวทั้งก้อน และเช็กข่าวว่าพื้นฐานเปลี่ยนหรือไม่']);
  if (a.flags.includes('below_ma200')) notes.push(['', 'ราคาอยู่ต่ำกว่าเส้นค่าเฉลี่ย 200 วัน (แนวโน้มระยะกลางเป็นขาลง)']);
  if (a.flags.includes('short_history')) notes.push(['', 'ข้อมูลย้อนหลังน้อยกว่า 2 ปี คะแนนจึงเชื่อถือได้น้อยลง']);
  if (a.stale) notes.push(['warn', 'ดึงราคารอบล่าสุดไม่สำเร็จ กำลังแสดงข้อมูลรอบก่อน']);
  if (p && p.capped) notes.push(['', `จำกัดยอดซื้อเพราะน้ำหนักในพอร์ตใกล้เพดาน ${pct(r.max_weight, 0, false)} ที่ตั้งไว้`]);

  let buy;
  if (opts.candidate) buy = null;
  else if (r.mode !== 'accumulate') {
    buy = h('div', { class: 'buybox' }, h('p', { class: 'small muted' }, 'โหมด DCA'),
      h('div', { class: 'amt' }, 'ซื้อตามแผนปกติ'),
      h('p', { class: 'small ink2' }, a.score >= 60 ? 'ราคาอยู่ในโซนลดราคา ถ้ามีงบเหลือเพิ่มยอด DCA รอบนี้ได้' : 'ไม่ต้องจับจังหวะ'));
  } else if (p.amt > 0) {
    const local = conv(p.amt, S.cur, r.cur);
    buy = h('div', { class: 'buybox' }, h('p', { class: 'small muted' }, 'แนะนำซื้อเพิ่มรอบนี้'),
      h('div', { class: 'amt' }, money(p.amt, S.cur, 0)),
      h('p', { class: 'small ink2' }, `≈ ${nf(local / a.price >= 10 ? 1 : 3).format(local / a.price)} หน่วย ที่ราคา ${money(a.price, r.cur)}`
        + (p.scaled ? ' · ปรับลดให้พอดีงบ' : '')));
  } else {
    const next = a.ladder.find(l => !l.hit);
    buy = h('div', { class: 'buybox' }, h('p', { class: 'small muted' }, 'รอบนี้'),
      h('div', { class: 'amt' }, p.capped ? 'ถือเต็มเพดานแล้ว' : 'ยังไม่ซื้อเพิ่ม'),
      h('p', { class: 'small ink2' }, next ? `จุดสนใจถัดไป ${money(next.price, r.cur)} (ลงอีก ${pct(1 - next.price / a.price, 1, false)})` : 'รอคะแนนถึง 45'));
  }

  const comps = Object.entries(a.components).filter(([, v]) => v != null).map(([k, v]) =>
    h('div', {}, h('div', { class: 'row between small' }, h('span', { class: 'ink2' }, COMP_LABEL[k]), h('strong', { class: 'num' }, Math.round(v))), meter(v, true)));

  const s = a.series, n = Math.min(s.d.length, 380), x = s.d.slice(-n), c = s.c.slice(-n);
  const lo = Math.min(...c) * 0.8;
  const chart = lineChart({ x, height: 200, label: `กราฟราคา ${r.symbol}`,
    series: [{ name: 'ราคา', y: c, color: 'var(--accent)', endDot: true },
             { name: 'เฉลี่ย 200 วัน', y: s.ma200.slice(-n), color: 'var(--muted)', width: 1.5 }],
    hlines: a.ladder.filter(l => l.price > lo).map(l => ({ y: l.price, label: l.label })),
    fmt: v => money(v, r.cur) });

  const f = a.fundamentals;
  return h('article', { class: 'card stack' },
    h('div', { class: 'row between' },
      h('div', {}, h('h3', {}, r.symbol.replace('.BK', ''), ' ', h('span', { class: 'muted', style: 'font-weight:400' }, r.name || a.name)),
        h('p', { class: 'small' }, h('span', { class: 'num' }, money(a.price, r.cur)), ' ',
          h('span', { class: cls(a.change_pct) }, pct(a.change_pct, 2)),
          h('span', { class: 'muted' }, ` · ต่ำกว่าจุดสูงสุด 52 สัปดาห์ ${pct(a.drawdown, 1, false)}`))),
      chip(a.score)),
    h('div', { class: 'grid2' },
      h('div', {}, h('div', { class: 'row', style: 'align-items:baseline' }, h('span', { class: 'scorebig' }, Math.round(a.score)), h('span', { class: 'muted small' }, '/ 100 คะแนนน่าซื้อ')),
        meter(a.score), h('div', { class: 'scale small muted' }, [45, 60, 75].map(t => h('span', { style: `left:${t}%` }, t)))),
      buy),
    opts.extra,
    notes.map(([k, t]) => h('p', { class: 'note ' + k }, t)),
    h('details', { open: opts.open || null }, h('summary', {}, 'รายละเอียดคะแนน กราฟ และขั้นบันไดราคา'),
      h('div', { class: 'stack', style: 'margin-top:10px' },
        h('div', { class: 'comps' }, comps),
        chart,
        h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'key', style: 'display:inline-block;width:14px;height:2px;background:var(--accent);margin-right:6px;vertical-align:middle' }), 'ราคา'),
          h('span', {}, h('span', { style: 'display:inline-block;width:14px;height:2px;background:var(--muted);margin-right:6px;vertical-align:middle' }), 'เฉลี่ย 200 วัน'),
          h('span', {}, h('span', { style: 'display:inline-block;width:14px;height:1px;background:var(--level);margin-right:6px;vertical-align:middle' }), 'ขั้นบันไดซื้อ')),
        a.ladder.length ? h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'ขั้น'), h('th', {}, 'ราคา'), h('th', {}, 'ลดจากจุดสูงสุด'), h('th', {}, 'สถานะ'))),
          h('tbody', {}, a.ladder.map(l => h('tr', {}, h('td', {}, l.label), h('td', { class: 'num' }, money(l.price, r.cur)),
            h('td', { class: 'num' }, pct(l.dd, 1, false)),
            h('td', {}, l.hit ? '✓ ถึงแล้ว' : `อีก ${pct(1 - l.price / a.price, 1, false)}`)))))) : null,
        h('p', { class: 'small muted' }, `RSI ${a.rsi14} · ห่างเส้น 200 วัน ${pct(a.dist200)} · ผันผวนต่อปี ${pct(a.vol, 0, false)} · ผลตอบแทน 1 ปี ${pct(a.ret['1y'])}`
          + (f ? ` · P/E ${f.pe ?? '–'} · Forward P/E ${f.forward_pe ?? '–'}` + (f.target_upside != null ? ` · เป้านักวิเคราะห์ ${pct(f.target_upside, 0)}` : '') : '')))));
}

function viewSignals() {
  const pos = positions(), plan = buyPlan(pos);
  const rows = pos.rows.filter(r => r.a).sort((a, b) =>
    (b.mode === 'accumulate') - (a.mode === 'accumulate') || b.a.score - a.a.score);
  const missing = pos.rows.filter(r => !r.a && r.manual_price == null);
  const buys = rows.filter(r => (plan.plan.get(r.symbol) || {}).amt > 0);
  return [
    h('section', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', {}, h('h2', {}, buys.length ? `รอบนี้ควรซื้อเพิ่ม ${money(plan.total, S.cur, 0)} ใน ${buys.length} ตัว` : 'รอบนี้ยังไม่มีตัวไหนถึงจุดซื้อเพิ่ม'),
          h('p', { class: 'small muted' }, buys.length ? buys.map(r => `${r.symbol.replace('.BK', '')} ${money(plan.plan.get(r.symbol).amt, S.cur, 0)}`).join(' · ')
            : 'DCA ตามแผนปกติต่อไป แล้วเก็บงบส่วนนี้ไว้รอจังหวะ')),
        h('label', { class: 'small ink2' }, 'งบซื้อสะสมต่อเดือน (บาท) ',
          h('input', { type: 'number', min: 0, step: 500, style: 'width:110px', value: S.portfolio.opportunity_budget,
            onchange: e => { S.portfolio.opportunity_budget = +e.target.value || 0; savePortfolio(); render(); } })))),
    rows.map((r, i) => signalCard(r, plan.plan.get(r.symbol), { open: i === 0 })),
    missing.length ? h('p', { class: 'note warn' }, `ยังไม่มีข้อมูลราคาของ ${missing.map(r => r.symbol).join(', ')} — เพิ่ม symbol ลง data/portfolio.json แล้วรอรอบอัปเดตถัดไป`) : null,
    methodCard(),
  ];
}

function methodCard() {
  const w = S.market.weights;
  return h('section', { class: 'card stack' },
    h('h2', {}, 'คะแนนน่าซื้อคิดอย่างไร'),
    h('ul', { class: 'clean small ink2' },
      h('li', {}, h('strong', {}, `ส่วนลดจากจุดสูงสุด (${w.drawdown * 100}%) `), '— ราคาต่ำกว่าจุดสูงสุด 52 สัปดาห์เท่าไร เทียบกับประวัติ 5 ปีของตัวมันเอง หุ้นผันผวนสูงต้องลงลึกกว่าจึงได้คะแนนเท่ากัน'),
      h('li', {}, h('strong', {}, `เทคนิคอล (${w.technical * 100}%) `), '— RSI 14 วัน, ระยะห่างจากเส้นเฉลี่ย 200 วัน และตำแหน่งใน Bollinger Band ใช้จับภาวะขายมากเกินไป'),
      h('li', {}, h('strong', {}, `แนวโน้มระยะยาว (${w.trend * 100}%) `), '— ราคาอยู่ต่ำหรือสูงกว่าเส้นแนวโน้มการเติบโต 5 ปีของตัวเองกี่ส่วนเบี่ยงเบนมาตรฐาน'),
      h('li', {}, h('strong', {}, `มูลค่าพื้นฐาน (${w.valuation * 100}%) `), '— ส่วนต่างจากราคาเป้าหมายนักวิเคราะห์และ PEG เฉพาะหุ้นรายตัวที่ดึงข้อมูลได้ ถ้าไม่มีจะเฉลี่ยน้ำหนักให้ 3 ข้อแรก')),
    h('p', { class: 'small ink2' }, 'ขนาดไม้: งบซื้อสะสมต่อเดือนแบ่งเป็น 3 หน่วย คะแนน 45–59 ซื้อครึ่งหน่วย, 60–74 หนึ่งหน่วย, 75 ขึ้นไปหนึ่งหน่วยครึ่ง รวมไม่เกินงบ และไม่เกินเพดานน้ำหนักของแต่ละตัว'),
    h('p', { class: 'note' }, 'คะแนนบอกแค่ว่า "ราคาถูกเมื่อเทียบกับอดีตของตัวเอง" ไม่ได้บอกว่าธุรกิจยังดีอยู่ ก่อนซื้อเพิ่มให้ถามตัวเองว่าเหตุผลที่ถือหุ้นตัวนี้ยังเป็นจริงหรือไม่'));
}

function viewIdeas() {
  const pos = positions(), out = [];
  const held = new Set(pos.rows.map(r => r.symbol));
  const end = Math.max(0, ...pos.rows.filter(r => r.a).map(r => r.a.series.d.at(-1)));
  const withData = pos.rows.filter(r => r.a && r.qty > 0);
  const portRet = withData.length ? weeklyReturns(d => {
    let v = 0;
    for (const r of withData) { const p = priceAt(r.a.series, d); if (p == null) return null; v += p * r.qty * fxRate(r.cur); }
    return v;
  }, end) : null;

  /* สุขภาพพอร์ต */
  const bySector = {};
  pos.rows.forEach(r => { const k = r.sector || 'อื่น ๆ'; bySector[k] = (bySector[k] || 0) + r.weight; });
  const sectors = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
  const typeW = t => pos.rows.filter(r => r.type === t).reduce((s, r) => s + r.weight, 0);
  const top = [...pos.rows].sort((a, b) => b.weight - a.weight)[0];
  const usd = pos.rows.filter(r => r.cur === 'USD').reduce((s, r) => s + r.weight, 0);
  const obs = [];
  if (top && top.weight > 0.25 && top.type !== 'etf' && top.type !== 'fund')
    obs.push(`${top.symbol} หนักถึง ${pct(top.weight, 0, false)} ของพอร์ต — ผลลัพธ์ทั้งพอร์ตขึ้นกับตัวเดียวค่อนข้างมาก`);
  if (sectors[0] && sectors[0][1] > 0.4) obs.push(`กลุ่ม "${sectors[0][0]}" รวม ${pct(sectors[0][1], 0, false)} — ตัวเลือกที่ช่วยกระจายคือกลุ่มที่พอร์ตยังไม่มี เช่น สุขภาพ การเงิน หรือหุ้นนอกสหรัฐ`);
  if (typeW('stock') > 0.5) obs.push(`หุ้นรายตัวรวม ${pct(typeW('stock'), 0, false)} — สำหรับคนเวลาน้อย แกน ETF/กองทุนดัชนีควรเป็นส่วนใหญ่ของพอร์ต`);
  if (typeW('crypto') > 0.1) obs.push(`คริปโต ${pct(typeW('crypto'), 0, false)} — ผันผวนสูง ควรเป็นสัดส่วนที่รับได้หากลดลง 70%`);
  if (usd > 0.8) obs.push(`สินทรัพย์สกุลดอลลาร์ ${pct(usd, 0, false)} — มูลค่าเป็นบาทจะแกว่งตามค่าเงินด้วย`);
  if (typeW('gold') === 0 && pos.rows.length) obs.push('ไม่มีสินทรัพย์ตั้งรับ (ทองคำ/ตราสารหนี้) — พอร์ตจะเคลื่อนไหวตามตลาดหุ้นเกือบทั้งหมด');
  if (!obs.length) obs.push('การกระจายตัวโดยรวมสมดุลดี ไม่มีจุดกระจุกตัวที่เด่นชัด');
  out.push(h('section', { class: 'card stack' },
    h('h2', {}, 'ภาพรวมการกระจายความเสี่ยงของพอร์ต'),
    h('div', { class: 'legend' }, sectors.slice(0, 6).map(([k, w]) => h('span', { class: 'tag' }, `${k} ${pct(w, 0, false)}`))),
    h('ul', { class: 'clean small ink2' }, obs.map(o => h('li', {}, o)))));

  /* รายชื่อน่าสนใจ */
  const cands = S.watch.candidates.filter(c => S.market.assets[c.symbol]).map(c => {
    const a = S.market.assets[c.symbol];
    const rho = portRet ? corr(weeklyReturns(d => priceAt(a.series, d), end), portRet) : null;
    const overlap = bySector[c.sector] || 0;
    const div = rho == null ? 0.5 : 1 - Math.max(0, rho);
    return { ...c, a, rho, overlap, cur: a.currency, rank: a.score * 0.6 + div * 100 * 0.3 + (1 - Math.min(1, overlap * 2)) * 100 * 0.1 };
  }).sort((x, y) => y.rank - x.rank);

  out.push(h('div', {}, h('h2', {}, 'หุ้นและ ETF น่าสนใจ'),
    h('p', { class: 'small muted' }, 'เรียงตามความน่าซื้อ ณ ราคาปัจจุบัน ผสมกับการช่วยกระจายความเสี่ยงให้พอร์ตของคุณ')));
  for (const c of cands) {
    const fit = c.rho == null ? 'ยังคำนวณความสัมพันธ์กับพอร์ตไม่ได้'
      : c.rho < 0.4 ? 'ช่วยกระจายความเสี่ยงได้ดี' : c.rho < 0.7 ? 'กระจายความเสี่ยงได้บางส่วน' : 'เคลื่อนไหวคล้ายพอร์ตเดิมมาก';
    const extra = h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('span', { class: 'tag' }, c.sector), h('span', { class: 'tag' }, c.role),
        held.has(c.symbol) ? h('span', { class: 'tag' }, 'ถืออยู่แล้ว') : null),
      h('p', {}, h('strong', {}, 'ทำไมน่าสนใจ: '), c.thesis),
      h('p', { class: 'ink2' }, h('strong', {}, 'ความเสี่ยง: '), c.risks),
      h('p', { class: 'note' }, h('strong', {}, 'เทียบกับพอร์ตคุณ: '), fit,
        c.rho != null ? ` (สหสัมพันธ์ ${c.rho.toFixed(2)})` : '',
        c.overlap > 0 ? ` · คุณมีกลุ่ม "${c.sector}" อยู่แล้ว ${pct(c.overlap, 0, false)}` : ` · พอร์ตยังไม่มีกลุ่ม "${c.sector}"`));
    out.push(signalCard({ ...c, mode: 'watch' }, null, { candidate: true, extra }));
  }
  out.push(h('p', { class: 'small muted' }, 'thesis เป็นมุมมองเชิงโครงสร้างที่เขียนไว้ล่วงหน้า ไม่ได้อัปเดตตามข่าวรายวัน ตรวจงบและข่าวล่าสุดก่อนตัดสินใจ · แก้รายชื่อได้ที่ data/watchlist.json'));
  return out;
}

function viewManage() {
  const P = S.portfolio;
  const commit = () => { savePortfolio(); render(); };
  const field = (hd, key, attrs = {}) => h('input', { ...attrs, value: hd[key] ?? '',
    onchange: e => { const v = e.target.value.trim();
      hd[key] = attrs.type === 'number' ? (v === '' ? null : +v) : key === 'symbol' ? v.toUpperCase() : v; commit(); } });
  const sel = (hd, key, options) => h('select', { onchange: e => { hd[key] = e.target.value; commit(); } },
    options.map(([v, l]) => h('option', { value: v, selected: hd[key] === v || null }, l)));
  return [
    h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('div', {}, h('h2', {}, 'สินทรัพย์ในพอร์ต'),
        h('p', { class: 'small muted' }, isLocal() ? 'กำลังใช้ข้อมูลที่แก้ไขในเบราว์เซอร์นี้ (เก็บในเครื่อง ไม่ถูกส่งออกไปไหน)' : 'กำลังใช้ข้อมูลจากไฟล์ data/portfolio.json')),
        h('button', { class: 'btn primary', onclick: () => { P.holdings.push({ symbol: '', name: '', type: 'stock', sector: '', qty: 0, avg_cost: 0, mode: 'accumulate', max_weight: 0.1 }); commit(); } }, '+ เพิ่มสินทรัพย์')),
      h('div', { class: 'tablewrap' }, h('table', { class: 'edit' },
        h('thead', {}, h('tr', {}, ['Symbol (Yahoo)', 'ชื่อ', 'ประเภท', 'กลุ่ม', 'จำนวน', 'ต้นทุนเฉลี่ย', 'วิธีซื้อ', 'เพดานน้ำหนัก %', ''].map(t => h('th', { style: 'text-align:left' }, t)))),
        h('tbody', {}, P.holdings.map((hd, i) => h('tr', {},
          h('td', {}, field(hd, 'symbol', { class: 'sym', placeholder: 'เช่น VOO, PTT.BK' })),
          h('td', {}, field(hd, 'name', { class: 'nm' })),
          h('td', {}, sel(hd, 'type', Object.entries(TYPES).map(([k, v]) => [k, v.label]))),
          h('td', {}, field(hd, 'sector', { class: 'sym' })),
          h('td', {}, field(hd, 'qty', { type: 'number', step: 'any', min: 0 })),
          h('td', {}, field(hd, 'avg_cost', { type: 'number', step: 'any', min: 0 })),
          h('td', {}, sel(hd, 'mode', [['dca', 'DCA ทุกเดือน'], ['accumulate', 'สะสมเมื่อราคาลง']])),
          h('td', {}, h('input', { type: 'number', min: 0, max: 100, step: 1, value: hd.max_weight ? Math.round(hd.max_weight * 100) : '',
            onchange: e => { hd.max_weight = e.target.value ? +e.target.value / 100 : null; commit(); } })),
          h('td', {}, h('button', { class: 'btn ghost', 'aria-label': 'ลบ ' + hd.symbol, onclick: () => { if (confirm(`ลบ ${hd.symbol || 'แถวนี้'} ออกจากพอร์ต?`)) { P.holdings.splice(i, 1); commit(); } } }, '✕'))))))),
      h('p', { class: 'small muted' }, 'ต้นทุนเฉลี่ยกรอกเป็นสกุลเงินของสินทรัพย์นั้น (หุ้นสหรัฐเป็น USD, หุ้นไทยเป็นบาท) · symbol ใหม่ที่ยังไม่อยู่ใน data/portfolio.json จะยังไม่มีราคาจนกว่าจะเพิ่มในไฟล์')),
    h('section', { class: 'card stack' },
      h('h2', {}, 'สำรองและย้ายข้อมูล'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => {
          const blob = new Blob([JSON.stringify(P, null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'portfolio.json' }); a.click(); URL.revokeObjectURL(a.href); } }, 'ดาวน์โหลด portfolio.json'),
        h('label', { class: 'btn', style: 'cursor:pointer;display:inline-block;border:1px solid var(--axis);border-radius:8px;padding:6px 9px;font-weight:600;font-size:13.5px' }, 'นำเข้าไฟล์',
          h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async e => {
            try { const data = JSON.parse(await e.target.files[0].text());
              if (!Array.isArray(data.holdings)) throw new Error('no holdings');
              S.portfolio = data; commit(); } catch (err) { alert('ไฟล์ไม่ถูกต้อง: ต้องเป็น portfolio.json ที่มีรายการ holdings'); } } })),
        isLocal() ? h('button', { class: 'btn ghost', onclick: () => { if (confirm('ล้างข้อมูลที่แก้ในเบราว์เซอร์ แล้วกลับไปใช้ไฟล์จาก repo?')) {
          try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } S.portfolio = loadPortfolio(); render(); } } }, 'กลับไปใช้ไฟล์จาก repo') : null),
      h('p', { class: 'small muted' }, 'การแก้ไขในหน้านี้เก็บไว้เฉพาะเบราว์เซอร์เครื่องนี้ ถ้าต้องการให้เห็นทุกอุปกรณ์ ให้ดาวน์โหลดไฟล์แล้วนำไปแทน data/portfolio.json ใน repo')),
  ];
}

/* ---------- shell ---------- */
const VIEWS = { overview: viewOverview, signals: viewSignals, ideas: viewIdeas, manage: viewManage };
function render() {
  if (!VIEWS[S.tab]) S.tab = 'overview';
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  document.querySelectorAll('#currency button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cur === S.cur)));
  document.getElementById('tip').hidden = true;
  const app = document.getElementById('app');
  const y = scrollY;
  app.replaceChildren(...VIEWS[S.tab]().flat(Infinity).filter(Boolean));
  scrollTo(0, y);
}
async function init() {
  const get = async f => { const res = await fetch(`data/${f}?t=${Date.now()}`); if (!res.ok) throw new Error(f + ' ' + res.status); return res.json(); };
  try {
    [S.market, S.repoPortfolio, S.watch] = await Promise.all([get('market.json'), get('portfolio.json'), get('watchlist.json')]);
  } catch (e) {
    document.getElementById('app').replaceChildren(h('div', { class: 'card empty' }, 'โหลดข้อมูลไม่สำเร็จ — ยังไม่มี data/market.json หรือเปิดไฟล์ตรง ๆ โดยไม่ผ่านเว็บเซิร์ฟเวอร์ (' + e.message + ')'));
    document.getElementById('updated').textContent = 'โหลดข้อมูลไม่สำเร็จ';
    return;
  }
  S.portfolio = loadPortfolio();
  S.cur = S.portfolio.display_currency || 'THB';
  const gen = new Date(S.market.generated_at);
  const ageH = (Date.now() - gen) / 36e5;
  document.getElementById('updated').textContent = 'ราคาอัปเดต ' + gen.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
    + ` · USD/THB ${fxRate('USD').toFixed(2)}` + (ageH > 96 ? ' · ⚠ ข้อมูลเก่ากว่า 4 วัน' : '');
  document.getElementById('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return;
    S.tab = b.dataset.tab; history.replaceState(null, '', '#' + S.tab); scrollTo(0, 0); render(); });
  document.getElementById('currency').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return;
    S.cur = b.dataset.cur; S.portfolio.display_currency = S.cur; if (isLocal()) savePortfolio(); render(); });
  render();
}
init();
})();
