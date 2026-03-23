import { useState, useCallback, useRef, useEffect } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { THEMES, C, F, setThemeVars, glass, fmt, fmtT, fmtN, GlassCard, Sec, Inp, Bdg, Tip, Btn, getTH, getTD, apiCall } from "./shared.jsx";

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
  const p = [params.maxFactories, params.maxLevel, params.upgradeBase, params.factoryBase,
    params.includeWorkers?1:0, params.includeMissions?1:0, params.includeCases?1:0, params.includeDonations?1:0, 
    params.startBalance, params.startStahl, params.startBeton].join(",");
  const f = facs.map(x => x.level + ":" + (x.item||"")).join(",");
  try { return btoa(p + "|" + f + "|" + theme); } catch { return ""; }
}

function decodeState(str) {
  try {
    const raw = atob(str.trim());
    const parts = raw.split("|");
    const pStr = parts[0], fStr = parts[1], thm = parts[2] || "grau";
    const p = pStr.split(",").map(Number);
    const facs = fStr.split(",").map(s => {
      const sp = s.split(":");
      return { level: Number(sp[0]), item: sp[1] || "" };
    });
    return {
      params: { maxFactories: p[0], maxLevel: p[1], upgradeBase: p[2], factoryBase: p[3],
        includeWorkers: !!p[4], includeMissions: !!p[5], includeCases: !!p[6], includeDonations: !!p[7], 
        startBalance: p[8] || 0, startStahl: p[9] || 0, startBeton: p[10] || 0 },
      facs, theme: thm === "pink" ? "pink" : "grau"
    };
  } catch { return null; }
}

// ── Game Logic ──
const upgStahl = (lvl, base) => base * Math.pow(2, lvl - 1);
const facBeton = (n, base) => n * base;

function totalGoldPerDay(fs, params) {
  const { includeWorkers, includeMissions, includeDonations, includeCases, optData } = params;
  let g = 0;
  if (includeMissions) g += 10 + 30/7;
  // Fallback box price if unknown, assume ~8G
  if (includeCases) g += (1 + 3/7) * (optData?.prices?.dailyResourceBox || 8); 
  if (includeDonations) g -= 5;
  for (const f of fs) {
    if (f.goldPerLevelPerDay) g += f.level * f.goldPerLevelPerDay;
    if (includeWorkers && f.workerGoldPerDay) g += f.workerGoldPerDay;
  }
  return g; // Net Gold per day
}

class Heap {
  constructor() { this.d = []; }
  push(p, v) { this.d.push({ p, v }); let i = this.d.length - 1; while (i > 0) { const j = (i-1)>>1; if (this.d[j].p <= this.d[i].p) break; [this.d[j], this.d[i]] = [this.d[i], this.d[j]]; i = j; } }
  pop() { const t = this.d[0], l = this.d.pop(); if (this.d.length > 0) { this.d[0] = l; let i = 0; while (true) { let s = i, a = 2*i+1, b = 2*i+2; if (a < this.d.length && this.d[a].p < this.d[s].p) s = a; if (b < this.d.length && this.d[b].p < this.d[s].p) s = b; if (s === i) break; [this.d[s], this.d[i]] = [this.d[i], this.d[s]]; i = s; } } return t; }
  get size() { return this.d.length; }
}

function facKey(fs) { return fs.map(f => f.level).sort().join("|"); }

function runDijkstra(startFacs, params) {
  const { maxFactories, maxLevel, upgradeBase, factoryBase, optData } = params;
  const priceStahl = optData?.prices?.steel || 1.58;
  const priceBeton = optData?.prices?.concrete || 1.57;
  const newFacGoldPerLevelDay = optData?.bestProduct ? (24 * optData.bestProduct.maxGoldPerPP) : 2.5;

  const heap = new Heap(), visited = new Set();
  const gp = []; for (const f of startFacs) gp.push(maxLevel);
  for (let i = startFacs.length; i < maxFactories; i++) gp.push(maxLevel);
  const gk = gp.sort().join("|");
  if (facKey(startFacs) === gk) return { path: [], complete: true, iter: 0 };

  const sk = (fs) => facKey(fs);
  heap.push(0, { facs: startFacs.map(f => ({ ...f })), path: [], savings: params.startBalance || 0, invStahl: params.startStahl || 0, invBeton: params.startBeton || 0 });
  let iter = 0;

  while (heap.size > 0 && iter < 500000) {
    iter++;
    const { p: time, v: { facs, path, savings, invStahl, invBeton } } = heap.pop();
    const key = sk(facs);
    if (visited.has(key)) continue; visited.add(key);
    if (facKey(facs) === gk) return { path, complete: true, iter };
    
    const rateDay = totalGoldPerDay(facs, params);
    const rateHour = rateDay / 24;
    // If we are losing money and have no savings, we are stuck
    if (rateHour <= 0 && savings <= 0 && invStahl <= 0 && invBeton <= 0) continue; 

    for (let i = 0; i < facs.length; i++) {
      if (facs[i].level >= maxLevel) continue;
      const lvl = facs[i].level;
      const stahl = upgStahl(lvl, upgradeBase);
      
      const usedStahl = Math.min(invStahl, stahl);
      const remainingStahl = stahl - usedStahl;
      const goldCost = remainingStahl * priceStahl;
      
      let dt = 0;
      if (savings < goldCost) {
        if (rateHour <= 0) continue;
        dt = (goldCost - savings) / rateHour;
      }
      
      const newSavings = savings + (dt * rateHour) - goldCost;
      const nf = facs.map((f, j) => j === i ? { ...f, level: f.level + 1 } : { ...f });
      const nk = sk(nf);
      
      if (!visited.has(nk)) {
        heap.push(time + dt, { facs: nf, path: [...path, {
          action: "Upgrade F" + (i+1) + " (" + (facs[i].name || facs[i].item || "Neu") + ") L" + lvl + " -> L" + (lvl+1),
          type: "upgrade", resType: "stahl", resCost: stahl, usedInv: usedStahl,
          goldCost, goldGainDay: facs[i].goldPerLevelPerDay, dt, time: time + dt, 
          rateDay: totalGoldPerDay(nf, params), savings: newSavings,
        }], savings: newSavings, invStahl: invStahl - usedStahl, invBeton });
      }
    }
    
    if (facs.length < maxFactories) {
      const n = facs.length + 1;
      const beton = facBeton(n, factoryBase);
      
      const usedBeton = Math.min(invBeton, beton);
      const remainingBeton = beton - usedBeton;
      const goldCost = remainingBeton * priceBeton;
      
      let dt = 0;
      if (savings < goldCost) {
        if (rateHour <= 0) continue;
        dt = (goldCost - savings) / rateHour;
      }
      
      const newSavings = savings + (dt * rateHour) - goldCost;
      const nf = [...facs.map(f => ({ ...f })), { 
        level: 1, 
        item: optData?.bestProduct?.itemCode || "Neu",
        goldPerLevelPerDay: newFacGoldPerLevelDay,
        workerGoldPerDay: 0 // Assume no workers assigned yet for simulations
      }];
      const nk = sk(nf);
      
      if (!visited.has(nk)) {
        heap.push(time + dt, { facs: nf, path: [...path, {
          action: "Neue Fabrik #" + n + " (" + (optData?.bestProduct?.itemCode || "Neu") + ")", type: "buy", resType: "beton", resCost: beton, usedInv: usedBeton,
          goldCost, goldGainDay: newFacGoldPerLevelDay, dt, time: time + dt, 
          rateDay: totalGoldPerDay(nf, params), savings: newSavings,
        }], savings: newSavings, invStahl, invBeton: invBeton - usedBeton });
      }
    }
  }
  return { path: [], complete: false, iter };
}

function simulate(startFacs, params, strategy) {
  const { maxFactories, maxLevel, upgradeBase, factoryBase, optData } = params;
  const priceStahl = optData?.prices?.steel || 1.58;
  const priceBeton = optData?.prices?.concrete || 1.57;
  const newFacGoldPerLevelDay = optData?.bestProduct ? (24 * optData.bestProduct.maxGoldPerPP) : 2.5;

  let st = startFacs.map(f => ({ ...f }));
  let t = 0;
  let savings = params.startBalance || 0;
  let invStahl = params.startStahl || 0;
  let invBeton = params.startBeton || 0;
  
  const path = []; let safe = 0;
  while (safe < 300) {
    safe++;
    if (st.length >= maxFactories && st.every(f => f.level >= maxLevel)) break;
    
    const rateDay = totalGoldPerDay(st, params);
    const rateHour = rateDay / 24;
    if (rateHour <= 0 && savings <= 0 && invStahl <= 0 && invBeton <= 0) break;

    const acts = [];
    st.forEach((f, i) => {
      if (f.level >= maxLevel) return;
      const stahl = upgStahl(f.level, upgradeBase);
      const usedStahl = Math.min(invStahl, stahl);
      const goldCost = (stahl - usedStahl) * priceStahl;
      let dt = savings < goldCost ? (rateHour > 0 ? ((goldCost - savings) / rateHour) : Infinity) : 0;
      acts.push({ type: "upgrade", idx: i, resCost: stahl, resType: "stahl", usedInv: usedStahl,
        goldCost, goldGainDay: f.goldPerLevelPerDay, dt, label: "Upgrade F" + (i+1) + " (" + (f.name || f.item || "Neu") + ") L" + f.level + " -> L" + (f.level+1) });
    });
    
    if (st.length < maxFactories) {
      const n = st.length + 1;
      const beton = facBeton(n, factoryBase);
      const usedBeton = Math.min(invBeton, beton);
      const goldCost = (beton - usedBeton) * priceBeton;
      let dt = savings < goldCost ? (rateHour > 0 ? ((goldCost - savings) / rateHour) : Infinity) : 0;
      acts.push({ type: "buy", resCost: beton, resType: "beton", usedInv: usedBeton,
        goldCost, goldGainDay: newFacGoldPerLevelDay, dt, label: "Neue Fabrik #" + n + " (" + (optData?.bestProduct?.itemCode || "Neu") + ")" });
    }
    
    if (!acts.length) break;
    
    let pick;
    if (strategy === "cheapest") pick = acts.sort((a, b) => a.goldCost - b.goldCost)[0];
    else if (strategy === "upgrade_first") { 
      const u = acts.filter(a => a.type === "upgrade").sort((a,b) => (b.goldGainDay/(b.goldCost||1)) - (a.goldGainDay/(a.goldCost||1))); 
      pick = u.length ? u[0] : acts.find(a => a.type === "buy"); 
    }
    else { 
      // buy first
      const b = acts.filter(a => a.type === "buy"); 
      pick = b.length ? b[0] : acts.sort((a,b) => a.goldCost - b.goldCost)[0]; 
    }
    
    if (pick.dt === Infinity) break;
    
    t += pick.dt;
    savings = savings + (pick.dt * rateHour) - pick.goldCost;
    if (pick.type === "upgrade") invStahl -= pick.usedInv;
    if (pick.type === "buy") invBeton -= pick.usedInv;
    
    if (pick.type === "upgrade") { 
      st = st.map((f, j) => j === pick.idx ? { ...f, level: f.level + 1 } : f); 
    } else { 
      st = [...st, { 
        level: 1, 
        item: optData?.bestProduct?.itemCode || "Neu",
        goldPerLevelPerDay: newFacGoldPerLevelDay,
        workerGoldPerDay: 0 
      }]; 
    }
    
    path.push({ action: pick.label, type: pick.type, resType: pick.resType, resCost: pick.resCost, usedInv: pick.usedInv,
      goldCost: pick.goldCost, goldGainDay: pick.goldGainDay, dt: pick.dt, time: t, 
      rateDay: totalGoldPerDay(st, params), savings });
  }
  return path;
}

function buildChart(paths, startRate, keys) {
  const ev = {};
  for (const k of keys) { const p = paths[k]; if (p?.length) ev[k] = [{ time: 0, rateDay: startRate }, ...p.map(s => ({ time: s.time, rateDay: s.rateDay }))]; }
  if (!Object.keys(ev).length) return [];
  const ts = new Set([0]);
  for (const e of Object.values(ev)) for (const x of e) ts.add(x.time);
  const mx = Math.max(...ts, 1), step = Math.max(0.5, mx / 500);
  for (let t = 0; t <= mx; t += step) ts.add(Math.round(t * 10) / 10);
  return [...ts].sort((a,b) => a - b).map(t => {
    const pt = { time: Math.round(t * 100) / 100 };
    for (const [k, e] of Object.entries(ev)) { let v = startRate; for (const x of e) { if (x.time <= t) v = x.rateDay; else break; } pt[k] = Math.round(v * 100) / 100; }
    return pt;
  });
}


// ── Main ──
export default function App({ theme, setTheme, optData }) {
  setThemeVars(theme);
  const T = THEMES[theme];
  const STRATS = getStrats();
  const TH = getTH();
  const TD = getTD;

  const [mxF, setMxF] = useState(12);
  const [mxL, setMxL] = useState(7);
  const [uB, setUB] = useState(20);
  const [fB, setFB] = useState(50);
  const [facs, setFacs] = useState([{ level: 1 }]);

  const [inclW, setInclW] = useState(true);
  const [inclM, setInclM] = useState(true);
  const [inclC, setInclC] = useState(true);
  const [inclD, setInclD] = useState(true);
  const [stB, setStB] = useState(0);
  const [stStahl, setStStahl] = useState(0);
  const [stBeton, setStBeton] = useState(0);

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
  const [useApiWealth, setUseApiWealth] = useState(true);

  useEffect(() => {
    if (optData?.facs && optData.facs.length > 0) {
      setFacs(optData.facs);
      
      let nextStB = stB;
      if (useApiWealth && optData.liquidAssets !== undefined) {
         nextStB = Math.round(optData.liquidAssets * 100) / 100;
         setStB(nextStB);
      }

      compute(optData.facs, {
        maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB,
        includeWorkers: inclW, includeMissions: inclM, includeCases: inclC, includeDonations: inclD, 
        startBalance: nextStB, startStahl: stStahl, startBeton: stBeton,
        optData
      });
    }
  }, [optData, useApiWealth]);

  function compute(customFacs = null, customParams = null) {
    setBusy(true);
    const fData = customFacs || facs;
    const pData = customParams || { 
      maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB,
      includeWorkers: inclW, includeMissions: inclM, includeCases: inclC, includeDonations: inclD, 
      startBalance: stB, startStahl: stStahl, startBeton: stBeton,
      optData
    };

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

  const updF = useCallback((i, k, v) => setFacs(p => p.map((f, j) => j === i ? { ...f, [k]: v } : f)), []);
  const addF = useCallback(() => setFacs(p => [...p, { level: 1 }]), []);
  const rmF = useCallback(i => setFacs(p => p.filter((_, j) => j !== i)), []);

  const params = { 
    maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB,
    includeWorkers: inclW, includeMissions: inclM, includeCases: inclC, includeDonations: inclD, 
    startBalance: stB, startStahl: stStahl, startBeton: stBeton,
    optData
  };
  const pph = totalGoldPerDay(facs, params);

  const code = encodeState(params, facs, theme);

  function doImport() {
    const d = decodeState(impStr);
    if (!d) return;
    const p = d.params;
    setMxF(p.maxFactories); setMxL(p.maxLevel); setUB(p.upgradeBase); setFB(p.factoryBase);
    setInclW(p.includeWorkers); setInclM(p.includeMissions); setInclC(p.includeCases); setInclD(p.includeDonations); 
    setStB(p.startBalance || 0); setStStahl(p.startStahl || 0); setStBeton(p.startBeton || 0);
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

  function computeOld() {}

  const chart = res ? (() => {
    const rd = buildChart(res.paths, pph, actv);
    if (cM === "rate") return rd;
    const acc = {}; let prev = 0;
    return rd.map(d => { const dt = d.time - prev; const pt = { time: d.time }; for (const k of actv) { if (!(k in acc)) acc[k] = 0; acc[k] += (d[k]||0) * dt; pt[k] = Math.round(acc[k]); } prev = d.time; return pt; });
  })() : [];

  const curPath = res?.paths?.[tS] || [];

  return (
    <div>
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
              <Inp label="Stahl im Lager" value={stStahl} onChange={v => { setStStahl(v); compute(); }} suffix="Stk" tip="Vorrätiger Stahl im Inventar (Reduziert Goldkosten beim Upgrade)." />
              <Inp label="Beton im Lager" value={stBeton} onChange={v => { setStBeton(v); compute(); }} suffix="Stk" tip="Vorrätiger Beton im Inventar (Reduziert Goldkosten beim Fabrikkauf)." />
              <Inp label="Max. Fabriken" value={mxF} onChange={v => { setMxF(v); compute(); }} suffix="Stk" tip="Die maximale Anzahl an Fabriken, die du bauen möchtest." />
              <Inp label="Max. Level" value={mxL} onChange={v => { setMxL(v); compute(); }} suffix="Lvl" tip="Das maximale Level, das jede Fabrik erreichen soll." />
              <Inp label="Basis Upg-Kosten" value={uB} onChange={v => { setUB(v); compute(); }} suffix="Stk" tip="Basiskosten an Stahl für ein Upgrade von Level 1 auf 2." />
              <Inp label="Basis Fab-Kosten" value={fB} onChange={v => { setFB(v); compute(); }} suffix="Bt" tip="Basiskosten an Beton für die allererste Fabrik." />
            </div>
            
            <div style={{...glass(0.05, 8), padding: 8, marginTop: 16, display: "flex", flexDirection: "column", gap: 4}}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{fontSize: 11, fontWeight: "bold", color: C.textDim, textTransform: "uppercase", letterSpacing: "0.05em"}}>Reichtum Profil (API)</div>
                <label style={{display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 10, color: C.textMuted}}>
                  <input type="checkbox" checked={useApiWealth} onChange={e => setUseApiWealth(e.target.checked)} /> API Auto-Sync Startkapital
                </label>
              </div>
              <div style={{fontSize: 12, color: C.text, display: "flex", flexWrap: "wrap", gap: 10, fontFamily: F.m}}>
                <span>Gesamt: <b style={{color: C.green}}>{fmtN(optData?.totalWealth || 0)}</b></span>
                <span>Firmenwert: <b style={{color: C.accent}}>{fmtN(optData?.totalCompaniesValue || 0)}</b></span>
                <span>Liquide: <b style={{color: C.gold || "#eab308"}}>{fmtN(Math.round((optData?.liquidAssets || 0) * 100) / 100)}</b></span>
              </div>
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

          <GlassCard style={{ marginTop: 0 }}>
            <Sec icon="&#9776;">Kostenreferenz ({fmt(optData?.prices?.steel, 2)}G/Stahl, {fmt(optData?.prices?.concrete, 2)}G/Beton)</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, fontSize: 16 }}>
              <div>
                <div style={{ color: C.stahl, fontWeight: 700, fontFamily: F.h, marginBottom: 12, letterSpacing: "0.08em" }}>UPGRADES</div>
                {Array.from({ length: mxL - 1 }, (_, i) => i+1).map(l => {
                  const s = upgStahl(l, uB), goldCost = s * (optData?.prices?.steel || 1.58);
                  return <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: C.textDim }}>
                    <span style={{ width: 70, color: C.text }}>L{l} -&gt; L{l+1}</span>
                    <span style={{ color: C.stahl }}>{fmt(s, 0)} Stahl</span>
                    <span style={{ color: C.gold || "#eab308" }}>{fmt(goldCost, 0)} G</span>
                  </div>;
                })}
              </div>
              <div>
                <div style={{ color: C.betonC, fontWeight: 700, fontFamily: F.h, marginBottom: 12, letterSpacing: "0.08em" }}>FABRIKEN</div>
                {Array.from({ length: mxF }, (_, i) => i+1).map(n => {
                  const b = facBeton(n, fB), goldCost = b * (optData?.prices?.concrete || 1.57);
                  return <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: C.textDim }}>
                    <span style={{ width: 70, color: C.text }}>Fabrik #{n}</span>
                    <span style={{ color: C.betonC }}>{fmt(b, 0)} Beton</span>
                    <span style={{ color: C.gold || "#eab308" }}>{fmt(goldCost, 0)} G</span>
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

            <div style={{ ...glass(0.03, 16), borderRadius: 12, padding: "16px", minWidth: 260, flex: 1, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 150 }}>
                <Inp label="Startkapital" value={stB} onChange={v => { setStB(v); compute(); }} suffix="G" tip="Geld + Items + Ausrüstung" />
              </div>
              
              <div style={{ width: "1px", minHeight: 120, background: "rgba(255,255,255,0.05)", display: "block" }}></div>

              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontFamily: F.h, fontSize: 12, color: C.textDim, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Einnahmequellen & Simulation</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label style={{display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13}}>
                    <input type="checkbox" checked={inclW} onChange={e => { setInclW(e.target.checked); compute(null, { ...params, includeWorkers: e.target.checked }); }} /> Mitarbeiter-Gewinn
                  </label>
                  <label style={{display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13}}>
                    <input type="checkbox" checked={inclM} onChange={e => { setInclM(e.target.checked); compute(null, { ...params, includeMissions: e.target.checked }); }} /> + Missionen (10G/Tag, 30G/W)
                  </label>
                  <label style={{display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13}}>
                    <input type="checkbox" checked={inclC} onChange={e => { setInclC(e.target.checked); compute(null, { ...params, includeCases: e.target.checked }); }} /> + Kistenverkauf (1/Tag, 3/W)
                  </label>
                  <label style={{display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13}}>
                    <input type="checkbox" checked={inclD} onChange={e => { setInclD(e.target.checked); compute(null, { ...params, includeDonations: e.target.checked }); }} /> - Spenden (5G/Tag)
                  </label>
                </div>
              </div>
            </div>
          </div>
          <GlassCard style={{ padding: "16px" }}>
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={chart}>
                <defs>{STRATS.map(s => <linearGradient key={s.key} id={"g_" + s.key} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.4} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="time" stroke={C.textMuted} tick={{ fontSize: 12 }} tickFormatter={v => v >= 48 ? (v/24).toFixed(0) + "d" : Math.round(v) + "h"} />
                <YAxis stroke={C.textMuted} tick={{ fontSize: 12 }} tickFormatter={v => fmtN(v)} />
                <Tooltip contentStyle={{ ...glass(0.12, 20), borderRadius: 10, fontSize: 13, border: "none" }} labelFormatter={v => v >= 48 ? (v/24).toFixed(1) + "d" : Math.round(v*10)/10 + "h"} formatter={(v, n) => [fmt(v, 1) + " Gold/Tag", STRATS.find(s => s.key === n)?.label || n]} />
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
                        <button aria-label="Level erhöhen" onClick={() => { if (f.level < mxL) { const nf = facs.map((x, j) => j === i ? { ...x, level: x.level + 1 } : x); setFacs(nf); compute(nf); } }} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: C.text, fontSize: 10, cursor: "pointer", padding: "2px 6px", borderRadius: 4, transition: "background 0.2s" }} onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.2)"} onMouseOut={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}>&#9650;</button>
                      </Tip>
                      <Tip text="Level senken (Planungszustand)">
                        <button aria-label="Level senken" onClick={() => { if (f.level > 1) { const nf = facs.map((x, j) => j === i ? { ...x, level: x.level - 1 } : x); setFacs(nf); compute(nf); } }} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: C.text, fontSize: 10, cursor: "pointer", padding: "2px 6px", borderRadius: 4, transition: "background 0.2s" }} onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.2)"} onMouseOut={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}>&#9660;</button>
                      </Tip>
                    </div>
                  </div>
                </div>

                <div style={{ flex: 1, padding: "0 20px" }}>
                  <div style={{ fontSize: 12, color: C.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", background: "rgba(0,0,0,0.2)", padding: "4px 12px", borderRadius: 6, display: "inline-block" }}>
                    {f.name && f.name !== f.item ? <span style={{ color: C.text }}>{f.name} <span style={{color: C.textMuted}}>({f.item})</span></span> : <span>{f.item || "Neu"}</span>}
                  </div>
                </div>

                <Tip text="Fabrik aus der Planung entfernen">
                  <button aria-label="Fabrik entfernen" onClick={() => { rmF(i); compute(facs.filter((_, j) => j !== i)); }} style={{ background: "rgba(255,50,50,0.1)", border: "1px solid rgba(255,50,50,0.3)", borderRadius: "50%", color: C.red, cursor: "pointer", fontSize: 14, fontWeight: 700, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }} onMouseOver={e => { e.currentTarget.style.background = C.red; e.currentTarget.style.color = "#fff"; }} onMouseOut={e => { e.currentTarget.style.background = "rgba(255,50,50,0.1)"; e.currentTarget.style.color = C.red; }}>&times;</button>
                </Tip>
              </div>
            ))}
            <Tip text="Neue Fabrik (L1) zur Planung hinzufügen">
              <button aria-label="Neue Fabrik hinzufügen" onClick={() => { const nf = [...facs, { level: 1, item: optData?.bestProduct?.itemCode || "Neu", goldPerLevelPerDay: optData?.bestProduct ? (24 * optData.bestProduct.maxGoldPerPP) : 2.5, workerGoldPerDay: 0 }]; setFacs(nf); compute(nf); }} style={{ ...glass(0.05), borderRadius: 12, border: "2px dashed rgba(255,255,255,0.2)", color: C.textMuted, cursor: "pointer", fontSize: 24, padding: "12px", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }} onMouseOver={e => { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }} onMouseOut={e => { e.currentTarget.style.background = glass(0.05).background; e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"; e.currentTarget.style.color = C.textMuted; }}>
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
                      <th style={TH}><Tip text="Gewinn an täglicher Goldproduktion durch diesen Schritt">G/d Gewinn</Tip></th>
                    </tr></thead>
                    <tbody>
                      {res.paths.dijkstra.map((s, i) => (
                        <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={TD(false)}>{i+1}</td>
                          <td style={TD(false)}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: s.type === "buy" ? C.blue : C.green }}>{s.action}</div>
                            <div style={{ fontSize: 9, color: C.textMuted }}>
                              {fmt(s.goldCost, 0)} G 
                              {s.usedInv > 0 ? ` (+ ${fmt(s.usedInv, 0)} aus Lager)` : ` (${fmt(s.resCost, 0)} Einh.)`}
                            </div>
                          </td>
                          <td style={TD(true)}>{fmtT(s.time)}</td>
                          <td style={{ ...TD(false), color: C.green }}>+{fmt(s.goldGainDay, 1)} G</td>
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
