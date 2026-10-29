import { useState, useEffect, useRef } from "react";
import { THEMES, C, F, setThemeVars, glass, fmt, fmtT, fmtN, GlassCard, Sec, Bdg, Tip, Btn, getTH, getTD, apiCall, setActiveApiKey } from "./shared.jsx";
import FactoryOptimizer from "./factory-optimizer.jsx";
import { getLang } from "./translations.jsx";

// ── URL params ──
function getUrlParam(...names) {
  try {
    const p = new URLSearchParams(window.location.search);
    for (const n of names) {
      const v = p.get(n);
      if (v != null && v.trim() !== "") return v.trim();
    }
  } catch {}
  return "";
}

function getInitialUserInput() {
  return getUrlParam("user", "username", "id") || (() => {
    try { return localStorage.getItem("warera_user_input") || ""; } catch { return ""; }
  })();
}

function getInitialApiKey() {
  const fromUrl = getUrlParam("apikey", "apiKey");
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem("warera_api_key") || ""; } catch { return ""; }
}

// ── Employee rules (WarEra v0.27) ──
// These constants live in the game client, not in gameConfig.getGameConfig. They are used when
// the API delivers no estimate for an employee and for the what-ifs (moves, product changes).
const RULES = {
  outputDivisor: 4,              // PP per hour = production stat / 4, before bonuses
  minStat: 1,                    // no stat goes below 1
  happinessNeutral: 50,
  happinessMin: 0,
  happinessMax: 100,
  happinessPercentPerPoint: 1,   // each point above/below 50 = ±1 % output
  happinessGood: 60,             // game colours: green from 60, red below 30 ...
  happinessQuitThreshold: 30,    // ... where employees start to quit
  managementPercentPerPoint: 2,  // owner management, +2 % per point
  coreRegionBonusPercent: 5,     // company in a core region of the owner's country
  specializationPercentPerDay: 1, // +1 % per day worked in a good, kept per good ...
  specializationMaxPercent: 20,  // ... up to +20 %
  responsibilityFullAt: 10,      // Responsibility blocks min(1, R/10) of every happiness loss
  loyalLossMultiplier: 0.5,      // trait "loyal" halves happiness losses
  taxShyPercentPerTaxPercent: 1, // trait "taxShy": -1 % output per 1 % income tax ...
  taxShyMaxPercent: 30,          // ... down to -30 %
  moveHappinessPenalty: 5,       // employee moved between own companies (7 days)
  companyMoveHappinessPenalty: 10, // company moved to another region (7 days, not on a free move)
  movePenaltyDays: 7,
  taxHappinessPerPercent: 1,     // each 1 % income tax = -1 happiness
};

// Goods each tool family boosts (from the game client). A tool in a company making another
// good sits idle.
const TOOL_FAMILY_GOODS = {
  sickle: ["grain", "livestock", "coca", "wood", "fish"],
  pickaxe: ["limestone", "iron", "lead", "petroleum"],
  skillet: ["bread", "steak", "cookedFish"],
  hammer: ["steel", "concrete"],
  flask: ["oil", "paper", "cocain"],
  caliper: ["lightAmmo", "ammo", "heavyAmmo"],
};

// Revealed traits whose effect changes with the good, the tool, the happiness or the time in a
// company (from the game client). Traits that depend on coworkers or on nationality are not
// modelled.
const TRAITS = {
  laborer: { rawStat: 3, manufacturedStat: -1 },      // Production on raw / manufactured goods
  craftsman: { rawStat: -1, manufacturedStat: 3 },
  specialist: { ownGoodStat: 3, ownGoodHappiness: 5 }, // while producing their own good (arg)
  handy: { withToolPercent: 40 },
  improviser: { withoutToolPercent: 25 },
  anchor: { lowHappinessPercent: -50 },                // below the quit threshold
  creatureOfHabit: { afterTransferPercent: -30, days: 3 },
  sprinter: { percent: 50, days: 1 },                  // first 24 h in a company
  veteran: { percent: 20, afterDays: 30 },             // in the same company
  diamondInTheRough: { statPerPeriod: 1, periodDays: 10, maxStat: 4 },  // +1 to its stat (arg)
  burnout: { statPerPeriod: -1, periodDays: 20, maxStat: -3 },          // -1 to all stats
};

// What-ifs are compared day by day for this long; after it every temporary effect is over
// (move penalty 7 days, specialization at most 20 days to its cap, burnout 60 days).
const TRANSITION_DAYS = 61;

// Only procedures documented in the official WarEra API (https://api2.warera.io/docs,
// spec at https://api2.warera.io/openapi.json) may be called, with or without the personal
// API key. WarEra v0.27.2 announced that API keys can now read your own employees and their
// events (https://app.warera.io/article/6ae2608f707baf45eebf26c5), but the spec does not list
// those procedures yet, so both entries stay null until it does. The game client reads them as:
//   employees: "employee.getMyEmployees" - no input; one flat array with the employees of all
//              the key owner's companies, each linked by `company` (company id).
//   events:    "employeeEvent.getMine"   - no input; array of events, company in cast[0].company.
// Both return only the key owner's own data, so they are only called with an API key.
const OFFICIAL_EMPLOYEE_ENDPOINTS = {
  employees: null,
  events: null,
};

// ── Helpers ──
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

async function resolveUser(input) {
  try {
    const u = await apiCall("user.getUserLite", { userId: input });
    if (u && u.username) return u;
  } catch {}
  const search = await apiCall("search.searchAnything", { searchText: input });
  if (!search.userIds?.length) throw new Error("Spieler nicht gefunden");
  for (const uid of search.userIds) {
    try {
      const u = await apiCall("user.getUserLite", { userId: uid });
      if (u.username.toLowerCase() === input.toLowerCase()) return u;
    } catch {}
  }
  throw new Error(`Keine exakte Übereinstimmung für "${input}".`);
}

async function batchParallel(ids, fn, concurrency = 2) {
  const results = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// Calls a key-only procedure that takes no input (see OFFICIAL_EMPLOYEE_ENDPOINTS).
async function loadOwnData(endpoint, hasKey) {
  if (!endpoint) return { state: "off" };
  if (!hasKey) return { state: "noKey" };
  try {
    return { state: "ok", data: await apiCall(endpoint) };
  } catch (e) {
    return { state: "error", error: e?.message || "ERROR" };
  }
}

function idString(v) {
  if (v == null) return null;
  return String(typeof v === "object" ? v._id : v);
}

// Employees of all own companies. Also accepts a roster object { employees: [...] };
// null for any other shape.
function parseEmployeeList(r) {
  const list = Array.isArray(r) ? r : (Array.isArray(r?.employees) ? r.employees : null);
  return list && list.filter(e => e && typeof e === "object");
}

// Employee events; null for an unexpected shape.
function parseEmployeeEvents(r) {
  return Array.isArray(r) ? r.filter(e => e && typeof e === "object") : null;
}

function eventCompanyId(ev) {
  return idString(ev?.cast?.[0]?.company);
}

// Employees who left stay listed (with leftAt) until the owner acknowledges it in the game.
function hasLeft(emp) {
  return !!emp?.leftAt;
}

// Stat before the floor of 1: base + training + revealed flat trait effects.
// null while the game still hides the stat (it shows "?").
function rawStatValue(emp, stat) {
  if (!emp?.revealed?.[stat]) return null;
  const b = emp?.breakdown?.[stat];
  if (b && typeof b === "object") {
    return (Array.isArray(b.contributions) ? b.contributions : []).reduce(
      (s, c) => (c?.revealed && !c.percent ? s + num(c.delta) : s),
      num(b.base) + num(b.trained));
  }
  const base = emp?.base?.[stat];
  return typeof base === "number" ? base : null;
}

// Stat as the game shows it (at least 1); null while hidden.
function statValue(emp, stat) {
  const raw = rawStatValue(emp, stat);
  return raw == null ? null : Math.max(RULES.minStat, raw);
}

function empHappiness(emp) {
  const v = emp?.happinessBreakdown?.value;
  return typeof v === "number" ? v : RULES.happinessNeutral;
}

// Chance per hour that the employee quits (0 while happy enough).
function empQuitChance(emp) {
  const q = emp?.happinessBreakdown?.quitChance;
  return typeof q === "number" && q > 0 ? q : 0;
}

// Revealed trait codes. Hidden traits are only counted, like in the game.
function empTraits(emp) {
  const list = (Array.isArray(emp?.traits) ? emp.traits : []).filter(t => t && typeof t.code === "string");
  return {
    revealed: list.filter(t => t.revealed).map(t => t.code),
    hiddenCount: list.filter(t => !t.revealed).length,
  };
}

function revealedTraits(emp) {
  return (Array.isArray(emp?.traits) ? emp.traits : []).filter(t => t && t.revealed && typeof t.code === "string");
}

function hasRevealedTrait(emp, code) {
  return revealedTraits(emp).some(t => t.code === code);
}

// Equipped tool: toolItem is the item, toolStatus its effect right now.
function empToolInfo(emp) {
  const item = emp?.toolItem;
  if (!item || typeof item !== "object") return null;
  const status = emp?.toolStatus;
  const rolled = [status?.rolledPercent, item.skills?.production].find(v => typeof v === "number");
  return {
    code: item.code || "tool",
    bonus: typeof status?.bonusPercent === "number" ? status.bonusPercent : null, // applied now
    rolled: typeof rolled === "number" ? rolled : null,
    broken: !!status?.isBroken || (typeof item.state === "number" && item.state <= 0),
    durability: typeof item.state === "number" ? item.state : null,
    maxDurability: typeof item.maxState === "number" ? item.maxState : 100,
  };
}

function toolFitsGood(tool, itemCode) {
  const goods = TOOL_FAMILY_GOODS[String(tool.code).replace(/\d+$/, "")];
  return !goods || goods.includes(itemCode);
}

// Bonus the tool would give in a company making itemCode: its rolled percent, unless it is
// broken or belongs to another tool family.
function toolBonusFor(tool, itemCode) {
  if (!tool || tool.broken || !toolFitsGood(tool, itemCode)) return 0;
  return tool.rolled ?? tool.bonus ?? 0;
}

function toolBonusNow(tool, itemCode) {
  if (!tool) return 0;
  return tool.bonus ?? toolBonusFor(tool, itemCode);
}

// An "away" event modifier means no work and no wage until it runs out.
function isAway(emp) {
  const now = Date.now();
  return (Array.isArray(emp?.eventModifiers) ? emp.eventModifiers : [])
    .some(m => m?.kind === "away" && Date.parse(m.until) > now);
}

// Wage cost per hour: the game's estimate, otherwise the contract wage.
function empWagePerHour(emp) {
  if (hasLeft(emp)) return 0;
  if (typeof emp?.estimate?.wage === "number") return Math.max(0, emp.estimate.wage);
  if (isAway(emp)) return 0;
  return Math.max(0, num(emp?.wage, 0));
}

function empHasEstimate(emp) {
  return typeof emp?.estimate?.production === "number";
}

function specializationPercent(emp, itemCode) {
  const days = Math.max(0, num(emp?.specializations?.[itemCode], 0));
  return Math.min(RULES.specializationMaxPercent, days * RULES.specializationPercentPerDay);
}

// Sum of all production bonuses in percent. The game adds them all up (productionBonus.total);
// without it, the known parts are added up here.
function empBonusPercent(emp, ctx) {
  if (typeof emp?.productionBonus?.total === "number") return emp.productionBonus.total;
  return (empHappiness(emp) - RULES.happinessNeutral) * RULES.happinessPercentPerPoint
    + (ctx?.managementPoints || 0) * RULES.managementPercentPerPoint
    + (ctx?.isCore ? RULES.coreRegionBonusPercent : 0)
    + toolBonusNow(empToolInfo(emp), ctx?.itemCode)
    + specializationPercent(emp, ctx?.itemCode);
}

// PP per hour of one employee. Uses the game's own estimate when present,
// otherwise Production/4 × (1 + sum of bonuses / 100).
function calcEmployeePPH(emp, ctx) {
  if (hasLeft(emp)) return 0;
  if (empHasEstimate(emp)) return Math.max(0, emp.estimate.production);
  if (isAway(emp)) return 0;
  const base = num(statValue(emp, "production"), 0) / RULES.outputDivisor;
  return Math.max(0, base * (1 + empBonusPercent(emp, ctx) / 100));
}

// Without the game's estimate a hidden Production stat leaves the output unknown.
function empOutputKnown(emp) {
  return hasLeft(emp) || empHasEstimate(emp) || isAway(emp) || statValue(emp, "production") != null;
}

// PP per hour before any bonus.
function baseEmployeePPH(emp, ctx) {
  const factor = 1 + empBonusPercent(emp, ctx) / 100;
  if (factor > 0.01) return calcEmployeePPH(emp, ctx) / factor;
  return num(statValue(emp, "production"), 0) / RULES.outputDivisor;
}

// Share of a happiness loss that reaches the employee: Responsibility blocks min(1, R/10) of it
// and the loyal trait halves it. A hidden Responsibility counts as 0.
function happinessLossFactor(emp) {
  const shield = Math.min(1, Math.max(0, num(statValue(emp, "responsibility"), 0)) / RULES.responsibilityFullAt);
  return (1 - shield) * (hasRevealedTrait(emp, "loyal") ? RULES.loyalLossMultiplier : 1);
}

function taxShyPercent(emp, taxPct) {
  if (!hasRevealedTrait(emp, "taxShy")) return 0;
  return -Math.min(RULES.taxShyMaxPercent, Math.max(0, taxPct) * RULES.taxShyPercentPerTaxPercent);
}

// Production points from revealed traits that depend on the good.
function goodTraitStat(emp, itemCode, itemType) {
  let stat = 0;
  for (const t of revealedTraits(emp)) {
    if ((t.code === "laborer" || t.code === "craftsman") && itemType) {
      stat += itemType === "raw" ? TRAITS[t.code].rawStat : TRAITS[t.code].manufacturedStat;
    } else if (t.code === "specialist" && t.arg === itemCode) {
      stat += TRAITS.specialist.ownGoodStat;
    }
  }
  return stat;
}

function goodTraitHappiness(emp, itemCode) {
  return revealedTraits(emp).some(t => t.code === "specialist" && t.arg === itemCode) ? TRAITS.specialist.ownGoodHappiness : 0;
}

// Specialization in a good after working it `days` more days: +1 % a day (twice as fast for a
// revealed quickStudy) up to the cap. Each good keeps its own days.
function specializationAfter(emp, itemCode, days) {
  const rate = RULES.specializationPercentPerDay * (hasRevealedTrait(emp, "quickStudy") ? 2 : 1);
  return Math.min(RULES.specializationMaxPercent, specializationPercent(emp, itemCode) + rate * days);
}

function daysSince(date) {
  const since = Date.parse(date);
  return Number.isFinite(since) ? Math.max(0, (Date.now() - since) / 86400000) : null;
}

// Output percent and Production points from revealed traits that depend on the time in a company:
// sprinter (first day), creatureOfHabit (3 days after a transfer), veteran (from day 30),
// diamondInTheRough on Production (+1 every 10 days) and burnout (-1 every 20 days).
function careerEffects(emp, daysInCompany, daysSinceTransfer) {
  let percent = 0, stat = 0;
  for (const t of revealedTraits(emp)) {
    if (t.code === "sprinter" && daysInCompany < TRAITS.sprinter.days) percent += TRAITS.sprinter.percent;
    else if (t.code === "creatureOfHabit" && daysSinceTransfer != null && daysSinceTransfer < TRAITS.creatureOfHabit.days) {
      percent += TRAITS.creatureOfHabit.afterTransferPercent;
    } else if (t.code === "veteran" && daysInCompany >= TRAITS.veteran.afterDays) percent += TRAITS.veteran.percent;
    else if ((t.code === "diamondInTheRough" && t.arg === "production") || t.code === "burnout") {
      const e = TRAITS[t.code];
      const sum = Math.floor(daysInCompany / e.periodDays) * e.statPerPeriod;
      stat += e.maxStat > 0 ? Math.min(e.maxStat, sum) : Math.max(e.maxStat, sum);
    }
  }
  return { percent, stat };
}

// How the time-dependent trait effects change, compared with today, on day d if the employee
// stays (moved: they change company today). Their current effects are already in the estimate.
function careerChange(emp, d, moved) {
  const tenure = daysSince(emp?.lastMovedAt || emp?.createdAt) ?? 0;
  const sinceMove = daysSince(emp?.lastMovedAt);
  const now = careerEffects(emp, tenure, sinceMove);
  const then = moved ? careerEffects(emp, d, d) : careerEffects(emp, tenure + d, sinceMove == null ? null : sinceMove + d);
  return { percent: then.percent - now.percent, stat: then.stat - now.stat };
}

// Bonus of the company's hired manager in the employee's own bonus breakdown (0 if none).
function managerPercent(emp) {
  const contributions = Array.isArray(emp?.productionBonus?.contributions) ? emp.productionBonus.contributions : [];
  return num(contributions.find(c => c?.source === "manager")?.percent, 0);
}

// PP per hour if the employee worked under other conditions. The game adds all bonuses into one
// percentage, so a change of d points turns base × (1 + total/100) into base × (1 + (total + d)/100);
// a change of the Production stat moves the base itself (Production / 4).
//   change.itemCode, itemType  good of the target company (tool family, good-dependent traits)
//   change.toolReturned        the tool goes back to the inventory if it does not fit the good
//   change.isCore              target region is a core region of the owner's country
//   change.taxPct              income tax at the target, in percent
//   change.happinessDelta      extra happiness before Responsibility, e.g. -5 right after a move
//   change.specialization      specialization (percent) in the good worked; default: as now
//   change.bonusDelta          further percentage points, e.g. a different manager
//   change.statDelta           further Production points, e.g. from careerChange
function projectEmployeePPH(emp, ctx, change = {}) {
  if (hasLeft(emp)) return 0;
  const total = empBonusPercent(emp, ctx);
  const loss = happinessLossFactor(emp);
  const curTax = num(ctx?.taxPct, 0);
  const newTax = change.taxPct ?? curTax;
  const itemCode = change.itemCode ?? ctx?.itemCode;
  const newGood = itemCode !== ctx?.itemCode;
  const extra = num(change.happinessDelta, 0);
  const goodHappiness = newGood ? goodTraitHappiness(emp, itemCode) - goodTraitHappiness(emp, ctx?.itemCode) : 0;
  const h = empHappiness(emp);
  const newH = clamp(h - (newTax - curTax) * RULES.taxHappinessPerPercent * loss + (extra < 0 ? extra * loss : extra) + goodHappiness,
    RULES.happinessMin, RULES.happinessMax);
  // A revealed anchor loses 50 % while below the quit threshold.
  const anchorPercent = v => (hasRevealedTrait(emp, "anchor") && v < RULES.happinessQuitThreshold ? TRAITS.anchor.lowHappinessPercent : 0);
  let delta = (newH - h) * RULES.happinessPercentPerPoint + anchorPercent(newH) - anchorPercent(h) + num(change.bonusDelta, 0);
  if (change.isCore != null) delta += ((change.isCore ? 1 : 0) - (ctx?.isCore ? 1 : 0)) * RULES.coreRegionBonusPercent;
  if (change.specialization != null) delta += change.specialization - specializationPercent(emp, ctx?.itemCode);
  delta += taxShyPercent(emp, newTax) - taxShyPercent(emp, curTax);
  let statDelta = num(change.statDelta, 0);
  if (newGood) {
    const tool = empToolInfo(emp);
    delta += toolBonusFor(tool, itemCode) - toolBonusNow(tool, ctx?.itemCode);
    // Without the tool, handy loses its bonus and improviser gains one.
    if (tool && change.toolReturned && !toolFitsGood(tool, itemCode)) {
      if (hasRevealedTrait(emp, "handy")) delta -= TRAITS.handy.withToolPercent;
      if (hasRevealedTrait(emp, "improviser")) delta += TRAITS.improviser.withoutToolPercent;
    }
    statDelta += goodTraitStat(emp, itemCode, change.itemType) - goodTraitStat(emp, ctx?.itemCode, ctx?.itemType);
  }
  let base = baseEmployeePPH(emp, ctx);
  if (base > 0 && statDelta) {
    // The game floors the stat at 1 after adding everything up, so a stat sitting at the floor
    // starts from its unfloored (revealed) value.
    const cur = base * RULES.outputDivisor;
    const raw = cur < RULES.minStat + 0.01 ? Math.min(cur, rawStatValue(emp, "production") ?? cur) : cur;
    base = Math.max(RULES.minStat, raw + statDelta) / RULES.outputDivisor;
  }
  return Math.max(0, base * (1 + (total + delta) / 100));
}

// Compares a change with carrying on as before, day by day. gainOnDay(d) is the extra gold on
// day d (0 = the first day after the change); gainOnDay(d, true) is the same without the
// temporary effects of the change (move penalty, specialization still to rebuild, ...). From
// TRANSITION_DAYS on both are at their steady value. Returns that steady daily gain, what the
// temporary effects cost, and the day the summed gain has paid back the upfront cost
// (Infinity if it never does).
function compareOverTime(gainOnDay, upfront = 0) {
  const dailyGain = gainOnDay(TRANSITION_DAYS);
  let sum = -upfront, transitionLoss = 0;
  let paybackDays = sum >= 0 ? 0 : null;
  for (let d = 0; d < TRANSITION_DAYS; d++) {
    const gain = gainOnDay(d);
    transitionLoss += gainOnDay(d, true) - gain;
    const next = sum + gain;
    if (next < 0) paybackDays = null;
    else if (paybackDays === null) paybackDays = d - sum / gain;
    sum = next;
  }
  if (paybackDays === null) paybackDays = dailyGain > 0 ? TRANSITION_DAYS - sum / dailyGain : Infinity;
  return { dailyGain, transitionLoss: Math.max(0, transitionLoss), paybackDays };
}

// "primaDonna" -> "prima donna"
function formatCodeName(code) {
  return String(code).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

export default function CompanyDashboard({ theme, setTheme, lang, setLang }) {
  setThemeVars(theme);
  const T = THEMES[theme];
  const L = getLang(lang);

  const [userInput, setUserInput] = useState(getInitialUserInput);
  const [apiKey, setApiKey] = useState(getInitialApiKey);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");

  // Loaded data
  const [userData, setUserData] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [employees, setEmployees] = useState({});     // companyId -> employee[] (leavers included)
  const [employeeStatus, setEmployeeStatus] = useState({ state: "off", error: null });
  const [employeeEvents, setEmployeeEvents] = useState([]);
  const [eventStatus, setEventStatus] = useState({ state: "off", error: null });
  const [regions, setRegions] = useState({});         // regionId -> region
  const [countries, setCountries] = useState({});     // countryId -> country
  const [prices, setPrices] = useState({});           // itemCode -> number
  const [ownerCountry, setOwnerCountry] = useState(null);
  const [gameConfig, setGameConfig] = useState(null);

  const [subTab, setSubTab] = useState("overview");
  const [expandedCompany, setExpandedCompany] = useState(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem("warera_user_input", userInput.trim());
    } catch {}
  }, [userInput]);

  useEffect(() => {
    setActiveApiKey(apiKey);
    try {
      localStorage.setItem("warera_api_key", apiKey.trim());
    } catch {}
    // A key passed in the URL shows in the address bar and in copied links; drop it from there.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("apikey") || url.searchParams.has("apiKey")) {
        url.searchParams.delete("apikey");
        url.searchParams.delete("apiKey");
        window.history.replaceState({}, "", url);
      }
    } catch {}
  }, [apiKey]);

  // Accept config (apiKey/user/lang) from a parent page via postMessage when embedded as iframe.
  useEffect(() => {
    if (window.parent === window) return; // not embedded
    let allowedOrigin = "";
    try { allowedOrigin = new URLSearchParams(window.location.search).get("allowedOrigin") || ""; } catch {}

    const onMessage = (e) => {
      if (allowedOrigin && e.origin !== allowedOrigin) return;
      const data = e.data;
      if (!data || data.type !== "warera:config") return;
      if (typeof data.apiKey === "string") setApiKey(data.apiKey.trim());
      if (typeof data.user === "string") setUserInput(data.user.trim());
      if (typeof data.lang === "string" && setLang) setLang(data.lang.trim());
    };

    window.addEventListener("message", onMessage);
    // Tell the parent we are ready to receive config.
    try { window.parent.postMessage({ type: "warera:ready" }, allowedOrigin || "*"); } catch {}
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    let interval;
    const handleRL = (e) => {
      let remaining = Math.ceil(e.detail.delay / 1000);
      setLoadingMsg(L.rateLimitWait(remaining));
      clearInterval(interval);
      interval = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
          setLoadingMsg(L.rateLimitWait(remaining));
        } else {
          clearInterval(interval);
        }
      }, 1000);
    };
    window.addEventListener('warera-rate-limit', handleRL);
    return () => {
      window.removeEventListener('warera-rate-limit', handleRL);
      clearInterval(interval);
    };
  }, []);

  async function loadData() {
    if (!userInput.trim()) return;
    // Only the newest load may write its results; an older one that finishes later is dropped.
    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current;
    setLoading(true); setError(""); setLoadingMsg(L.loadingSearchPlayer);
    // Employee data belongs to the key owner and must not stay on screen while another player loads.
    setEmployees({}); setEmployeeStatus({ state: "off", error: null }); setEmployeeEvents([]); setEventStatus({ state: "off", error: null });
    const key = apiKey.trim();
    setActiveApiKey(key);
    try {
      // Phase 1: Resolve user + load global data in parallel
      const [user, pricesData, regionsData, countriesData, configData] = await Promise.all([
        resolveUser(userInput.trim()),
        apiCall("itemTrading.getPrices", {}).catch(() => ({})),
        apiCall("region.getRegionsObject", {}).catch(() => ({})),
        apiCall("country.getAllCountries", {}).catch(() => []),
        apiCall("gameConfig.getGameConfig", {}).catch(() => null),
      ]);
      if (stale()) return;

      setUserData(user);
      setPrices(pricesData || {});
      setGameConfig(configData);

      // Build region lookup (object keyed by _id)
      const regMap = {};
      if (regionsData && typeof regionsData === "object") {
        if (Array.isArray(regionsData)) {
          for (const r of regionsData) if (r?._id) regMap[r._id] = r;
        } else {
          for (const [k, r] of Object.entries(regionsData)) {
            regMap[r?._id || k] = r;
          }
        }
      }
      setRegions(regMap);

      // Build country lookup
      const cntMap = {};
      const cntArr = Array.isArray(countriesData) ? countriesData : (countriesData?.items || Object.values(countriesData));
      for (const c of cntArr) {
        if (c?._id) cntMap[c._id] = c;
      }
      setCountries(cntMap);

      // Phase 2: Load companies
      setLoadingMsg(L.loadingFactories);
      const userId = user._id || user.id || user.userId;
      const companiesResp = await apiCall("company.getCompanies", { userId, perPage: 100 });
      if (stale()) return;
      const companyIds = companiesResp?.items || [];
      if (!companyIds.length) throw new Error("Keine Fabriken gefunden");

      // Phase 3: Load company details (documented) and, only once WarEra documents them and an
      // API key is set, the key owner's employees and events. See OFFICIAL_EMPLOYEE_ENDPOINTS.
      setLoadingMsg(L.loadingFactoriesN(companyIds.length));
      const [companyDetails, employeeResult, eventResult] = await Promise.all([
        batchParallel(companyIds, cid => apiCall("company.getById", { companyId: cid })),
        loadOwnData(OFFICIAL_EMPLOYEE_ENDPOINTS.employees, !!key),
        loadOwnData(OFFICIAL_EMPLOYEE_ENDPOINTS.events, !!key),
      ]);
      if (stale()) return;

      const comps = companyDetails.filter(comp => comp?._id);
      const compIds = new Set(comps.map(comp => String(comp._id)));
      const totalCompaniesValue = comps.reduce((s, comp) => s + (comp.estimatedValue || 0), 0);
      const empMap = {};
      for (const id of compIds) empMap[id] = [];
      let empStatus = { state: employeeResult.state, error: employeeResult.error || null };
      if (employeeResult.state === "ok") {
        const list = parseEmployeeList(employeeResult.data);
        let matched = 0;
        for (const emp of list || []) {
          const cid = idString(emp.company);
          if (compIds.has(cid)) { empMap[cid].push(emp); matched++; }
        }
        // The key only reads its owner's employees. If none of them work in these companies,
        // the key belongs to another player; an empty list cannot tell whose key it is.
        if (!list) empStatus = { state: "error", error: "UNEXPECTED_RESPONSE" };
        else if (matched === 0) empStatus = { state: list.length > 0 ? "mismatch" : "empty", error: null };
      }
      let evStatus = { state: empStatus.state === "ok" ? eventResult.state : "off", error: eventResult.error || null };
      const events = evStatus.state === "ok" ? parseEmployeeEvents(eventResult.data) : [];
      if (!events) evStatus = { state: "error", error: "UNEXPECTED_RESPONSE" };

      setCompanies(comps);
      setEmployees(empMap);
      setEmployeeStatus(empStatus);
      setEmployeeEvents((events || []).filter(ev => compIds.has(eventCompanyId(ev))));
      setEventStatus(evStatus);

      // Phase 3b: Calculate Liquid Assets (Geld + Items + Waffen)
      setLoadingMsg(L.loadingLiquid);
      const wealthRanking = await apiCall("ranking.getRanking", { rankingType: "userWealth", limit: 100, skip: 0 }).catch(() => null);
      if (stale()) return;
      let totalWealth = 0;
      if (wealthRanking?.items) {
        const me = wealthRanking.items.find(i => (i.user?._id || i.user) === userId);
        if (me) totalWealth = me.value || 0;
      }
      const liquidAssets = totalWealth > 0 ? Math.max(0, totalWealth - totalCompaniesValue) : 0;
      setUserData(prev => ({ ...prev, liquidAssets, totalWealth, totalCompaniesValue }));

      // Phase 4: Load owner's country for enemy check
      setLoadingMsg(L.loadingDiplomacy);
      const ownerCountryId = user.country; // field is "country" on user object
      if (ownerCountryId && cntMap[ownerCountryId]) {
        setOwnerCountry(cntMap[ownerCountryId]);
      } else if (ownerCountryId) {
        try {
          const oc = await apiCall("country.getCountryById", { countryId: ownerCountryId });
          if (stale()) return;
          setOwnerCountry(oc);
          if (oc) cntMap[oc._id] = oc;
        } catch {
          if (stale()) return;
          setOwnerCountry(null);
        }
      }

      setLoadingMsg("");
    } catch (e) {
      if (stale()) return;
      // Nothing of the previous player may stay on screen after a failed load.
      setUserData(null); setCompanies([]); setEmployees({}); setOwnerCountry(null);
      setEmployeeStatus({ state: "off", error: null }); setEmployeeEvents([]); setEventStatus({ state: "off", error: null });
      setError(e.message);
    }
    setLoading(false);
  }

  // ── Lookups ──
  function getRegionName(comp) {
    const region = regions[comp.region];
    return region?.name || L.unknown;
  }

  function getCountryForRegion(regionId) {
    const region = regions[regionId];
    if (!region) return null;
    return countries[region.country] || null; // field is "country" on region
  }

  function getCountryName(regionId) {
    const country = getCountryForRegion(regionId);
    return country?.name || "?";
  }

  // Income tax of the country a region belongs to, in percent (e.g. 5 = 5 %).
  function getIncomeTaxPct(regionId) {
    const country = getCountryForRegion(regionId);
    return num(country?.taxes?.income, 0);
  }

  // A battle in the region costs every employee 5 happiness (deaths are off since v0.27.1).
  function hasActiveBattle(comp) {
    return !!regions[comp.region]?.activeBattle;
  }

  // v0.27 granted everyone one free move (company.freeMoves). The game warns about the
  // -10 happiness for 7 days only when no free move is left.
  function hasFreeMove(comp) {
    return num(comp.freeMoves, 0) > 0;
  }

  // Concrete needed to move the company.
  function getMoveConcreteCost(comp) {
    const moveCost = gameConfig?.company?.moveCost || 5;
    return hasFreeMove(comp) ? 0 : moveCost;
  }

  // A region is a core region of the owner's country when it originally belonged to it.
  function isCoreRegionId(regionId) {
    const region = regions[regionId];
    const home = userData?.country;
    if (!region || !home) return false;
    return (region.initialCountry || region.country) === home;
  }

  function isCoreRegion(comp) {
    return isCoreRegionId(comp.region);
  }

  // Best core region to move a company to: owned by the home country, highest development.
  function getSuggestedHomeRegion() {
    const home = userData?.country;
    if (!home) return null;
    let best = null;
    for (const region of Object.values(regions)) {
      if ((region.initialCountry || region.country) !== home) continue;
      if (region.country !== home) continue; // currently occupied by someone else
      if (!best || num(region.development) > num(best.development)) best = region;
    }
    return best;
  }

  // Employees still working in the company.
  function getEmployees(comp) {
    return (employees[String(comp._id)] || []).filter(e => !hasLeft(e));
  }

  // Employees who left; they keep their slot until the owner acknowledges it in the game.
  function getLeavers(comp) {
    return (employees[String(comp._id)] || []).filter(hasLeft);
  }

  function getUsedSlots(comp) {
    return (employees[String(comp._id)] || []).length;
  }

  function getEmployeeCap(comp) {
    const lvl = comp.activeUpgradeLevels?.breakRoom || 1;
    const cfgCap = gameConfig?.upgradesConfig?.breakRoom?.levels?.[lvl]?.stats?.maxWorkers;
    return typeof cfgCap === "number" ? cfgCap : lvl;
  }

  function getOwnerManagementPoints() {
    const m = userData?.skills?.management;
    if (!m) return 0;
    for (const v of [m.total, m.value]) if (typeof v === "number") return v;
    return 0;
  }

  // The game's estimate and productionBonus.total already contain a hired manager's bonus. Only
  // the local fallback leaves it out, because manager contracts are not part of the official API.
  function empCtx(comp) {
    return {
      isCore: isCoreRegion(comp),
      managementPoints: getOwnerManagementPoints(),
      itemCode: comp.itemCode,
      itemType: getItemType(comp.itemCode),
      taxPct: getIncomeTaxPct(comp.region),
    };
  }

  // "raw" or "product" (manufactured), from the public gameConfig.
  function getItemType(itemCode) {
    return gameConfig?.items?.[itemCode]?.type || null;
  }

  // A hired manager's bonus applies to every employee of the company; read it from them
  // (0 for a company without employees, whose manager is unknown).
  function getCompanyManagerPercent(comp) {
    return Math.max(0, ...getEmployees(comp).map(managerPercent));
  }

  // ── Calculations ──
  // Deposits are disabled since v0.27 and region bonuses are gone: the engine makes level × 24 PP a day.
  function calcEnginePPDay(comp) {
    const engineLevel = comp.activeUpgradeLevels?.automatedEngine || 1;
    return engineLevel * 24;
  }

  function calcEmployeePPDay(emp, comp) {
    return calcEmployeePPH(emp, empCtx(comp)) * 24;
  }

  function calcEmployeesPPDay(comp) {
    return getEmployees(comp).reduce((sum, e) => sum + calcEmployeePPDay(e, comp), 0);
  }

  function calcCompanyPPDay(comp) {
    return calcEnginePPDay(comp) + calcEmployeesPPDay(comp);
  }

  function calcEmployeeCostDay(emp) {
    return empWagePerHour(emp) * 24;
  }

  function calcDailyCost(comp) {
    return getEmployees(comp).reduce((sum, e) => sum + calcEmployeeCostDay(e), 0);
  }

  function getItemPrice(itemCode) {
    const p = prices[itemCode];
    if (!p) return 0;
    if (typeof p === "number") return p;
    return p.price || p.buyPrice || p.sellPrice || 0;
  }

  // Material cost per unit produced (from productionNeeds)
  function calcMaterialCostPerUnit(itemCode) {
    const itemConfig = gameConfig?.items?.[itemCode];
    if (!itemConfig?.productionNeeds) return 0;
    let cost = 0;
    for (const [matCode, matQty] of Object.entries(itemConfig.productionNeeds)) {
      cost += getItemPrice(matCode) * matQty;
    }
    return cost;
  }

  // Net margin per unit = sell price - material cost
  function calcNetMarginPerUnit(itemCode) {
    return getItemPrice(itemCode) - calcMaterialCostPerUnit(itemCode);
  }

  function getPPPerUnit(itemCode) {
    return gameConfig?.items?.[itemCode]?.productionPoints || null;
  }

  // Gold per PP after material costs
  function calcGoldPerPP(itemCode) {
    const ppPerUnit = getPPPerUnit(itemCode);
    if (!ppPerUnit) return 0;
    return calcNetMarginPerUnit(itemCode) / ppPerUnit;
  }

  function calcDailyRevenue(comp) {
    return calcCompanyPPDay(comp) * calcGoldPerPP(comp.itemCode);
  }

  function calcDailyProfit(comp) {
    return calcDailyRevenue(comp) - calcDailyCost(comp);
  }

  function calcEmployeeNetDay(emp, comp) {
    return calcEmployeePPDay(emp, comp) * calcGoldPerPP(comp.itemCode) - calcEmployeeCostDay(emp);
  }

  function hasEmployees(comp) {
    return getEmployees(comp).length > 0;
  }

  // ── Optimization Analysis ──
  function getWageLossWarnings() {
    const warnings = [];
    for (const comp of companies) {
      const goldPerPP = calcGoldPerPP(comp.itemCode);
      for (const emp of getEmployees(comp)) {
        if (!empOutputKnown(emp)) continue;
        const dailyContribution = calcEmployeePPDay(emp, comp) * goldPerPP;
        const dailyWage = calcEmployeeCostDay(emp);
        if (dailyWage > dailyContribution && dailyWage > 0) {
          warnings.push({
            company: comp,
            employee: emp,
            dailyWage,
            dailyContribution,
            loss: dailyWage - dailyContribution,
            breakEvenWagePerH: dailyContribution / 24,
          });
        }
      }
    }
    return warnings.sort((a, b) => b.loss - a.loss);
  }

  // Companies with employees outside the owner's core regions: moving home gives +5 % and
  // changes the income tax the employees feel (1 % tax = -1 happiness).
  function getCoreRegionSuggestions() {
    const suggestions = [];
    const betonPrice = getItemPrice("concrete") || 1;
    const homeRegion = getSuggestedHomeRegion();
    if (!homeRegion) return suggestions;
    const toTax = getIncomeTaxPct(homeRegion._id);

    for (const comp of companies) {
      if (isCoreRegion(comp) || !hasEmployees(comp)) continue;
      const goldPerPP = calcGoldPerPP(comp.itemCode);
      const ctx = empCtx(comp);
      const emps = getEmployees(comp);
      // Without a free move the employees also get -10 happiness for the first 7 days.
      const penalty = hasFreeMove(comp) ? 0 : -RULES.companyMoveHappinessPenalty;
      const gainOnDay = (d, steady) => emps.reduce((s, emp) => s + (projectEmployeePPH(emp, ctx, {
        isCore: true, taxPct: toTax, happinessDelta: !steady && d < RULES.movePenaltyDays ? penalty : 0,
      }) - calcEmployeePPH(emp, ctx)) * 24 * goldPerPP, 0);
      const concreteNeeded = getMoveConcreteCost(comp);
      const concreteCost = concreteNeeded * betonPrice;
      const { dailyGain, transitionLoss, paybackDays } = compareOverTime(gainOnDay, concreteCost);
      suggestions.push({
        company: comp,
        currentRegion: regions[comp.region],
        homeRegion,
        dailyGain,
        relocCost: concreteCost + transitionLoss,
        concreteNeeded,
        concreteCost,
        happinessLoss: transitionLoss,
        paybackDays,
        fromTax: ctx.taxPct,
        toTax,
      });
    }
    return suggestions.sort((a, b) => a.paybackDays - b.paybackDays);
  }

  function getEnemyWarnings() {
    if (!ownerCountry) return [];
    const warsWith = ownerCountry.warsWith || [];
    if (!warsWith.length) return [];

    const warnings = [];
    for (const comp of companies) {
      const emps = getEmployees(comp);
      if (!emps.length) continue;

      const factoryCountry = getCountryForRegion(comp.region);
      if (!factoryCountry) continue;

      if (warsWith.includes(factoryCountry._id)) {
        warnings.push({
          company: comp,
          factoryCountry,
          employeeCount: emps.length,
        });
      }
    }
    return warnings;
  }

  function getAllProductsRanked() {
    const items = gameConfig?.items || {};
    const products = [];
    for (const [code, item] of Object.entries(items)) {
      if (!item.productionPoints) continue; // skip weapons, equipment, cases
      if (item.type !== "raw" && item.type !== "product") continue;
      const price = getItemPrice(code);
      const pp = item.productionPoints;
      const materialCost = calcMaterialCostPerUnit(code);
      const netMargin = price - materialCost;
      const goldPerPP = netMargin / pp;
      const needs = item.productionNeeds || null;
      const userComps = companies.filter(c => c.itemCode === code);

      products.push({
        itemCode: code, type: item.type, price: price, pp, materialCost, netMargin, goldPerPP, needs,
        maxGoldPerPP: goldPerPP, // kept for the factory optimizer; regions give no product bonus anymore
        userCompanyCount: userComps.length,
        userTotalProfit: userComps.reduce((s, c) => s + calcDailyProfit(c), 0),
        userTotalRevenue: userComps.reduce((s, c) => s + calcDailyRevenue(c), 0),
        userTotalCost: userComps.reduce((s, c) => s + calcDailyCost(c), 0),
      });
    }
    return products.sort((a, b) => b.goldPerPP - a.goldPerPP);
  }

  // Product change (+5 concrete) and/or move into a core region (+5 concrete).
  function getGlobalOptimization() {
    if (!gameConfig) return [];
    const allProducts = getAllProductsRanked();
    const betonPrice = getItemPrice("concrete") || 1;
    const changeCost = gameConfig.company?.changeItemCost || 5;
    const homeRegion = getSuggestedHomeRegion();

    const suggestions = [];

    for (const comp of companies) {
      const currentItem = comp.itemCode;
      const currentCore = isCoreRegion(comp);
      const currentGoldPerPP = calcGoldPerPP(currentItem);
      const currentProfit = calcDailyProfit(comp);
      const enginePP = calcEnginePPDay(comp);
      const emps = getEmployees(comp);
      const ctx = empCtx(comp);

      const regionOptions = [{ region: regions[comp.region], isCore: currentCore, move: false }];
      if (!currentCore && homeRegion && emps.length > 0) regionOptions.push({ region: homeRegion, isCore: true, move: true });

      // The best option by its steady daily gain; the transition is only simulated for it.
      let best = null;
      for (const prod of allProducts) {
        for (const opt of regionOptions) {
          if (prod.itemCode === currentItem && !opt.move) continue;
          // Tools of another family go back to the inventory on a product change.
          const change = { itemCode: prod.itemCode, itemType: prod.type, toolReturned: true, isCore: opt.isCore };
          if (opt.move) change.taxPct = getIncomeTaxPct(opt.region._id);
          const penalty = opt.move && !hasFreeMove(comp) ? -RULES.companyMoveHappinessPenalty : 0;
          // Extra gold on day d: specialization grows in whichever good is worked, and a move
          // without a free move costs -10 happiness for the first 7 days. Without those temporary
          // effects (steady) the new good would start at the old good's specialization. The
          // employees stay in the company, so time-dependent traits run on in both cases.
          const gainOnDay = (d, steady) => enginePP * (prod.goldPerPP - currentGoldPerPP) + emps.reduce((s, emp) => {
            const career = careerChange(emp, d, false);
            const stay = projectEmployeePPH(emp, ctx, {
              specialization: specializationAfter(emp, currentItem, d), bonusDelta: career.percent, statDelta: career.stat,
            });
            const after = projectEmployeePPH(emp, ctx, {
              ...change,
              specialization: specializationAfter(emp, steady ? currentItem : prod.itemCode, d),
              happinessDelta: !steady && d < RULES.movePenaltyDays ? penalty : 0,
              bonusDelta: career.percent, statDelta: career.stat,
            });
            return s + (after * prod.goldPerPP - stay * currentGoldPerPP) * 24;
          }, 0);
          const dailyGain = gainOnDay(TRANSITION_DAYS);
          if (dailyGain > (best ? best.dailyGain : 0)) best = { prod, opt, gainOnDay, dailyGain };
        }
      }
      if (!best) continue;

      let concreteNeeded = 0;
      if (best.opt.move) concreteNeeded += getMoveConcreteCost(comp);
      if (best.prod.itemCode !== currentItem) concreteNeeded += changeCost;
      const concreteCost = concreteNeeded * betonPrice;
      const { dailyGain, transitionLoss, paybackDays } = compareOverTime(best.gainOnDay, concreteCost);
      suggestions.push({
        company: comp,
        currentItem,
        currentRegion: regions[comp.region],
        currentCore,
        currentProfit,
        newItem: best.prod.itemCode,
        newRegion: best.opt.region,
        newCore: best.opt.isCore,
        moveFree: best.opt.move && hasFreeMove(comp),
        newProfit: currentProfit + dailyGain,
        dailyGain,
        totalCost: concreteCost + transitionLoss,
        concreteCost,
        transitionLoss,
        concreteNeeded,
        paybackDays,
      });
    }
    return suggestions.sort((a, b) => a.paybackDays - b.paybackDays);
  }

  // For each employee: the own company where they would earn the most net gold.
  function getEmployeeOptimization() {
    if (!gameConfig) return [];
    const suggestions = [];

    for (const fromComp of companies) {
      const fromCtx = empCtx(fromComp);
      const fromGoldPerPP = calcGoldPerPP(fromComp.itemCode);
      for (const emp of getEmployees(fromComp)) {
        const ppDay = calcEmployeePPDay(emp, fromComp);
        const costDay = calcEmployeeCostDay(emp); // wage is set by the employee, same everywhere
        const currentNetPerDay = ppDay * fromGoldPerPP - costDay;

        const ownManager = managerPercent(emp);
        let best = null;
        for (const toComp of companies) {
          if (toComp._id === fromComp._id) continue;
          if (getUsedSlots(toComp) >= getEmployeeCap(toComp)) continue; // break room full
          // The tool moves with the employee (it just sits idle if it does not fit the good).
          const change = {
            itemCode: toComp.itemCode, itemType: getItemType(toComp.itemCode),
            isCore: isCoreRegion(toComp), taxPct: getIncomeTaxPct(toComp.region),
          };
          const managerDelta = getCompanyManagerPercent(toComp) - ownManager;
          const goldPerPP = calcGoldPerPP(toComp.itemCode);
          // Extra gold on day d (the wage stays the same): specialization grows in whichever good
          // is worked; after the move come 7 days of -5 happiness, and the time-dependent traits
          // (creatureOfHabit, sprinter, veteran, diamondInTheRough, burnout) start over. Without
          // those temporary effects (steady) the employee would carry on as if they had stayed.
          const gainOnDay = (d, steady) => {
            const stayCareer = careerChange(emp, d, false);
            const movedCareer = steady ? stayCareer : careerChange(emp, d, true);
            const stay = projectEmployeePPH(emp, fromCtx, {
              specialization: specializationAfter(emp, fromComp.itemCode, d),
              bonusDelta: stayCareer.percent, statDelta: stayCareer.stat,
            });
            const moved = projectEmployeePPH(emp, fromCtx, {
              ...change,
              specialization: specializationAfter(emp, steady ? fromComp.itemCode : toComp.itemCode, d),
              happinessDelta: !steady && d < RULES.movePenaltyDays ? -RULES.moveHappinessPenalty : 0,
              bonusDelta: managerDelta + movedCareer.percent, statDelta: movedCareer.stat,
            });
            return (moved * goldPerPP - stay * fromGoldPerPP) * 24;
          };
          const dailyGain = gainOnDay(TRANSITION_DAYS);
          if (dailyGain > (best ? best.dailyGain : 0)) best = { toComp, change, gainOnDay, dailyGain };
        }

        if (best) {
          const { dailyGain, transitionLoss, paybackDays } = compareOverTime(best.gainOnDay);
          suggestions.push({
            employee: emp,
            fromCompany: fromComp,
            toCompany: best.toComp,
            currentNetPerDay,
            newNetPerDay: currentNetPerDay + dailyGain,
            dailyGain,
            moveLoss: transitionLoss,
            paybackDays,
            fromTax: fromCtx.taxPct,
            toTax: best.change.taxPct,
            happinessDelta: (fromCtx.taxPct - best.change.taxPct) * RULES.taxHappinessPerPercent * happinessLossFactor(emp),
          });
        }
      }
    }
    return suggestions.sort((a, b) => b.dailyGain - a.dailyGain);
  }

  // Why no employee data is shown.
  function getEmployeeStateText() {
    switch (employeeStatus.state) {
      case "off": return L.rosterUnavailable;
      case "noKey": return L.employeesNeedKey;
      case "mismatch": return L.employeesKeyMismatch;
      case "empty": return L.employeesEmpty;
      case "error":
        return /UNAUTHORIZED|FORBIDDEN|\b40[13]\b/.test(employeeStatus.error || "")
          ? L.employeesKeyInvalid
          : L.employeesLoadFailed(employeeStatus.error);
      default: return "";
    }
  }

  // Employee events waiting for the owner's decision (soonest deadline first), and outcomes the
  // game decided on its own because nobody answered in time.
  function getEventSummary() {
    const now = Date.now();
    const pending = [];
    let autoDecided = 0;
    for (const ev of employeeEvents) {
      const company = companies.find(c => String(c._id) === eventCompanyId(ev));
      if (!company) continue;
      if (ev.status === "pending") {
        const expires = Date.parse(ev.expiresAt);
        pending.push({ event: ev, company, hoursLeft: Number.isFinite(expires) ? (expires - now) / 3600000 : null });
      } else if (ev.status === "resolved" && ev.outcome?.auto && !ev.seenAt) {
        autoDecided++;
      }
    }
    pending.sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity));
    return { pending, autoDecided };
  }

  // ── Render ──
  const TH = getTH();
  const TD = getTD;
  const hasData = companies.length > 0;

  const enemyWarnings = hasData ? getEnemyWarnings() : [];
  const wageWarnings = hasData ? getWageLossWarnings() : [];
  const coreSuggestions = hasData ? getCoreRegionSuggestions() : [];
  const allProducts = hasData ? getAllProductsRanked() : [];
  const globalOptimization = hasData ? getGlobalOptimization() : [];
  const employeeOptimization = hasData ? getEmployeeOptimization() : [];
  const totalWarnings = enemyWarnings.length + wageWarnings.length;

  const empState = employeeStatus.state;
  const employeesKnown = hasData && empState === "ok";
  const employeeStateText = getEmployeeStateText();
  const totalEmployees = employeesKnown ? companies.reduce((s, c) => s + getEmployees(c).length, 0) : 0;
  const anyEstimateMissing = employeesKnown && companies.some(c => getEmployees(c).some(e => !empHasEstimate(e)));
  const eventSummary = hasData ? getEventSummary() : { pending: [], autoDecided: 0 };

  const optimizerProps = hasData ? {
    liquidAssets: userData?.liquidAssets || 0,
    totalWealth: userData?.totalWealth || 0,
    totalCompaniesValue: userData?.totalCompaniesValue || 0,
    prices: prices,
    bestProduct: allProducts[0],
    facs: companies.map(c => {
      const goldPerPP = calcGoldPerPP(c.itemCode);
      return {
        level: c.activeUpgradeLevels?.automatedEngine || 1,
        name: c.name || c.itemCode,
        item: c.itemCode,
        goldPerLevelPerDay: 24 * goldPerPP,
        workerGoldPerDay: calcEmployeesPPDay(c) * goldPerPP - calcDailyCost(c),
      };
    })
  } : null;

  return (
    <div>
      {/* User Input */}
      <GlassCard style={{ padding: "20px 24px" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ width: "100%", maxWidth: "600px" }}>
            <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                  <Sec icon="&#128100;">{L.sectionPlayer}</Sec>
                </div>
                <Tip text={L.tipPlayerInput}>
                  <input
                    value={userInput} onChange={e => setUserInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && !loading && loadData()}
                    placeholder={L.placeholderPlayer}
                    style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 8, color: C.text, padding: "10px 14px", fontSize: 14, fontFamily: F.m, outline: "none", width: "100%", boxSizing: "border-box" }}
                  />
                </Tip>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                  <Sec icon="&#128273;">{L.sectionApiKey}</Sec>
                </div>
                <Tip text={L.tipApiKey} wrap>
                  <input
                    type="password"
                    value={apiKey} onChange={e => setApiKey(e.target.value)}
                    placeholder="wae_..."
                    style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 8, color: C.text, padding: "10px 14px", fontSize: 14, fontFamily: F.m, outline: "none", width: "100%", boxSizing: "border-box" }}
                  />
                </Tip>
                {!apiKey && <div style={{ fontSize: 11, color: C.accent, marginTop: 6, textAlign: "center" }}>{L.apiKeyRequiredForWorkers}</div>}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Btn on big color={C.accent} onClick={loadData} disabled={loading || !userInput.trim()}>
                {loading ? loadingMsg || L.loadingGeneric : L.btnLoadData}
              </Btn>
            </div>
          </div>
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12, fontFamily: F.m, color: C.red, textAlign: "center" }}>{error}</div>}
        {userData && !loading && (
          <div style={{ marginTop: 12, fontSize: 12, fontFamily: F.m, color: C.green, textAlign: "center" }}>
            {L.successLoaded(userData.username, companies.length)}
            {ownerCountry && <span>{L.successCountry(ownerCountry.name)}</span>}
            {employeesKnown && <span>{L.successEmployees(totalEmployees)}</span>}
            {hasData && !employeesKnown && <div style={{ color: C.accent, marginTop: 4 }}>{employeeStateText}</div>}
            {employeesKnown && eventStatus.state === "error" && <div style={{ color: C.accent, marginTop: 4 }}>{L.eventsFailed}</div>}
            {anyEstimateMissing && <div style={{ color: C.textMuted, marginTop: 4 }}>{L.estimateFallbackNote}</div>}
          </div>
        )}
      </GlassCard>

      {/* Warnings Banner */}
      {totalWarnings > 0 && (
        <GlassCard glow="rgba(248,113,113,0.3)" style={{ borderColor: C.red + "44" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 24 }}>&#9888;</span>
            <div>
              <div style={{ fontFamily: F.h, fontSize: 15, fontWeight: 700, color: C.red, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {L.warningsTitle(totalWarnings)}
              </div>
              <div style={{ fontSize: 12, color: C.textDim }}>
                {enemyWarnings.length > 0 && <span>{L.warningEnemy(enemyWarnings.length)} &middot; </span>}
                {wageWarnings.length > 0 && <span>{L.warningWage(wageWarnings.length)}</span>}
              </div>
            </div>
          </div>
        </GlassCard>
      )}

      {!hasData && !loading && (
        <GlassCard>
          <div style={{ textAlign: "center", color: C.textMuted, padding: "40px 0" }}>
            {L.emptyState}
          </div>
        </GlassCard>
      )}

      {hasData && (
        <>
          {/* Sub-Tab Navigation */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
            {[
              { key: "overview", label: L.tabOverview, icon: "&#127981;" },
              { key: "optimize", label: L.tabOptimize, icon: "&#128161;" },
              { key: "market", label: L.tabMarket, icon: "&#128176;" },
              { key: "optimizer_build", label: L.tabOptimizerBuild, icon: "&#127976;" },
            ].map(t => (
              <Btn key={t.key} on={subTab === t.key} onClick={() => setSubTab(t.key)} color={C.accent}>
                <span dangerouslySetInnerHTML={{ __html: t.icon }} /> {t.label}
              </Btn>
            ))}
          </div>

          {/* ── OVERVIEW TAB ── */}
          {subTab === "overview" && (
            <GlassCard style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px 8px" }}>
                <Sec icon="&#127981;">{L.sectionFactoryOverview(companies.length)}</Sec>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: -10, marginBottom: 8 }}>
                  {employeesKnown ? L.tipClickWorkerDetails : L.engineOnlyNote}
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
                  <thead><tr>
                    <th style={TH}>{L.colName}</th>
                    <th style={TH}>{L.colProduct}</th>
                    <th style={TH}>{L.colEngine}</th>
                    <th style={TH}>{L.colStorage}</th>
                    <th style={TH}>{L.colRegion}</th>
                    <th style={TH}><Tip text={L.tipCore}><span>{L.colCore}</span></Tip></th>
                    <th style={TH}>{L.colWorkers}</th>
                    <th style={TH}>{L.colEnginePP}</th>
                    <th style={TH}>{L.colWorkerPP}</th>
                    <th style={TH}>{L.colTotalPP}</th>
                    <th style={TH}>{L.colRevenue}</th>
                    <th style={TH}>{L.colCost}</th>
                    <th style={TH}>{L.colProfit}</th>
                    <th style={TH}>{L.colStatus}</th>
                  </tr></thead>
                  <tbody>
                    {companies.map((comp, i) => {
                      const compId = comp._id;
                      const emps = getEmployees(comp);
                      const cap = getEmployeeCap(comp);
                      const core = isCoreRegion(comp);
                      const enginePP = calcEnginePPDay(comp);
                      const empPPTotal = calcEmployeesPPDay(comp);
                      const ppDay = enginePP + empPPTotal;
                      const revenue = calcDailyRevenue(comp);
                      const cost = calcDailyCost(comp);
                      const profit = calcDailyProfit(comp);
                      const isEnemy = enemyWarnings.some(w => w.company._id === compId);
                      const inBattle = hasActiveBattle(comp);
                      const hasWageLoss = wageWarnings.some(w => w.company._id === compId);
                      const leavers = getLeavers(comp);
                      const quitRisk = emps.some(e => empQuitChance(e) > 0);
                      const pendingHere = eventSummary.pending.filter(p => p.company._id === compId).length;
                      const allClear = !isEnemy && !inBattle && !hasWageLoss && !leavers.length && !quitRisk && !pendingHere
                        && eventStatus.state !== "error";
                      const canExpand = employeesKnown && (emps.length > 0 || leavers.length > 0);
                      const isExpanded = expandedCompany === compId;

                      return [
                        <tr key={compId} onClick={() => canExpand && setExpandedCompany(isExpanded ? null : compId)}
                          style={{ background: i % 2 ? C.rowAlt : "transparent", cursor: canExpand ? "pointer" : "default",
                            outline: isExpanded ? "1px solid " + C.accent + "44" : "none" }}>
                          <td style={TD(false)}>
                            {canExpand && <span style={{ marginRight: 6, fontSize: 10, color: C.accent }}>{isExpanded ? "▼" : "▶"}</span>}
                            {comp.name || L.factoryFallback(i)}
                          </td>
                          <td style={TD(false)}>{comp.itemCode}</td>
                          <td style={TD(true)}>Lv {comp.activeUpgradeLevels?.automatedEngine || 1}</td>
                          <td style={TD(false)}>Lv {comp.activeUpgradeLevels?.storage || 1}</td>
                          <td style={TD(false)}>
                            <div style={{ fontSize: 13 }}>{getRegionName(comp)}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>{getCountryName(comp.region)} &middot; {L.taxShort(fmt(getIncomeTaxPct(comp.region), 0))}</div>
                          </td>
                          <td style={{ ...TD(false), color: core ? C.green : C.textMuted }}>
                            {core ? L.coreYes : L.coreNo}
                          </td>
                          <td style={{ ...TD(false), color: employeesKnown ? C.text : C.textMuted }}>
                            {employeesKnown ? getUsedSlots(comp) : "?"}/{cap}
                          </td>
                          <td style={{ ...TD(false), color: C.blue }}>{fmt(enginePP, 1)}</td>
                          <td style={{ ...TD(false), color: empPPTotal > 0 ? C.purple : C.textMuted }}>
                            {empPPTotal > 0 ? fmt(empPPTotal, 1) : "-"}
                          </td>
                          <td style={{ ...TD(false), fontWeight: 700 }}>{fmt(ppDay, 1)}</td>
                          <td style={{ ...TD(false), color: C.accent }}>{fmt(revenue, 2)} G</td>
                          <td style={{ ...TD(false), color: cost > 0 ? C.red : C.textMuted }}>
                            {cost > 0 ? fmt(cost, 2) + " G" : "-"}
                          </td>
                          <td style={{ ...TD(false), color: profit >= 0 ? C.green : C.red, fontWeight: 700 }}>
                            {fmt(profit, 2)} G
                          </td>
                          <td style={TD(false)}>
                            {isEnemy && <Bdg color={C.red}>{L.badgeEnemy}</Bdg>}
                            {inBattle && <Tip text={L.tipBattle}><span><Bdg color="#ff9900">{L.badgeBattle}</Bdg></span></Tip>}
                            {hasWageLoss && <Bdg color="#ff9900">{L.badgeWageLoss}</Bdg>}
                            {leavers.length > 0 && <Tip text={L.tipLeft} wrap><span><Bdg color="#ff9900">{L.badgeLeft}</Bdg></span></Tip>}
                            {quitRisk && <Tip text={L.tipQuitRisk} wrap><span><Bdg color={C.red}>{L.badgeQuitRisk}</Bdg></span></Tip>}
                            {pendingHere > 0 && <Tip text={L.tipDecision} wrap><span><Bdg color={C.blue}>{L.badgeDecision(pendingHere)}</Bdg></span></Tip>}
                            {!getPPPerUnit(comp.itemCode) && <Bdg color={C.red}>{L.badgeConfigMissing}</Bdg>}
                            {allClear && getPPPerUnit(comp.itemCode) && <Bdg color={C.green}>{L.badgeOk}</Bdg>}
                          </td>
                        </tr>,
                        // Expanded employee details
                        isExpanded && canExpand && (
                          <tr key={compId + "-employees"}>
                            <td colSpan={14} style={{ padding: 0, background: "rgba(0,0,0,0.2)" }}>
                              <div style={{ padding: "12px 20px 12px 36px" }}>
                                <div style={{ fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
                                  {L.employeeDetailsTitle(getUsedSlots(comp), cap)}
                                  <span style={{ color: core ? C.green : C.textMuted, marginLeft: 12, fontSize: 11 }}>{core ? L.coreDetailYes : L.coreDetailNo}</span>
                                </div>
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                  <thead><tr>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colEmployee}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colStats}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colHappiness}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colTraits}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colTool}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colPotential}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colPPH}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colPPDay}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colWageH}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colCostDay}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colNetDay}</th>
                                  </tr></thead>
                                  <tbody>
                                    {emps.map((emp, ei) => {
                                      const pph = calcEmployeePPH(emp, empCtx(comp));
                                      const ppDayE = pph * 24;
                                      const wageH = empWagePerHour(emp);
                                      const costDay = wageH * 24;
                                      const netDay = calcEmployeeNetDay(emp, comp);
                                      const outputKnown = empOutputKnown(emp);
                                      const happiness = empHappiness(emp);
                                      const quitChance = empQuitChance(emp);
                                      const traits = empTraits(emp);
                                      const tool = empToolInfo(emp);
                                      const toolPct = toolBonusNow(tool, comp.itemCode);
                                      const potential = typeof emp.potential === "number" ? emp.potential : null;
                                      const potentialMax = typeof emp.potentialMax === "number" ? emp.potentialMax : null;
                                      const happinessColor = happiness >= RULES.happinessGood ? C.green : happiness >= RULES.happinessQuitThreshold ? C.textDim : C.red;
                                      const stat = s => { const v = statValue(emp, s); return v == null ? "?" : fmt(v, 0); };
                                      return (
                                        <tr key={emp._id || ei} style={{ background: ei % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                                          <td style={{ ...TD(false), fontSize: 13 }}>
                                            {emp.name || L.employeeFallback(ei)}
                                            {typeof emp.age === "number" && <span style={{ color: C.textMuted, fontSize: 10, marginLeft: 6 }}>{L.ageLabel(emp.age)}</span>}
                                            {isAway(emp) && <Tip text={L.tipAway} wrap><span style={{ color: "#ff9900", fontSize: 10, marginLeft: 6 }}>{L.awayLabel}</span></Tip>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, whiteSpace: "nowrap" }}>
                                            <span style={{ color: C.blue }}>{stat("production")}</span>
                                            <span style={{ color: C.textMuted }}> / </span>
                                            <span style={{ color: C.accent }}>{stat("luck")}</span>
                                            <span style={{ color: C.textMuted }}> / </span>
                                            <span style={{ color: C.purple }}>{stat("responsibility")}</span>
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: happinessColor }}>
                                            {fmt(Math.round(happiness), 0)}
                                            {quitChance > 0 && <div style={{ fontSize: 9, color: C.red }}>{L.quitChance(fmt(quitChance * 100, 1))}</div>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 11, color: C.textDim }}>
                                            {traits.revealed.length > 0 && traits.revealed.map(formatCodeName).join(", ")}
                                            {traits.hiddenCount > 0 && <span style={{ color: C.textMuted }}>{traits.revealed.length > 0 ? " · " : ""}{L.hiddenTraits(traits.hiddenCount)}</span>}
                                            {!traits.revealed.length && !traits.hiddenCount && <span style={{ color: C.textMuted }}>-</span>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 11, color: C.textDim }}>
                                            {tool ? (
                                              <div>
                                                <div>
                                                  {tool.code}
                                                  {toolPct > 0
                                                    ? <span style={{ color: C.green }}> +{fmt(toolPct, 0)}%</span>
                                                    : <span style={{ color: "#ff9900" }}> {tool.broken ? L.toolBroken : L.toolIdle}</span>}
                                                </div>
                                                {tool.durability != null && <div style={{ fontSize: 9, color: C.textMuted }}>{fmt(tool.durability, 0)}/{fmt(tool.maxDurability, 0)}</div>}
                                              </div>
                                            ) : <span style={{ color: C.textMuted }}>-</span>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.textDim }}>
                                            {potential != null ? `${potential}${potentialMax != null ? "/" + potentialMax : ""}` : "-"}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.purple, fontWeight: 700 }}>
                                            {outputKnown ? fmt(pph, 2) : "?"}
                                            {!empHasEstimate(emp) && <span title={L.estimateFallbackNote} style={{ color: C.textMuted, fontSize: 9, marginLeft: 4 }}>~</span>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.purple }}>{outputKnown ? fmt(ppDayE, 1) : "?"}</td>
                                          <td style={{ ...TD(false), fontSize: 13 }}>{fmt(wageH, 3)} G</td>
                                          <td style={{ ...TD(false), fontSize: 13, color: costDay > 0 ? C.red : C.textMuted }}>
                                            {costDay > 0 ? fmt(costDay, 2) + " G" : "-"}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: !outputKnown ? C.textMuted : netDay >= 0 ? C.green : C.red, fontWeight: 700 }}>
                                            {outputKnown ? fmt(netDay, 2) + " G" : "?"}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    {leavers.map((emp, li) => (
                                      <tr key={emp._id || "left-" + li} style={{ opacity: 0.7 }}>
                                        <td style={{ ...TD(false), fontSize: 13 }}>{emp.name || L.employeeFallback(emps.length + li)}</td>
                                        <td colSpan={10} style={{ ...TD(false), fontSize: 12, color: "#ff9900" }}>
                                          {L.employeeLeft(L.leaveReasons[emp.leaveReason] || formatCodeName(emp.leaveReason || "?"))}
                                        </td>
                                      </tr>
                                    ))}
                                    <tr style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                                      <td colSpan={6} style={{ ...TD(false), fontSize: 12, fontWeight: 700, color: C.textDim, textAlign: "right" }}>{L.sumEmployees}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.purple, fontWeight: 700 }}>{fmt(empPPTotal / 24, 2)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.purple, fontWeight: 700 }}>{fmt(empPPTotal, 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.textMuted }}>-</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.red, fontWeight: 700 }}>{fmt(cost, 2)} G</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.textMuted }}>-</td>
                                    </tr>
                                    <tr>
                                      <td colSpan={6} style={{ ...TD(false), fontSize: 12, fontWeight: 700, color: C.textDim, textAlign: "right" }}>{L.engineRow(comp.activeUpgradeLevels?.automatedEngine || 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.blue, fontWeight: 700 }}>{fmt(enginePP / 24, 2)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.blue, fontWeight: 700 }}>{fmt(enginePP, 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.textMuted }}>-</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.textMuted }}>-</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.textMuted }}>-</td>
                                    </tr>
                                    <tr style={{ borderTop: "1px solid " + C.accent + "44" }}>
                                      <td colSpan={6} style={{ ...TD(false), fontSize: 13, fontWeight: 700, color: C.accent, textAlign: "right" }}>{L.totalRow}</td>
                                      <td style={{ ...TD(false), fontSize: 14, color: C.accent, fontWeight: 700 }}>{fmt(ppDay / 24, 2)}</td>
                                      <td style={{ ...TD(false), fontSize: 14, color: C.accent, fontWeight: 700 }}>{fmt(ppDay, 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.textMuted }}>-</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.red, fontWeight: 700 }}>{fmt(cost, 2)} G</td>
                                      <td style={{ ...TD(false), fontSize: 14, color: profit >= 0 ? C.green : C.red, fontWeight: 700 }}>{fmt(profit, 2)} G</td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
              {/* Totals */}
              <div style={{ padding: "12px 20px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 24, flexWrap: "wrap" }}>
                <div><span style={{ color: C.textMuted, fontSize: 12 }}>{L.totalPPDay}</span> <span style={{ color: C.accent, fontWeight: 700, fontFamily: F.h, fontSize: 18 }}>{fmt(companies.reduce((s, c) => s + calcCompanyPPDay(c), 0), 1)}</span></div>
                <div><span style={{ color: C.textMuted, fontSize: 12 }}>{L.totalRevenue}</span> <span style={{ color: C.accent, fontWeight: 700, fontFamily: F.h, fontSize: 18 }}>{fmt(companies.reduce((s, c) => s + calcDailyRevenue(c), 0), 2)} G</span></div>
                <div><span style={{ color: C.textMuted, fontSize: 12 }}>{L.totalCost}</span> <span style={{ color: C.red, fontWeight: 700, fontFamily: F.h, fontSize: 18 }}>{fmt(companies.reduce((s, c) => s + calcDailyCost(c), 0), 2)} G</span></div>
                <div><span style={{ color: C.textMuted, fontSize: 12 }}>{L.totalProfit}</span> <span style={{ color: C.green, fontWeight: 700, fontFamily: F.h, fontSize: 18 }}>{fmt(companies.reduce((s, c) => s + calcDailyProfit(c), 0), 2)} G</span></div>
              </div>
            </GlassCard>
          )}

          {/* ── OPTIMIZATION TAB ── */}
          {subTab === "optimize" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Employee features need documented API support and the owner's API key */}
              {!employeesKnown && (
                <GlassCard style={{ borderColor: C.accent + "44" }}>
                  <Sec icon="&#9203;">{empState === "off" ? L.sectionEmployeePending : L.sectionEmployeeMissing}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim }}>{empState === "off" ? L.employeeFeaturesPending : employeeStateText}</div>
                </GlassCard>
              )}

              {/* Employee events waiting for a decision */}
              {employeesKnown && eventStatus.state !== "off" && (
                <GlassCard glow={eventSummary.pending.length > 0 ? C.blueGlow : undefined}>
                  <Sec icon="&#128276;">{L.sectionEvents(eventStatus.state === "ok" ? eventSummary.pending.length : "?")}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>{L.eventsDesc}</div>
                  {eventStatus.state !== "ok" ? (
                    <div style={{ fontSize: 12, color: C.accent }}>{L.eventsFailed}</div>
                  ) : eventSummary.pending.length === 0 ? (
                    <div style={{ padding: "16px", textAlign: "center", color: C.green, background: "rgba(0,255,0,0.05)", borderRadius: 8, border: "1px solid " + C.green + "44" }}>
                      {L.eventsNone}
                    </div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead><tr>
                        <th style={TH}>{L.colName}</th>
                        <th style={TH}>{L.colEvent}</th>
                        <th style={TH}>{L.colEmployee}</th>
                        <th style={TH}>{L.colTimeLeft}</th>
                      </tr></thead>
                      <tbody>
                        {eventSummary.pending.map((p, i) => (
                          <tr key={p.event._id || i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                            <td style={TD(false)}>{p.company.name || p.company.itemCode}</td>
                            <td style={TD(false)}>{formatCodeName(p.event.code || "?")}</td>
                            <td style={TD(false)}>
                              {(Array.isArray(p.event.cast) ? p.event.cast : []).map((c, ci) => c?.name || L.employeeFallback(ci)).join(", ") || "-"}
                            </td>
                            <td style={{ ...TD(false), fontWeight: 700, color: p.hoursLeft != null && p.hoursLeft < 6 ? C.red : C.accent }}>
                              {p.hoursLeft == null ? "?" : p.hoursLeft <= 0 ? L.eventExpiring : fmtT(p.hoursLeft)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {eventSummary.autoDecided > 0 && (
                    <div style={{ marginTop: 10, fontSize: 12, color: C.accent }}>{L.eventsAutoDecided(eventSummary.autoDecided)}</div>
                  )}
                </GlassCard>
              )}

              {/* Enemy Warnings */}
              {enemyWarnings.length > 0 && (
                <GlassCard glow="rgba(248,113,113,0.2)" style={{ borderColor: C.red + "33" }}>
                  <Sec icon="&#9876;">{L.sectionEnemyWarnings(enemyWarnings.length)}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                    {L.enemyWarningDesc(ownerCountry?.name)}
                  </div>
                  {enemyWarnings.map((w, i) => (
                    <div key={i} style={{ ...glass(0.08, 10), borderRadius: 8, padding: "12px 16px", marginBottom: 8, borderColor: C.red + "33" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <span style={{ fontWeight: 700, color: C.text }}>{w.company.name || w.company.itemCode}</span>
                          <span style={{ color: C.textMuted, marginLeft: 8 }}>({w.company.itemCode})</span>
                        </div>
                        <Bdg color={C.red}>{w.factoryCountry.name}</Bdg>
                      </div>
                      <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>
                        {L.enemyWorkerWarning(w.employeeCount)}
                      </div>
                    </div>
                  ))}
                </GlassCard>
              )}

              {/* Wage Loss Warnings */}
              {wageWarnings.length > 0 && (
                <GlassCard glow="rgba(255,153,0,0.15)" style={{ borderColor: "#ff990033" }}>
                  <Sec icon="&#128184;">{L.sectionWageWarnings(wageWarnings.length)}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                    {L.wageWarningDesc}
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={TH}>{L.colName}</th>
                      <th style={TH}>{L.colEmployee}</th>
                      <th style={TH}>{L.colWageH}</th>
                      <th style={TH}>{L.colMaxWage}</th>
                      <th style={TH}>{L.colCost}</th>
                      <th style={TH}>{L.colRevenue}</th>
                      <th style={TH}>{L.colProfit}</th>
                    </tr></thead>
                    <tbody>
                      {wageWarnings.map((w, i) => (
                        <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={TD(false)}>{w.company.name || w.company.itemCode}</td>
                          <td style={TD(false)}>
                            <div>{w.employee.name || L.employeeFallback(i)}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>
                              P:{(p => p == null ? "?" : fmt(p, 0))(statValue(w.employee, "production"))} · {L.colHappiness} {fmt(Math.round(empHappiness(w.employee)), 0)}
                            </div>
                          </td>
                          <td style={{ ...TD(false), color: C.red }}>{fmt(empWagePerHour(w.employee), 3)} G</td>
                          <td style={{ ...TD(false), color: C.green }}>{fmt(w.breakEvenWagePerH, 3)} G</td>
                          <td style={{ ...TD(false), color: C.red }}>{fmt(w.dailyWage, 2)} G</td>
                          <td style={{ ...TD(false), color: C.green }}>{fmt(w.dailyContribution, 2)} G</td>
                          <td style={{ ...TD(false), color: C.red, fontWeight: 700 }}>-{fmt(w.loss, 2)} G</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </GlassCard>
              )}

              {/* Core region check */}
              <GlassCard glow={coreSuggestions.length > 0 ? C.greenGlow : undefined}>
                <Sec icon="&#127968;">{L.sectionCoreRegions(coreSuggestions.length)}</Sec>
                <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                  {L.coreRegionsDesc}
                </div>
                {coreSuggestions.length === 0 ? (
                  !employeesKnown ? (
                    <div style={{ padding: "16px", textAlign: "center", color: C.textDim, background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}>
                      {empState === "off" ? L.employeeFeaturesPendingShort : employeeStateText}
                    </div>
                  ) : (
                    <div style={{ padding: "16px", textAlign: "center", color: C.green, background: "rgba(0,255,0,0.05)", borderRadius: 8, border: "1px solid " + C.green + "44" }}>
                      {L.allCoreRegions}
                    </div>
                  )
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={TH}>{L.colName}</th>
                      <th style={TH}>{L.colCurrent}</th>
                      <th style={TH}></th>
                      <th style={TH}>{L.colHomeRegion}</th>
                      <th style={TH}>{L.colExtraGain}</th>
                      <th style={TH}>{L.colMoveCost}</th>
                      <th style={TH}>{L.colPayback}</th>
                    </tr></thead>
                    <tbody>
                      {coreSuggestions.map((s, i) => (
                        <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={TD(false)}>
                            <div>{s.company.name || s.company.itemCode}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>{s.company.itemCode}</div>
                          </td>
                          <td style={TD(false)}>
                            <div>{s.currentRegion?.name || "?"}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>{getCountryName(s.company.region)} &middot; {L.taxShort(fmt(s.fromTax, 0))}</div>
                          </td>
                          <td style={{ ...TD(false), color: C.accent, fontSize: 18 }}>&rarr;</td>
                          <td style={TD(false)}>
                            <div style={{ color: C.green }}>{s.homeRegion?.name || ownerCountry?.name || "?"}</div>
                            <div style={{ fontSize: 10, color: C.green }}>{L.coreYes} &middot; {L.taxShort(fmt(s.toTax, 0))}</div>
                          </td>
                          <td style={{ ...TD(false), color: s.dailyGain >= 0 ? C.green : C.red, fontWeight: 700 }}>{s.dailyGain >= 0 ? "+" : ""}{fmt(s.dailyGain, 2)} G</td>
                          <td style={{ ...TD(false), color: C.textDim }}>
                            <div>{fmt(s.relocCost, 2)} G{s.concreteNeeded === 0 && <span style={{ color: C.green, fontSize: 10, marginLeft: 6 }}>{L.freeMove}</span>}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>{L.moveCostBreakdown(fmt(s.concreteCost, 2), fmt(s.happinessLoss, 2))}</div>
                          </td>
                          <td style={{ ...TD(false), fontWeight: 700, color: s.paybackDays <= 7 ? C.green : s.paybackDays <= 30 ? C.accent : C.red }}>
                            {s.paybackDays === Infinity ? L.never : L.days(fmt(s.paybackDays, 1))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </GlassCard>

              {/* Employee Optimization */}
              {employeeOptimization.length > 0 && (
                <GlassCard glow={C.blueGlow}>
                  <Sec icon="&#128101;">{L.sectionEmployeeOpt(employeeOptimization.length)}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                    {L.employeeOptDesc}
                  </div>
                  {employeeOptimization.map((s, i) => (
                    <div key={i} style={{ ...glass(0.08, 10), borderRadius: 8, padding: "12px 16px", marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <div>
                          <span style={{ color: C.accent, fontWeight: 700 }}>{s.employee.name || L.employeeFallback(i)}</span>
                          <span style={{ color: C.textDim, margin: "0 8px" }}>{L.wordFrom}</span>
                          <span style={{ color: C.text, fontWeight: 600 }}>{s.fromCompany.name || s.fromCompany.itemCode}</span>
                          <span style={{ color: C.textDim, fontSize: 12 }}> ({s.fromCompany.itemCode}, {fmt(s.currentNetPerDay, 2)} G/d)</span>
                          <span style={{ color: C.accent, margin: "0 10px", fontSize: 16 }}>&rarr;</span>
                          <span style={{ color: C.green, fontWeight: 600 }}>{s.toCompany.name || s.toCompany.itemCode}</span>
                          <span style={{ color: C.green, fontSize: 12 }}> ({s.toCompany.itemCode}, {fmt(s.newNetPerDay, 2)} G/d)</span>
                        </div>
                        <Bdg color={C.green}>+{fmt(s.dailyGain, 2)} G/d</Bdg>
                      </div>
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                        <div style={{ color: C.textDim }}>
                          {L.incomeTax}{" "}
                          <span style={{ color: C.text }}>{fmt(s.fromTax, 1)}%</span>
                          <span style={{ margin: "0 6px" }}>&rarr;</span>
                          <span style={{ color: s.toTax <= s.fromTax ? C.green : C.red }}>{fmt(s.toTax, 1)}%</span>
                          <span style={{ marginLeft: 8, color: C.textDim }}>
                            {L.movePenaltyLine(fmt(s.moveLoss, 2), s.paybackDays === Infinity ? L.never : L.days(fmt(s.paybackDays, 1)))}
                          </span>
                        </div>
                        <Bdg color={s.happinessDelta >= 0 ? C.green : C.red}>
                          {L.happinessDeltaBadge((s.happinessDelta >= 0 ? "+" : "") + fmt(s.happinessDelta, 0))}
                        </Bdg>
                      </div>
                    </div>
                  ))}
                </GlassCard>
              )}

              {/* Global Optimization */}
              <GlassCard glow={globalOptimization.length > 0 ? C.accentGlow : undefined}>
                <Sec icon="&#128260;">{L.sectionGlobalOpt(globalOptimization.length)}</Sec>
                <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                  {L.globalOptDesc}
                </div>
                {globalOptimization.length === 0 ? (
                  <div style={{ padding: "16px", textAlign: "center", color: C.green, background: "rgba(0,255,0,0.05)", borderRadius: 8, border: "1px solid " + C.green + "44" }}>
                    {L.allOptimalGlobal}
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={TH}>{L.colName}</th>
                      <th style={TH}>{L.colCurrent}</th>
                      <th style={TH}></th>
                      <th style={TH}>{L.colGlobalRec}</th>
                      <th style={TH}>{L.colOldProfit}</th>
                      <th style={TH}>{L.colNewProfit}</th>
                      <th style={TH}>{L.colExtraProfit}</th>
                      <th style={TH}>{L.colConcrete}</th>
                      <th style={TH}>{L.colPayback}</th>
                    </tr></thead>
                    <tbody>
                      {globalOptimization.map((s, i) => (
                        <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={TD(false)}>{s.company.name || "Fabrik"}</td>
                          <td style={TD(false)}>
                            <div>{s.currentItem}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>{s.currentRegion?.name} ({s.currentCore ? L.coreYes : L.coreNo})</div>
                          </td>
                          <td style={{ ...TD(false), color: C.accent, fontSize: 18 }}>&rarr;</td>
                          <td style={TD(false)}>
                            <div style={{ color: C.green, fontWeight: 700 }}>{s.newItem}</div>
                            <div style={{ fontSize: 10, color: C.green }}>{s.newRegion?.name} ({s.newCore ? L.coreYes : L.coreNo})</div>
                          </td>
                          <td style={{ ...TD(false), color: C.textDim }}>{fmt(s.currentProfit, 2)} G</td>
                          <td style={{ ...TD(false), color: C.green }}>{fmt(s.newProfit, 2)} G</td>
                          <td style={{ ...TD(false), color: C.green, fontWeight: 700 }}>+{fmt(s.dailyGain, 2)} G</td>
                          <td style={{ ...TD(false), color: s.concreteNeeded > 0 ? C.red : C.green }}>
                            {s.concreteNeeded} <span style={{fontSize:10}}>({fmt(s.concreteCost, 1)} G)</span>
                            {s.moveFree && <div style={{ fontSize: 10, color: C.green }}>{L.freeMove}</div>}
                            {s.transitionLoss > 0 && <div style={{ fontSize: 10, color: C.textMuted }}>{L.transitionLossLine(fmt(s.transitionLoss, 2))}</div>}
                          </td>
                          <td style={{ ...TD(false), fontWeight: 700, color: s.paybackDays <= 2 ? C.green : s.paybackDays <= 7 ? C.accent : C.red }}>
                            {L.days(fmt(s.paybackDays, 1))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </GlassCard>
            </div>
          )}

          {/* ── MARKET TAB ── */}
          {subTab === "market" && (
            <GlassCard style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px 8px" }}>
                <Sec icon="&#128176;">{L.sectionMarket}</Sec>
                <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                  {L.marketDesc}
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                  <thead><tr>
                    <th style={TH}>#</th>
                    <th style={TH}>{L.colName}</th>
                    <th style={TH}>{L.colType}</th>
                    <th style={TH}>{L.colSellPerUnit}</th>
                    <th style={TH}>{L.colMatCost}</th>
                    <th style={TH}>{L.colMargin}</th>
                    <th style={TH}>{L.colPPUnit}</th>
                    <th style={TH}>{L.colBaseMarginPP}</th>
                    <th style={TH}>{L.colYourFactories}</th>
                    <th style={TH}>{L.colYourProfit}</th>
                  </tr></thead>
                  <tbody>
                    {allProducts.map((p, i) => {
                      const isProducing = p.userCompanyCount > 0;
                      const needsStr = p.needs ? Object.entries(p.needs).map(([k, v]) => v + "× " + k).join(", ") : null;
                      return (
                        <tr key={p.itemCode} style={{
                          background: isProducing ? C.accent + "0a" : i % 2 ? C.rowAlt : "transparent",
                          borderLeft: isProducing ? "3px solid " + C.accent : "3px solid transparent",
                        }}>
                          <td style={{ ...TD(false), fontFamily: F.h, fontWeight: 700, color: i < 3 ? C.accent : C.textDim, fontSize: 16 }}>
                            {i + 1}
                          </td>
                          <td style={{ ...TD(false), fontWeight: 700 }}>
                            {p.itemCode}
                          </td>
                          <td style={{ ...TD(false), fontSize: 12 }}>
                            <Bdg color={p.type === "raw" ? C.blue : C.purple}>{p.type === "raw" ? L.badgeRaw : L.badgeProduct}</Bdg>
                          </td>
                          <td style={{ ...TD(false), color: C.accent }}>{fmt(p.price, 4)} G</td>
                          <td style={TD(false)}>
                            {p.materialCost > 0
                              ? <div>
                                  <span style={{ color: C.red }}>{fmt(p.materialCost, 4)} G</span>
                                  <div style={{ fontSize: 9, color: C.textMuted }}>{needsStr}</div>
                                </div>
                              : <span style={{ color: C.textMuted }}>-</span>
                            }
                          </td>
                          <td style={{ ...TD(false), color: p.netMargin > 0 ? C.green : C.red, fontWeight: 700 }}>
                            {fmt(p.netMargin, 4)} G
                          </td>
                          <td style={TD(false)}>{p.pp}</td>
                          <td style={{ ...TD(false), fontWeight: 700, color: i === 0 ? C.green : p.goldPerPP > 0 ? C.text : C.red, fontSize: 15 }}>
                            {fmt(p.goldPerPP, 4)} G
                          </td>
                          <td style={TD(false)}>
                            {isProducing
                              ? <span style={{ color: C.accent }}>{L.factoriesCount(p.userCompanyCount)}</span>
                              : <span style={{ color: C.textMuted }}>-</span>
                            }
                          </td>
                          <td style={TD(false)}>
                            {isProducing
                              ? <span style={{ color: p.userTotalProfit >= 0 ? C.green : C.red, fontWeight: 700 }}>
                                  {p.userTotalProfit >= 0 ? "+" : ""}{fmt(p.userTotalProfit, 2)} G
                                </span>
                              : <span style={{ color: C.textMuted }}>-</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          )}

          {/* ── OPTIMIZER BUILD TAB ── */}
          {subTab === "optimizer_build" && optimizerProps && (
            <FactoryOptimizer theme={theme} setTheme={setTheme} optData={optimizerProps} lang={lang} />
          )}
        </>
      )}
    </div>
  );
}
