import { useState, useRef, useEffect, useMemo, useId } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { C, F, setThemeVars, glass, fmt, fmtT, fmtN, GlassCard, Sec, Inp, Tip, Btn, getTH, getTD, useIsMobile, useMediaQuery } from "./shared.jsx";
import { TRANSLATIONS, getLang, itemName } from "./translations.jsx";

// Hover / keyboard-focus states that inline styles cannot express
const FO_CSS = `
  .fo-row { transition: transform 0.2s, box-shadow 0.2s; }
  .fo-row:hover, .fo-row:focus-within { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.4) !important; }
  .fo-lvl:not([aria-disabled="true"]):hover, .fo-lvl:not([aria-disabled="true"]):focus-visible { background: rgba(255,255,255,0.22) !important; }
  .fo-rm:hover, .fo-rm:focus-visible { background: var(--fo-red) !important; color: #fff !important; }
  .fo-add:hover, .fo-add:focus-visible { background: rgba(255,255,255,0.1) !important; border-color: var(--accent) !important; color: var(--accent) !important; }
  .fo-card { transition: background 0.2s, border-color 0.2s, box-shadow 0.2s; }
  .fo-card:hover { background: rgba(255,255,255,0.09) !important; }
  .fo-card > .tip-wrap { flex: 1 1 auto; }
  @keyframes foSpin { to { transform: rotate(360deg); } }
  .fo-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: foSpin 0.8s linear infinite; vertical-align: -1px; }
`;
{
  let el = document.getElementById("fo-style");
  if (!el) { el = document.createElement("style"); el.id = "fo-style"; document.head.appendChild(el); }
  el.textContent = FO_CSS;
}

const STRAT_KEYS = ["dijkstra", "cheapest", "buy_first", "upgrade_first"];

function getStrats(L) {
  return [
    { key: "dijkstra", label: L.stratOptimal, color: C.accent, glow: C.accentGlow, tip: L.stratTipOptimal },
    { key: "cheapest", label: L.stratCheapest, color: C.green, glow: C.greenGlow, tip: L.stratTipCheapest },
    { key: "buy_first", label: L.stratBuyFirst, color: C.blue, glow: C.blueGlow, tip: L.stratTipBuyFirst },
    { key: "upgrade_first", label: L.stratUpgradeFirst, color: C.purple, glow: "rgba(167,139,250,0.2)", tip: L.stratTipUpgradeFirst },
  ];
}

// Internal item code for planned factories without a known product (only localized on display)
const NEW_ITEM = "Neu";
// Older codes/states may carry the translated "new" label as item
const PLACEHOLDER_ITEMS = new Set([NEW_ITEM, ...Object.values(TRANSLATIONS).map(t => t.newFac)]);

// Localized product name; placeholders become "New"
function itemLabel(code, L) { return !code || PLACEHOLDER_ITEMS.has(code) ? L.newFac : itemName(code, L); }
// A factory's own name if it has one, otherwise its localized product
function facLabel(f, L) { return f?.name && f.name !== f.item ? f.name : itemLabel(f?.item, L); }
// Plan steps carry structured data so labels follow the current language
function actionLabel(s, L) {
  return s.type === "upgrade"
    ? L.upgradeAction(s.facNo, facLabel(s.fac, L), s.from, s.to)
    : L.newFactoryAction(s.facNo, itemLabel(s.item, L));
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

// A decoded code is only usable if the core parameters and factory levels are sane numbers
function isValidState(d) {
  if (!d) return false;
  const p = d.params;
  const inRange = v => Number.isFinite(v) && v >= 1 && v <= 1000;
  return inRange(p.maxFactories) && inRange(p.maxLevel) && Number.isFinite(p.upgradeBase) && Number.isFinite(p.factoryBase)
    && d.facs.length > 0 && d.facs.every(f => inRange(f.level));
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
          facNo: i+1, fac: { name: facs[i].name, item: facs[i].item }, from: lvl, to: lvl+1,
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
        item: optData?.bestProduct?.itemCode || NEW_ITEM,
        goldPerLevelPerDay: newFacGoldPerLevelDay,
        workerGoldPerDay: 0 // Assume no workers assigned yet for simulations
      }];
      const nk = sk(nf);

      if (!visited.has(nk)) {
        heap.push(time + dt, { facs: nf, path: [...path, {
          facNo: n, item: optData?.bestProduct?.itemCode || "", type: "buy", resType: "beton", resCost: beton, usedInv: usedBeton,
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
        goldCost, goldGainDay: f.goldPerLevelPerDay, dt, desc: { facNo: i+1, fac: { name: f.name, item: f.item }, from: f.level, to: f.level+1 } });
    });

    if (st.length < maxFactories) {
      const n = st.length + 1;
      const beton = facBeton(n, factoryBase);
      const usedBeton = Math.min(invBeton, beton);
      const goldCost = (beton - usedBeton) * priceBeton;
      let dt = savings < goldCost ? (rateHour > 0 ? ((goldCost - savings) / rateHour) : Infinity) : 0;
      acts.push({ type: "buy", resCost: beton, resType: "beton", usedInv: usedBeton,
        goldCost, goldGainDay: newFacGoldPerLevelDay, dt, desc: { facNo: n, item: optData?.bestProduct?.itemCode || "" } });
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
        item: optData?.bestProduct?.itemCode || NEW_ITEM,
        goldPerLevelPerDay: newFacGoldPerLevelDay,
        workerGoldPerDay: 0
      }];
    }

    path.push({ ...pick.desc, type: pick.type, resType: pick.resType, resCost: pick.resCost, usedInv: pick.usedInv,
      goldCost: pick.goldCost, goldGainDay: pick.goldGainDay, dt: pick.dt, time: t,
      rateDay: totalGoldPerDay(st, params), savings });
  }
  return path;
}

// Runs all strategies for one input state
function computePlans(fData, pData) {
  const paths = {}, d = runDijkstra(fData, pData);
  paths.dijkstra = d.path;
  for (const k of STRAT_KEYS) { if (k !== "dijkstra") try { paths[k] = simulate(fData, pData, k); } catch { paths[k] = []; } }
  const finals = {};
  for (const k of STRAT_KEYS) { const p = paths[k]; finals[k] = p?.length ? p[p.length-1].time : null; }
  const { maxFactories, maxLevel } = pData;
  const goalReached = fData.length >= maxFactories && fData.every(f => f.level >= maxLevel);
  // Steps needed to reach the goal: one per missing level, one purchase + upgrades per missing factory
  const needed = fData.reduce((s, f) => s + Math.max(0, maxLevel - f.level), 0) + Math.max(0, maxFactories - fData.length) * Math.max(1, maxLevel);
  const done = {};
  for (const k of STRAT_KEYS) done[k] = paths[k].length > 0 && (k === "dijkstra" ? d.complete : paths[k].length === needed);
  return { paths, finals, done, goalReached, startRate: totalGoldPerDay(fData, pData), nFacs: fData.length, maxLevel, ok: d.complete, iter: d.iter };
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

// Centered message box used in place of empty charts / tables
function Notice({ icon, children, action, compact }) {
  return <div style={{ ...glass(0.04, 16), borderRadius: 12, padding: compact ? "14px 16px" : "28px 20px", marginBottom: 14, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, textAlign: "center", minHeight: compact ? 0 : 160 }}>
    {icon && <span aria-hidden="true" style={{ fontSize: compact ? 20 : 28, lineHeight: 1 }}>{icon}</span>}
    <div style={{ color: C.textDim, fontSize: 14, lineHeight: 1.5, maxWidth: 560 }}>{children}</div>
    {action}
  </div>;
}


// ── Main ──
export default function App({ theme, setTheme, optData, lang }) {
  setThemeVars(theme);
  const L = getLang(lang);
  const STRATS = getStrats(L);
  const TH = getTH();
  const TD = getTD;
  const isMobile = useIsMobile();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const advId = useId(), impErrId = useId();

  const apiFacs = optData?.facs?.length ? optData.facs : null;
  const liquid = optData?.liquidAssets;

  const [mxF, setMxF] = useState(() => Math.max(12, apiFacs?.length || 0));
  const [mxL, setMxL] = useState(7);
  const [uB, setUB] = useState(20);
  const [fB, setFB] = useState(50);
  const [facs, setFacs] = useState(() => apiFacs || [{ level: 1 }]);

  const [inclW, setInclW] = useState(true);
  const [inclM, setInclM] = useState(true);
  const [inclC, setInclC] = useState(true);
  const [inclD, setInclD] = useState(true);
  const [useApiWealth, setUseApiWealth] = useState(true);
  const [stB, setStB] = useState(() => apiFacs && liquid !== undefined ? Math.round(liquid * 100) / 100 : 0);
  const [stStahl, setStStahl] = useState(0);
  const [stBeton, setStBeton] = useState(0);

  const [actv, setActv] = useState(["dijkstra", "cheapest"]);
  const [cM, setCM] = useState("rate");
  const [tS, setTS] = useState("dijkstra");
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [impStr, setImpStr] = useState("");
  const [impErr, setImpErr] = useState(false);
  const [showImp, setShowImp] = useState(false);
  const [copied, setCopied] = useState(false);

  // optData is rebuilt on every dashboard render, so sync by content, not identity
  const facsSig = apiFacs ? JSON.stringify(apiFacs) : "";
  useEffect(() => {
    if (!apiFacs) return;
    setFacs(apiFacs);
    // many players already own more factories than the default maximum
    setMxF(m => Math.max(m, apiFacs.length));
  }, [facsSig]);

  useEffect(() => {
    if (useApiWealth && apiFacs && liquid !== undefined) setStB(Math.round(liquid * 100) / 100);
  }, [liquid, useApiWealth, !!apiFacs]);

  // Only these optData fields enter the calculation
  const optSig = JSON.stringify([optData?.prices?.steel, optData?.prices?.concrete, optData?.prices?.dailyResourceBox, optData?.bestProduct?.itemCode, optData?.bestProduct?.maxGoldPerPP]);
  const params = useMemo(() => ({
    maxFactories: mxF, maxLevel: mxL, upgradeBase: uB, factoryBase: fB,
    includeWorkers: inclW, includeMissions: inclM, includeCases: inclC, includeDonations: inclD,
    startBalance: stB, startStahl: stStahl, startBeton: stBeton,
    optData
  }), [mxF, mxL, uB, fB, inclW, inclM, inclC, inclD, stB, stStahl, stBeton, optSig]);

  // Recompute whenever inputs change; debounced so typing does not start many searches,
  // and results of outdated runs are dropped.
  const runRef = useRef(0);
  useEffect(() => {
    const run = ++runRef.current;
    setBusy(true);
    const timer = setTimeout(() => {
      if (run !== runRef.current) return;
      let out = null;
      try { out = computePlans(facs, params); } catch (e) { console.error(e); }
      if (run !== runRef.current) return;
      setRes(out);
      setBusy(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [facs, params]);

  const lvlUp = i => setFacs(p => p.map((x, j) => j === i && x.level < mxL ? { ...x, level: x.level + 1 } : x));
  const lvlDown = i => setFacs(p => p.map((x, j) => j === i && x.level > 1 ? { ...x, level: x.level - 1 } : x));
  const rmF = i => setFacs(p => p.filter((_, j) => j !== i));
  const addF = () => {
    const n = facs.length + 1;
    setFacs(p => [...p, { level: 1, item: optData?.bestProduct?.itemCode || NEW_ITEM, goldPerLevelPerDay: optData?.bestProduct ? (24 * optData.bestProduct.maxGoldPerPP) : 2.5, workerGoldPerDay: 0 }]);
    setMxF(m => Math.max(m, n));
  };
  const toggleChart = k => setActv(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k]);

  const code = encodeState(params, facs, theme);

  function doImport() {
    const d = decodeState(impStr);
    if (!isValidState(d)) { setImpErr(true); return; }
    const p = d.params;
    setMxF(Math.max(p.maxFactories, d.facs.length)); setMxL(p.maxLevel); setUB(p.upgradeBase); setFB(p.factoryBase);
    setInclW(p.includeWorkers); setInclM(p.includeMissions); setInclC(p.includeCases); setInclD(p.includeDonations);
    setStB(p.startBalance || 0); setStStahl(p.startStahl || 0); setStBeton(p.startBeton || 0);
    setFacs(d.facs);
    if (d.theme) setTheme(d.theme);
    setImpErr(false); setShowImp(false); setImpStr("");
  }

  const expRef = useRef(null);

  function doCopy() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (expRef.current) { expRef.current.classList.remove("copy-flash"); void expRef.current.offsetWidth; expRef.current.classList.add("copy-flash"); }
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {});
  }

  // "Open options" from the empty states: open the panel and focus the max-factories field
  const mxFRef = useRef(null);
  const focusMaxRef = useRef(false);
  const focusMaxFactories = () => {
    const el = mxFRef.current?.querySelector("input");
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  };
  function openAdvanced() {
    if (showAdvanced) { focusMaxFactories(); return; }
    focusMaxRef.current = true;
    setShowAdvanced(true);
  }
  useEffect(() => {
    if (showAdvanced && focusMaxRef.current) { focusMaxRef.current = false; focusMaxFactories(); }
  }, [showAdvanced]);

  const chartKeys = res ? actv.filter(k => res.paths[k]?.length) : [];
  const chart = useMemo(() => {
    if (!res || !chartKeys.length) return [];
    const rd = buildChart(res.paths, res.startRate, chartKeys);
    if (cM === "rate") return rd;
    // cumulative gold: integrate gold/day over the time axis (hours)
    const acc = {}; let prev = 0;
    return rd.map(d => { const dt = d.time - prev; const pt = { time: d.time }; for (const k of chartKeys) { if (!(k in acc)) acc[k] = 0; acc[k] += (d[k]||0) * dt / 24; pt[k] = Math.round(acc[k]); } prev = d.time; return pt; });
  }, [res, actv, cM]);

  const selStrat = STRATS.find(s => s.key === tS) || STRATS[0];
  const curPath = res?.paths?.[tS] || [];
  const anyPath = !!res && STRAT_KEYS.some(k => res.paths[k]?.length);
  const noPlanMsg = res && res.startRate <= 0 ? L.optNoPlanIncome(fmt(res.startRate, 1)) : L.optNoPlanGeneric;
  const doneFinals = res ? STRAT_KEYS.filter(k => res.done[k]).map(k => res.finals[k]) : [];
  const bestT = doneFinals.length ? Math.min(...doneFinals) : null;
  const unit = cM === "rate" ? L.optUnitGoldPerDay : L.optUnitGoldTotal;
  const steelName = itemName("steel", L), concreteName = itemName("concrete", L);
  const priceSteel = optData?.prices?.steel || 1.58, priceConcrete = optData?.prices?.concrete || 1.57;
  const dim = { opacity: busy && res ? 0.55 : 1, transition: "opacity 0.15s" };
  const thS = isMobile ? { ...TH, padding: "8px 8px", fontSize: 12 } : TH;
  const tdS = hl => isMobile ? { ...TD(hl), padding: "8px 8px", fontSize: 13 } : TD(hl);
  const cardPad = isMobile ? { padding: "14px 14px" } : undefined;
  const openOptionsBtn = <Btn onClick={openAdvanced} aria-controls={advId}>{L.optOpenOptions}</Btn>;
  const lvlBtn = disabled => ({ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: C.text, fontSize: 11, lineHeight: 1, cursor: disabled ? "default" : "pointer", width: 26, height: 20, padding: 0, borderRadius: 4, opacity: disabled ? 0.35 : 1, display: "flex", alignItems: "center", justifyContent: "center" });
  const refTh = color => ({ textAlign: "right", padding: "0 0 8px 8px", color, fontFamily: F.h, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" });
  const refTd = { textAlign: "right", padding: "3px 0 3px 8px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <Btn on={showAdvanced} onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced} aria-controls={advId}>
          {showAdvanced ? L.hideAdvanced : L.showAdvanced}
        </Btn>
      </div>

      <div id={advId}>
      {showAdvanced && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 14, marginBottom: 20 }}>
          <GlassCard style={cardPad}>
            <Sec icon="⚙️">{L.sectionParams}</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0 12px" }}>
              <Inp label={L.labelSteelInv} value={stStahl} onChange={setStStahl} suffix={L.optUnitPcs} tip={L.tipSteelInv} />
              <Inp label={L.labelConcreteInv} value={stBeton} onChange={setStBeton} suffix={L.optUnitPcs} tip={L.tipConcreteInv} />
              <div ref={mxFRef} style={{ minWidth: 0 }}>
                <Inp label={L.labelMaxFactories} value={mxF} onChange={setMxF} suffix={L.optUnitPcs} tip={L.tipMaxFactories} />
              </div>
              <Inp label={L.labelMaxLevel} value={mxL} onChange={setMxL} suffix={L.optUnitLvl} tip={L.tipMaxLevel} />
              <Inp label={L.labelUpgCost} value={uB} onChange={setUB} suffix={steelName} tip={L.tipUpgCost} />
              <Inp label={L.labelFacCost} value={fB} onChange={setFB} suffix={concreteName} tip={L.tipFacCost} />
            </div>

            <div style={{...glass(0.05, 8), padding: 10, marginTop: 16, display: "flex", flexDirection: "column", gap: 6}}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <div style={{fontSize: 12, fontWeight: "bold", color: C.textDim, textTransform: "uppercase", letterSpacing: "0.05em"}}>{L.wealthProfile}</div>
                <label style={{display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: C.textDim}}>
                  <input type="checkbox" checked={useApiWealth} onChange={e => setUseApiWealth(e.target.checked)} /> {L.apiAutoSync}
                </label>
              </div>
              <div style={{fontSize: 12, color: C.text, display: "flex", flexWrap: "wrap", gap: 10, fontFamily: F.m}}>
                <span>{L.wordTotal}: <b style={{color: C.green}}>{fmtN(optData?.totalWealth || 0)}</b></span>
                <span>{L.wordCompanyValue}: <b style={{color: C.accent}}>{fmtN(optData?.totalCompaniesValue || 0)}</b></span>
                <span>{L.wordLiquid}: <b style={{color: C.gold || "#eab308"}}>{fmtN(Math.round((optData?.liquidAssets || 0) * 100) / 100)}</b></span>
              </div>
            </div>
          </GlassCard>
          <GlassCard style={cardPad}>
            <Sec icon="📋">{L.sectionImportExport}</Sec>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <Tip text={L.tipCopyCode}>
                <Btn on={copied} onClick={doCopy}>{copied ? L.btnCopied : L.btnCopyCode}</Btn>
              </Tip>
              <Tip text={L.tipImportCode}>
                <Btn on={showImp} aria-expanded={showImp} onClick={() => { setShowImp(!showImp); setImpErr(false); }}>{L.btnImportCode}</Btn>
              </Tip>
            </div>
            {showImp && (
              <>
                <form onSubmit={e => { e.preventDefault(); doImport(); }} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <input value={impStr} onChange={e => { setImpStr(e.target.value); setImpErr(false); }} placeholder={L.codePlaceholder}
                    aria-label={L.btnImportCode} aria-invalid={impErr} aria-describedby={impErr ? impErrId : undefined}
                    style={{ background: C.inputBg, border: "1px solid " + (impErr ? C.red : C.inputBorder), borderRadius: 6, color: C.text, padding: "6px 10px", fontSize: 14, fontFamily: F.m, flex: "1 1 160px", minWidth: 0 }} />
                  <Btn type="submit" on color={C.green}>{L.btnLoad}</Btn>
                </form>
                {impErr && <div id={impErrId} role="alert" style={{ color: C.red, fontSize: 13, marginTop: 8 }}><span aria-hidden="true">⚠️ </span>{L.optImportError}</div>}
              </>
            )}
            <div ref={expRef} style={{ fontSize: 13, color: C.textMuted, wordBreak: "break-all", marginTop: 12, lineHeight: 1.4 }}>{code}</div>
          </GlassCard>

          <GlassCard style={{ marginTop: 0, ...cardPad }}>
            <Sec icon="☰">{L.costRef(fmt(priceSteel, 2), fmt(priceConcrete, 2))}</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: "16px 24px", fontSize: 13, fontFamily: F.m }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr>
                  <th scope="col" style={{ ...refTh(C.stahl), textAlign: "left", paddingLeft: 0 }}>{L.upgradesHeader}</th>
                  <th scope="col" style={refTh(C.stahl)}>{steelName}</th>
                  <th scope="col" style={refTh(C.gold || "#eab308")}>{L.optWordGold}</th>
                </tr></thead>
                <tbody>
                  {Array.from({ length: Math.min(Math.max(mxL - 1, 0), 100) }, (_, i) => i+1).map(l => {
                    const s = upgStahl(l, uB), goldCost = s * priceSteel;
                    return <tr key={l}>
                      <th scope="row" style={{ ...refTd, textAlign: "left", paddingLeft: 0, color: C.text, fontWeight: 400 }}>{L.optLvl(l)} → {L.optLvl(l+1)}</th>
                      <td style={{ ...refTd, color: C.stahl }}>{fmt(s, 0)}</td>
                      <td style={{ ...refTd, color: C.gold || "#eab308" }}>{fmt(goldCost, 0)} G</td>
                    </tr>;
                  })}
                </tbody>
              </table>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr>
                  <th scope="col" style={{ ...refTh(C.betonC), textAlign: "left", paddingLeft: 0 }}>{L.factoriesHeader}</th>
                  <th scope="col" style={refTh(C.betonC)}>{concreteName}</th>
                  <th scope="col" style={refTh(C.gold || "#eab308")}>{L.optWordGold}</th>
                </tr></thead>
                <tbody>
                  {Array.from({ length: Math.min(Math.max(mxF, 0), 100) }, (_, i) => i+1).map(n => {
                    const b = facBeton(n, fB), goldCost = b * priceConcrete;
                    return <tr key={n}>
                      <th scope="row" style={{ ...refTd, textAlign: "left", paddingLeft: 0, color: C.text, fontWeight: 400 }}>{L.optFactoryNo(n)}</th>
                      <td style={{ ...refTd, color: C.betonC }}>{fmt(b, 0)}</td>
                      <td style={{ ...refTd, color: C.gold || "#eab308" }}>{fmt(goldCost, 0)} G</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </GlassCard>
        </div>
      )}
      </div>

      {/* Main Results Display */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", columnGap: 16 }}>
          <Sec icon="📈">{L.sectionProductionCurve}</Sec>
          <div role="status" aria-live="polite" style={{ fontSize: 13, color: C.textDim, marginBottom: 16, minHeight: 18, display: "flex", alignItems: "center", gap: 8 }}>
            {busy && <><span className="fo-spin" aria-hidden="true" />{L.optComputing}</>}
          </div>
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: -8, marginBottom: 12 }}>{L.optStratHint}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 20 }}>
          <div style={{ ...dim, flex: "1 1 560px", minWidth: 0, display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 140 : 150}px, 1fr))`, gap: isMobile ? 10 : 14 }} aria-busy={busy}>
            {STRATS.map(s => {
              const on = actv.includes(s.key), sel = tS === s.key;
              const isDone = !!res?.done[s.key], t = res?.finals[s.key];
              const isBest = isDone && t === bestT;
              const sub = !res ? "" : isBest ? null : res.goalReached ? L.optGoalReachedShort : isDone ? "" : res.paths[s.key]?.length ? L.optIncompleteShort : L.optNoPlanShort;
              return (
                <div key={s.key} className="fo-card" style={{ ...glass(sel ? 0.08 : 0.03, 16), borderRadius: 12, minWidth: 0, display: "flex", flexDirection: "column",
                  border: "2px solid " + (sel ? s.color : "rgba(255,255,255,0.08)"),
                  boxShadow: sel ? "0 0 20px " + s.glow : "0 2px 8px rgba(0,0,0,0.2)" }}>
                  <Tip text={s.tip} block>
                    <button type="button" aria-pressed={sel} onClick={() => setTS(s.key)}
                      style={{ background: "none", border: 0, margin: 0, color: C.text, font: "inherit", textAlign: "left", cursor: "pointer", width: "100%", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "flex-start", borderRadius: 10, padding: isMobile ? "12px 12px 4px" : "14px 16px 4px" }}>
                      <span style={{ display: "block", fontFamily: F.h, fontSize: 12, color: s.color, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6, overflowWrap: "anywhere" }}>{s.label}</span>
                      <span style={{ display: "block", fontSize: isMobile ? 20 : 24, fontWeight: 700, fontFamily: F.h, lineHeight: 1.2 }}>{!res ? "…" : isDone ? fmtT(t) : "—"}</span>
                      <span style={{ display: "block", minHeight: 16, marginTop: 4, fontSize: 12, fontWeight: 700, color: isBest ? s.color : C.textMuted }}>
                        {isBest ? <><span aria-hidden="true">★ </span>{L.best}</> : sub}
                      </span>
                    </button>
                  </Tip>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, padding: isMobile ? "4px 12px 10px" : "4px 16px 12px", fontSize: 12, color: C.textDim, cursor: "pointer", width: "fit-content" }}>
                    <input type="checkbox" checked={on} onChange={() => toggleChart(s.key)} style={{ accentColor: s.color, margin: 0 }} />
                    {L.optShowInChart}
                  </label>
                </div>
              );
            })}
          </div>

          <div style={{ ...glass(0.03, 16), borderRadius: 12, padding: isMobile ? 14 : 16, flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: isMobile ? "column" : "row", gap: isMobile ? 14 : 24 }}>
            <div style={{ flex: isMobile ? "none" : "1 1 150px", minWidth: 0 }}>
              <Inp label={L.labelStartBalance} value={stB} onChange={setStB} suffix="G" tip={L.tipStartBalance} />
            </div>
            <div aria-hidden="true" style={isMobile ? { height: 1, background: "rgba(255,255,255,0.08)" } : { width: 1, alignSelf: "stretch", background: "rgba(255,255,255,0.08)" }} />
            <fieldset style={{ flex: isMobile ? "none" : "1 1 200px", minWidth: 0, border: 0, margin: 0, padding: 0 }}>
              <legend style={{ padding: 0, fontFamily: F.h, fontSize: 12, color: C.textDim, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>{L.incomeSources}</legend>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[[inclW, setInclW, L.inclWorkers], [inclM, setInclM, L.inclMissions], [inclC, setInclC, L.inclCases], [inclD, setInclD, L.inclDonations]].map(([val, set, label]) => (
                  <label key={label} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                    <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} /> {label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </div>

        <div style={dim} aria-busy={busy}>
          {!res ? (
            <Notice icon={busy ? null : "⚠️"}>{busy ? <><span className="fo-spin" aria-hidden="true" /> {L.optComputing}</> : L.optNoPlanGeneric}</Notice>
          ) : res.goalReached ? (
            <Notice icon="🏁" action={openOptionsBtn}>{L.optGoalReached(res.nFacs, res.maxLevel)}</Notice>
          ) : !anyPath ? (
            <Notice icon="⚠️" action={res.startRate > 0 ? openOptionsBtn : null}>{noPlanMsg}</Notice>
          ) : (
            <GlassCard style={{ padding: isMobile ? "12px 8px 8px" : 16 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, padding: isMobile ? "0 4px" : 0 }}>
                <div style={{ fontSize: 13, color: C.textDim }}>{cM === "rate" ? L.optChartCaptionRate : L.optChartCaptionCum}</div>
                <div role="group" aria-label={L.optChartMode} style={{ display: "flex", gap: 6 }}>
                  {[["rate", L.optChartModeRate], ["cum", L.optChartModeCum]].map(([m, label]) => (
                    <Btn key={m} on={cM === m} aria-pressed={cM === m} onClick={() => setCM(m)} style={{ padding: "6px 12px", fontSize: 13 }}>{label}</Btn>
                  ))}
                </div>
              </div>
              {chartKeys.length ? (
                <ResponsiveContainer width="100%" height={isMobile ? 260 : 350}>
                  <AreaChart data={chart} margin={isMobile ? { top: 5, right: 16, left: 0, bottom: 0 } : { top: 5, right: 20, left: 0, bottom: 5 }}>
                    <defs>{STRATS.map(s => <linearGradient key={s.key} id={"g_" + s.key} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.4} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="time" stroke={C.textMuted} tick={{ fontSize: 12 }} minTickGap={isMobile ? 28 : 20} interval="preserveStartEnd" tickFormatter={v => v >= 48 ? fmt(v/24, 0) + "d" : fmt(v, v < 10 ? 1 : 0) + "h"} />
                    <YAxis stroke={C.textMuted} tick={{ fontSize: 12 }} width={isMobile ? 44 : 60} tickFormatter={v => fmtN(v)} />
                    <Tooltip contentStyle={{ background: "rgba(15,20,35,0.95)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, fontSize: 13, color: C.text }} labelStyle={{ color: C.text }}
                      labelFormatter={v => v >= 48 ? fmt(v/24, 1) + "d" : fmt(v, 1) + "h"}
                      formatter={(v, n) => [fmt(v, cM === "rate" ? 1 : 0) + " " + unit, STRATS.find(s => s.key === n)?.label || n]} />
                    {STRATS.filter(s => chartKeys.includes(s.key)).map(s => <Area key={s.key} type="stepAfter" dataKey={s.key} stroke={s.color} strokeWidth={3} fill={"url(#g_" + s.key + ")"} dot={false} isAnimationActive={!reduceMotion} />)}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <Notice icon="👁️" compact>{L.optChartNoneSelected}</Notice>
              )}
            </GlassCard>
          )}
        </div>
      </div>

      {/* Side by Side */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 500px", minWidth: 0 }}>
          <Sec icon="🏭">{L.sectionYourFactories(facs.length, mxF)}</Sec>
          <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 10 : 12, marginBottom: 20 }}>
            {facs.map((f, i) => {
              const upOff = f.level >= mxL, downOff = f.level <= 1;
              return (
                <div key={i} className="fo-row" style={{ ...glass(0.08, 10), borderRadius: 12, padding: isMobile ? "10px 10px" : "12px 16px", border: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", gap: isMobile ? 8 : 16, minWidth: 0, "--fo-red": C.red }}>
                  <div style={{ fontSize: 13, color: C.accent, fontWeight: 700, letterSpacing: "0.05em", minWidth: isMobile ? 26 : 30, flexShrink: 0 }}>F{i+1}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: isMobile ? 18 : 20, fontWeight: 700, fontFamily: F.h, minWidth: 30, textAlign: "center" }}>{L.optLvl(f.level)}</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <Tip text={L.tipIncreaseLevel}>
                        <button type="button" className="fo-lvl" aria-label={L.tipIncreaseLevel} aria-disabled={upOff} onClick={() => lvlUp(i)} style={lvlBtn(upOff)}><span aria-hidden="true">▲</span></button>
                      </Tip>
                      <Tip text={L.tipDecreaseLevel}>
                        <button type="button" className="fo-lvl" aria-label={L.tipDecreaseLevel} aria-disabled={downOff} onClick={() => lvlDown(i)} style={lvlBtn(downOff)}><span aria-hidden="true">▼</span></button>
                      </Tip>
                    </div>
                  </div>

                  <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: C.textDim, background: "rgba(0,0,0,0.2)", padding: "4px 10px", borderRadius: 6, display: "inline-block", maxWidth: "100%", overflowWrap: "anywhere", lineHeight: 1.4 }}>
                      {f.name && f.name !== f.item
                        ? <><span style={{ color: C.text }}>{f.name}</span> <span style={{ color: C.textMuted }}>({itemLabel(f.item, L)})</span></>
                        : itemLabel(f.item, L)}
                    </span>
                  </div>

                  <div style={{ flexShrink: 0 }}>
                    <Tip text={L.tipRemoveFactory}>
                      <button type="button" className="fo-rm" aria-label={L.tipRemoveFactory} onClick={() => rmF(i)} style={{ background: "rgba(255,50,50,0.1)", border: "1px solid rgba(255,50,50,0.3)", borderRadius: "50%", color: C.red, cursor: "pointer", fontSize: 16, fontWeight: 700, width: 30, height: 30, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }}><span aria-hidden="true">&times;</span></button>
                    </Tip>
                  </div>
                </div>
              );
            })}
            <Tip text={L.tipAddFactory} block>
              <button type="button" className="fo-add" onClick={addF} style={{ ...glass(0.05), borderRadius: 12, border: "2px dashed rgba(255,255,255,0.2)", color: C.textDim, cursor: "pointer", fontSize: 15, fontFamily: F.h, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: 12, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.2s" }}>
                <span aria-hidden="true" style={{ fontSize: 22, lineHeight: 1 }}>+</span>{L.optAddFactory}
              </button>
            </Tip>
          </div>
        </div>

        <div style={{ flex: "1 1 400px", minWidth: 0, ...dim }} aria-busy={busy}>
          <Sec icon="📜">{L.optPlanFor(selStrat.label)}</Sec>
          {!res ? (
            <Notice compact>{busy ? <><span className="fo-spin" aria-hidden="true" /> {L.optComputing}</> : L.optNoPlanGeneric}</Notice>
          ) : res.goalReached ? (
            <Notice icon="✅" compact>{L.optPlanNoSteps}</Notice>
          ) : !curPath.length ? (
            <Notice icon="⚠️" compact>{noPlanMsg}</Notice>
          ) : (
            <>
              <div style={{ fontSize: 13, marginBottom: 10, color: res.done[tS] ? C.textDim : C.accent }}>
                {res.done[tS]
                  ? L.optPlanSummary(curPath.length, fmtT(res.finals[tS]), res.finals[tS] <= 0)
                  : <><span aria-hidden="true">⚠️ </span>{L.optPlanIncomplete}</>}
              </div>
              <GlassCard style={{ padding: "0", overflow: "hidden" }}>
                <div style={{ maxHeight: "600px", overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th scope="col" style={thS}><Tip text={L.tipStep}>{L.colStep}</Tip></th>
                      <th scope="col" style={thS}><Tip text={L.tipAction}>{L.colAction}</Tip></th>
                      <th scope="col" style={thS}><Tip text={L.tipTime}>{L.colTime}</Tip></th>
                      <th scope="col" style={thS}><Tip text={L.tipGainPerDay}>{L.colGainPerDay}</Tip></th>
                    </tr></thead>
                    <tbody>
                      {curPath.map((s, i) => (
                        <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={tdS(false)}>{i+1}</td>
                          <td style={tdS(false)}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: s.type === "buy" ? C.blue : C.green, overflowWrap: "anywhere" }}>{actionLabel(s, L)}</div>
                            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                              {fmt(s.goldCost, 0)} G{" "}
                              {s.usedInv > 0 ? L.fromInventory(fmt(s.usedInv, 0)) : `(${fmt(s.resCost, 0)} ${s.resType === "stahl" ? steelName : concreteName})`}
                            </div>
                          </td>
                          <td style={{ ...tdS(true), whiteSpace: "nowrap" }}>{fmtT(s.time)}</td>
                          <td style={{ ...tdS(false), color: C.green, whiteSpace: "nowrap" }}>+{fmt(s.goldGainDay || 0, 1)} G</td>
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

      <div style={{ textAlign: "center", fontSize: 11, color: C.textMuted, marginTop: 16, paddingBottom: 24, fontFamily: F.h, letterSpacing: "0.15em" }}>
        {L.footerText}
      </div>
    </div>
  );
}
