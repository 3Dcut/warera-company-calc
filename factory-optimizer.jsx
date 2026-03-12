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
    bg: "linear-gradient(135deg, #1f001f 0%, #300040 40%, #1a001a 100%)",
    orb1: "rgba(255,0,255,0.1)", orb2: "rgba(0,255,255,0.06)",
    C: {
      accent: "#ff00ff", accentGlow: "rgba(255,0,255,0.5)",
      green: "#00ffcc", greenGlow: "rgba(0,255,204,0.4)",
      red: "#ff3366",
      blue: "#00ccff", blueGlow: "rgba(0,204,255,0.4)",
      purple: "#cc66ff",
      stahl: "#ff9966", betonC: "#66ffcc",
      text: "#ffffff", textDim: "#ffccff", textMuted: "#996699",
      inputBg: "rgba(255,0,255,0.05)", inputBorder: "rgba(255,0,255,0.3)",
      rowAlt: "rgba(255,0,255,0.04)",
    },
  },
};

let C = THEMES.grau.C;

// Tooltip CSS injection
const styleEl = document.createElement("style");
styleEl.textContent = `
  @keyframes tipIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes copyFlash { 0% { box-shadow: 0 0 0 rgba(52,211,153,0); } 50% { box-shadow: 0 0 24px rgba(52,211,153,0.5); } 100% { box-shadow: 0 0 0 rgba(52,211,153,0); } }
  * { box-sizing: border-box; }
  body, html { margin: 0; padding: 0; overflow-x: hidden; }
  .tip-wrap { position: relative; display: inline-flex; }
  .tip-wrap .tip-box {
    display: none; position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    padding: 8px 12px; border-radius: 6px; font-size: 13px; line-height: 1.4; white-space: nowrap; z-index: 100; pointer-events: none;
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
  const p = [params.ppPerStahl, params.ppPerBeton,
    params.maxFactories, params.maxLevel, params.upgradeBase, params.factoryBase].join(",");
  const f = facs.map(x => x.level).join(",");
  try { return btoa(p + "|" + f + "|" + theme); } catch { return ""; }
}

function decodeState(str) {
  try {
    const raw = atob(str.trim());
    const parts = raw.split("|");
    const pStr = parts[0], fStr = parts[1], thm = parts[2] || "grau";
    const p = pStr.split(",").map(Number);
    const facs = fStr.split(",").map(s => {
      const l = Number(s);
      return { level: l };
    });
    return {
      params: { ppPerStahl: p[0], ppPerBeton: p[1],
        maxFactories: p[2], maxLevel: p[3], upgradeBase: p[4], factoryBase: p[5] },
      facs, theme: thm === "pink" ? "pink" : "grau"
    };
  } catch { return null; }
}

// ── Game Logic ──
const upgStahl = (lvl, base) => base * Math.pow(2, lvl - 1);
const facBeton = (n, base) => n * base;
function calcPPH(level) { return level; }
function totalPPH(fs) { return fs.reduce((s, f) => s + calcPPH(f.level), 0); }

function effPP(amount, resType, p) {
  if (resType === "stahl") return amount * p.ppPerStahl;
  return amount * p.ppPerBeton;
}

class Heap {
  constructor() { this.d = []; }
  push(p, v) { this.d.push({ p, v }); let i = this.d.length - 1; while (i > 0) { const j = (i-1)>>1; if (this.d[j].p <= this.d[i].p) break; [this.d[j], this.d[i]] = [this.d[i], this.d[j]]; i = j; } }
  pop() { const t = this.d[0], l = this.d.pop(); if (this.d.length > 0) { this.d[0] = l; let i = 0; while (true) { let s = i, a = 2*i+1, b = 2*i+2; if (a < this.d.length && this.d[a].p < this.d[s].p) s = a; if (b < this.d.length && this.d[b].p < this.d[s].p) s = b; if (s === i) break; [this.d[s], this.d[i]] = [this.d[i], this.d[s]]; i = s; } } return t; }
  get size() { return this.d.length; }
}

function facKey(fs) { return fs.map(f => f.level).sort().join("|"); }

function runDijkstra(startFacs, params) {
  const { maxFactories, maxLevel, upgradeBase, factoryBase } = params;
  const heap = new Heap(), visited = new Set();
  const gp = []; for (const f of startFacs) gp.push(maxLevel);
  for (let i = startFacs.length; i < maxFactories; i++) gp.push(maxLevel);
  const gk = gp.sort().join("|");
  if (facKey(startFacs) === gk) return { path: [], complete: true, iter: 0 };

  const sk = (fs) => facKey(fs);
  heap.push(0, { facs: startFacs.map(f => ({ ...f })), path: [] });
  let iter = 0;

  while (heap.size > 0 && iter < 500000) {
    iter++;
    const { p: time, v: { facs, path } } = heap.pop();
    const key = sk(facs);
    if (visited.has(key)) continue; visited.add(key);
    if (facKey(facs) === gk) return { path, complete: true, iter };
    const pph = totalPPH(facs); if (pph <= 0) continue;

    for (let i = 0; i < facs.length; i++) {
      if (facs[i].level >= maxLevel) continue;
      const lvl = facs[i].level, stahl = upgStahl(lvl, upgradeBase);
      const pp = effPP(stahl, "stahl", params);
      const dt = pp / pph;
      const nf = facs.map((f, j) => j === i ? { ...f, level: f.level + 1 } : { ...f });
      const nk = sk(nf);
      if (!visited.has(nk)) {
        heap.push(time + dt, { facs: nf, path: [...path, {
          action: "Upgrade L" + lvl + " -> L" + (lvl+1),
          type: "upgrade", resType: "stahl", resCost: stahl,
          ppCost: pp, ppGain: calcPPH(1), dt, time: time + dt, pph: totalPPH(nf),
        }]});
      }
    }
    if (facs.length < maxFactories) {
      const n = facs.length + 1, beton = facBeton(n, factoryBase);
      const pp = effPP(beton, "beton", params);
      const dt = pph > 0 ? pp / pph : Infinity;
      const nf = [...facs.map(f => ({ ...f })), { level: 1 }];
      const nk = sk(nf);
      if (!visited.has(nk)) {
        heap.push(time + dt, { facs: nf, path: [...path, {
          action: "Neue Fabrik #" + n, type: "buy", resType: "beton", resCost: beton,
          ppCost: pp, ppGain: calcPPH(1), dt, time: time + dt, pph: totalPPH(nf),
        }]});
      }
    }
  }
  return { path: [], complete: false, iter };
}

function simulate(facs, params, strategy) {
  const { maxFactories, maxLevel, upgradeBase, factoryBase } = params;
  let st = facs.map(f => ({ ...f })), t = 0;
  const path = []; let safe = 0;
  while (safe < 300) {
    safe++;
    if (st.length >= maxFactories && st.every(f => f.level >= maxLevel)) break;
    const pph = totalPPH(st); if (pph <= 0) break;
    const acts = [];
    st.forEach((f, i) => {
      if (f.level >= maxLevel) return;
      const stahl = upgStahl(f.level, upgradeBase);
      const pp = effPP(stahl, "stahl", params);
      const ppG = calcPPH(1);
      acts.push({ type: "upgrade", idx: i, resCost: stahl, resType: "stahl",
        ppCost: pp, ppGain: ppG, dt: pp / pph, label: "Upgrade L" + f.level + " -> L" + (f.level+1) });
    });
    if (st.length < maxFactories) {
      const n = st.length + 1, beton = facBeton(n, factoryBase);
      const pp = effPP(beton, "beton", params);
      acts.push({ type: "buy", resCost: beton, resType: "beton",
        ppCost: pp, ppGain: calcPPH(1), dt: pp / pph, label: "Neue Fabrik #" + n });
    }
    if (!acts.length) break;
    let pick;
    if (strategy === "cheapest") pick = acts.sort((a, b) => a.ppCost - b.ppCost)[0];
    else if (strategy === "upgrade_first") { const u = acts.filter(a => a.type === "upgrade").sort((a,b) => a.ppCost - b.ppCost); pick = u.length ? u[0] : acts.find(a => a.type === "buy"); }
    else { const b = acts.filter(a => a.type === "buy"); pick = b.length ? b[0] : acts.sort((a,b) => a.ppCost - b.ppCost)[0]; }
    t += pick.dt;
    if (pick.type === "upgrade") { st = st.map((f, j) => j === pick.idx ? { ...f, level: f.level + 1 } : f); }
    else { st = [...st, { level: 1 }]; }
    path.push({ action: pick.label, type: pick.type, resType: pick.resType, resCost: pick.resCost,
      ppCost: pick.ppCost, ppGain: pick.ppGain, dt: pick.dt, time: t, pph: totalPPH(st) });
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

function fmt(n, d = 1) {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: d }).format(n);
}
function fmtT(h) { if (h <= 0) return "sofort"; if (h < 1) return fmt(h*60, 0) + "m"; if (h < 24) return fmt(h, 1) + "h"; const d = h / 24; return d < 365 ? fmt(d, 1) + "d" : fmt(d/365, 1) + "y"; }
function fmtN(n) { if (Math.abs(n) >= 1e6) return fmt(n/1e6, 1) + "M"; if (Math.abs(n) >= 1e3) return fmt(n/1e3, 1) + "k"; return fmt(n, 1); }

// ── Styled primitives ──
function GlassCard({ children, style, glow }) {
  return <div style={{ ...glass(0.05, 20), borderRadius: 12, padding: "16px 20px", marginBottom: 14, ...(glow ? { boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 24px " + glow } : {}), ...style }}>{children}</div>;
}
function Sec({ children, icon }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
    {icon && <span style={{ fontSize: 20 }}>{icon}</span>}
    <span style={{ fontFamily: F.h, fontSize: 17, fontWeight: 700, color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>{children}</span>
  </div>;
}
function Inp({ label, value, onChange, step = 1, suffix, tip }) {
  const inner = <div style={{ marginBottom: 12 }}>
    <label style={{ fontFamily: F.m, fontSize: 14, color: C.textDim, marginBottom: 5, display: "block", letterSpacing: "0.03em" }}>{label} {tip && <span style={{ color: C.textMuted, cursor: "help" }}>&#9432;</span>}</label>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="number" step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text,
          padding: "9px 12px", fontSize: 15, width: "100%", boxSizing: "border-box", outline: "none",
          fontFamily: F.m, transition: "border-color 0.2s, box-shadow 0.2s" }}
        onFocus={e => { e.target.style.borderColor = C.accent + "88"; e.target.style.boxShadow = "0 0 12px " + C.accentGlow; }}
        onBlur={e => { e.target.style.borderColor = C.inputBorder; e.target.style.boxShadow = "none"; }} />
      {suffix && <span style={{ fontFamily: F.m, fontSize: 14, color: C.textMuted, whiteSpace: "nowrap" }}>{suffix}</span>}
    </div>
  </div>;
  return tip ? <Tip text={tip}>{inner}</Tip> : inner;
}
function Bdg({ color, children }) {
  return <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 4, fontSize: 13, fontWeight: 700, fontFamily: F.h, background: color + "25", color, border: "1px solid " + color + "44", letterSpacing: "0.06em", textTransform: "uppercase", textShadow: "0 0 8px " + color + "44" }}>{children}</span>;
}
function Tip({ text, children, pos = "top" }) {
  if (!text) return children;
  return <span className="tip-wrap">{children}<span className="tip-box" style={pos === "bottom" ? { bottom: "auto", top: "calc(100% + 8px)" } : {}}>{text}</span></span>;
}
function Btn({ on, color = C.accent, children, onClick, big, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{
    padding: big ? "14px 32px" : "8px 18px", borderRadius: 8, border: "1px solid " + (on ? color + "88" : "rgba(255,255,255,0.08)"),
    background: on ? color + "18" : "rgba(255,255,255,0.03)", color: disabled ? C.textMuted : on ? color : C.textDim,
    cursor: disabled ? "not-allowed" : "pointer", fontSize: big ? 18 : 14, fontFamily: F.h, fontWeight: 700,
    letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.2s", opacity: disabled ? 0.4 : 1,
    boxShadow: on ? "0 0 16px " + color + "22, inset 0 1px 0 rgba(255,255,255,0.06)" : "0 2px 8px rgba(0,0,0,0.2)",
    textShadow: on ? "0 0 10px " + color + "44" : "none",
  }}>{children}</button>;
}
const TH = { textAlign: "left", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", color: C.textDim, fontSize: 13, fontFamily: F.h, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 };
const TD = (hl) => ({ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: hl ? C.accent : C.text, fontSize: 15, fontFamily: F.m });

// ── Main ──
export default function App() {
  const [ppS, setPpS] = useState(20);
  const [ppB, setPpB] = useState(20);
  const [mxF, setMxF] = useState(12);
  const [mxL, setMxL] = useState(7);
  const [uB, setUB] = useState(20);
  const [fB, setFB] = useState(50);
  const [facs, setFacs] = useState([{ level: 1 }]);
  const [actv, setActv] = useState(["dijkstra", "cheapest"]);
  const [tab, setTab] = useState("chart");
  const [cM, setCM] = useState("rate");
  const [tS, setTS] = useState("dijkstra");
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
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

  function compute(customFacs = null, customParams = null) {
    setBusy(true);
    const fData = customFacs || facs;
    const pData = customParams || { ppPerStahl: ppS, ppPerBeton: ppB, maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB };
    
    setTimeout(() => {
      const paths = {}, d = runDijkstra(fData, pData);
      paths.dijkstra = d.path;
      for (const s of STRATS) { if (s.key !== "dijkstra") try { paths[s.key] = simulate(fData, pData, s.key); } catch { paths[s.key] = []; } }
      const finals = {};
      for (const s of STRATS) { const p = paths[s.key]; finals[s.key] = p?.length ? p[p.length-1].time : null; }
      setRes({ paths, finals, ok: d.complete, iter: d.iter });
      setBusy(false);
    }, 50);
  }

  async function loadFromAPI() {
    if (!apiUser.trim()) return;
    setApiLoading(true); setApiError(""); setApiInfo("");
    try {
      let userId;
      let username;
      const input = apiUser.trim();

      // Robuste Strategie: Versuche JEDE Eingabe zuerst als direkte User-ID
      try {
        const u = await apiCall("user.getUserLite", { userId: input });
        if (u && u.username) {
          userId = input;
          username = u.username;
        }
      } catch (e) {
        // Falls kein direkter Treffer (z.B. bei Benutzernamen), gehen wir zur Suche über
      }

      if (!userId) {
        const search = await apiCall("search.searchAnything", { searchText: input });
        if (!search.userIds?.length) throw new Error("Spieler oder ID nicht gefunden");

        // Bei mehreren Such-Ergebnissen suchen wir nach einer exakten Namensübereinstimmung
        let foundExact = false;
        for (const uid of search.userIds) {
          const u = await apiCall("user.getUserLite", { userId: uid });
          if (u.username.toLowerCase() === input.toLowerCase()) {
            userId = uid;
            username = u.username;
            foundExact = true;
            break;
          }
          // Fallback: Wir merken uns den ersten Treffer, falls kein exakter Name gefunden wird
          if (uid === search.userIds[0]) {
            userId = uid;
            username = u.username;
          }
        }
        if (!userId) throw new Error("Spieler oder ID nicht gefunden");
      }

      const companies = await apiCall("company.getCompanies", { userId, perPage: 100 });
      const companyIds = companies.items || [];
      if (!companyIds.length) throw new Error("Keine Fabriken gefunden");

      const newFacs = [];
      for (const cid of companyIds) {
        const comp = await apiCall("company.getById", { companyId: cid });
        newFacs.push({ level: comp.activeUpgradeLevels?.automatedEngine || 1, name: comp.name, item: comp.itemCode });
      }

      setFacs(newFacs);
      setApiInfo(username + ": " + newFacs.length + " Fabriken geladen.");
      
      // Sofort berechnen mit NEUEN Daten
      const newParams = { ppPerStahl: ppS, ppPerBeton: ppB, maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB };
      compute(newFacs, newParams);
    } catch (e) {
      setApiError(e.message);
    }
    setApiLoading(false);
  }

  const updF = useCallback((i, k, v) => setFacs(p => p.map((f, j) => j === i ? { ...f, [k]: v } : f)), []);
  const addF = useCallback(() => setFacs(p => [...p, { level: 1 }]), []);
  const rmF = useCallback(i => setFacs(p => p.filter((_, j) => j !== i)), []);

  const params = { ppPerStahl: ppS, ppPerBeton: ppB, maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB };
  const pph = totalPPH(facs);

  const code = encodeState(params, facs, theme);

  function doImport() {
    const d = decodeState(impStr);
    if (!d) return;
    const p = d.params;
    setPpS(p.ppPerStahl); setPpB(p.ppPerBeton);
    setMxF(p.maxFactories); setMxL(p.maxLevel); setUB(p.upgradeBase); setFB(p.factoryBase);
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

  const trade = null;

  const displayActs = res?.paths?.dijkstra?.slice(0, 3) || [];

  function computeOld() {
    // Keep internal compute if needed or remove if redundant
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
      color: C.text, minHeight: "100vh", fontFamily: F.m, padding: "28px 24px", margin: "0 auto",
      transition: "background 0.5s",
    }}>
      {/* BG glow orbs */}
      <div style={{ position: "fixed", top: -200, right: -200, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb1 + " 0%, transparent 70%)", pointerEvents: "none", transition: "background 0.5s" }} />
      <div style={{ position: "fixed", bottom: -300, left: -200, width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb2 + " 0%, transparent 70%)", pointerEvents: "none", transition: "background 0.5s" }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 28, paddingBottom: 20, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.h, fontSize: 13, color: C.textMuted, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 6 }}>WarEra Produktions-Planungstool</div>
          <h1 style={{ fontFamily: F.h, fontSize: 32, fontWeight: 700, color: C.accent, margin: 0, letterSpacing: "0.04em", textShadow: "0 0 30px " + C.accentGlow, lineHeight: 1.2 }}>
            Fabrik-Optimierer<br />
            <span style={{ fontSize: 18, fontWeight: 600, color: C.textDim, letterSpacing: "0.08em" }}>des Hebelministeriums Deutschland</span>
          </h1>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <Tip text={"Theme wechseln: " + (theme === "grau" ? "Pink" : "Grau")}>
            <button onClick={() => setTheme(t => t === "grau" ? "pink" : "grau")} style={{
              padding: "8px 18px", borderRadius: 20,
              border: "1px solid " + (theme === "pink" ? "rgba(255,107,157,0.5)" : "rgba(255,255,255,0.1)"),
              background: theme === "pink"
                ? "linear-gradient(135deg, rgba(255,107,157,0.2), rgba(200,130,255,0.15))"
                : "rgba(255,255,255,0.04)",
              color: theme === "pink" ? "#ff6b9d" : C.textDim,
              cursor: "pointer", fontSize: 13, fontFamily: F.h, fontWeight: 700,
              letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.3s",
              boxShadow: theme === "pink" ? "0 0 16px rgba(255,107,157,0.2)" : "0 2px 8px rgba(0,0,0,0.2)",
            }}>
              {theme === "pink" ? "\u2665 PINK" : "\u25C9 GRAU"}
            </button>
          </Tip>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 36, fontWeight: 700, color: C.accent, fontFamily: F.h, textShadow: "0 0 20px " + C.accentGlow }}>{fmt(pph * 24, 1)} <span style={{ fontSize: 18, color: C.textDim }}>PP/d</span></div>
            <div style={{ fontSize: 16, color: C.textDim }}>{fmt(pph, 1)} PP/h</div>
          </div>
        </div>
      </div>



      <GlassCard style={{ padding: "20px 24px" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: "500px" }}>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Sec icon="&#128100;">WarEra Spieler</Sec>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Tip text="Gib den Namen eines Spielers ein, um seine Fabriken und Daten direkt von der WarEra-API zu laden.">
                <input
                  aria-label="WarEra Username"
                  value={apiUser} onChange={e => setApiUser(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && loadFromAPI()}
                  placeholder="Username..."
                  style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 8, color: C.text, padding: "10px 14px", fontSize: 14, fontFamily: F.m, outline: "none", flex: 1 }}
                />
              </Tip>
              <Btn on big color={C.accent} onClick={loadFromAPI} disabled={apiLoading || !apiUser.trim()}>
                {apiLoading ? "Lädt..." : "Import & Optimieren"}
              </Btn>
            </div>
          </div>
        </div>
        {(apiError || apiInfo) && (
          <div style={{ marginTop: 12, fontSize: 12, fontFamily: F.m, color: apiError ? C.red : C.green, textAlign: "center" }}>
            {apiError || apiInfo}
          </div>
        )}
      </GlassCard>

      <div style={{ marginBottom: 14 }}>
        <Btn on={showAdvanced} onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? "Optionen ausblenden \u25B4" : "Fortgeschrittene Optionen \u25BE"}
        </Btn>
      </div>

      {showAdvanced && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginBottom: 20 }}>
          <GlassCard>
            <Sec icon="&#9881;">Parameter & Einheiten</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0 12px" }}>
              <Inp label="PP pro Stahl" value={ppS} onChange={v => { setPpS(v); compute(); }} suffix="PP/Stk" tip="Wie viele Produktionspunkte (PP) ein Stück Stahl wert ist." />
              <Inp label="PP pro Beton" value={ppB} onChange={v => { setPpB(v); compute(); }} suffix="PP/Bt" tip="Wie viele Produktionspunkte (PP) ein Stück Beton wert ist." />
              <Inp label="Max. Fabriken" value={mxF} onChange={v => { setMxF(v); compute(); }} suffix="Stk" tip="Die maximale Anzahl an Fabriken, die du bauen möchtest." />
              <Inp label="Max. Level" value={mxL} onChange={v => { setMxL(v); compute(); }} suffix="Lvl" tip="Das maximale Level, das jede Fabrik erreichen soll." />
              <Inp label="Basis Upg-Kosten" value={uB} onChange={v => { setUB(v); compute(); }} suffix="Stk" tip="Basiskosten an Stahl für ein Upgrade von Level 1 auf 2." />
              <Inp label="Basis Fab-Kosten" value={fB} onChange={v => { setFB(v); compute(); }} suffix="Bt" tip="Basiskosten an Beton für die allererste Fabrik." />
            </div>
          </GlassCard>
          <GlassCard>
            <Sec icon="&#128203;">Konfiguration (Import/Export)</Sec>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <Tip text="Alle Parameter + Fabriken als Code in die Zwischenablage kopieren">
                <Btn on={copied} onClick={doCopy}>{copied ? "\u2713 Kopiert" : "Code kopieren"}</Btn>
              </Tip>
              <Tip text="Einen gespeicherten Code eingeben, um Parameter und Fabriken zu laden">
                <Btn on={showImp} onClick={() => setShowImp(!showImp)}>Import-Code</Btn>
              </Tip>
            </div>
            {showImp && (
              <div style={{ display: "flex", gap: 8 }}>
                <input value={impStr} onChange={e => setImpStr(e.target.value)} placeholder="Code..."
                  style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text, padding: "6px 10px", fontSize: 14, fontFamily: F.m, outline: "none", flex: 1 }} />
                <Btn on color={C.green} onClick={doImport}>Laden</Btn>
              </div>
            )}
            <div style={{ fontSize: 16, color: C.textMuted, wordBreak: "break-all", marginTop: 12, lineHeight: 1.4 }}>{code}</div>
          </GlassCard>

          {/* Cost Ref - Now inside Advanced */}
          <GlassCard style={{ marginTop: 0 }}>
            <Sec icon="&#9776;">Kostenreferenz</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, fontSize: 16 }}>
              <div>
                <div style={{ color: C.stahl, fontWeight: 700, fontFamily: F.h, marginBottom: 12, letterSpacing: "0.08em" }}>UPGRADES (STAHL)</div>
                {Array.from({ length: mxL - 1 }, (_, i) => i+1).map(l => {
                  const s = upgStahl(l, uB), pp = effPP(s, "stahl", params);
                  return <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: C.textDim }}>
                    <span style={{ width: 70, color: C.text }}>L{l} -&gt; L{l+1}</span>
                    <span style={{ color: C.stahl }}>{fmt(s, 0)} Einh.</span>
                    <span>{fmt(pp, 0)} PP</span>
                  </div>;
                })}
              </div>
              <div>
                <div style={{ color: C.betonC, fontWeight: 700, fontFamily: F.h, marginBottom: 12, letterSpacing: "0.08em" }}>FABRIKEN (BETON)</div>
                {Array.from({ length: mxF }, (_, i) => i+1).map(n => {
                  const b = facBeton(n, fB), pp = effPP(b, "beton", params);
                  return <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: C.textDim }}>
                    <span style={{ width: 70, color: C.text }}>Fabrik #{n}</span>
                    <span style={{ color: C.betonC }}>{fmt(b, 0)} Einh.</span>
                    <span>{fmt(pp, 0)} PP</span>
                  </div>;
                })}
              </div>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Main Results Display */}
      {res && (
        <div style={{ marginBottom: 20 }}>
          <Sec icon="&#128200;">Produktionskurve</Sec>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 20 }}>
            {STRATS.map(s => {
              const t = res.finals[s.key], on = actv.includes(s.key);
              const isBest = t === Math.min(...Object.values(res.finals).filter(v => v != null)) && t != null;
              return (
                <Tip key={s.key} text={s.tip}>
                  <div onClick={() => setActv(p => p.includes(s.key) ? p.filter(x => x !== s.key) : [...p, s.key])}
                    style={{ ...glass(on ? 0.07 : 0.03, 16), borderRadius: 12, padding: "16px", cursor: "pointer",
                      borderColor: on ? s.color + "55" : "rgba(255,255,255,0.06)", transition: "all 0.2s",
                      boxShadow: isBest && on ? "0 0 20px " + s.glow : "none" }}>
                    <div style={{ fontFamily: F.h, fontSize: 12, color: s.color, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{s.label}</div>
                    <div style={{ fontSize: 24, fontWeight: 700, fontFamily: F.h }}>{t != null ? fmtT(t) : "-"}</div>
                    {isBest && <div style={{ fontSize: 10, color: s.color, fontWeight: 700, marginTop: 4 }}>BESTE</div>}
                  </div>
                </Tip>
              );
            })}
          </div>
          <GlassCard style={{ padding: "16px" }}>
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={chart}>
                <defs>{STRATS.map(s => <linearGradient key={s.key} id={"g_" + s.key} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.4} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="time" stroke={C.textMuted} tick={{ fontSize: 12 }} tickFormatter={v => v >= 48 ? (v/24).toFixed(0) + "d" : Math.round(v) + "h"} />
                <YAxis stroke={C.textMuted} tick={{ fontSize: 12 }} tickFormatter={v => fmtN(v)} />
                <Tooltip contentStyle={{ ...glass(0.12, 20), borderRadius: 10, fontSize: 13, border: "none" }} labelFormatter={v => v >= 48 ? (v/24).toFixed(1) + "d" : Math.round(v*10)/10 + "h"} formatter={(v, n) => [fmt(v, 1) + " PP/h", STRATS.find(s => s.key === n)?.label || n]} />
                {STRATS.filter(s => actv.includes(s.key)).map(s => <Area key={s.key} type="stepAfter" dataKey={s.key} stroke={s.color} strokeWidth={3} fill={"url(#g_" + s.key + ")"} dot={false} />)}
              </AreaChart>
            </ResponsiveContainer>
          </GlassCard>
        </div>
      )}

      {/* Side by Side */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 500px", minWidth: 0 }}>
          <Sec icon="&#127981;">Deine Fabriken ({facs.length}/{mxF})</Sec>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
            {facs.map((f, i) => (
              <div key={i} style={{ ...glass(0.08, 10), borderRadius: 12, padding: "12px 16px", border: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "transform 0.2s, box-shadow 0.2s" }} onMouseOver={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,0.4)"; }} onMouseOut={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = glass(0.08, 10).boxShadow; }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ fontSize: 13, color: C.accent, fontWeight: 700, letterSpacing: "0.05em", width: "24px" }}>F{i+1}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 20, fontWeight: 700, fontFamily: F.h, width: "32px", textAlign: "center" }}>L{f.level}</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <Tip text="Level erhöhen (Planungszustand)">
                        <button aria-label="Level erhöhen" onClick={() => { if (f.level < mxL) { const nf = facs.map((x, j) => j === i ? { ...x, level: x.level + 1 } : x); setFacs(nf); compute(nf); } }} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: C.text, fontSize: 10, cursor: "pointer", padding: "2px 6px", borderRadius: 4, transition: "background 0.2s" }} onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.2)"} onMouseOut={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}>▲</button>
                      </Tip>
                      <Tip text="Level senken (Planungszustand)">
                        <button aria-label="Level senken" onClick={() => { if (f.level > 1) { const nf = facs.map((x, j) => j === i ? { ...x, level: x.level - 1 } : x); setFacs(nf); compute(nf); } }} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: C.text, fontSize: 10, cursor: "pointer", padding: "2px 6px", borderRadius: 4, transition: "background 0.2s" }} onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.2)"} onMouseOut={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}>▼</button>
                      </Tip>
                    </div>
                  </div>
                </div>

                <div style={{ flex: 1, padding: "0 20px" }}>
                  <div style={{ fontSize: 12, color: C.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", background: "rgba(0,0,0,0.2)", padding: "4px 12px", borderRadius: 6, display: "inline-block" }}>{f.item || "Unbekannt"}</div>
                </div>

                <Tip text="Fabrik aus der Planung entfernen">
                  <button aria-label="Fabrik entfernen" onClick={() => { rmF(i); compute(facs.filter((_, j) => j !== i)); }} style={{ background: "rgba(255,50,50,0.1)", border: "1px solid rgba(255,50,50,0.3)", borderRadius: "50%", color: C.red, cursor: "pointer", fontSize: 14, fontWeight: 700, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }} onMouseOver={e => { e.currentTarget.style.background = C.red; e.currentTarget.style.color = "#fff"; }} onMouseOut={e => { e.currentTarget.style.background = "rgba(255,50,50,0.1)"; e.currentTarget.style.color = C.red; }}>&times;</button>
                </Tip>
              </div>
            ))}
            <Tip text="Neue Fabrik (L1) zur Planung hinzufügen">
              <button aria-label="Neue Fabrik hinzufügen" onClick={() => { const nf = [...facs, { level: 1 }]; setFacs(nf); compute(nf); }} style={{ ...glass(0.05), borderRadius: 12, border: "2px dashed rgba(255,255,255,0.2)", color: C.textMuted, cursor: "pointer", fontSize: 24, padding: "12px", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }} onMouseOver={e => { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }} onMouseOut={e => { e.currentTarget.style.background = glass(0.05).background; e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"; e.currentTarget.style.color = C.textMuted; }}>
                +
              </button>
            </Tip>
          </div>
        </div>

        <div style={{ flex: "1 1 400px", minWidth: 0 }}>
          {res && (
            <>
              <Sec icon="&#128220;">Bester Bauplan (Dijkstra)</Sec>
              <GlassCard style={{ padding: "0", overflow: "hidden" }}>
                <div style={{ maxHeight: "600px", overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={TH}><Tip text="Schrittnummer im Bauplan">Schritt</Tip></th>
                      <th style={TH}><Tip text="Die auszuführende Aktion">Aktion</Tip></th>
                      <th style={TH}><Tip text="Zeitpunkt (kumuliert) ab jetzt">Zeit</Tip></th>
                      <th style={TH}><Tip text="Gewinn an Produktionsrate durch diesen Schritt">PP/d Gewinn</Tip></th>
                    </tr></thead>
                    <tbody>
                      {res.paths.dijkstra.map((s, i) => (
                        <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={TD(false)}>{i+1}</td>
                          <td style={TD(false)}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: s.type === "buy" ? C.blue : C.green }}>{s.action}</div>
                            <div style={{ fontSize: 9, color: C.textMuted }}>{fmtN(s.ppCost)} PP ({fmt(s.resCost, 0)} Einh.)</div>
                          </td>
                          <td style={TD(true)}>{fmtT(s.time)}</td>
                          <td style={{ ...TD(false), color: C.green }}>+{fmt(s.ppGain * 24, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </GlassCard>
            </>
          )}
        </div>
      </div>

      <div style={{ textAlign: "center", fontSize: 10, color: C.textMuted, marginTop: 16, paddingBottom: 24, fontFamily: F.h, letterSpacing: "0.15em" }}>
        HEBELMINISTERIUM DEUTSCHLAND &middot; FABRIK-OPTIMIERER &middot; DIJKSTRA + MARKTHANDEL
      </div>
    </div>
  );
}
