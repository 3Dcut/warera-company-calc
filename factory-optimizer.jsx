import { useState, useCallback, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

/* ═══════════════════════════════════════════════════════
   AERO GLASS - deep navy base, frosted panels,
   high contrast, dramatic shadows
   Font: Rajdhani (display) + Source Code Pro (data)
   ═══════════════════════════════════════════════════════ */

const fl = document.createElement("link");
fl.rel = "stylesheet";
fl.href = "https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500;600;700&family=Quicksand:wght@400;500;600;700&display=swap";
document.head.appendChild(fl);

let F = { h: "'Rajdhani', sans-serif", m: "'Source Code Pro', monospace" };

const THEMES = {
  grau: {
    F: { h: "'Rajdhani', sans-serif", m: "'Source Code Pro', monospace" },
    bg: "linear-gradient(135deg, #0a0e1a 0%, #111827 40%, #0f172a 100%)",
    orb1: "rgba(240,180,41,0.04)", orb2: "rgba(96,165,250,0.03)",
    C: {
      accent: "#f0b429", accentGlow: "rgba(240,180,41,0.25)",
      green: "#34d399", greenGlow: "rgba(52,211,153,0.2)",
      red: "#f87171",
      blue: "#60a5fa", blueGlow: "rgba(96,165,250,0.2)",
      purple: "#a78bfa",
      stahl: "#f0a060", betonC: "#90b0a0",
      text: "#f0f0ec", textDim: "#a0a8b4", textMuted: "#556070",
      inputBg: "rgba(0,0,0,0.3)", inputBorder: "rgba(255,255,255,0.1)",
      rowAlt: "rgba(255,255,255,0.02)",
    },
  },
  pink: {
    F: { h: "'Quicksand', sans-serif", m: "'Source Code Pro', monospace" },
    bg: "linear-gradient(135deg, #1a0e18 0%, #201225 40%, #180d1e 100%)",
    orb1: "rgba(255,107,157,0.06)", orb2: "rgba(200,130,255,0.04)",
    C: {
      accent: "#ff6b9d", accentGlow: "rgba(255,107,157,0.3)",
      green: "#5eeaaa", greenGlow: "rgba(94,234,170,0.2)",
      red: "#ff6b6b",
      blue: "#82b4ff", blueGlow: "rgba(130,180,255,0.2)",
      purple: "#d0a0ff",
      stahl: "#ffb088", betonC: "#a8c8a0",
      text: "#f8f0f4", textDim: "#c0a8b8", textMuted: "#705868",
      inputBg: "rgba(30,10,25,0.5)", inputBorder: "rgba(255,130,180,0.12)",
      rowAlt: "rgba(255,200,220,0.03)",
    },
  },
};

let C = THEMES.grau.C;

// Tooltip CSS injection
const styleEl = document.createElement("style");
styleEl.textContent = `
  @keyframes tipIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes copyFlash { 0% { box-shadow: 0 0 0 rgba(52,211,153,0); } 50% { box-shadow: 0 0 24px rgba(52,211,153,0.5); } 100% { box-shadow: 0 0 0 rgba(52,211,153,0); } }
  .tip-wrap { position: relative; display: inline-flex; }
  .tip-wrap .tip-box {
    display: none; position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    padding: 6px 10px; border-radius: 6px; font-size: 11px; line-height: 1.4; white-space: nowrap; z-index: 100; pointer-events: none;
    background: rgba(15,20,35,0.92); border: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: #d4d4cc;
    font-family: 'Source Code Pro', monospace; animation: tipIn 0.15s ease-out;
  }
  .tip-wrap .tip-box::after {
    content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: rgba(255,255,255,0.12);
  }
  .tip-wrap:hover .tip-box { display: block; }
  .copy-flash { animation: copyFlash 0.6s ease-out; }
`;
document.head.appendChild(styleEl);

const glass = (opacity = 0.06, blur = 16) => ({
  background: `rgba(255,255,255,${opacity})`,
  backdropFilter: `blur(${blur}px)`,
  WebkitBackdropFilter: `blur(${blur}px)`,
  border: "1px solid rgba(255,255,255,0.1)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)",
});

function getStrats() {
  return [
    { key: "dijkstra", label: "Optimal (Dijkstra)", color: C.accent, glow: C.accentGlow, tip: "Durchsucht alle moeglichen Pfade und findet den nachweislich schnellsten" },
    { key: "cheapest", label: "Billigstes zuerst", color: C.green, glow: C.greenGlow, tip: "Nimmt immer die billigste naechste Aktion" },
    { key: "buy_first", label: "Fabriken zuerst", color: C.blue, glow: C.blueGlow, tip: "Kauft erst alle Fabriken, dann Upgrades" },
    { key: "upgrade_first", label: "Upgrades zuerst", color: C.purple, glow: "rgba(167,139,250,0.2)", tip: "Upgradet erst alles, kauft dann neue Fabriken" },
  ];
}

// ── Encode / Decode ──
function encodeState(params, facs, theme) {
  const p = [params.ppPerStahl, params.ppPerBeton, params.stahlPrice, params.betonPrice,
    params.maxFactories, params.maxLevel, params.upgradeBase, params.factoryBase,
    params.defaultBonus, params.startStahl, params.startBeton].join(",");
  const f = facs.map(x => x.level + "." + x.bonus).join(",");
  try { return btoa(p + "|" + f + "|" + theme); } catch { return ""; }
}

function decodeState(str) {
  try {
    const raw = atob(str.trim());
    const parts = raw.split("|");
    const pStr = parts[0], fStr = parts[1], thm = parts[2] || "grau";
    const p = pStr.split(",").map(Number);
    const facs = fStr.split(",").map(s => {
      const [l, b] = s.split(".").map(Number);
      return { level: l, bonus: b };
    });
    return {
      params: { ppPerStahl: p[0], ppPerBeton: p[1], stahlPrice: p[2], betonPrice: p[3],
        maxFactories: p[4], maxLevel: p[5], upgradeBase: p[6], factoryBase: p[7],
        defaultBonus: p[8], startStahl: p[9], startBeton: p[10] },
      facs, theme: thm === "pink" ? "pink" : "grau"
    };
  } catch { return null; }
}

// ── Game Logic ──
const upgStahl = (lvl, base) => base * Math.pow(2, lvl - 1);
const facBeton = (n, base) => n * base;
function calcPPH(level, bonus) { return level * (1 + bonus / 100); }
function totalPPH(fs) { return fs.reduce((s, f) => s + calcPPH(f.level, f.bonus), 0); }

function effPP(amount, resType, p) {
  if (resType === "stahl") {
    const d = amount * p.ppPerStahl;
    const v = p.betonPrice > 0 ? amount * (p.stahlPrice / p.betonPrice) * p.ppPerBeton : Infinity;
    return v < d ? { pp: v, method: "via Beton" } : { pp: d, method: "direkt" };
  }
  const d = amount * p.ppPerBeton;
  const v = p.stahlPrice > 0 ? amount * (p.betonPrice / p.stahlPrice) * p.ppPerStahl : Infinity;
  return v < d ? { pp: v, method: "via Stahl" } : { pp: d, method: "direkt" };
}

class Heap {
  constructor() { this.d = []; }
  push(p, v) { this.d.push({ p, v }); let i = this.d.length - 1; while (i > 0) { const j = (i-1)>>1; if (this.d[j].p <= this.d[i].p) break; [this.d[j], this.d[i]] = [this.d[i], this.d[j]]; i = j; } }
  pop() { const t = this.d[0], l = this.d.pop(); if (this.d.length > 0) { this.d[0] = l; let i = 0; while (true) { let s = i, a = 2*i+1, b = 2*i+2; if (a < this.d.length && this.d[a].p < this.d[s].p) s = a; if (b < this.d.length && this.d[b].p < this.d[s].p) s = b; if (s === i) break; [this.d[s], this.d[i]] = [this.d[i], this.d[s]]; i = s; } } return t; }
  get size() { return this.d.length; }
}

function facKey(fs) { return fs.map(f => f.bonus + ":" + f.level).sort().join("|"); }

function runDijkstra(startFacs, params, sStahl, sBeton) {
  const { maxFactories, maxLevel, upgradeBase, factoryBase, defaultBonus } = params;
  const heap = new Heap(), visited = new Set();
  const gp = []; for (const f of startFacs) gp.push(f.bonus + ":" + maxLevel);
  for (let i = startFacs.length; i < maxFactories; i++) gp.push(defaultBonus + ":" + maxLevel);
  const gk = gp.sort().join("|");
  if (facKey(startFacs) === gk) return { path: [], complete: true, iter: 0 };

  const sk = (fs, rs, rb) => facKey(fs) + ";" + rs + ";" + rb;
  heap.push(0, { facs: startFacs.map(f => ({ ...f })), path: [], rs: sStahl, rb: sBeton });
  let iter = 0;

  while (heap.size > 0 && iter < 500000) {
    iter++;
    const { p: time, v: { facs, path, rs, rb } } = heap.pop();
    const key = sk(facs, rs, rb);
    if (visited.has(key)) continue; visited.add(key);
    if (facKey(facs) === gk) return { path, complete: true, iter };
    const pph = totalPPH(facs); if (pph <= 0) continue;
    const seen = new Set();

    for (let i = 0; i < facs.length; i++) {
      if (facs[i].level >= maxLevel) continue;
      const sig = facs[i].bonus + ":" + facs[i].level;
      if (seen.has(sig)) continue; seen.add(sig);
      const lvl = facs[i].level, stahl = upgStahl(lvl, upgradeBase);
      const free = Math.min(rs, stahl), need = stahl - free;
      const { pp, method } = need > 0 ? effPP(need, "stahl", params) : { pp: 0, method: "Lager" };
      const dt = pp / pph;
      const nf = facs.map((f, j) => j === i ? { ...f, level: f.level + 1 } : { ...f });
      const nrs = rs - free, nk = sk(nf, nrs, rb);
      if (!visited.has(nk)) {
        heap.push(time + dt, { facs: nf, rs: nrs, rb, path: [...path, {
          action: "Upgrade L" + lvl + " -> L" + (lvl+1) + " (" + facs[i].bonus + "%)",
          type: "upgrade", resType: "stahl", resCost: stahl, freeRes: free,
          method: free === stahl ? "Lager" : method, ppCost: pp,
          ppGain: calcPPH(1, facs[i].bonus), dt, time: time + dt, pph: totalPPH(nf),
        }]});
      }
    }
    if (facs.length < maxFactories) {
      const n = facs.length + 1, beton = facBeton(n, factoryBase);
      const free = Math.min(rb, beton), need = beton - free;
      const { pp, method } = need > 0 ? effPP(need, "beton", params) : { pp: 0, method: "Lager" };
      const dt = pph > 0 ? pp / pph : Infinity;
      const nf = [...facs.map(f => ({ ...f })), { level: 1, bonus: defaultBonus }];
      const nrb = rb - free, nk = sk(nf, rs, nrb);
      if (!visited.has(nk)) {
        heap.push(time + dt, { facs: nf, rs, rb: nrb, path: [...path, {
          action: "Neue Fabrik #" + n, type: "buy", resType: "beton", resCost: beton,
          freeRes: free, method: free === beton ? "Lager" : method, ppCost: pp,
          ppGain: calcPPH(1, defaultBonus), dt, time: time + dt, pph: totalPPH(nf),
        }]});
      }
    }
  }
  return { path: [], complete: false, iter };
}

function simulate(facs, params, strategy, sStahl, sBeton) {
  const { maxFactories, maxLevel, upgradeBase, factoryBase, defaultBonus } = params;
  let st = facs.map(f => ({ ...f })), t = 0, rs = sStahl, rb = sBeton;
  const path = []; let safe = 0;
  while (safe < 300) {
    safe++;
    if (st.length >= maxFactories && st.every(f => f.level >= maxLevel)) break;
    const pph = totalPPH(st); if (pph <= 0) break;
    const acts = [], seen = new Set();
    st.forEach((f, i) => {
      if (f.level >= maxLevel) return;
      const sig = f.bonus + ":" + f.level; if (seen.has(sig)) return; seen.add(sig);
      const stahl = upgStahl(f.level, upgradeBase), free = Math.min(rs, stahl), need = stahl - free;
      const { pp, method } = need > 0 ? effPP(need, "stahl", params) : { pp: 0, method: "Lager" };
      acts.push({ type: "upgrade", idx: i, resCost: stahl, resType: "stahl", freeRes: free,
        method: free === stahl ? "Lager" : method, ppCost: pp, ppGain: calcPPH(1, f.bonus),
        dt: pp / pph, label: "Upgrade L" + f.level + " -> L" + (f.level+1) + " (" + f.bonus + "%)" });
    });
    if (st.length < maxFactories) {
      const n = st.length + 1, beton = facBeton(n, factoryBase), free = Math.min(rb, beton), need = beton - free;
      const { pp, method } = need > 0 ? effPP(need, "beton", params) : { pp: 0, method: "Lager" };
      acts.push({ type: "buy", resCost: beton, resType: "beton", freeRes: free,
        method: free === beton ? "Lager" : method, ppCost: pp, ppGain: calcPPH(1, defaultBonus),
        dt: pp / pph, label: "Neue Fabrik #" + n });
    }
    if (!acts.length) break;
    let pick;
    if (strategy === "cheapest") pick = acts.sort((a, b) => a.ppCost - b.ppCost)[0];
    else if (strategy === "upgrade_first") { const u = acts.filter(a => a.type === "upgrade").sort((a,b) => a.ppCost - b.ppCost); pick = u.length ? u[0] : acts.find(a => a.type === "buy"); }
    else { const b = acts.filter(a => a.type === "buy"); pick = b.length ? b[0] : acts.sort((a,b) => a.ppCost - b.ppCost)[0]; }
    t += pick.dt;
    if (pick.type === "upgrade") { rs -= pick.freeRes; st = st.map((f, j) => j === pick.idx ? { ...f, level: f.level + 1 } : f); }
    else { rb -= pick.freeRes; st = [...st, { level: 1, bonus: defaultBonus }]; }
    path.push({ action: pick.label, type: pick.type, resType: pick.resType, resCost: pick.resCost,
      freeRes: pick.freeRes, method: pick.method, ppCost: pick.ppCost, ppGain: pick.ppGain,
      dt: pick.dt, time: t, pph: totalPPH(st) });
  }
  return path;
}

function buildChart(paths, startPPH, keys) {
  const ev = {};
  for (const k of keys) { const p = paths[k]; if (p?.length) ev[k] = [{ time: 0, pph: startPPH }, ...p.map(s => ({ time: s.time, pph: s.pph }))]; }
  if (!Object.keys(ev).length) return [];
  const ts = new Set([0]);
  for (const e of Object.values(ev)) for (const x of e) ts.add(x.time);
  const mx = Math.max(...ts, 1), step = Math.max(0.5, mx / 500);
  for (let t = 0; t <= mx; t += step) ts.add(Math.round(t * 10) / 10);
  return [...ts].sort((a,b) => a - b).map(t => {
    const pt = { time: Math.round(t * 100) / 100 };
    for (const [k, e] of Object.entries(ev)) { let v = startPPH; for (const x of e) { if (x.time <= t) v = x.pph; else break; } pt[k] = Math.round(v * 100) / 100; }
    return pt;
  });
}

function fmtT(h) { if (h <= 0) return "sofort"; if (h < 1) return (h*60).toFixed(0) + "m"; if (h < 24) return h.toFixed(1) + "h"; const d = h / 24; return d < 365 ? d.toFixed(1) + "d" : (d/365).toFixed(1) + "y"; }
function fmtN(n) { if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(1) + "M"; if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(1) + "k"; return Number.isInteger(n) ? String(n) : n.toFixed(1); }

// ── Styled primitives ──
function GlassCard({ children, style, glow }) {
  return <div style={{ ...glass(0.05, 20), borderRadius: 12, padding: "16px 20px", marginBottom: 14, ...(glow ? { boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 24px " + glow } : {}), ...style }}>{children}</div>;
}
function Sec({ children, icon }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
    {icon && <span style={{ fontSize: 15 }}>{icon}</span>}
    <span style={{ fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>{children}</span>
  </div>;
}
function Inp({ label, value, onChange, step = 1, suffix, tip }) {
  const inner = <div style={{ marginBottom: 8 }}>
    <label style={{ fontFamily: F.m, fontSize: 10, color: C.textDim, marginBottom: 3, display: "block", letterSpacing: "0.03em" }}>{label} {tip && <span style={{ color: C.textMuted, cursor: "help" }}>&#9432;</span>}</label>
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <input type="number" step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text,
          padding: "7px 10px", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none",
          fontFamily: F.m, transition: "border-color 0.2s, box-shadow 0.2s" }}
        onFocus={e => { e.target.style.borderColor = C.accent + "88"; e.target.style.boxShadow = "0 0 12px " + C.accentGlow; }}
        onBlur={e => { e.target.style.borderColor = C.inputBorder; e.target.style.boxShadow = "none"; }} />
      {suffix && <span style={{ fontFamily: F.m, fontSize: 10, color: C.textMuted, whiteSpace: "nowrap" }}>{suffix}</span>}
    </div>
  </div>;
  return tip ? <Tip text={tip}>{inner}</Tip> : inner;
}
function Bdg({ color, children }) {
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 700, fontFamily: F.h, background: color + "25", color, border: "1px solid " + color + "44", letterSpacing: "0.06em", textTransform: "uppercase", textShadow: "0 0 8px " + color + "44" }}>{children}</span>;
}
function Tip({ text, children, pos = "top" }) {
  if (!text) return children;
  return <span className="tip-wrap">{children}<span className="tip-box" style={pos === "bottom" ? { bottom: "auto", top: "calc(100% + 8px)" } : {}}>{text}</span></span>;
}
function Btn({ on, color = C.accent, children, onClick, big, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{
    padding: big ? "11px 28px" : "6px 14px", borderRadius: 8, border: "1px solid " + (on ? color + "88" : "rgba(255,255,255,0.08)"),
    background: on ? color + "18" : "rgba(255,255,255,0.03)", color: disabled ? C.textMuted : on ? color : C.textDim,
    cursor: disabled ? "not-allowed" : "pointer", fontSize: big ? 14 : 11, fontFamily: F.h, fontWeight: 700,
    letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.2s", opacity: disabled ? 0.4 : 1,
    boxShadow: on ? "0 0 16px " + color + "22, inset 0 1px 0 rgba(255,255,255,0.06)" : "0 2px 8px rgba(0,0,0,0.2)",
    textShadow: on ? "0 0 10px " + color + "44" : "none",
  }}>{children}</button>;
}
const TH = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.08)", color: C.textDim, fontSize: 9, fontFamily: F.h, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 };
const TD = (hl) => ({ padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: hl ? C.accent : C.text, fontSize: 12, fontFamily: F.m });

// ── Main ──
export default function App() {
  const [ppS, setPpS] = useState(20);
  const [ppB, setPpB] = useState(20);
  const [sP, setSP] = useState(2.0);
  const [bP, setBP] = useState(2.0);
  const [mxF, setMxF] = useState(12);
  const [mxL, setMxL] = useState(7);
  const [uB, setUB] = useState(20);
  const [fB, setFB] = useState(50);
  const [dB, setDB] = useState(50);
  const [sS, setSS] = useState(0);
  const [sB, setSB] = useState(0);
  const [facs, setFacs] = useState([{ level: 1, bonus: 50 }]);
  const [actv, setActv] = useState(["dijkstra", "cheapest"]);
  const [tab, setTab] = useState("chart");
  const [cM, setCM] = useState("rate");
  const [tS, setTS] = useState("dijkstra");
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [impStr, setImpStr] = useState("");
  const [showImp, setShowImp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState("grau");
  const [apiUser, setApiUser] = useState("");
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const [apiInfo, setApiInfo] = useState("");

  // Apply theme
  const T = THEMES[theme];
  C = T.C;
  F = T.F;
  const STRATS = getStrats();

  // ── WarEra API Integration ──
  const API = "https://api2.warera.io/trpc/";
  async function apiCall(endpoint, body) {
    const r = await fetch(API + endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.data?.code || d.error.message || "API Error");
    return d.result.data;
  }

  async function loadFromAPI() {
    if (!apiUser.trim()) return;
    setApiLoading(true); setApiError(""); setApiInfo("");
    try {
      // 1. Search for user
      const search = await apiCall("search.searchAnything", { searchText: apiUser.trim() });
      if (!search.userIds?.length) throw new Error("Spieler nicht gefunden");

      // 2. Find exact match or first result
      let userId = search.userIds[0];
      let username = apiUser.trim();
      for (const uid of search.userIds) {
        const u = await apiCall("user.getUserLite", { userId: uid });
        if (u.username.toLowerCase() === apiUser.trim().toLowerCase()) {
          userId = uid;
          username = u.username;
          break;
        }
        if (uid === search.userIds[0]) username = u.username;
      }

      // 3. Get companies
      const companies = await apiCall("company.getCompanies", { userId, perPage: 100 });
      const companyIds = companies.items || [];
      if (!companyIds.length) throw new Error("Keine Fabriken gefunden fuer " + username);

      // 4. Get each company's details
      const newFacs = [];
      for (const cid of companyIds) {
        const comp = await apiCall("company.getById", { companyId: cid });
        const aeLevel = comp.activeUpgradeLevels?.automatedEngine || 1;
        newFacs.push({
          level: aeLevel,
          bonus: dB,
          name: comp.name || ("Fabrik " + (newFacs.length + 1)),
          item: comp.itemCode || "?",
        });
      }

      // 5. Get market prices
      try {
        const prices = await apiCall("itemTrading.getPrices", {});
        if (prices.steel != null) setSP(Math.round(prices.steel * 10000) / 10000);
        if (prices.concrete != null) setBP(Math.round(prices.concrete * 10000) / 10000);
      } catch {}

      setFacs(newFacs);
      setApiInfo(username + ": " + newFacs.length + " Fabriken geladen, Marktpreise aktualisiert");
      setRes(null);
    } catch (e) {
      setApiError(e.message || "Fehler beim Laden");
    }
    setApiLoading(false);
  }

  const updF = useCallback((i, k, v) => setFacs(p => p.map((f, j) => j === i ? { ...f, [k]: v } : f)), []);
  const addF = useCallback(() => setFacs(p => [...p, { level: 1, bonus: dB }]), [dB]);
  const rmF = useCallback(i => setFacs(p => p.filter((_, j) => j !== i)), []);

  const params = { ppPerStahl: ppS, ppPerBeton: ppB, stahlPrice: sP, betonPrice: bP, maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB, defaultBonus: dB, startStahl: sS, startBeton: sB };
  const pph = totalPPH(facs);

  const code = encodeState(params, facs, theme);

  function doImport() {
    const d = decodeState(impStr);
    if (!d) return;
    const p = d.params;
    setPpS(p.ppPerStahl); setPpB(p.ppPerBeton); setSP(p.stahlPrice); setBP(p.betonPrice);
    setMxF(p.maxFactories); setMxL(p.maxLevel); setUB(p.upgradeBase); setFB(p.factoryBase);
    setDB(p.defaultBonus); setSS(p.startStahl); setSB(p.startBeton);
    setFacs(d.facs);
    if (d.theme) setTheme(d.theme);
    setShowImp(false); setImpStr(""); setRes(null);
  }

  const expRef = useRef(null);

  function doCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (expRef.current) { expRef.current.classList.remove("copy-flash"); void expRef.current.offsetWidth; expRef.current.classList.add("copy-flash"); }
      setTimeout(() => setCopied(false), 2500);
    });
  }

  const trade = (() => {
    if (sP <= 0 || bP <= 0) return null;
    const sv = (sP / bP) * ppB, bv = (bP / sP) * ppS;
    return { sE: Math.min(ppS, sv), sM: sv < ppS ? "via Beton" : "direkt", bE: Math.min(ppB, bv), bM: bv < ppB ? "via Stahl" : "direkt" };
  })();

  const nextActs = (() => {
    if (pph <= 0 || !facs.length) return [];
    const a = [], seen = new Set();
    facs.forEach((f, i) => {
      if (f.level >= mxL) return;
      const sig = f.bonus + ":" + f.level; if (seen.has(sig)) return; seen.add(sig);
      const stahl = upgStahl(f.level, uB), free = Math.min(sS, stahl), need = stahl - free;
      const { pp, method } = need > 0 ? effPP(need, "stahl", params) : { pp: 0, method: "Lager" };
      const ppG = calcPPH(1, f.bonus);
      a.push({ label: "F" + (i+1) + " L" + f.level + " -> " + (f.level+1), type: "upgrade", resType: "Stahl", resCost: stahl, free, ppCost: pp, method: free === stahl ? "Lager" : method, ppGain: ppG, hours: pp / pph, amortH: pp / (pph + ppG) });
    });
    if (facs.length < mxF) {
      const n = facs.length + 1, beton = facBeton(n, fB), free = Math.min(sB, beton), need = beton - free;
      const { pp, method } = need > 0 ? effPP(need, "beton", params) : { pp: 0, method: "Lager" };
      const ppG = calcPPH(1, dB);
      a.push({ label: "Neue Fabrik #" + n, type: "buy", resType: "Beton", resCost: beton, free, ppCost: pp, method: free === beton ? "Lager" : method, ppGain: ppG, hours: pp / pph, amortH: pp / (pph + ppG) });
    }
    a.sort((x, y) => (x.ppGain / Math.max(x.ppCost, 0.001)) > (y.ppGain / Math.max(y.ppCost, 0.001)) ? -1 : 1);
    return a;
  })();

  function compute() {
    setBusy(true);
    setTimeout(() => {
      const paths = {}, d = runDijkstra(facs, params, sS, sB);
      paths.dijkstra = d.path;
      for (const s of STRATS) { if (s.key !== "dijkstra") try { paths[s.key] = simulate(facs, params, s.key, sS, sB); } catch { paths[s.key] = []; } }
      const finals = {};
      for (const s of STRATS) { const p = paths[s.key]; finals[s.key] = p?.length ? p[p.length-1].time : null; }
      setRes({ paths, finals, ok: d.complete, iter: d.iter });
      setBusy(false);
    }, 50);
  }

  const chart = res ? (() => {
    const rd = buildChart(res.paths, pph, actv);
    if (cM === "rate") return rd;
    const acc = {}; let prev = 0;
    return rd.map(d => { const dt = d.time - prev; const pt = { time: d.time }; for (const k of actv) { if (!(k in acc)) acc[k] = 0; acc[k] += (d[k]||0) * dt; pt[k] = Math.round(acc[k]); } prev = d.time; return pt; });
  })() : [];

  const curPath = res?.paths?.[tS] || [];

  return (
    <div style={{
      background: T.bg,
      color: C.text, minHeight: "100vh", fontFamily: F.m, padding: "28px 24px", maxWidth: 1260, margin: "0 auto",
      transition: "background 0.5s",
    }}>
      {/* BG glow orbs */}
      <div style={{ position: "fixed", top: -200, right: -200, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb1 + " 0%, transparent 70%)", pointerEvents: "none", transition: "background 0.5s" }} />
      <div style={{ position: "fixed", bottom: -300, left: -200, width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb2 + " 0%, transparent 70%)", pointerEvents: "none", transition: "background 0.5s" }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 28, paddingBottom: 20, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.h, fontSize: 11, color: C.textMuted, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 4 }}>WarEra Produktions-Planungstool</div>
          <h1 style={{ fontFamily: F.h, fontSize: 24, fontWeight: 700, color: C.accent, margin: 0, letterSpacing: "0.04em", textShadow: "0 0 30px " + C.accentGlow, lineHeight: 1.2 }}>
            Fabrik-Optimierer<br />
            <span style={{ fontSize: 14, fontWeight: 600, color: C.textDim, letterSpacing: "0.08em" }}>des Hebelministeriums Deutschland</span>
          </h1>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <Tip text={"Theme wechseln: " + (theme === "grau" ? "Pink" : "Grau")}>
            <button onClick={() => setTheme(t => t === "grau" ? "pink" : "grau")} style={{
              padding: "6px 14px", borderRadius: 20,
              border: "1px solid " + (theme === "pink" ? "rgba(255,107,157,0.5)" : "rgba(255,255,255,0.1)"),
              background: theme === "pink"
                ? "linear-gradient(135deg, rgba(255,107,157,0.2), rgba(200,130,255,0.15))"
                : "rgba(255,255,255,0.04)",
              color: theme === "pink" ? "#ff6b9d" : C.textDim,
              cursor: "pointer", fontSize: 11, fontFamily: F.h, fontWeight: 700,
              letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.3s",
              boxShadow: theme === "pink" ? "0 0 16px rgba(255,107,157,0.2)" : "0 2px 8px rgba(0,0,0,0.2)",
            }}>
              {theme === "pink" ? "\u2665 PINK" : "\u25C9 GRAU"}
            </button>
          </Tip>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: C.accent, fontFamily: F.h, textShadow: "0 0 20px " + C.accentGlow }}>{pph.toFixed(1)} <span style={{ fontSize: 14, color: C.textDim }}>PP/h</span></div>
            <div style={{ fontSize: 12, color: C.textDim }}>{(pph * 24).toFixed(0)} PP/Tag</div>
          </div>
        </div>
      </div>

      {/* Import/Export Bar */}
      <GlassCard style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: F.h, fontSize: 11, color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>Konfiguration:</span>
        <Tip text="Alle Parameter + Fabriken als Code in die Zwischenablage kopieren">
          <button ref={expRef} onClick={doCopy} style={{
            padding: "6px 14px", borderRadius: 8,
            border: "1px solid " + (copied ? C.green + "88" : "rgba(255,255,255,0.08)"),
            background: copied ? C.green + "22" : "rgba(255,255,255,0.03)",
            color: copied ? C.green : C.textDim,
            cursor: "pointer", fontSize: 11, fontFamily: F.h, fontWeight: 700,
            letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.3s",
            boxShadow: copied ? "0 0 20px " + C.greenGlow : "0 2px 8px rgba(0,0,0,0.2)",
            textShadow: copied ? "0 0 10px " + C.greenGlow : "none",
          }}>
            {copied ? "\u2713 Kopiert!" : "Exportieren"}
          </button>
        </Tip>
        <Tip text="Gespeicherten Code einfuegen und Konfiguration laden">
          <Btn on={showImp} onClick={() => setShowImp(!showImp)}>Importieren</Btn>
        </Tip>
        {showImp && <>
          <input value={impStr} onChange={e => setImpStr(e.target.value)} placeholder="Code einfuegen..."
            style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text, padding: "6px 10px", fontSize: 12, fontFamily: F.m, outline: "none", flex: 1, minWidth: 200 }}
            onKeyDown={e => e.key === "Enter" && doImport()} />
          <Btn on color={C.green} onClick={doImport}>Laden</Btn>
        </>}
        {!showImp && <span style={{ fontSize: 10, color: C.textMuted, fontFamily: F.m, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>{code}</span>}
      </GlassCard>

      {/* Config Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14 }}>
        <div>
          <GlassCard>
            <Sec icon="&#9881;">Spielregeln</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <Inp label="Max Fabriken" value={mxF} onChange={setMxF} tip="Maximale Anzahl an Fabriken" />
              <Inp label="Max Level" value={mxL} onChange={setMxL} tip="Hoechstes Fabrik-Level" />
              <Inp label="Upgrade-Basis" value={uB} onChange={setUB} suffix="Stahl" tip="Basiskosten L1->L2. Verdoppelt sich pro Level." />
              <Inp label="Fabrik-Basis" value={fB} onChange={setFB} suffix="Beton" tip="Fabrik #N kostet N x Basis Beton" />
              <Inp label="PP / Stahl" value={ppS} onChange={setPpS} tip="Produktionspunkte um 1 Stahl herzustellen" />
              <Inp label="PP / Beton" value={ppB} onChange={setPpB} tip="Produktionspunkte um 1 Beton herzustellen" />
              <Inp label="Std-Bonus" value={dB} onChange={setDB} suffix="%" tip="Produktionsbonus neuer Fabriken" />
            </div>
          </GlassCard>
          <GlassCard>
            <Sec icon="&#9878;">Markt &amp; Lager</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <Inp label="Stahlpreis" value={sP} onChange={setSP} step={0.0001} tip="Marktpreis pro Stahl (fuer Handel)" />
              <Inp label="Betonpreis" value={bP} onChange={setBP} step={0.0001} tip="Marktpreis pro Beton (fuer Handel)" />
              <Inp label="Stahl Lager" value={sS} onChange={setSS} tip="Stahl auf Vorrat - wird zuerst verbraucht" />
              <Inp label="Beton Lager" value={sB} onChange={setSB} tip="Beton auf Vorrat - wird zuerst verbraucht" />
            </div>
            {trade && <div style={{ ...glass(0.04, 12), borderRadius: 8, padding: "8px 10px", marginTop: 10, fontSize: 11, lineHeight: 1.7 }}>
              <div>Eff. PP/Stahl: <span style={{ color: C.stahl, fontWeight: 600 }}>{trade.sE.toFixed(1)}</span> <span style={{ color: C.textMuted }}>({trade.sM})</span></div>
              <div>Eff. PP/Beton: <span style={{ color: C.betonC, fontWeight: 600 }}>{trade.bE.toFixed(1)}</span> <span style={{ color: C.textMuted }}>({trade.bM})</span></div>
            </div>}
          </GlassCard>
        </div>

        <GlassCard>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <Sec icon="&#9878;">Fabriken ({facs.length}/{mxF})</Sec>
            <Tip text="Neue Fabrik auf Level 1 hinzufuegen"><Btn on color={C.green} onClick={addF}>+ Hinzufuegen</Btn></Tip>
          </div>
          {/* API Import */}
          <div style={{ ...glass(0.04, 12), borderRadius: 8, padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: F.h, fontSize: 10, color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>WarEra API:</span>
            <input
              value={apiUser} onChange={e => setApiUser(e.target.value)}
              onKeyDown={e => e.key === "Enter" && loadFromAPI()}
              placeholder="Username eingeben..."
              style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text, padding: "6px 10px", fontSize: 12, fontFamily: F.m, outline: "none", flex: 1, minWidth: 140 }}
            />
            <Tip text="Fabriken und Marktpreise automatisch von der WarEra API laden">
              <Btn on color={C.accent} onClick={loadFromAPI} disabled={apiLoading || !apiUser.trim()}>
                {apiLoading ? "Lade..." : "Importieren"}
              </Btn>
            </Tip>
            {apiError && <span style={{ fontSize: 10, color: C.red, fontFamily: F.m }}>{apiError}</span>}
            {apiInfo && <span style={{ fontSize: 10, color: C.green, fontFamily: F.m }}>{apiInfo}</span>}
          </div>
          {!facs.length && <div style={{ padding: 24, textAlign: "center", color: C.textMuted }}>Keine Fabriken</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(152px, 1fr))", gap: 8 }}>
            {facs.map((f, i) => {
              const p = calcPPH(f.level, f.bonus);
              return <div key={i} style={{ ...glass(0.04, 12), borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.accent, textShadow: "0 0 8px " + C.accentGlow }}>{i+1}</span>
                  {f.item && <span style={{ fontSize: 9, color: C.textMuted, fontFamily: F.h, letterSpacing: "0.04em" }}>{f.item}</span>}
                  <span style={{ fontSize: 11, color: C.green, fontWeight: 600, textShadow: "0 0 8px " + C.greenGlow }}>{p.toFixed(1)}</span>
                  <button onClick={() => rmF(i)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 18, fontWeight: 700, padding: 0, opacity: 0.7, lineHeight: 1 }}>&times;</button>
                </div>
                {f.name && <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 4, fontFamily: F.m, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>}
                <div style={{ display: "flex", gap: 6 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 9, color: C.textMuted, display: "block", marginBottom: 2, fontFamily: F.h, letterSpacing: "0.06em" }}>LVL</label>
                    <select value={f.level} onChange={e => updF(i, "level", +e.target.value)}
                      style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 5, color: C.text, padding: "4px 6px", fontSize: 12, width: "100%", fontFamily: F.m, outline: "none" }}>
                      {Array.from({ length: mxL }, (_, l) => l+1).map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 9, color: C.textMuted, display: "block", marginBottom: 2, fontFamily: F.h, letterSpacing: "0.06em" }}>BONUS</label>
                    <input type="number" step={1} value={f.bonus} onChange={e => updF(i, "bonus", +e.target.value)}
                      style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 5, color: C.text, padding: "4px 6px", fontSize: 12, width: "100%", boxSizing: "border-box", fontFamily: F.m, outline: "none" }} />
                  </div>
                </div>
              </div>;
            })}
          </div>
        </GlassCard>
      </div>

      {/* Next Actions */}
      {nextActs.length > 0 && <GlassCard style={{ marginTop: 2 }}>
        <Sec icon="&#9654;">Naechste Aktionen</Sec>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={TH}>Aktion</th>
              <th style={TH}>Res.</th>
              <th style={TH}><Tip text="Benoetigte Ressourcenmenge">Menge</Tip></th>
              <th style={TH}><Tip text="Vom Lager abgezogen (kostenlos)">Lager</Tip></th>
              <th style={TH}><Tip text="Effektive PP-Kosten nach Lagerabzug und Markthandel">Eff. PP</Tip></th>
              <th style={TH}><Tip text="Beschaffungsweg: direkt, via Handel oder Lager">Weg</Tip></th>
              <th style={TH}><Tip text="Produktionszeit bei aktueller PP-Rate">Dauer</Tip></th>
              <th style={TH}><Tip text="Produktionsgewinn pro Stunde">+PP/h</Tip></th>
              <th style={TH}><Tip text="Zeit bis die Investition sich durch Mehrproduktion amortisiert">Amort.</Tip></th>
            </tr></thead>
            <tbody>{nextActs.map((a, i) => (
              <tr key={i} style={{ background: i === 0 ? "rgba(240,180,41,0.06)" : i % 2 ? C.rowAlt : "transparent" }}>
                <td style={TD(i === 0)}><Bdg color={a.type === "buy" ? C.blue : C.green}>{a.type === "buy" ? "NEU" : "UP"}</Bdg><span style={{ marginLeft: 8 }}>{a.label}</span></td>
                <td style={{ ...TD(false), color: a.resType === "Stahl" ? C.stahl : C.betonC }}>{a.resType}</td>
                <td style={TD(false)}>{fmtN(a.resCost)}</td>
                <td style={{ ...TD(false), color: a.free > 0 ? C.green : C.textMuted }}>{a.free > 0 ? "-" + fmtN(a.free) : "-"}</td>
                <td style={TD(false)}>{fmtN(a.ppCost)}</td>
                <td style={{ ...TD(false), fontSize: 10, color: a.method === "Lager" ? C.green : a.method === "direkt" ? C.textMuted : C.accent }}>{a.method}</td>
                <td style={TD(false)}>{fmtT(a.hours)}</td>
                <td style={{ ...TD(false), color: C.green }}>+{a.ppGain.toFixed(1)}</td>
                <td style={TD(false)}>{fmtT(a.amortH)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </GlassCard>}

      {/* Compute */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "10px 0 18px" }}>
        <Tip text="Dijkstra + Greedy-Vergleich berechnen (kann einige Sekunden dauern)">
          <Btn on big color={C.accent} onClick={compute} disabled={busy || !facs.length}>{busy ? "Berechne..." : "Optimierung starten"}</Btn>
        </Tip>
        {res && <span style={{ fontSize: 11, color: res.ok ? C.green : C.red, textShadow: "0 0 8px " + (res.ok ? C.greenGlow : "rgba(248,113,113,0.3)") }}>
          {res.ok ? "Optimum gefunden" : "Limit erreicht"} - {res.iter.toLocaleString()} Iterationen
        </span>}
      </div>

      {res && <>
        {/* Strategy Cards */}
        <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 6, fontFamily: F.m }}>Karten anklicken zum Ein-/Ausblenden im Chart</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
          {STRATS.map(s => {
            const t = res.finals[s.key], n = res.paths[s.key]?.length || 0, on = actv.includes(s.key);
            const best = Math.min(...Object.values(res.finals).filter(v => v != null));
            const isBest = t === best && t != null;
            return <div key={s.key} onClick={() => setActv(p => p.includes(s.key) ? p.filter(x => x !== s.key) : [...p, s.key])}
              style={{ ...glass(on ? 0.07 : 0.03, 16), borderRadius: 12, padding: "14px 16px", cursor: "pointer",
                borderColor: on ? s.color + "55" : "rgba(255,255,255,0.06)",
                boxShadow: isBest && on ? "0 8px 32px rgba(0,0,0,0.4), 0 0 24px " + s.glow : "0 4px 16px rgba(0,0,0,0.3)",
                transition: "all 0.2s" }}>
              <div style={{ fontFamily: F.h, fontSize: 10, color: s.color, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, textShadow: "0 0 10px " + s.glow }}><Tip text={s.tip} pos="bottom">{s.label}</Tip></div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: F.h, color: t != null ? C.text : C.textMuted }}>{t != null ? fmtT(t) : "-"}</div>
              <div style={{ fontSize: 10, color: C.textMuted, marginTop: 3 }}>{n} Schritte</div>
              {isBest && <div style={{ fontFamily: F.h, fontSize: 9, color: s.color, marginTop: 5, fontWeight: 700, letterSpacing: "0.1em", textShadow: "0 0 8px " + s.glow }}>SCHNELLSTER</div>}
            </div>;
          })}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
          <Tip text="Produktionsrate ueber Zeit (Treppenkurve)"><Btn on={tab === "chart"} onClick={() => setTab("chart")}>Kurve</Btn></Tip>
          <Tip text="Schritt-fuer-Schritt Bau-Reihenfolge"><Btn on={tab === "table"} onClick={() => setTab("table")}>Reihenfolge</Btn></Tip>
          {tab === "chart" && <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Tip text="Produktionsrate pro Stunde"><Btn on={cM === "rate"} color={C.textDim} onClick={() => setCM("rate")}>PP/h</Btn></Tip>
            <Tip text="Kumulierte Gesamtproduktion"><Btn on={cM === "cum"} color={C.textDim} onClick={() => setCM("cum")}>Kumulativ</Btn></Tip>
          </div>}
        </div>

        {/* Chart */}
        {tab === "chart" && chart.length > 0 && <GlassCard>
          <ResponsiveContainer width="100%" height={400}>
            <AreaChart data={chart} margin={{ top: 10, right: 20, bottom: 30, left: 30 }}>
              <defs>{STRATS.map(s => <linearGradient key={s.key} id={"g_" + s.key} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.3} /><stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>)}</defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="time" stroke={C.textMuted} tick={{ fontSize: 10, fill: C.textMuted, fontFamily: F.m }}
                label={{ value: "Zeit", position: "insideBottom", offset: -16, fill: C.textMuted, fontSize: 11, fontFamily: F.h }}
                tickFormatter={v => v >= 48 ? (v/24).toFixed(0) + "d" : Math.round(v) + "h"} />
              <YAxis stroke={C.textMuted} tick={{ fontSize: 10, fill: C.textMuted, fontFamily: F.m }}
                label={{ value: cM === "rate" ? "PP/h" : "Gesamt PP", angle: -90, position: "insideLeft", offset: 8, fill: C.textMuted, fontSize: 11, fontFamily: F.h }}
                tickFormatter={v => fmtN(v)} />
              <Tooltip contentStyle={{ ...glass(0.12, 20), borderRadius: 10, fontSize: 12, color: C.text, fontFamily: F.m }}
                labelFormatter={v => Math.round(v) + "h (Tag " + (v/24).toFixed(1) + ")"}
                formatter={(v, n) => [cM === "rate" ? v + " PP/h" : fmtN(v) + " PP", n]} />
              {STRATS.filter(s => actv.includes(s.key)).map(s =>
                <Area key={s.key} type="stepAfter" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2.5} fill={"url(#g_" + s.key + ")"} dot={false} connectNulls />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </GlassCard>}

        {/* Table */}
        {tab === "table" && <GlassCard>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {STRATS.map(s => <Btn key={s.key} on={tS === s.key} color={s.color} onClick={() => setTS(s.key)}>{s.label}</Btn>)}
          </div>
          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["#", "Aktion", "Res.", "Menge", "Lager", "Weg", "PP", "Dauer", "Gesamt", "PP/h", "+PP/h"].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
              <tbody>
                {curPath.map((s, i) => <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                  <td style={TD(false)}>{i+1}</td>
                  <td style={TD(false)}><Bdg color={s.type === "buy" ? C.blue : C.green}>{s.type === "buy" ? "NEU" : "UP"}</Bdg><span style={{ marginLeft: 8 }}>{s.action}</span></td>
                  <td style={{ ...TD(false), color: s.resType === "stahl" ? C.stahl : C.betonC }}>{s.resType === "stahl" ? "Stahl" : "Beton"}</td>
                  <td style={TD(false)}>{fmtN(s.resCost)}</td>
                  <td style={{ ...TD(false), color: s.freeRes > 0 ? C.green : C.textMuted }}>{s.freeRes > 0 ? "-" + s.freeRes : "-"}</td>
                  <td style={{ ...TD(false), fontSize: 10, color: s.method === "Lager" ? C.green : s.method === "direkt" ? C.textMuted : C.accent }}>{s.method}</td>
                  <td style={TD(false)}>{fmtN(s.ppCost)}</td>
                  <td style={TD(false)}>{fmtT(s.dt)}</td>
                  <td style={TD(true)}>{fmtT(s.time)}</td>
                  <td style={{ ...TD(false), color: C.green }}>{s.pph.toFixed(1)}</td>
                  <td style={{ ...TD(false), color: C.green }}>+{s.ppGain.toFixed(1)}</td>
                </tr>)}
                {!curPath.length && <tr><td colSpan={11} style={{ padding: 24, textAlign: "center", color: C.textMuted }}>Kein Pfad / Max erreicht</td></tr>}
              </tbody>
            </table>
          </div>
        </GlassCard>}
      </>}

      {/* Cost Ref */}
      <GlassCard style={{ marginTop: 8 }}>
        <Sec icon="&#9776;">Kostenreferenz</Sec>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, fontSize: 11 }}>
          <div>
            <div style={{ color: C.stahl, fontWeight: 700, fontFamily: F.h, marginBottom: 8, letterSpacing: "0.08em" }}>UPGRADES (STAHL)</div>
            {Array.from({ length: mxL - 1 }, (_, i) => i+1).map(l => {
              const s = upgStahl(l, uB), { pp, method } = effPP(s, "stahl", params);
              return <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: C.textDim }}>
                <span style={{ width: 70, color: C.text }}>L{l} -&gt; L{l+1}</span>
                <span style={{ color: C.stahl }}>{s}</span>
                <span>{pp.toFixed(0)} PP</span>
                <span style={{ fontSize: 10, color: method === "direkt" ? C.textMuted : C.accent }}>{method}</span>
              </div>;
            })}
          </div>
          <div>
            <div style={{ color: C.betonC, fontWeight: 700, fontFamily: F.h, marginBottom: 8, letterSpacing: "0.08em" }}>FABRIKEN (BETON)</div>
            {Array.from({ length: mxF }, (_, i) => i+1).map(n => {
              const b = facBeton(n, fB), { pp, method } = effPP(b, "beton", params);
              return <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: C.textDim }}>
                <span style={{ width: 70, color: C.text }}>Fabrik #{n}</span>
                <span style={{ color: C.betonC }}>{b}</span>
                <span>{pp.toFixed(0)} PP</span>
                <span style={{ fontSize: 10, color: method === "direkt" ? C.textMuted : C.accent }}>{method}</span>
              </div>;
            })}
          </div>
        </div>
      </GlassCard>

      <div style={{ textAlign: "center", fontSize: 10, color: C.textMuted, marginTop: 16, paddingBottom: 24, fontFamily: F.h, letterSpacing: "0.15em" }}>
        HEBELMINISTERIUM DEUTSCHLAND &middot; FABRIK-OPTIMIERER &middot; DIJKSTRA + MARKTHANDEL
      </div>
    </div>
  );
}
