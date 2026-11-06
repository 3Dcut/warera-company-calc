// ═══════════════════════════════════════════════════════
//   WORKFORCE TAB ("Belegschaft") – UI only
//   Maths lives in employee-model.js / employee-optimizer.js.
// ═══════════════════════════════════════════════════════

/**
 * WorkforceTab – Tab „Belegschaft“ (final-spec §7).
 *
 * Props (the dashboard wires exactly these):
 * @param {object}   props.L                   language object from getLang(lang); all texts come from here (§8 keys)
 * @param {string}   props.theme               "grau" | "pink"; passed to setThemeVars(theme)
 * @param {Array}    props.firmsInput          firmsInput[] per §4.2:
 *                                             { id, name, itemCode, itemType, g, cap, leavers, isCore, taxPct,
 *                                               regionCountry, regionInitialCountry, storageLevel, engineLevel, disabled }
 * @param {Object}   props.employeesByCompany  { [companyId]: employee[] } – raw getMyEmployees objects, leavers included
 *                                             (the dashboard's `employees` state)
 * @param {{state:string, error:?string}} props.employeeStatus   "off" | "noKey" | "mismatch" | "empty" | "error" | "ok"
 * @param {Array}    props.events              employeeEvent.getMine result (the dashboard's `employeeEvents` state)
 * @param {{state:string, error:?string}} props.eventStatus
 * @param {?object}  props.summary             employee.getMyWorkforceSummary result, or null (not loaded / failed)
 * @param {number}   props.ppm                 PP money value (gameStat.getPpMoneyValue, else fallback)
 * @param {boolean}  props.ppmEstimated        true when ppm is the fallback value
 * @param {?object}  props.userSkills          the player's skills (optional, informational)
 * @param {number}   props.prodSkillLevel      production skill level for the energy price (M32); 0 without data
 * @param {boolean}  props.apiKeySet           a personal API key is entered
 * @param {() => Promise<void>} props.onReload reloads getMyEmployees, getMyWorkforceSummary and employeeEvent.getMine;
 *                                             should reject (throw) on failure so the tab can show wfLoadError
 * @param {boolean}  props.reloading           true while onReload runs
 * @param {() => string} props.getEmployeeStateText  the dashboard's explanation for employeeStatus ≠ ok
 *
 * Navigation from outside (B13 banner): write localStorage "warera_workforce_view" = "check" and
 * "warera_workforce_check_filter" = "fire" before switching to the tab; both are read on mount.
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { C, F, setThemeVars, glass, fmt, GlassCard, Sec, Bdg, Tip, Btn, getTH, getTD, apiCall } from "./shared.jsx";
import {
  traitList, hasTrait, formatCodeName, RULES, empQuitChance, empHappiness, isAway, hasLeft, statValue,
  empToolInfo, toolFitsGood, empWagePerHour,
} from "./employee-model.js";
import {
  OPT_DEFAULTS, buildWorkforceModel, optimizeDistribution, buildMoveSequence, evaluatePlan, adviseAll,
  trainingEV, candidateValue, minCandidate, managerROI, toolboxBalance,
} from "./employee-optimizer.js";

// ── Constants ──
const LS_SETTINGS = "warera_workforce_settings";
const LS_VIEW = "warera_workforce_view";
const LS_FILTER = "warera_workforce_check_filter";
const LS_DONE = "warera_workforce_done";
const VIEWS = ["today", "plan", "check", "tools"];
const FILTERS = ["all", "action", "train", "replace", "fire", "retireSoon", "trainToday"];
const MOBILE_PX = 700;
const MANAGER_TTL_MS = 10 * 60 * 1000;
const ORANGE = "#ff9900";
const VERDICT_ORDER = { critical: 0, fire: 1, replace: 2, train: 3, keep: 4 };
// Events whose 36-h default answer can cost the employee (§7.3).
const RISKY_DEFAULT_EVENTS = ["retirement", "poachingOffer", "unionOfOne", "strangeMoodDemand", "letterFromHomePromise"];
const R = k => (RULES && typeof RULES[k] === "number" ? RULES[k] : undefined); // B3 constants, with fallbacks
const ENERGY_PER_SESSION = R("trainingEnergy") ?? 10;

// ── Small pure helpers ──
const isNum = v => typeof v === "number" && Number.isFinite(v);
const n0 = (v, d = 0) => (isNum(v) ? v : d);
const idStr = v => (v == null ? null : String(typeof v === "object" ? v._id ?? v.id : v));
const getM = (m, k) => (m == null || k == null ? undefined : m instanceof Map ? m.get(k) ?? m.get(String(k)) : m[k]);
const median = arr => {
  const a = arr.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const h = Math.floor(a.length / 2);
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
};
const isUnauthorized = msg => /UNAUTHORIZED|FORBIDDEN|\b40[13]\b/.test(String(msg || ""));

function loadLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function saveLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function loadLSString(key, allowed, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    let v = raw;
    try { v = JSON.parse(raw); } catch {}
    return allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
}

function settingsDefaults() {
  const o = OPT_DEFAULTS || {};
  return {
    minGainPerMoveDay: n0(o.minGainPerMoveDay, 0.5),
    horizonDays: n0(o.horizonDays, 30),
    retirementPolicy: o.retirementPolicy || "convince",
    toolboxValue: n0(o.toolboxValue, 0),
    energyPrice: isNum(o.energyPrice) ? o.energyPrice : null,
    pins: [],
    locks: [],
    onlyPaybackBeforeRetire: true,
  };
}
function loadSettings() {
  const d = settingsDefaults();
  const s = loadLS(LS_SETTINGS, null);
  if (!s || typeof s !== "object") return d;
  return {
    minGainPerMoveDay: isNum(s.minGainPerMoveDay) && s.minGainPerMoveDay >= 0 ? s.minGainPerMoveDay : d.minGainPerMoveDay,
    horizonDays: [14, 30, 60].includes(s.horizonDays) ? s.horizonDays : d.horizonDays,
    retirementPolicy: s.retirementPolicy === "notNow" || s.retirementPolicy === "convince" ? s.retirementPolicy : d.retirementPolicy,
    toolboxValue: isNum(s.toolboxValue) && s.toolboxValue >= 0 ? s.toolboxValue : d.toolboxValue,
    energyPrice: isNum(s.energyPrice) && s.energyPrice >= 0 ? s.energyPrice : null,
    pins: Array.isArray(s.pins) ? s.pins.map(String) : [],
    locks: Array.isArray(s.locks) ? s.locks.map(String) : [],
    onlyPaybackBeforeRetire: typeof s.onlyPaybackBeforeRetire === "boolean" ? s.onlyPaybackBeforeRetire : d.onlyPaybackBeforeRetire,
  };
}

// djb2 hash of a string → short base36 id (key of the "done" checkboxes).
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function batchParallel(items, fn, concurrency = 2) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return out;
}

// Runs a pipeline stage; a failing (or not yet finished) engine function must not break the tab.
function safe(fn, fallback = null) {
  try {
    const v = fn();
    return { value: v === undefined ? fallback : v, error: null };
  } catch (e) {
    return { value: fallback, error: e?.message || String(e) };
  }
}

function listFrom(r) {
  if (Array.isArray(r)) return r;
  for (const k of ["items", "data", "offers", "results", "rows"]) if (Array.isArray(r?.[k])) return r[k];
  return [];
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Mean of a numeric field over completed days (today's row is still running and is left out).
function meanCompletedDays(rows, field) {
  const today = todayUTC();
  const vals = listFrom(rows).filter(r => r && r.dailyDate !== today).map(r => r[field]).filter(isNum);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

function useIsMobile() {
  const get = () => (typeof window !== "undefined" ? window.innerWidth < MOBILE_PX : false);
  const [mobile, setMobile] = useState(get);
  useEffect(() => {
    const onResize = () => setMobile(get());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
}

// Stay chance of a retirement event (M20/M21), used only when the advisor gives none.
function retireOdds(emp, policy, mgmtLevel) {
  const over = Math.max(0, n0(emp?.age) - (R("retirementAge") ?? 65));
  const h = empHappiness(emp);
  const hapMod = Math.trunc((h - 50) / 5);
  const clampP = v => Math.min(90, Math.max(5, v)) / 100;
  const perYear = R("retirementOddsPerYear") ?? 5;
  const wage = n0(empWagePerHour(emp));
  if (policy === "notNow") {
    const luck = n0(statValue(emp, "luck"));
    return { stay: clampP((R("notNowBase") ?? 70) + 2 * n0(mgmtLevel) + hapMod + 2 * luck - perYear * over), cost: 0 };
  }
  const p = clampP((R("convinceBase") ?? 65) + (hasTrait(emp, "loyal") ? R("convinceLoyalBonus") ?? 15 : 0) + 2 * n0(mgmtLevel) + hapMod - perYear * over);
  const critShare = (R("critShare") ?? 0.1) * (hasTrait(emp, "gambler") ? 2 : 1);
  return { stay: 1 - (1 - p) * critShare, cost: (R("convinceCostWageDays") ?? 0.75) * 24 * wage };
}

function rawTrainable(emp) {
  if (!emp || hasLeft(emp) || emp.companyDisabled) return false;
  if (!(n0(emp.potential) > 0)) return false;
  return n0(emp.trainingsToday) < n0(emp.trainingsPerDay, 1);
}

function retireInDays(emp) {
  if (isNum(emp?.retireInDays)) return emp.retireInDays;
  return isNum(emp?.age) ? 65 - emp.age : null;
}

// ── Module-level UI helpers (stable component identity: inputs keep focus across re-renders) ──
const linkStyleOf = () => ({ color: C.accent, cursor: "pointer", fontFamily: F.m, fontSize: 12, whiteSpace: "nowrap", background: "none", border: "none", padding: 0 });
const inputStyleOf = () => ({ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text, padding: "7px 10px", fontSize: 14, width: "100%", boxSizing: "border-box", outline: "none", fontFamily: F.m });

function GoLink({ label, onClick }) {
  return <button type="button" onClick={onClick} style={linkStyleOf()}>&rarr; {label}</button>;
}

function Field({ label, tip, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: F.m, fontSize: 13, color: C.textDim, marginBottom: 5 }}>
        {label} {tip && <Tip text={tip} wrap pos="bottom"><span style={{ color: C.textMuted, cursor: "help" }}>&#9432;</span></Tip>}
      </div>
      {children}
    </div>
  );
}

// Number input that accepts intermediate text ("0,", "") and reports only valid values ≥ 0.
function NumInput({ value, onChange, step = 0.1, placeholder, allowEmpty }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setText(prev => (Number(prev) === value && prev !== "" ? prev : value == null ? "" : String(value)));
  }, [value]);
  return (
    <input type="number" step={step} min={0} value={text} placeholder={placeholder}
      onChange={e => {
        const raw = e.target.value;
        setText(raw);
        if (raw === "") { if (allowEmpty) onChange(null); return; }
        const v = Number(raw);
        if (Number.isFinite(v) && v >= 0) onChange(v);
      }}
      style={inputStyleOf()} />
  );
}

// Expandable detail of one employee (Rechenweg, training EV, replacement, candidate check, actual values).
// Module level on purpose: a stable component type keeps the candidate form state across re-renders.
function EmpDetail({ r, ctx }) {
  const {
    L, model, opts, settings, assignment, ppm, isMobile, actualEmp, actualBlocked, loadActualEmp,
    traitChips, callL, signed, dimText, mutedText, errorLine,
  } = ctx;
  const linkStyle = linkStyleOf();
  const inputStyle = inputStyleOf();
  const TD = getTD;
  const { a, id, emp, firmId, nums: n } = r;
  const [cand, setCand] = useState({ P: "", L: "", R: "", age: "", wage: "" });
  const roster = Object.keys(assignment).filter(x => String(assignment[x]) === String(firmId));
  const others = roster.filter(x => x !== id);
  const rosterKey = roster.join(",");
  const ev = useMemo(() => safe(() => trainingEV(model, id, firmId, roster, opts)).value, [model, opts, id, firmId, rosterKey]);
  // The advice was computed in the plan's target slot — judge candidates in the same one.
  const minC = useMemo(() => (a.verdict === "replace" || a.verdict === "keep" ? safe(() => minCandidate(model, a, opts, { firmId, rosterIds: roster })).value : undefined), [model, opts, a, firmId, rosterKey]);
  const ppmNow = n0(model?.ctx?.ppm, n0(ppm));
  const basis = model?.ctx?.wageBasis === "bt" ? n0(emp?.base?.production) : n0(emp?.breakdown?.production?.total, n0(statValue(emp, "production")));
  const wage = n0(safe(() => empWagePerHour(emp)).value);
  const impliedK = basis > 0 && ppmNow > 0 ? wage / (basis / 4 * ppmNow) : null;
  const d = retireInDays(emp);
  const showRetire = isNum(d) && d <= n0(opts.advisorHorizonDays, 60);
  const odds = isNum(n.retireStayPct) ? { stay: n.retireStayPct / 100, cost: n0(n.retireCostPerEvent) } : retireOdds(emp, settings.retirementPolicy, model?.ctx?.ownerMgmtLevel);

  const candResult = useMemo(() => {
    const P = Number(cand.P), Lk = Number(cand.L), R = Number(cand.R), age = Number(cand.age), w = Number(cand.wage);
    if (![P, Lk, R, age, w].every(v => Number.isFinite(v)) || cand.P === "" || cand.age === "" || cand.wage === "" || P <= 0 || ppmNow <= 0) return null;
    const k = w / (P / 4 * ppmNow);
    const mk = (kind, potentialMax, traitPct) => ({ kind, production: P, luck: Lk, responsibility: R, age, k, wageH: w, potentialMax, traitPct });
    const val = prof => safe(() => candidateValue(model, firmId, others, prof, opts)).value?.value;
    const lo = val(mk("low", 3, -25)), mid = val(mk("mid", 6.5, 0)), hi = val(mk("high", 10, 20));
    if (![lo, mid, hi].every(isNum)) return null;
    const keep = n0(n.keepValue); // keepValue already contains trainValue (keepBase + trainValue)
    return { adv: mid - keep, lo: lo - keep, hi: hi - keep };
  }, [cand, model, opts, firmId, rosterKey, n.keepValue, ppmNow]);

  const act = actualEmp[id];
  const actMean = act?.rows ? meanCompletedDays(act.rows, "employeeProd") : null;
  const estDay = n0(emp?.estimate?.production) * 24;

  const box = { ...glass(0.04, 8), borderRadius: 8, padding: "10px 14px", marginTop: 10 };
  const h = { fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 };
  const rarityRows = (() => {
    const best = ev?.bestByRarity;
    if (!best) return [];
    const entries = Array.isArray(best) ? best.map((v, i) => [v?.rarity ?? String(i), v?.value ?? v]) : Object.entries(best);
    return entries.map(([k, v]) => [k, isNum(v) ? v : n0(v?.value), getM(ev?.weights, k)]);
  })();

  return (
    <div onClick={e => e.stopPropagation()} style={{ cursor: "default" }}>
      {isMobile && traitChips(emp)}
      <div style={box}>
        <div style={h}>{L.calcTitle}</div>
        <div style={{ ...dimText, display: "flex", flexDirection: "column", gap: 3 }}>
          <span>{L.calcOutput(fmt(n0(statValue(emp, "production")), 0), fmt(n0(emp?.productionBonus?.total), 1), fmt(n0(emp?.estimate?.production), 2))}</span>
          {impliedK != null && <span>{L.calcWage(fmt(basis, 0), fmt(ppmNow, 4), fmt(impliedK, 3), fmt(wage, 3))}</span>}
          {isNum(n.marginPerPoint) && <span>{L.calcMargin(fmt(n.marginPerPoint, 2))}</span>}
          {isNum(n.expectedDays) && <span>{L.calcLife(fmt(n0(n.marginalDay), 2), fmt(n.expectedDays, 1), fmt(n0(n.keepValue), 2))}</span>}
          {showRetire && <span>{L.calcRetire(fmt(odds.stay * 100, 0), fmt(odds.cost, 2))}</span>}
          {Array.isArray(a.reasons) && a.reasons.slice(1).map((rs, ri) => <span key={ri} style={{ color: C.textMuted }}>{callL(rs.key, rs.params)}</span>)}
        </div>
      </div>

      {rarityRows.length > 0 && (
        <div style={box}>
          <div style={h}>{L.calcTrainRarity}</div>
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {rarityRows.map(([k, v, w]) => (
                <tr key={k}>
                  <td style={{ ...TD(false), fontSize: 12, padding: "3px 12px 3px 0" }}>{formatCodeName(k)}</td>
                  <td style={{ ...TD(false), fontSize: 12, padding: "3px 12px", color: C.textMuted }}>{isNum(w) ? fmt(w, 1) + " %" : ""}</td>
                  <td style={{ ...TD(false), fontSize: 12, padding: "3px 0 3px 12px", color: v > 0 ? C.green : C.textMuted }}>{fmt(v, 2)} G</td>
                </tr>
              ))}
            </tbody>
          </table>
          {isNum(ev?.evNet) && <div style={{ ...mutedText, marginTop: 4 }}>{L.whyTrain(fmt(ev.evNet, 2))}</div>}
        </div>
      )}

      {isNum(n.replaceMid) && (
        <div style={box}>
          <div style={h}>{L.colReplaceAdv}</div>
          <Tip text={L.rangeTip} wrap>
            <span style={{ ...dimText, cursor: "help" }}>{L.rangeLine(fmt(n.replaceMid, 2), fmt(n0(n.replaceLow), 2), fmt(n0(n.replaceHigh), 2))} &#9432;</span>
          </Tip>
          {isNum(n.replaceAdvantage) && <div style={{ ...mutedText, marginTop: 4 }}>{L.whyReplace(fmt(n.replaceAdvantage, 2))}</div>}
        </div>
      )}

      {minC !== undefined && (
        <div style={box}>
          <div style={h}>{L.minCandTitle}</div>
          <div style={dimText}>{minC ? L.minCand(emp?.name || id, fmt(n0(minC.production), 0), fmt(n0(minC.maxAge), 0), fmt(n0(minC.maxWageH), 3)) : L.minCandNone}</div>
          <div style={{ ...mutedText, marginTop: 4 }}>{L.minCandHow}</div>
        </div>
      )}

      <div style={box}>
        <div style={h}>{L.candCheckTitle}</div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, minmax(70px, 1fr))", gap: 8 }}>
          {[["P", L.candP], ["L", L.candL], ["R", L.candR], ["age", L.candAge], ["wage", L.candWage]].map(([k, label]) => (
            <div key={k}>
              <div style={mutedText}>{label}</div>
              <input type="number" min={0} step={k === "wage" ? 0.001 : 1} value={cand[k]} onChange={e => { const v = e.target.value; setCand(c => ({ ...c, [k]: v })); }} style={inputStyle} />
            </div>
          ))}
        </div>
        {candResult && (
          <div style={{ ...dimText, marginTop: 8, color: candResult.adv > 0 ? C.green : C.red, fontWeight: 700 }}>
            {L.candCheckResult(signed(candResult.adv), signed(candResult.lo), signed(candResult.hi))}
          </div>
        )}
      </div>

      {!actualBlocked ? (
        <div style={box}>
          <button type="button" onClick={() => loadActualEmp(id)} disabled={!!act?.loading} style={linkStyle}>&#128202; {L.actualLink}</button>
          {act?.loading && <span style={{ ...mutedText, marginLeft: 8 }}>{L.loadingGeneric}</span>}
          {act?.error && errorLine(act.error)}
          {act?.rows && actMean != null && estDay > 0 && (
            <div style={{ ...dimText, marginTop: 6 }}>{L.actualCompare(fmt(actMean, 1), fmt(estDay, 1), signed((actMean / estDay - 1) * 100, 1))}</div>
          )}
        </div>
      ) : (
        <div style={{ ...box, ...mutedText }}>{L.actualUnavailable}</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
export default function WorkforceTab({
  L, theme, firmsInput, employeesByCompany, employeeStatus, events, eventStatus, summary, ppm, ppmEstimated,
  userSkills, prodSkillLevel, apiKeySet, onReload, reloading, getEmployeeStateText,
}) {
  if (theme) setThemeVars(theme);
  const isMobile = useIsMobile();
  const TH = getTH();
  const TD = getTD;

  const [view, setViewState] = useState(() => loadLSString(LS_VIEW, VIEWS, "today"));
  const [filter, setFilterState] = useState(() => loadLSString(LS_FILTER, FILTERS, "all"));
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showTraining, setShowTraining] = useState(false);
  const [expandedEmp, setExpandedEmp] = useState(null);
  const [sort, setSort] = useState({ key: "verdict", dir: 1 });
  const [showBeforeAfter, setShowBeforeAfter] = useState(false);
  const [reloadError, setReloadError] = useState(null);
  const [doneState, setDoneState] = useState(() => loadLS(LS_DONE, { hash: null, done: [] }));

  // On-demand data
  const managerCache = useRef(null); // { ts, data }
  const [mgr, setMgr] = useState(null);
  const [mgrLoading, setMgrLoading] = useState(false);
  const [mgrRateInput, setMgrRateInput] = useState(null);
  const [actualBlocked, setActualBlocked] = useState(false);
  const [actualEmp, setActualEmp] = useState({});     // empId -> { loading, rows, error }
  const [actualAll, setActualAll] = useState(null);   // { loading, done, total, results: {firmId: {rows, error}} }

  const setView = v => { setViewState(v); saveLS(LS_VIEW, v); };
  const setFilter = f => { setFilterState(f); saveLS(LS_FILTER, f); };
  const updateSettings = patch => setSettings(prev => {
    const next = { ...prev, ...patch };
    saveLS(LS_SETTINGS, next);
    return next;
  });
  const resetSettings = () => { const d = settingsDefaults(); saveLS(LS_SETTINGS, d); setSettings(d); };
  const togglePin = id => updateSettings({ pins: settings.pins.includes(id) ? settings.pins.filter(x => x !== id) : [...settings.pins, id] });
  const toggleLock = id => updateSettings({ locks: settings.locks.includes(id) ? settings.locks.filter(x => x !== id) : [...settings.locks, id] });

  const empOk = employeeStatus?.state === "ok";
  const firms = Array.isArray(firmsInput) ? firmsInput : [];

  // ── Index of raw data (names, current firm) independent of the engine ──
  const index = useMemo(() => {
    const firmById = new Map();
    for (const f of firms) firmById.set(String(f.id), f);
    const empById = new Map();       // id -> { emp, firmId }
    const activeByFirm = new Map();  // firmId -> [empId] (without leavers)
    const leaversByFirm = new Map();
    for (const f of firms) { activeByFirm.set(String(f.id), []); leaversByFirm.set(String(f.id), 0); }
    for (const [cid, list] of Object.entries(employeesByCompany || {})) {
      for (const emp of Array.isArray(list) ? list : []) {
        if (!emp || typeof emp !== "object") continue;
        const id = idStr(emp._id);
        if (!id) continue;
        const firmId = String(cid);
        empById.set(id, { emp, firmId });
        if (hasLeft(emp)) leaversByFirm.set(firmId, (leaversByFirm.get(firmId) || 0) + 1);
        else {
          if (!activeByFirm.has(firmId)) activeByFirm.set(firmId, []);
          activeByFirm.get(firmId).push(id);
        }
      }
    }
    return { firmById, empById, activeByFirm, leaversByFirm };
  }, [firms, employeesByCompany]);

  const firmKey = useMemo(() => firms.map(f => String(f.id)).sort().join(","), [firms]);
  // A different player (other firms) clears all session caches (§6).
  useEffect(() => {
    managerCache.current = null;
    setMgr(null); setMgrRateInput(null); setActualBlocked(false); setActualEmp({}); setActualAll(null);
  }, [firmKey]);

  // Point in time of the loaded data; the whole pipeline uses it instead of the wall clock.
  const nowMs = useMemo(() => Date.now(), [employeesByCompany, events, summary]);

  const opts = useMemo(() => ({
    ...(OPT_DEFAULTS || {}),
    horizonDays: settings.horizonDays,
    minGainPerMoveDay: settings.minGainPerMoveDay,
    retirementPolicy: settings.retirementPolicy,
    toolboxValue: settings.toolboxValue,
    energyPrice: settings.energyPrice,
    onlyPaybackBeforeRetire: settings.onlyPaybackBeforeRetire,
    pinnedEmpIds: settings.pins,
    lockedFirmIds: settings.locks,
    events: eventStatus?.state === "ok" && Array.isArray(events) ? events : [],
    nowMs,
  }), [settings, events, eventStatus, nowMs]);

  // ── Pipeline (§4.4) ──
  const modelRes = useMemo(() => {
    if (!empOk) return { value: null, error: null };
    return safe(() => buildWorkforceModel({
      firmsInput: firms, employeesByCompany: employeesByCompany || {}, ppm, prodSkillLevel: n0(prodSkillLevel), nowMs,
      events: opts.events,
      settings: { ...settings, pinnedEmpIds: settings.pins, lockedFirmIds: settings.locks },
    }));
  }, [empOk, firms, employeesByCompany, ppm, prodSkillLevel, nowMs, settings, opts.events]);
  const model = modelRes.value;

  const distRes = useMemo(() => (model ? safe(() => optimizeDistribution(model, opts)) : { value: null, error: null }), [model, opts]);
  const dist = distRes.value;
  const assignment = useMemo(() => {
    const cur = {};
    for (const [id, { emp, firmId }] of index.empById) if (!hasLeft(emp)) cur[id] = firmId;
    const base = model?.current && typeof model.current === "object" ? { ...cur, ...model.current } : cur;
    return dist?.assignment && typeof dist.assignment === "object" ? { ...base, ...dist.assignment } : base;
  }, [dist, model, index]);
  const currentAssign = useMemo(() => {
    const cur = {};
    for (const [id, { emp, firmId }] of index.empById) if (!hasLeft(emp)) cur[id] = firmId;
    return model?.current && typeof model.current === "object" ? { ...cur, ...model.current } : cur;
  }, [model, index]);

  const stepsRes = useMemo(() => (model && dist ? safe(() => buildMoveSequence(model, assignment), []) : { value: [], error: null }), [model, dist, assignment]);
  const steps = Array.isArray(stepsRes.value) ? stepsRes.value.filter(Boolean) : [];
  const evalRes = useMemo(() => (model && dist ? safe(() => evaluatePlan(model, assignment, opts)) : { value: null, error: null }), [model, dist, assignment, opts]);
  const planEval = evalRes.value;
  const adviceRes = useMemo(() => (model ? safe(() => adviseAll(model, assignment, opts), []) : { value: [], error: null }), [model, assignment, opts]);
  const advice = Array.isArray(adviceRes.value) ? adviceRes.value.filter(a => a && a.empId != null) : [];
  const adviceById = useMemo(() => {
    const m = new Map();
    for (const a of advice) m.set(String(a.empId), a);
    return m;
  }, [advice]);
  const toolBal = useMemo(() => (model ? safe(() => toolboxBalance(summary, model)).value : null), [model, summary]);
  const calcError = modelRes.error || distRes.error || stepsRes.error || evalRes.error || adviceRes.error;

  // ── Lookup helpers for rendering ──
  const empName = id => {
    const e = index.empById.get(String(id))?.emp;
    return e?.name || getM(model?.emps, String(id))?.name || String(id ?? "?");
  };
  const nameOf = v => (v != null && index.empById.has(String(v)) ? empName(v) : v == null ? "?" : String(v));
  const firmOf = id => index.firmById.get(String(id));
  const firmLabel = id => {
    const f = firmOf(id);
    return f ? `${f.name || f.itemCode || f.id} (${f.itemCode || "?"})` : String(id ?? "?");
  };
  const rawEmp = id => index.empById.get(String(id))?.emp || null;
  const g2 = v => fmt(n0(v), 2);
  const signed = (v, d = 2) => (n0(v) > 0 ? "+" : "") + fmt(n0(v), d);
  const fmtParam = v => {
    if (isNum(v)) return v > 1e11 ? new Date(v).toLocaleString() : fmt(v, Math.abs(v) >= 100 ? 0 : 2);
    if (v != null && index.empById.has(String(v))) return empName(v);
    return v == null ? "?" : String(v);
  };
  const callL = (key, params) => {
    const t = L[key];
    if (typeof t === "function") {
      const list = Array.isArray(params) ? params : params && typeof params === "object" ? Object.values(params) : params != null ? [params] : [];
      return t(...list.map(fmtParam));
    }
    return typeof t === "string" ? t : formatCodeName(key);
  };
  const paybackText = d => (!isNum(d) || d === Infinity ? L.paybackNever : d <= 0 ? L.paybackNow : L.paybackDaysFmt(fmt(d, 1)));
  const energyPrice = isNum(settings.energyPrice) ? settings.energyPrice : n0(model?.ctx?.energyPrice, null);

  const badgeInfo = (b, emp) => {
    const code = typeof b === "string" ? b : b?.code;
    switch (code) {
      case "retireSoon": return { text: L.bRetire(fmt(n0(b?.params?.days ?? retireInDays(emp)), 0)), color: C.accent };
      case "climber": return { text: L.bClimber, color: ORANGE };
      case "paused": return { text: L.bPaused, color: C.textDim };
      case "toolBroken": return { text: L.bToolBroken, color: ORANGE };
      case "toolMismatch": return { text: L.bToolMismatch, color: ORANGE };
      case "loss": return { text: L.bLoss, color: C.red };
      case "trainToday": return { text: L.bTrainToday, color: C.blue };
      case "uncertain": return { text: L.bUncertain, color: C.purple };
      default: return code ? { text: formatCodeName(code), color: C.textDim } : null;
    }
  };
  const hasBadge = (a, code) => (Array.isArray(a?.badges) ? a.badges : []).some(b => (typeof b === "string" ? b : b?.code) === code);
  const verdictInfo = v => ({
    critical: { text: L.vCritical, color: C.red },
    fire: { text: L.vFire, color: C.red },
    replace: { text: L.vReplace, color: ORANGE },
    train: { text: L.vTrain, color: C.blue },
    keep: { text: L.vKeep, color: C.green },
  }[v] || { text: v ? formatCodeName(v) : "-", color: C.textDim });

  const warnText = w => {
    const p = w?.params ?? {};
    const a = Array.isArray(p) ? p.map(fmtParam) : null;
    switch (w?.code) {
      case "creatureOfHabit": return a ? L.warnCreature(...a) : L.warnCreature(g2(p.loss));
      case "specLoss": return a ? L.warnSpec(...a) : L.warnSpec(nameOf(p.empId ?? p.name), p.good, fmt(n0(p.pct), 0), p.good2);
      case "pairSplit": return a ? L.warnPair(...a) : L.warnPair(nameOf(p.a ?? p.empId), nameOf(p.b ?? p.withEmpId ?? p.partnerId));
      case "nemesisJoin": return a ? L.warnNemesis(...a) : L.warnNemesis(nameOf(p.a ?? p.empId), nameOf(p.b ?? p.withEmpId ?? p.nemesisId));
      case "toolReturned": return a ? L.warnTool(...a) : L.warnTool(p.tool, fmt(n0(p.pct), 0), p.good);
      case "veteranReset": return L.warnVeteran;
      case "loneEngine": return L.warnEngine;
      case "disabledTarget": return L.warnDisabled;
      case "coworkerLoss": return a ? L.warnCoworker(...a) : L.warnCoworker(nameOf(p.empId ?? p.name), signed(p.g));
      default: return formatCodeName(w?.code || "?");
    }
  };

  // ── Derived lists ──
  const activeIds = useMemo(() => [...index.empById.entries()].filter(([, v]) => !hasLeft(v.emp)).map(([id]) => id), [index]);
  const rosterOf = (asg, firmId) => Object.keys(asg).filter(id => String(asg[id]) === String(firmId));

  const pendingEvents = useMemo(() => {
    if (eventStatus?.state !== "ok" || !Array.isArray(events)) return [];
    const out = [];
    for (const ev of events) {
      if (!ev || ev.status !== "pending") continue;
      const firmId = idStr(ev?.cast?.[0]?.company);
      if (!firmId || !index.firmById.has(firmId)) continue;
      const expires = Date.parse(ev.expiresAt);
      out.push({ ev, firmId, hoursLeft: Number.isFinite(expires) ? (expires - nowMs) / 3600000 : null });
    }
    return out.sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity));
  }, [events, eventStatus, index, nowMs]);

  const quitList = activeIds.map(id => ({ id, q: empQuitChance(rawEmp(id)) })).filter(x => x.q > 0).sort((a, b) => b.q - a.q);
  const retireList = activeIds.filter(id => { const d = retireInDays(rawEmp(id)); return isNum(d) && d <= 3; });
  const isTrainable = id => {
    const a = adviceById.get(String(id));
    return a ? hasBadge(a, "trainToday") || (a.verdict === "train" && rawTrainable(rawEmp(id))) : rawTrainable(rawEmp(id));
  };
  const trainableIds = activeIds.filter(isTrainable);
  const toolIssueIds = activeIds.filter(id => {
    const a = adviceById.get(String(id));
    if (a && (hasBadge(a, "toolBroken") || hasBadge(a, "toolMismatch"))) return true;
    const emp = rawEmp(id);
    const tool = safe(() => empToolInfo(emp)).value;
    const firm = firmOf(index.empById.get(id)?.firmId);
    return !!tool && (tool.broken || (firm?.itemCode && safe(() => toolFitsGood(tool, firm.itemCode), true).value === false));
  });

  const moveSteps = steps.filter(s => s.kind === "move");
  const swapSteps = steps.filter(s => s.kind === "swap");
  const movedCount = new Set(steps.filter(s => s.kind !== "confirmLeaver").flatMap(s => [s.empId, s.withEmpId].filter(x => x != null).map(String))).size;
  const planDailyGain = n0(planEval?.dailyGain, steps.reduce((s, x) => s + n0(x.gainDay), 0));
  const planOptimal = steps.length === 0 || planDailyGain < settings.minGainPerMoveDay * Math.max(1, movedCount);
  const bestBelow = (() => {
    const b = dist?.bestBelow;
    if (b && b.empId != null) return { empId: b.empId, toId: b.toId ?? b.firmId, gainDay: b.gainDay };
    if (!steps.length) return null;
    const top = [...steps].filter(s => s.kind !== "confirmLeaver").sort((x, y) => n0(y.gainDay) - n0(x.gainDay))[0];
    return top && n0(top.gainDay) > 0 ? { empId: top.empId, toId: top.toId, gainDay: top.gainDay } : null;
  })();
  const uncertainPinned = (Array.isArray(dist?.pinnedIds) ? dist.pinnedIds : []).map(String).filter(id => !settings.pins.includes(id));
  const timeBudgetHit = !!dist && (dist.timedOut === true || (isNum(dist.ms) && dist.ms >= n0(opts.timeBudgetMs, Infinity)));

  // Done checkboxes are bound to this exact plan.
  const planHash = useMemo(() => hashStr(JSON.stringify(Object.keys(assignment).sort().map(k => [k, String(assignment[k])]))
    + "|" + steps.map(s => `${s.n}:${s.empId}:${s.toId}`).join(",")), [assignment, steps]);
  const doneSet = new Set(doneState.hash === planHash && Array.isArray(doneState.done) ? doneState.done : []);
  const toggleDone = n => {
    const next = new Set(doneSet);
    if (next.has(n)) next.delete(n); else next.add(n);
    const st = { hash: planHash, done: [...next] };
    setDoneState(st); saveLS(LS_DONE, st);
  };

  // Rows of the employee check (computed before any early return: hook order must stay fixed).
  const checkRows = useMemo(() => advice.map(a => {
    const id = String(a.empId);
    const emp = rawEmp(id);
    const firmId = assignment[id] ?? index.empById.get(id)?.firmId;
    return { a, id, emp, firmId, nums: a.numbers || {} };
  }), [advice, assignment, index]);
  const filterCounts = { all: checkRows.length, action: 0, train: 0, replace: 0, fire: 0, retireSoon: 0, trainToday: 0 };
  for (const r of checkRows) {
    if (["critical", "fire", "replace"].includes(r.a.verdict)) filterCounts.action++;
    if (r.a.verdict === "train") filterCounts.train++;
    if (r.a.verdict === "replace") filterCounts.replace++;
    if (r.a.verdict === "fire") filterCounts.fire++;
    const d = retireInDays(r.emp);
    if (hasBadge(r.a, "retireSoon") || (isNum(d) && d <= 7)) filterCounts.retireSoon++;
    if (isTrainable(r.id)) filterCounts.trainToday++;
  }

  // ── KPIs (§7.2) ──
  const kpi = useMemo(() => {
    const capSum = firms.reduce((s, f) => s + n0(f.cap), 0);
    const gByItem = {};
    for (const f of firms) if (f.itemCode && isNum(f.g) && gByItem[f.itemCode] == null) gByItem[f.itemCode] = f.g;
    let ownProd = 0, ownValue = 0, ownWage = 0;
    for (const id of activeIds) {
      const { emp, firmId } = index.empById.get(id);
      const pph = isAway(emp) ? 0 : n0(emp?.estimate?.production);
      ownProd += pph;
      ownValue += pph * n0(firmOf(firmId)?.g);
      ownWage += n0(safe(() => empWagePerHour(emp)).value);
    }
    const s = summary && typeof summary === "object" ? summary : null;
    const prodH = isNum(s?.production) ? s.production : ownProd;
    const valueH = s?.productionByItem && typeof s.productionByItem === "object"
      ? Object.entries(s.productionByItem).reduce((sum, [item, pph]) => sum + n0(pph) * n0(gByItem[item]), 0)
      : ownValue;
    const wageH = isNum(s?.wageCost) ? s.wageCost + n0(s.managerCost) : ownWage;
    let mW = 0, mS = 0;
    for (const a of advice) {
      const m = a?.numbers?.marginPerPoint;
      if (!isNum(m)) continue;
      const w = Math.max(1, n0(statValue(rawEmp(a.empId), "production"), 1));
      mW += w; mS += w * m;
    }
    return {
      employees: isNum(s?.employeeCount) ? s.employeeCount : activeIds.length,
      capSum,
      prodDay: prodH * 24,
      valueDay: valueH * 24,
      wageDay: wageH * 24,
      netDay: (valueH - wageH) * 24,
      marginAvg: mW > 0 ? mS / mW : null,
      toolboxesDay: isNum(s?.toolboxesPerHour) ? s.toolboxesPerHour * 24 : null,
      claimable: n0(s?.foundToolboxes),
      trainable: isNum(s?.trainableCount) ? s.trainableCount : trainableIds.length,
    };
  }, [firms, activeIds, index, summary, advice, trainableIds.length]);

  // ── Actions ──
  async function handleReload() {
    if (typeof onReload !== "function") return;
    setReloadError(null);
    try { await onReload(); } catch (e) { setReloadError(e?.message || String(e)); }
  }

  function goTo(v, f, training) {
    setView(v);
    if (f) setFilter(f);
    if (training != null) setShowTraining(training);
  }

  async function calcManagers() {
    const cached = managerCache.current;
    if (cached && Date.now() - cached.ts < MANAGER_TTL_MS) { setMgr(cached.data); return; }
    setMgrLoading(true);
    const withEmps = firms.filter(f => (index.activeByFirm.get(String(f.id)) || []).length > 0);
    const pointsP = batchParallel(withEmps, async f => {
      try {
        const r = await apiCall("employee.getManagerPointValue", { companyId: f.id });
        return [String(f.id), { ppp: isNum(r?.productionPerPoint) ? r.productionPerPoint : null }];
      } catch (e) { return [String(f.id), { error: e?.message || "ERROR" }]; }
    }, 2);
    const offersP = apiCall("managerOffer.getManyPaginated", { limit: 50 }).then(r => ({ list: listFrom(r) }), e => ({ error: e?.message || "ERROR" }));
    const statsP = apiCall("managerOffer.getWageStats").then(r => ({ stats: r }), e => ({ error: e?.message || "ERROR" }));
    try {
      const [points, offers, stats] = await Promise.all([pointsP, offersP, statsP]);
      const data = {
        points: Object.fromEntries(points),
        medianRate: offers.list ? median(offers.list.map(o => o?.rateManagement)) : null,
        offersError: offers.error || null,
        wageStats: stats.stats || null,
        wageStatsError: stats.error || null,
      };
      managerCache.current = { ts: Date.now(), data };
      setMgr(data);
    } finally {
      setMgrLoading(false);
    }
  }

  async function loadActualEmp(empId) {
    if (actualBlocked || actualEmp[empId]?.rows || actualEmp[empId]?.loading) return;
    setActualEmp(prev => ({ ...prev, [empId]: { loading: true } }));
    try {
      const rows = await apiCall("work.getStatsByEmployee", { employeeId: empId, days: 7 });
      setActualEmp(prev => ({ ...prev, [empId]: { rows: listFrom(rows) } }));
    } catch (e) {
      if (isUnauthorized(e?.message)) setActualBlocked(true);
      setActualEmp(prev => ({ ...prev, [empId]: { error: e?.message || "ERROR" } }));
    }
  }

  async function loadActualAll() {
    if (actualBlocked || actualAll?.loading) return;
    const withEmps = firms.filter(f => (index.activeByFirm.get(String(f.id)) || []).length > 0);
    const results = { ...(actualAll?.results || {}) };
    const todo = withEmps.filter(f => !results[String(f.id)]?.rows);
    let done = withEmps.length - todo.length;
    setActualAll({ loading: true, done, total: withEmps.length, results });
    let blocked = false;
    await batchParallel(todo, async f => {
      if (blocked) return;
      try {
        const rows = await apiCall("work.getStatsByCompany", { companyId: f.id, days: 7 });
        results[String(f.id)] = { rows: listFrom(rows) };
      } catch (e) {
        if (isUnauthorized(e?.message)) blocked = true;
        results[String(f.id)] = { error: e?.message || "ERROR" };
      }
      done++;
      setActualAll({ loading: true, done, total: withEmps.length, results: { ...results } });
    }, 2);
    if (blocked) setActualBlocked(true);
    setActualAll({ loading: false, done, total: withEmps.length, results: { ...results } });
  }

  // ── Shared UI bits ──
  const dimText = { fontSize: 12, color: C.textDim, fontFamily: F.m, lineHeight: 1.5 };
  const mutedText = { fontSize: 11, color: C.textMuted, fontFamily: F.m, lineHeight: 1.5 };
  const linkStyle = linkStyleOf();
  const greenBox = text => (
    <div style={{ padding: 16, textAlign: "center", color: C.green, background: "rgba(0,255,0,0.05)", borderRadius: 8, border: "1px solid " + C.green + "44", fontFamily: F.m, fontSize: 13 }}>{text}</div>
  );
  const errorLine = text => <div style={{ fontSize: 12, color: C.red, fontFamily: F.m, marginTop: 6 }}>{text}</div>;

  const traitChips = emp => {
    const traits = safe(() => traitList(emp), []).value || [];
    if (!traits.length) return null;
    const pbC = Array.isArray(emp?.productionBonus?.contributions) ? emp.productionBonus.contributions : [];
    const stC = Array.isArray(emp?.breakdown?.production?.contributions) ? emp.breakdown.production.contributions : [];
    const hpC = Array.isArray(emp?.happinessBreakdown?.contributions) ? emp.happinessBreakdown.contributions : [];
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
        {traits.map((t, i) => {
          const parts = [];
          const pct = pbC.filter(c => c?.source === t.code).reduce((s, c) => s + n0(c.percent), 0);
          if (pct) parts.push(`${signed(pct, 1)} %`);
          const flat = stC.filter(c => c?.code === t.code && !c.percent).reduce((s, c) => s + n0(c.delta), 0);
          if (flat) parts.push(`${signed(flat, 0)} ${L.candP}`);
          const hap = hpC.filter(c => c?.reason === "trait" && (c.code === t.code || c.traitCode === t.code || c.eventCode === t.code)).reduce((s, c) => s + n0(c.delta), 0);
          if (hap) parts.push(`${signed(hap, 0)} ${L.colHappiness}`);
          const arg = t.arg != null ? ` (${nameOf(t.arg)})` : "";
          const tip = formatCodeName(t.code) + arg + (parts.length ? ": " + parts.join(" · ") : "");
          return (
            <Tip key={t.code + i} text={tip} wrap>
              <span style={{ fontSize: 10, fontFamily: F.m, color: C.textDim, padding: "1px 6px", borderRadius: 4, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", whiteSpace: "nowrap" }}>
                {formatCodeName(t.code)}
              </span>
            </Tip>
          );
        })}
      </div>
    );
  };

  const detailCtx = {
    L, model, opts, settings, assignment, ppm, isMobile, actualEmp, actualBlocked, loadActualEmp,
    traitChips, callL, signed, dimText, mutedText, errorLine,
  };

  // ═════════ Explanation card when employee data is not usable (§7.1) ═════════
  if (!empOk) {
    const state = employeeStatus?.state;
    const extra = state === "mismatch" ? L.wfOwnOnly : (state === "noKey" || !apiKeySet) ? L.wfNeedKey : null;
    return (
      <GlassCard style={{ borderColor: C.accent + "44" }}>
        <Sec icon="&#128101;">{L.tabWorkforce}</Sec>
        <div style={dimText}>{typeof getEmployeeStateText === "function" ? getEmployeeStateText() : ""}</div>
        {extra && <div style={{ ...dimText, marginTop: 8, color: C.accent }}>{extra}</div>}
      </GlassCard>
    );
  }

  // ═════════ Header, KPIs, segments ═════════
  const header = (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: F.h, fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          <span dangerouslySetInnerHTML={{ __html: "&#128101;" }} /> {L.tabWorkforce}
        </span>
        {ppmEstimated && <Bdg color={ORANGE}>{L.ppmEstimated}</Bdg>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Tip text={L.wfReloadTip} wrap pos="bottom">
          <Btn on color={C.accent} onClick={handleReload} disabled={!!reloading}>&#8635; {reloading ? L.loadingGeneric : L.wfReload}</Btn>
        </Tip>
        <Btn on={showSettings} color={C.blue} onClick={() => setShowSettings(s => !s)}>&#9881; {L.wfSettings}</Btn>
      </div>
      {showSettings && settingsPopover()}
    </div>
  );

  function settingsPopover() {
    const autoEnergy = n0(model?.ctx?.energyPrice, null);
    return (
      <div style={{ ...glass(0.1, 24), position: "absolute", top: "100%", right: 0, zIndex: 50, marginTop: 8, borderRadius: 12, padding: "16px 18px",
        width: "min(440px, calc(100vw - 32px))", maxHeight: "75vh", overflowY: "auto", background: "rgba(15,20,35,0.96)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontFamily: F.h, fontSize: 15, fontWeight: 700, color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>&#9881; {L.wfSettings}</span>
          <button type="button" onClick={() => setShowSettings(false)} style={{ ...linkStyle, fontSize: 18, color: C.textDim }}>&times;</button>
        </div>
        <Field label={L.setMinGain} tip={L.setMinGainTip}>
          <NumInput value={settings.minGainPerMoveDay} step={0.1} onChange={v => updateSettings({ minGainPerMoveDay: v })} />
        </Field>
        <Field label={L.setHorizon}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[14, 30, 60].map(d => <Btn key={d} on={settings.horizonDays === d} onClick={() => updateSettings({ horizonDays: d })}>{L.setHorizonDays(d)}</Btn>)}
          </div>
        </Field>
        <Field label={L.setPolicy} tip={L.setPolicyTip}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Btn on={settings.retirementPolicy === "convince"} onClick={() => updateSettings({ retirementPolicy: "convince" })}>{L.setPolicyConvince}</Btn>
            <Btn on={settings.retirementPolicy === "notNow"} onClick={() => updateSettings({ retirementPolicy: "notNow" })}>{L.setPolicyNotNow}</Btn>
          </div>
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, cursor: "pointer", ...dimText }}>
          <input type="checkbox" checked={settings.onlyPaybackBeforeRetire} onChange={e => updateSettings({ onlyPaybackBeforeRetire: e.target.checked })} />
          {L.setBeforeRetire}
        </label>
        <Field label={L.setToolboxValue} tip={L.setToolboxValueTip}>
          <NumInput value={settings.toolboxValue} step={0.5} onChange={v => updateSettings({ toolboxValue: v })} />
        </Field>
        <Field label={L.setEnergyValue} tip={L.setEnergyValueTip}>
          <NumInput value={settings.energyPrice} step={0.1} allowEmpty placeholder={autoEnergy != null ? fmt(autoEnergy, 2) : ""}
            onChange={v => updateSettings({ energyPrice: v })} />
        </Field>
        <Field label={L.setPin}>
          <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
            {activeIds.map(id => (
              <label key={id} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", ...mutedText, color: C.textDim }}>
                <input type="checkbox" checked={settings.pins.includes(id)} onChange={() => togglePin(id)} />
                {empName(id)} <span style={{ color: C.textMuted }}>· {firmLabel(index.empById.get(id)?.firmId)}</span>
                {uncertainPinned.includes(id) && <span style={{ color: C.purple }}>· {L.bUncertain}</span>}
              </label>
            ))}
          </div>
        </Field>
        <Field label={L.setLock}>
          <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
            {firms.map(f => (
              <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", ...mutedText, color: C.textDim }}>
                <input type="checkbox" checked={settings.locks.includes(String(f.id))} onChange={() => toggleLock(String(f.id))} />
                {firmLabel(f.id)}
              </label>
            ))}
          </div>
        </Field>
        <Btn color={C.red} onClick={resetSettings}>{L.setReset}</Btn>
      </div>
    );
  }

  const kpiCard = (key, label, value, { tip, sub, badge, color } = {}) => (
    <GlassCard key={key} style={{ padding: "12px 14px", marginBottom: 0 }}>
      <div style={{ fontFamily: F.h, fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
        {tip ? <Tip text={tip} wrap pos="bottom"><span style={{ cursor: "help" }}>{label} &#9432;</span></Tip> : label}
      </div>
      <div style={{ fontFamily: F.h, fontSize: 20, fontWeight: 700, color: color || C.text }}>{value}</div>
      {sub && <div style={{ ...mutedText, marginTop: 2 }}>{sub}</div>}
      {badge && <div style={{ marginTop: 4 }}>{badge}</div>}
    </GlassCard>
  );

  const kpiBar = (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
      {kpiCard("emp", L.kpiEmployees, `${fmt(kpi.employees, 0)} / ${fmt(kpi.capSum, 0)}`, { tip: L.kpiEmployeesTip })}
      {kpiCard("prod", L.kpiProduction, `${fmt(kpi.prodDay, 1)} PP`, { tip: L.kpiProductionTip, color: C.purple })}
      {kpiCard("value", L.kpiValue, `${fmt(kpi.valueDay, 2)} G`, { tip: L.kpiValueTip, color: C.accent })}
      {kpiCard("wages", L.kpiWages, `${fmt(kpi.wageDay, 2)} G`, { color: C.red })}
      {kpiCard("net", L.kpiNet, `${fmt(kpi.netDay, 2)} G`, {
        tip: L.kpiNetTip, color: kpi.netDay >= 0 ? C.green : C.red,
        sub: kpi.marginAvg != null ? <Tip text={L.kpiMarginTip} wrap><span style={{ cursor: "help" }}>{L.kpiMarginAvg(fmt(kpi.marginAvg, 2))}</span></Tip> : null,
      })}
      {kpiCard("tb", L.kpiToolboxes, kpi.toolboxesDay != null ? fmt(kpi.toolboxesDay, 2) : "–", {
        tip: L.kpiToolboxesTip,
        badge: kpi.claimable > 0 ? <Bdg color={C.green}>{L.kpiToolboxesClaim(fmt(kpi.claimable, 0))}</Bdg> : null,
      })}
      {kpiCard("train", L.kpiTrainable, fmt(kpi.trainable, 0), { tip: L.kpiTrainableTip(fmt(kpi.trainable * ENERGY_PER_SESSION, 0)), color: C.blue })}
    </div>
  );

  const segments = (
    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
      {[
        { key: "today", label: L.wfViewToday, icon: "&#128197;" },
        { key: "plan", label: L.wfViewPlan, icon: "&#128260;" },
        { key: "check", label: L.wfViewCheck, icon: "&#9989;" },
        { key: "tools", label: L.wfViewTools, icon: "&#128295;" },
      ].map(t => (
        <Btn key={t.key} on={view === t.key} color={C.accent} onClick={() => setView(t.key)}>
          <span dangerouslySetInnerHTML={{ __html: t.icon }} /> {t.label}
        </Btn>
      ))}
    </div>
  );

  // ═════════ View: Heute (§7.3) ═════════
  function renderToday() {
    const rows = [];
    const row = (key, icon, text, number, link, color, children) => (
      <div key={key} style={{ padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 18 }} dangerouslySetInnerHTML={{ __html: icon }} />
          <span style={{ flex: 1, minWidth: 180, fontFamily: F.m, fontSize: 14, color: color || C.text }}>{text}</span>
          {number != null && <span style={{ fontFamily: F.h, fontSize: 18, fontWeight: 700, color: color || C.accent }}>{number}</span>}
          {link}
        </div>
        {children}
      </div>
    );

    if (pendingEvents.length > 0) {
      rows.push(row("events", "&#128276;", L.sectionEvents(pendingEvents.length), null, null, C.blue, (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={TH}>{L.colName}</th>
              <th style={TH}>{L.colEvent}</th>
              <th style={TH}>{L.colEmployee}</th>
              <th style={TH}>{L.colTimeLeft}</th>
              <th style={TH}><Tip text={L.defaultRiskTip} wrap><span style={{ cursor: "help" }}>{L.colDefaultRisk} &#9432;</span></Tip></th>
            </tr></thead>
            <tbody>
              {pendingEvents.map((p, i) => {
                const risky = RISKY_DEFAULT_EVENTS.includes(p.ev.code);
                return (
                  <tr key={p.ev._id || i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                    <td style={TD(false)}>{firmLabel(p.firmId)}</td>
                    <td style={TD(false)}>{formatCodeName(p.ev.code || "?")}</td>
                    <td style={TD(false)}>{(Array.isArray(p.ev.cast) ? p.ev.cast : []).map((c, ci) => c?.name || nameOf(idStr(c?.employee)) || L.employeeFallback(ci)).join(", ") || "-"}</td>
                    <td style={{ ...TD(false), fontWeight: 700, color: p.hoursLeft != null && p.hoursLeft < 6 ? C.red : C.accent }}>
                      {p.hoursLeft == null ? "?" : p.hoursLeft <= 0 ? L.eventExpiring : L.eventDeadline(fmt(p.hoursLeft, 0))}
                    </td>
                    <td style={TD(false)}>{risky ? <Bdg color={C.red}>{L.defaultRiskYes}</Bdg> : <span style={{ color: C.textMuted }}>–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )));
    }
    if (eventStatus?.state === "error") rows.push(row("evErr", "&#9888;", L.eventsFailed, null, null, C.accent));

    if (quitList.length > 0) {
      rows.push(row("quit", "&#128680;", L.todayQuit(quitList.length), quitList.length,
        <GoLink label={L.wfViewCheck} onClick={() => goTo("check", "action", false)} />, C.red, (
          <div style={{ marginTop: 6, paddingLeft: 28, display: "flex", flexDirection: "column", gap: 2 }}>
            {quitList.map(x => (
              <div key={x.id} style={mutedText}>
                <span style={{ color: C.text }}>{empName(x.id)}</span> · {firmLabel(index.empById.get(x.id)?.firmId)} · {L.todayQuitHours(fmt(1 / x.q, 0))}
              </div>
            ))}
          </div>
        )));
    }
    if (retireList.length > 0) {
      rows.push(row("retire", "&#9203;", L.todayRetire(retireList.length), retireList.length,
        <GoLink label={L.wfViewCheck} onClick={() => goTo("check", "retireSoon", false)} />, C.accent));
    }
    if (trainableIds.length > 0) {
      rows.push(row("train", "&#127947;", L.todayTrain(trainableIds.length), trainableIds.length,
        <GoLink label={L.trainTodayTitle} onClick={() => goTo("check", "trainToday", true)} />, C.blue));
    }
    if (toolIssueIds.length > 0) {
      rows.push(row("tools", "&#128295;", L.todayTools(toolIssueIds.length), toolIssueIds.length,
        <GoLink label={L.wfViewCheck} onClick={() => goTo("check", "all", false)} />, ORANGE));
    }
    const planRow = !planOptimal && steps.length > 0;
    if (planRow) {
      rows.push(row("plan", "&#128260;", L.todayPlan(steps.length, fmt(planDailyGain, 2)), null,
        <GoLink label={L.wfViewPlan} onClick={() => goTo("plan")} />, C.green));
    }
    if (kpi.claimable > 0) {
      rows.push(row("tb", "&#127873;", L.todayToolboxes(fmt(kpi.claimable, 0)), kpi.claimable,
        <GoLink label={L.wfViewTools} onClick={() => goTo("tools")} />, C.green));
    }

    return (
      <GlassCard>
        <Sec icon="&#128197;">{L.todayTitle}</Sec>
        {rows.length === 0 ? greenBox(L.todayNothing) : rows}
        {!planRow && model && (
          <div style={{ ...mutedText, marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: C.green }}>&#10004; {L.todayPlanOptimal}</span>
            <GoLink label={L.wfViewPlan} onClick={() => goTo("plan")} />
          </div>
        )}
      </GlassCard>
    );
  }

  // ═════════ View: Verteilung (§7.4) ═════════
  function renderPlan() {
    if (!model) return <GlassCard>{greenBox(L.noEmployees)}</GlassCard>;
    const pe = planEval || {};
    const before = n0(pe.beforeNetDay), after = n0(pe.afterNetDay, before + planDailyGain);
    const pct = Math.abs(before) > 1e-9 ? (planDailyGain / Math.abs(before)) * 100 : 0;

    // Slot occupancy along the sequence (for "freier Platz u/c" and "erst nach Schritt n").
    const used = new Map();
    for (const f of firms) used.set(String(f.id), (index.activeByFirm.get(String(f.id)) || []).length + (index.leaversByFirm.get(String(f.id)) || 0));
    const initialFree = new Map(firms.map(f => [String(f.id), n0(f.cap) - (used.get(String(f.id)) || 0)]));
    const stepMeta = new Map();
    const cycles = new Map();
    for (const s of steps) {
      if (s.cycleId == null) continue;
      const c = cycles.get(s.cycleId) || { a: Infinity, b: -Infinity, g: 0 };
      c.a = Math.min(c.a, n0(s.n)); c.b = Math.max(c.b, n0(s.n)); c.g += n0(s.gainDay);
      cycles.set(s.cycleId, c);
    }
    steps.forEach((s, i) => {
      const meta = {};
      const to = String(s.toId ?? ""), from = String(s.fromId ?? "");
      if (s.kind === "move") {
        const u = (used.get(to) || 0) + 1;
        meta.freeSlot = L.stepFreeSlot(u, n0(firmOf(to)?.cap));
        used.set(to, u);
        used.set(from, Math.max(0, (used.get(from) || 0) - 1));
        if (isNum(s.after)) meta.after = s.after;
        else if ((initialFree.get(to) || 0) <= 0) {
          const dep = steps.slice(0, i).reverse().find(p => (p.kind === "move" && String(p.fromId) === to) || (p.kind === "confirmLeaver" && String(p.firmId ?? p.toId ?? p.fromId) === to));
          if (dep) meta.after = dep.n;
        }
      } else if (s.kind === "confirmLeaver") {
        const fid = String(s.firmId ?? s.toId ?? s.fromId ?? "");
        used.set(fid, Math.max(0, (used.get(fid) || 0) - 1));
      }
      stepMeta.set(i, meta);
    });

    return (
      <div>
        <GlassCard glow={C.accentGlow}>
          <Sec icon="&#128260;">{L.planTitle}</Sec>
          <div style={{ ...dimText, marginBottom: 12 }}>{L.planDesc}</div>
          {planEval && (
            <div style={{ fontFamily: F.h, fontSize: 18, fontWeight: 700, color: planDailyGain > 0 ? C.green : C.text, marginBottom: 6 }}>
              {L.planBeforeAfter(fmt(before, 2), fmt(after, 2), fmt(planDailyGain, 2), fmt(pct, 1))}
            </div>
          )}
          {planEval && steps.length > 0 && (
            <div style={{ ...dimText, marginBottom: 6 }}>
              {L.planSummary(fmt(n0(pe.transitionLoss), 2), paybackText(pe.paybackDays), steps.length, swapSteps.length, moveSteps.length)}
            </div>
          )}
          <div style={mutedText}>{L.planHorizon(settings.horizonDays)}</div>
          <div style={mutedText}>{L.planWageSame}</div>
          <div style={mutedText}>{L.planProductsNote}</div>
          {uncertainPinned.length > 0 && (
            <div style={{ ...dimText, marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Bdg color={C.purple}>{L.bUncertain}</Bdg>
              <span>{L.planPinnedUncertain(uncertainPinned.length)}</span>
              <GoLink label={L.wfSettings} onClick={() => setShowSettings(true)} />
            </div>
          )}
          {timeBudgetHit && <div style={{ ...mutedText, color: ORANGE, marginTop: 6 }}>{L.planTimeBudget}</div>}
        </GlassCard>

        {planOptimal ? (
          <GlassCard>
            {greenBox(L.planOptimal(fmt(settings.minGainPerMoveDay, 1)))}
            {bestBelow && (
              <div style={{ ...dimText, marginTop: 10, textAlign: "center" }}>
                {L.planBestBelow(empName(bestBelow.empId), firmLabel(bestBelow.toId), fmt(n0(bestBelow.gainDay), 2))}
              </div>
            )}
          </GlassCard>
        ) : (
          steps.map((s, i) => {
            const meta = stepMeta.get(i) || {};
            const done = doneSet.has(s.n);
            const kindInfo = s.kind === "swap" ? { t: L.stepSwap, c: C.purple } : s.kind === "confirmLeaver" ? { t: L.stepConfirmLeaver, c: ORANGE } : { t: L.stepMove, c: C.blue };
            const cycAll = s.cycleId != null ? cycles.get(s.cycleId) : null;
            const cyc = cycAll && cycAll.b > cycAll.a ? cycAll : null; // a ring of one swap needs no ring note
            const loss = s.transitionLoss ?? s.loss;
            const warnings = Array.isArray(s.warnings) ? s.warnings : [];
            return (
              <GlassCard key={s.n ?? i} style={{ opacity: done ? 0.5 : 1, padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: F.h, fontSize: 20, fontWeight: 700, color: C.accent, minWidth: 28 }}>{s.n ?? i + 1}</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", ...mutedText }}>
                    <input type="checkbox" checked={done} onChange={() => toggleDone(s.n)} /> {L.stepDone}
                  </label>
                  <Bdg color={kindInfo.c}>{kindInfo.t}</Bdg>
                  {s.kind !== "confirmLeaver" && <span style={{ fontFamily: F.h, fontSize: 16, fontWeight: 700, color: n0(s.gainDay) >= 0 ? C.green : C.red }}>{L.gPerDay(signed(s.gainDay))}</span>}
                  {s.kind !== "confirmLeaver" && (
                    <Tip text={s.confidence === "estimate" ? L.confEstimateTip : null} wrap>
                      <span><Bdg color={s.confidence === "estimate" ? C.purple : C.green}>{s.confidence === "estimate" ? L.confEstimate : L.confSure}</Bdg></span>
                    </Tip>
                  )}
                </div>
                <div style={{ fontFamily: F.m, fontSize: 14, color: C.text, marginTop: 8, wordBreak: "break-word" }}>
                  {s.kind === "confirmLeaver" ? L.stepConfirmLeaverText(firmLabel(s.firmId ?? s.toId ?? s.fromId)) :
                    s.kind === "swap" ? <>
                      <b>{empName(s.empId)}</b> <span style={{ color: C.textDim }}>{firmLabel(s.fromId)}</span> <span style={{ color: C.accent }}>&#8644;</span> <span style={{ color: C.textDim }}>{firmLabel(s.toId)}</span> <b>{empName(s.withEmpId)}</b>
                    </> : <>
                      <b>{empName(s.empId)}</b> <span style={{ color: C.textDim }}>{firmLabel(s.fromId)}</span> <span style={{ color: C.accent }}>&rarr;</span> <span style={{ color: C.textDim }}>{firmLabel(s.toId)}</span>
                    </>}
                </div>
                <div style={{ ...mutedText, marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                  {(isNum(loss) || isNum(s.paybackDays)) && <span>{L.stepLine(fmt(n0(loss), 2), paybackText(s.paybackDays))}</span>}
                  {meta.freeSlot && <span>{meta.freeSlot}</span>}
                  {meta.after != null && <span style={{ color: ORANGE }}>{L.stepAfter(meta.after)}</span>}
                  {s.kind === "swap" && <span>{L.stepHowSwap}</span>}
                  {cyc && <span style={{ color: C.purple }}>{L.stepCycle(cyc.a, cyc.b, fmt(n0(s.cycleGainDay, cyc.g), 2))}</span>}
                </div>
                {warnings.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                    {warnings.map((w, wi) => (
                      <div key={wi} style={{ fontSize: 12, fontFamily: F.m, color: C.accent, background: C.accent + "14", border: "1px solid " + C.accent + "33", borderRadius: 4, padding: "3px 8px" }}>
                        &#9888; {warnText(w)}
                      </div>
                    ))}
                  </div>
                )}
              </GlassCard>
            );
          })
        )}

        {planEval && Array.isArray(planEval.perFirm) && planEval.perFirm.length > 0 && (
          <GlassCard style={{ padding: 0, overflow: "hidden" }}>
            <div onClick={() => setShowBeforeAfter(v => !v)} style={{ padding: "12px 20px", cursor: "pointer", fontFamily: F.h, fontSize: 14, fontWeight: 700, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              <span style={{ marginRight: 6, fontSize: 10, color: C.accent }}>{showBeforeAfter ? "▼" : "▶"}</span>{L.planTableToggle}
            </div>
            {showBeforeAfter && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={TH}>{L.colCompany}</th>
                    <th style={TH}>{L.colProduct}</th>
                    <th style={TH}>{L.colBeforeAfterRoster}</th>
                    <th style={TH}>{L.colNetBeforeAfter}</th>
                  </tr></thead>
                  <tbody>
                    {planEval.perFirm.map((pf, i) => {
                      const f = firmOf(pf.id);
                      const b = rosterOf(currentAssign, pf.id).map(empName).join(", ") || "–";
                      const a = rosterOf(assignment, pf.id).map(empName).join(", ") || "–";
                      const delta = n0(pf.afterDay) - n0(pf.beforeDay);
                      return (
                        <tr key={pf.id ?? i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={{ ...TD(false), fontSize: 13 }}>{f?.name || pf.id}</td>
                          <td style={{ ...TD(false), fontSize: 13 }}>{f?.itemCode || "-"}</td>
                          <td style={{ ...TD(false), fontSize: 12 }}>
                            <div style={{ color: C.textDim }}>{b}</div>
                            {a !== b && <div style={{ color: C.accent }}>&rarr; {a}</div>}
                          </td>
                          <td style={{ ...TD(false), fontSize: 13, whiteSpace: "nowrap" }}>
                            {fmt(n0(pf.beforeDay), 2)} &rarr; <span style={{ color: delta > 0.005 ? C.green : delta < -0.005 ? C.red : C.text, fontWeight: 700 }}>{fmt(n0(pf.afterDay), 2)} G</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>
        )}
        <div style={{ ...mutedText, padding: "0 4px 14px" }}>{L.planVerifyTip}</div>
      </div>
    );
  }

  // ═════════ View: Mitarbeiter-Check (§7.5) ═════════
  function renderCheck() {
    if (!model) return <GlassCard>{greenBox(L.noEmployees)}</GlassCard>;
    const passes = r => {
      switch (filter) {
        case "action": return ["critical", "fire", "replace"].includes(r.a.verdict);
        case "train": return r.a.verdict === "train";
        case "replace": return r.a.verdict === "replace";
        case "fire": return r.a.verdict === "fire";
        case "retireSoon": { const d = retireInDays(r.emp); return hasBadge(r.a, "retireSoon") || (isNum(d) && d <= 7); }
        case "trainToday": return isTrainable(r.id);
        default: return true;
      }
    };
    const amount = r => {
      const n = r.nums;
      switch (r.a.verdict) {
        case "critical": return empQuitChance(r.emp);
        case "fire": return -n0(n.marginalDay);
        case "replace": return n0(n.replaceAdvantage);
        case "train": return n0(n.evSession);
        default: return -n0(n.marginalDay);
      }
    };
    const sortVal = r => {
      switch (sort.key) {
        case "name": return (r.emp?.name || r.id).toLowerCase();
        case "company": return firmLabel(r.firmId).toLowerCase();
        case "net": return n0(r.nums.marginalDay);
        case "remaining": return n0(retireInDays(r.emp), 999) + n0(r.nums.retireTailDays);
        case "potential": return n0(r.emp?.potential);
        case "wage": return n0(safe(() => empWagePerHour(r.emp)).value);
        default: return null;
      }
    };
    const rows = checkRows.filter(passes).sort((x, y) => {
      if (sort.key === "verdict") {
        const d = (VERDICT_ORDER[x.a.verdict] ?? 9) - (VERDICT_ORDER[y.a.verdict] ?? 9);
        return (d !== 0 ? d : amount(y) - amount(x)) * sort.dir;
      }
      const a = sortVal(x), b = sortVal(y);
      return (a < b ? -1 : a > b ? 1 : 0) * sort.dir;
    });
    const sortHead = (key, label) => (
      <th style={{ ...TH, cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
        {label}{sort.key === key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
      </th>
    );
    const chips = [
      { key: "all", label: `${L.fAll} (${filterCounts.all})` },
      { key: "action", label: `${L.fAction} (${filterCounts.action})` },
      { key: "train", label: `${L.vTrain} (${filterCounts.train})` },
      { key: "replace", label: `${L.vReplace} (${filterCounts.replace})` },
      { key: "fire", label: `${L.vFire} (${filterCounts.fire})` },
      { key: "retireSoon", label: `${L.fRetireSoon} (${filterCounts.retireSoon})` },
      { key: "trainToday", label: `${L.fTrainToday} (${filterCounts.trainToday})` },
    ];

    const cellParts = r => {
      const n = r.nums;
      const emp = r.emp;
      const v = verdictInfo(r.a.verdict);
      const own = n0(n.netNow);
      const cw = n0(n.marginalDay) - own;
      const d = retireInDays(emp);
      const paused = hasBadge(r.a, "paused") || !!emp?.companyDisabled;
      const wage = n0(safe(() => empWagePerHour(emp)).value);
      const reason = Array.isArray(r.a.reasons) && r.a.reasons[0] ? callL(r.a.reasons[0].key, r.a.reasons[0].params) : "";
      const badges = (Array.isArray(r.a.badges) ? r.a.badges : []).map(b => badgeInfo(b, emp)).filter(Boolean);
      return {
        verdict: <Bdg color={v.color}>{v.text}</Bdg>,
        badges: badges.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>{badges.map((b, bi) => <Bdg key={bi} color={b.color}>{b.text}</Bdg>)}</div>,
        net: (
          <Tip text={L.netSplitTip(fmt(own, 2), signed(cw))} wrap>
            <span style={{ color: n0(n.marginalDay) >= 0 ? C.green : C.red, fontWeight: 700, cursor: "help" }}>&asymp; {fmt(n0(n.marginalDay), 2)} G</span>
          </Tip>
        ),
        remaining: <span>{paused && <span title={L.bPaused}>&#9208; </span>}{isNum(d) ? L.remainingFmt(fmt(d, 0), fmt(n0(n.retireTailDays), 0)) : "-"}</span>,
        potential: isNum(emp?.potential) ? `${emp.potential}${isNum(emp?.potentialMax) ? "/" + emp.potentialMax : ""}` : "-",
        wage: (
          <span>
            {fmt(wage, 3)} G
            {hasTrait(emp, "climber") && isNum(n.wageDriftPerWeek) && <div style={{ fontSize: 10, color: ORANGE }}>{L.driftLine(fmt(n.wageDriftPerWeek, 2))}</div>}
          </span>
        ),
        reason,
      };
    };

    return (
      <div>
        <GlassCard>
          <Sec icon="&#9989;">{L.checkTitle}</Sec>
          <div style={{ ...dimText, marginBottom: 6 }}>{L.checkDesc}</div>
          {!planOptimal && steps.length > 0 && <div style={{ ...mutedText, color: C.accent, marginBottom: 6 }}>{L.checkAfterPlan}</div>}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {chips.map(c => <Btn key={c.key} on={filter === c.key} color={C.accent} onClick={() => setFilter(c.key)}>{c.label}</Btn>)}
            <Btn on={showTraining} color={C.blue} onClick={() => setShowTraining(t => !t)}>&#127947; {L.trainTodayTitle}</Btn>
          </div>
        </GlassCard>

        {showTraining && renderTrainingToday()}

        {reloading && <GlassCard><div style={{ ...dimText, textAlign: "center" }}>{L.loadingGeneric}</div></GlassCard>}

        {rows.length === 0 ? (
          <GlassCard>{greenBox(checkRows.length === 0 ? L.noEmployees : L.todayNothing)}</GlassCard>
        ) : isMobile ? (
          rows.map(r => {
            const p = cellParts(r);
            const open = expandedEmp === r.id;
            return (
              <GlassCard key={r.id} style={{ padding: "12px 14px", outline: open ? "1px solid " + C.accent + "44" : "none" }}>
                <div onClick={() => setExpandedEmp(open ? null : r.id)} style={{ cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: F.m, fontSize: 14, color: C.text, fontWeight: 700 }}>
                        <span style={{ marginRight: 6, fontSize: 10, color: C.accent }}>{open ? "▼" : "▶"}</span>
                        {r.emp?.name || r.id}
                        {isNum(r.emp?.age) && <span style={{ color: C.textMuted, fontSize: 10, marginLeft: 6 }}>{L.ageLabel(r.emp.age)}</span>}
                      </div>
                      <div style={mutedText}>{firmLabel(r.firmId)}</div>
                    </div>
                    {p.verdict}
                  </div>
                  {p.badges}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 8, fontFamily: F.m, fontSize: 12 }}>
                    <div><div style={mutedText}>{L.colNetDay}</div>{p.net}</div>
                    <div><div style={mutedText}>{L.colRemaining}</div><span style={{ color: C.text }}>{p.remaining}</span></div>
                    <div><div style={mutedText}>{L.colWage}</div><span style={{ color: C.text }}>{p.wage}</span></div>
                  </div>
                  {p.reason && <div style={{ ...dimText, marginTop: 6 }}>{p.reason}</div>}
                </div>
                {open && <EmpDetail r={r} ctx={detailCtx} />}
              </GlassCard>
            );
          })
        ) : (
          <GlassCard style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  {sortHead("name", L.colEmployee)}
                  {sortHead("company", L.colCompany)}
                  {sortHead("net", L.colNetDay)}
                  {sortHead("remaining", L.colRemaining)}
                  {sortHead("potential", L.colPotential)}
                  {sortHead("wage", L.colWage)}
                  {sortHead("verdict", L.colVerdict)}
                  <th style={TH}>{L.colWhy}</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const p = cellParts(r);
                    const open = expandedEmp === r.id;
                    return [
                      <tr key={r.id} onClick={() => setExpandedEmp(open ? null : r.id)}
                        style={{ background: i % 2 ? C.rowAlt : "transparent", cursor: "pointer", outline: open ? "1px solid " + C.accent + "44" : "none" }}>
                        <td style={{ ...TD(false), fontSize: 13 }}>
                          <span style={{ marginRight: 6, fontSize: 10, color: C.accent }}>{open ? "▼" : "▶"}</span>
                          {r.emp?.name || r.id}
                          {isNum(r.emp?.age) && <span style={{ color: C.textMuted, fontSize: 10, marginLeft: 6 }}>{L.ageLabel(r.emp.age)}</span>}
                          {traitChips(r.emp)}
                        </td>
                        <td style={{ ...TD(false), fontSize: 13 }}>{firmLabel(r.firmId)}</td>
                        <td style={{ ...TD(false), fontSize: 13, whiteSpace: "nowrap" }}>{p.net}</td>
                        <td style={{ ...TD(false), fontSize: 13, whiteSpace: "nowrap" }}>{p.remaining}</td>
                        <td style={{ ...TD(false), fontSize: 13 }}>{p.potential}</td>
                        <td style={{ ...TD(false), fontSize: 13, whiteSpace: "nowrap" }}>{p.wage}</td>
                        <td style={{ ...TD(false), fontSize: 13 }}>{p.verdict}{p.badges}</td>
                        <td style={{ ...TD(false), fontSize: 12, color: C.textDim, minWidth: 200 }}>{p.reason}</td>
                      </tr>,
                      open && (
                        <tr key={r.id + "-detail"}>
                          <td colSpan={8} style={{ padding: 0, background: "rgba(0,0,0,0.2)" }}>
                            <div style={{ padding: "12px 20px 12px 36px" }}><EmpDetail r={r} ctx={detailCtx} /></div>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </GlassCard>
        )}
      </div>
    );
  }

  function renderTrainingToday() {
    const list = trainableIds.map(id => {
      const a = adviceById.get(id);
      const firmId = assignment[id] ?? index.empById.get(id)?.firmId;
      const ev = safe(() => trainingEV(model, id, firmId, rosterOf(assignment, firmId), opts)).value;
      const evSession = n0(ev?.evSession, n0(a?.numbers?.evSession));
      const evNet = isNum(ev?.evNet) ? ev.evNet : evSession - n0(energyPrice);
      return { id, firmId, evNet, evSession };
    }).sort((x, y) => y.evNet - x.evNet);
    let cum = 0;
    return (
      <GlassCard glow={C.blueGlow}>
        <Sec icon="&#127947;">{L.trainTodayTitle}</Sec>
        <div style={{ ...dimText, marginBottom: 10 }}>{L.trainTodayDesc}</div>
        {list.length === 0 ? greenBox(L.noEmployees) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={TH}>{L.colEmployee}</th>
                <th style={TH}>{L.colCompany}</th>
                <th style={TH}>{L.colTrainValue}</th>
                <th style={TH}>&sum;</th>
              </tr></thead>
              <tbody>
                {list.map((x, i) => {
                  cum += ENERGY_PER_SESSION;
                  const curFirm = index.empById.get(x.id)?.firmId;
                  const trainerHere = (index.activeByFirm.get(String(curFirm)) || []).some(oid => hasTrait(rawEmp(oid), "trainer"));
                  const grey = x.evNet <= 0;
                  return (
                    <tr key={x.id} style={{ background: i % 2 ? C.rowAlt : "transparent", opacity: grey ? 0.45 : 1 }}>
                      <td style={{ ...TD(false), fontSize: 13 }}>
                        {empName(x.id)}
                        {trainerHere && <div style={{ fontSize: 10, color: C.blue }}>{L.trainerHint(firmLabel(curFirm))}</div>}
                      </td>
                      <td style={{ ...TD(false), fontSize: 13 }}>{firmLabel(curFirm)}</td>
                      <td style={{ ...TD(false), fontSize: 13, color: grey ? C.textMuted : C.green, fontWeight: 700 }}>{signed(x.evNet)} G</td>
                      <td style={{ ...TD(false), fontSize: 12, color: C.textDim, whiteSpace: "nowrap" }}>{L.trainEnergyCum(cum)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    );
  }

  // ═════════ View: Werkzeug & Manager (§7.6) ═════════
  function renderTools() {
    const found = isNum(toolBal?.foundPerDay) ? toolBal.foundPerDay : kpi.toolboxesDay;
    const need = toolBal?.needPerDay;
    const state = toolBal?.state;
    const rate = isNum(mgrRateInput) ? mgrRateInput : mgr?.medianRate;
    const mgrRows = mgr ? firms.filter(f => mgr.points[String(f.id)]).map(f => {
      const pt = mgr.points[String(f.id)];
      const ids = index.activeByFirm.get(String(f.id)) || [];
      const roster = ids.map(id => ({ basePPH: n0(statValue(rawEmp(id), "production")) / 4 }));
      const sumP = ids.reduce((s, id) => s + n0(statValue(rawEmp(id), "production")), 0);
      const roi = pt.error || !isNum(pt.ppp) || !isNum(rate) ? null
        : safe(() => managerROI({ ppp: pt.ppp, g: n0(f.g), roster, rate, sumP })).value;
      return { f, pt, sumP, roi };
    }) : [];
    const actualRows = actualAll ? firms.filter(f => actualAll.results[String(f.id)]).map(f => {
      const res = actualAll.results[String(f.id)];
      const ids = index.activeByFirm.get(String(f.id)) || [];
      const est = ids.reduce((s, id) => s + (isAway(rawEmp(id)) ? 0 : n0(rawEmp(id)?.estimate?.production)), 0) * 24;
      const actual = res.rows ? meanCompletedDays(res.rows, "employeeProd") : null;
      const dev = actual != null && est > 0 ? (actual / est - 1) * 100 : null;
      return { f, res, est, actual, dev };
    }) : [];
    const outside = actualRows.some(x => x.dev != null && Math.abs(x.dev) > 3);

    return (
      <div>
        <GlassCard>
          <Sec icon="&#127873;">{L.toolBalanceTitle}</Sec>
          <Tip text={L.toolBalanceTip} wrap>
            <span style={{ ...dimText, fontSize: 14, cursor: "help" }}>{L.toolBalance(isNum(found) ? fmt(found, 2) : "–", isNum(need) ? fmt(need, 2) : "–")} &#9432;</span>
          </Tip>
          {state === "surplus" && <div style={{ ...dimText, color: C.green, marginTop: 8 }}>{L.toolSurplus}</div>}
          {state === "deficit" && <div style={{ ...dimText, color: ORANGE, marginTop: 8 }}>{L.toolDeficit}</div>}
          <div style={{ maxWidth: 260, marginTop: 12 }}>
            <Field label={L.setToolboxValue} tip={L.setToolboxValueTip}>
              <NumInput value={settings.toolboxValue} step={0.5} onChange={v => updateSettings({ toolboxValue: v })} />
            </Field>
          </div>
        </GlassCard>

        <GlassCard>
          <Sec icon="&#128084;">{L.mgrTitle}</Sec>
          <div style={{ ...dimText, marginBottom: 10 }}>{L.mgrDesc}</div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
            <Btn on color={C.accent} onClick={calcManagers} disabled={mgrLoading || !apiKeySet}>{mgrLoading ? L.loadingGeneric : L.mgrCalc}</Btn>
            {mgr && (
              <div style={{ width: 220 }}>
                <Field label={L.mgrRate} tip={L.mgrRateTip}>
                  <NumInput value={isNum(mgrRateInput) ? mgrRateInput : mgr.medianRate} step={0.001} allowEmpty
                    placeholder={isNum(mgr.medianRate) ? fmt(mgr.medianRate, 4) : ""} onChange={v => setMgrRateInput(v)} />
                </Field>
              </div>
            )}
          </div>
          {mgr?.offersError && errorLine(mgr.offersError)}
          {mgr?.wageStats?.allowedRange && (
            <div style={{ ...mutedText, marginBottom: 8 }}>
              {L.mgrWageStats(fmt(n0(mgr.wageStats.allowedRange.min), 4), fmt(n0(mgr.wageStats.allowedRange.max), 4), fmt(n0(mgr.wageStats.allowedRange.average), 4))}
            </div>
          )}
          {mgrRows.length > 0 && (
            isMobile ? (
              mgrRows.map(({ f, pt, sumP, roi }) => {
                const net11 = Array.isArray(roi?.byPoints) ? roi.byPoints.find(p => p?.points === 11)?.netDay : null;
                const yes = roi?.recommendation != null || (isNum(roi?.perPointNetH) && roi.perPointNetH > 0);
                return (
                  <div key={f.id} style={{ ...glass(0.04, 8), borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontFamily: F.m, fontSize: 13, color: C.text }}>{firmLabel(f.id)}</span>
                      {roi ? <Bdg color={yes ? C.green : C.red}>{yes ? L.mgrYes : L.mgrNo}</Bdg> : <span style={mutedText}>{L.rowUnavailable}</span>}
                    </div>
                    {roi && <div style={{ ...mutedText, marginTop: 4 }}>&Sigma; {L.candP} {fmt(sumP, 0)} · {L.mgrPPP} {fmt(n0(pt.ppp), 3)} · {L.mgrRow(fmt(n0(roi.perPointGainH), 4), fmt(n0(rate), 4))}</div>}
                    {isNum(net11) && <div style={{ ...dimText, marginTop: 2 }}>{L.mgrNet11}: <span style={{ color: net11 >= 0 ? C.green : C.red }}>{fmt(net11, 2)} G</span></div>}
                  </div>
                );
              })
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={TH}>{L.colCompany}</th>
                    <th style={TH}>&Sigma; {L.candP}</th>
                    <th style={TH}>{L.mgrPPP}</th>
                    <th style={TH}>{L.mgrGainCostCol}</th>
                    <th style={TH}>{L.mgrNet11}</th>
                    <th style={TH}>{L.colVerdict}</th>
                  </tr></thead>
                  <tbody>
                    {mgrRows.map(({ f, pt, sumP, roi }, i) => {
                      const net11 = Array.isArray(roi?.byPoints) ? roi.byPoints.find(p => p?.points === 11)?.netDay : null;
                      const yes = roi?.recommendation != null || (isNum(roi?.perPointNetH) && roi.perPointNetH > 0);
                      return (
                        <tr key={f.id} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={{ ...TD(false), fontSize: 13 }}>{firmLabel(f.id)}</td>
                          <td style={{ ...TD(false), fontSize: 13 }}>{fmt(sumP, 0)}</td>
                          <td style={{ ...TD(false), fontSize: 13 }}>{pt.error ? <span style={{ color: C.textMuted }}>{L.rowUnavailable}</span> : fmt(n0(pt.ppp), 3)}</td>
                          <td style={{ ...TD(false), fontSize: 12 }}>{roi ? L.mgrRow(fmt(n0(roi.perPointGainH), 4), fmt(n0(rate), 4)) : "–"}</td>
                          <td style={{ ...TD(false), fontSize: 13, fontWeight: 700, color: !isNum(net11) ? C.textMuted : net11 >= 0 ? C.green : C.red }}>{isNum(net11) ? fmt(net11, 2) + " G" : "–"}</td>
                          <td style={{ ...TD(false), fontSize: 13 }}>
                            {roi ? (
                              <Tip text={isNum(roi.breakEvenSumP) ? L.mgrBreakEven(fmt(roi.breakEvenSumP, 0)) : null} wrap>
                                <span><Bdg color={yes ? C.green : C.red}>{yes ? L.mgrYes : L.mgrNo}</Bdg></span>
                              </Tip>
                            ) : <span style={{ color: C.textMuted }}>{L.rowUnavailable}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
          {mgr && <div style={{ ...mutedText, marginTop: 10 }}>{L.mgrCaveat}</div>}
        </GlassCard>

        <GlassCard>
          <Sec icon="&#128202;">{L.actualAllTitle}</Sec>
          {actualBlocked ? (
            <div style={dimText}>{L.actualUnavailable}</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Btn on color={C.accent} onClick={loadActualAll} disabled={!!actualAll?.loading || !apiKeySet}>{L.actualAllBtn}</Btn>
                {actualAll?.loading && <span style={mutedText}>{L.loadingGeneric} {actualAll.done}/{actualAll.total}</span>}
              </div>
              {actualRows.length > 0 && (
                <div style={{ overflowX: "auto", marginTop: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={TH}>{L.colCompany}</th>
                      <th style={TH}>{L.colActualDay}</th>
                      <th style={TH}>{L.colEstimateDay}</th>
                      <th style={TH}>{L.colDeviation}</th>
                    </tr></thead>
                    <tbody>
                      {actualRows.map(({ f, res, est, actual, dev }, i) => (
                        <tr key={f.id} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={{ ...TD(false), fontSize: 13 }}>{firmLabel(f.id)}</td>
                          {res.error ? (
                            <td colSpan={3} style={{ ...TD(false), fontSize: 12, color: C.red }}>{res.error}</td>
                          ) : (
                            <>
                              <td style={{ ...TD(false), fontSize: 13 }}>{actual != null ? fmt(actual, 1) : "–"}</td>
                              <td style={{ ...TD(false), fontSize: 13 }}>{fmt(est, 1)}</td>
                              <td style={{ ...TD(false), fontSize: 13, fontWeight: 700, color: dev == null ? C.textMuted : Math.abs(dev) <= 3 ? C.green : ORANGE }}>{dev != null ? signed(dev, 1) + " %" : "–"}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(outside || actualRows.length > 0) && <div style={{ ...mutedText, marginTop: 8, color: outside ? ORANGE : C.textMuted }}>{L.actualAllHint}</div>}
            </>
          )}
        </GlassCard>
      </div>
    );
  }

  // ═════════ Render ═════════
  return (
    <div>
      {header}
      {reloadError && errorLine(L.wfLoadError(reloadError))}
      {calcError && errorLine(L.wfCalcError(calcError))}
      {kpiBar}
      {segments}
      {view === "today" && renderToday()}
      {view === "plan" && renderPlan()}
      {view === "check" && renderCheck()}
      {view === "tools" && renderTools()}
    </div>
  );
}
