import { useState, useEffect, useRef, useMemo } from "react";
import { THEMES, C, F, setThemeVars, glass, fmt, fmtT, fmtN, GlassCard, Sec, Bdg, Tip, Btn, getTH, getTD, apiCall, setActiveApiKey } from "./shared.jsx";
import FactoryOptimizer from "./factory-optimizer.jsx";
import WorkforceTab from "./workforce-tab.jsx";
import { getLang } from "./translations.jsx";
// The whole employee mechanic lives in employee-model.js (pure, tested against live data);
// the workforce tools build on employee-optimizer.js.
import {
  RULES, num, clamp, idString, hasLeft, traitList, hasTrait,
  rawStatValue, statValue, empHappiness, empQuitChance,
  empToolInfo, toolFitsGood, toolBonusNow, isAway, empWagePerHour, empHasEstimate,
  specializationPercent, specializationAfter, empBonusPercent, calcEmployeePPH,
  empOutputKnown, managerPercent, projectEmployeePPH, neutralize, compareOverTime,
  formatCodeName, TRANSITION_DAYS,
} from "./employee-model.js";
import { buildWorkforceModel, adviseAll } from "./employee-optimizer.js";

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

// WarEra v0.27.2 opened the employee procedures to personal API keys
// (https://app.warera.io/article/6ae2608f707baf45eebf26c5). The official Swagger
// (api2.warera.io/docs, spec version 0.17.4-beta) lags behind the live API; the community
// API explorer at https://warera.realmarijn.nl/api-explorer documents the full surface and
// confirms both procedure names (checked 2026-11-06):
//   employees: "employee.getMyEmployees" - no input; one flat array with the employees of all
//              the key owner's companies, each linked by `company` (company id).
//   events:    "employeeEvent.getMine"   - no input; array of events, company in cast[0].company.
// Both return only the key owner's own data, so they are only called with an API key.
const OFFICIAL_EMPLOYEE_ENDPOINTS = {
  employees: "employee.getMyEmployees",
  events: "employeeEvent.getMine",
};

// ── Helpers ──
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

  const [ppm, setPpm] = useState(null);           // gameStat.getPpMoneyValue (GET, game-wide)
  const [summary, setSummary] = useState(null);   // employee.getMyWorkforceSummary (key owner)
  const [reloading, setReloading] = useState(false);

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
    setSummary(null);
    const key = apiKey.trim();
    setActiveApiKey(key);
    try {
      // Phase 1: Resolve user + load global data in parallel. getPpMoneyValue is a void-input
      // procedure: only a bare GET works (POST with {} returns 400 "Expected void").
      const [user, pricesData, regionsData, countriesData, configData, ppmData] = await Promise.all([
        resolveUser(userInput.trim()),
        apiCall("itemTrading.getPrices", {}).catch(() => ({})),
        apiCall("region.getRegionsObject", {}).catch(() => ({})),
        apiCall("country.getAllCountries", {}).catch(() => []),
        apiCall("gameConfig.getGameConfig", {}).catch(() => null),
        apiCall("gameStat.getPpMoneyValue", undefined, 3, { method: "GET" }).catch(() => null),
      ]);
      if (stale()) return;

      setUserData(user);
      setPrices(pricesData || {});
      setGameConfig(configData);
      setPpm(typeof ppmData === "number" && ppmData > 0 ? ppmData : null);

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

      // Workforce key figures of the key owner (1 extra call, fire-and-forget).
      if (empStatus.state === "ok") {
        apiCall("employee.getMyWorkforceSummary")
          .then(s => { if (!stale()) setSummary(s || null); })
          .catch(() => {});
      }

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

  // Reloads only the key owner's employee data (3 calls), e.g. after executing plan steps in
  // the game. Throws on failure so the workforce tab can show the error.
  async function reloadEmployees() {
    const key = apiKey.trim();
    if (!key || !companies.length) return;
    setReloading(true);
    try {
      const [empsRes, evsRes, sumRes] = await Promise.all([
        apiCall(OFFICIAL_EMPLOYEE_ENDPOINTS.employees),
        apiCall(OFFICIAL_EMPLOYEE_ENDPOINTS.events).catch(() => null),
        apiCall("employee.getMyWorkforceSummary").catch(() => null),
      ]);
      const list = parseEmployeeList(empsRes);
      if (!list) throw new Error("UNEXPECTED_RESPONSE");
      const compIds = new Set(companies.map(c => String(c._id)));
      const empMap = {};
      for (const id of compIds) empMap[id] = [];
      let matched = 0;
      for (const emp of list) {
        const cid = idString(emp.company);
        if (compIds.has(cid)) { empMap[cid].push(emp); matched++; }
      }
      setEmployees(empMap);
      setEmployeeStatus({ state: matched > 0 ? "ok" : list.length > 0 ? "mismatch" : "empty", error: null });
      const events = parseEmployeeEvents(evsRes);
      setEmployeeEvents((events || []).filter(ev => compIds.has(eventCompanyId(ev))));
      setEventStatus({ state: events ? "ok" : "error", error: null });
      setSummary(sumRes || null);
    } finally {
      setReloading(false);
    }
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

  // The company context doubles as the full Place for projectEmployeePPH (geography traits,
  // storage, battle, manager). The game's estimate and productionBonus.total already contain a
  // hired manager's bonus; managementPoints only feeds the no-estimate fallback.
  function empCtx(comp) {
    const region = regions[comp.region];
    return {
      isCore: isCoreRegion(comp),
      managementPoints: getOwnerManagementPoints(),
      itemCode: comp.itemCode,
      itemType: getItemType(comp.itemCode),
      taxPct: getIncomeTaxPct(comp.region),
      regionCountry: region?.country ?? null,
      regionInitialCountry: region?.initialCountry ?? region?.country ?? null,
      storageLevel: comp.activeUpgradeLevels?.storage ?? null,
      regionAttacked: hasActiveBattle(comp),
      managerPct: getCompanyManagerPercent(comp),
      engineLevel: comp.activeUpgradeLevels?.automatedEngine || 1,
      disabled: getEmployees(comp).some(e => e.companyDisabled),
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
  // Deposits are disabled since v0.27 and region bonuses are gone: the engine makes level × 24
  // PP a day — doubled while a talksToMachines holder is the only employee (v0.27.4).
  function engineMult(comp) {
    const emps = getEmployees(comp);
    return emps.length === 1 && hasTrait(emps[0], "talksToMachines") ? 2 : 1;
  }

  function calcEnginePPDay(comp) {
    const engineLevel = comp.activeUpgradeLevels?.automatedEngine || 1;
    return engineLevel * 24 * engineMult(comp);
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
  // (The per-employee wage-loss list and the greedy employee moves were replaced by the
  // workforce tab: the advisor and the distribution plan compute both correctly, including
  // coworker traits and slot limits. The warning banner links there.)

  // Companies with employees outside the owner's core regions: moving the COMPANY home gives
  // +5 % and changes the tax and the geography traits (patriot/homesick/expat follow the
  // employee's nationality). Without a free move: -10 happiness for the first 7 days.
  function getCoreRegionSuggestions() {
    const suggestions = [];
    const betonPrice = getItemPrice("concrete") || 1;
    const homeRegion = getSuggestedHomeRegion();
    if (!homeRegion) return suggestions;
    const toTax = getIncomeTaxPct(homeRegion._id);
    const nowMs = Date.now();

    for (const comp of companies) {
      if (isCoreRegion(comp) || !hasEmployees(comp)) continue;
      const goldPerPP = calcGoldPerPP(comp.itemCode);
      const ctx = empCtx(comp);
      const emps = getEmployees(comp);
      const neutralOf = new Map(emps.map(e => [e, neutralize(e, ctx, [], nowMs)]));
      const targetPlace = {
        isCore: true,
        taxPct: toTax,
        regionCountry: homeRegion.country ?? userData?.country ?? null,
        regionInitialCountry: homeRegion.initialCountry ?? homeRegion.country ?? null,
      };
      // Without a free move the employees also get -10 happiness for the first 7 days.
      const penalty = hasFreeMove(comp) ? 0 : -RULES.companyMoveHappinessPenalty;
      const gainOnDay = (d, steady) => emps.reduce((s, emp) => {
        const neutral = neutralOf.get(emp);
        const stay = projectEmployeePPH(emp, ctx, { day: d, neutral, steady: !!steady }, nowMs);
        const moved = projectEmployeePPH(emp, ctx, {
          place: targetPlace, day: d, neutral, steady: !!steady,
          happinessDelta: !steady && d < RULES.movePenaltyDays ? penalty : 0,
        }, nowMs);
        return s + (moved - stay) * 24 * goldPerPP;
      }, 0);
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
      // The employees stay in the company (no transfer: tenure and coworkers unchanged), so
      // only specialization, tool fit, geography and tax effects move. For an unfitting tool
      // the better of keeping it idle (bonus 0) or returning it (handy off / improviser on)
      // counts; the row hints to re-equip in the game.
      const nowMs = Date.now();
      const neutralOf = new Map(emps.map(e => [e, neutralize(e, ctx, [], nowMs)]));
      let best = null;
      for (const prod of allProducts) {
        for (const opt of regionOptions) {
          if (prod.itemCode === currentItem && !opt.move) continue;
          const place = {
            itemCode: prod.itemCode, itemType: prod.type, isCore: opt.isCore,
            ...(opt.move ? {
              taxPct: getIncomeTaxPct(opt.region._id),
              regionCountry: opt.region.country ?? null,
              regionInitialCountry: opt.region.initialCountry ?? opt.region.country ?? null,
            } : {}),
          };
          const penalty = opt.move && !hasFreeMove(comp) ? -RULES.companyMoveHappinessPenalty : 0;
          const gainOnDay = (d, steady) => enginePP * (prod.goldPerPP - currentGoldPerPP) + emps.reduce((s, emp) => {
            const neutral = neutralOf.get(emp);
            // steady on BOTH sides, so natural specialization growth cancels out.
            const stay = projectEmployeePPH(emp, ctx, { day: d, neutral, steady: !!steady }, nowMs);
            const common = {
              place, day: d, neutral, steady: !!steady, transferred: false,
              happinessDelta: !steady && d < RULES.movePenaltyDays ? penalty : 0,
            };
            // Unfitting tools go back to the inventory automatically (game behavior), which
            // also flips handy off / improviser on.
            const after = projectEmployeePPH(emp, ctx, { ...common, toolReturned: true }, nowMs);
            return s + (after * prod.goldPerPP - stay * currentGoldPerPP) * 24;
          }, 0);
          const dailyGain = gainOnDay(TRANSITION_DAYS);
          if (dailyGain > (best ? best.dailyGain : 0)) best = { prod, opt, gainOnDay, dailyGain };
        }
      }
      if (!best) continue;

      // Will the game auto-return tools on this product change? (Informational hint only.)
      const toolRemove = best.prod.itemCode !== currentItem && emps.some(emp => {
        const tool = empToolInfo(emp);
        return !!tool && !toolFitsGood(tool, best.prod.itemCode);
      });

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
        toolRemove,
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

  // ── Derived data for the workforce tools ──
  const hasData = companies.length > 0;
  const ppmValue = typeof ppm === "number" && ppm > 0 ? ppm : (num(gameConfig?.ppMoneyValueFallback, 0) || 0.1);
  const ppmEstimated = !(typeof ppm === "number" && ppm > 0);
  // Self-work (M32) scales with the PRODUCTION SKILL level, not the account level.
  const prodSkillLevel = (() => {
    const p = userData?.skills?.production;
    if (!p) return 0;
    for (const v of [p.level, p.total, p.value]) if (typeof v === "number" && v <= 10) return v;
    return 0;
  })();

  const firmsInput = useMemo(() => {
    if (!hasData) return [];
    return companies.map(comp => {
      const ctx = empCtx(comp);
      return {
        id: String(comp._id),
        name: comp.name || comp.itemCode,
        itemCode: comp.itemCode,
        itemType: ctx.itemType,
        g: calcGoldPerPP(comp.itemCode),
        cap: getEmployeeCap(comp),
        leavers: getLeavers(comp).length,
        isCore: ctx.isCore,
        taxPct: ctx.taxPct,
        regionCountry: ctx.regionCountry,
        regionInitialCountry: ctx.regionInitialCountry,
        storageLevel: ctx.storageLevel,
        regionAttacked: ctx.regionAttacked,
        managerPct: ctx.managerPct,
        engineLevel: ctx.engineLevel,
        disabled: ctx.disabled,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, employees, regions, countries, prices, gameConfig, userData]);

  // The advisor verdicts feed the warning banner and the per-company badges; the heavy
  // distribution plan only runs inside the workforce tab.
  const workforceAdvice = useMemo(() => {
    if (employeeStatus.state !== "ok" || !firmsInput.length) return null;
    try {
      const model = buildWorkforceModel({
        firmsInput, employeesByCompany: employees, ppm: ppmValue,
        prodSkillLevel, events: employeeEvents, settings: {},
      });
      return adviseAll(model, model.current);
    } catch (e) {
      console.error("workforce advice failed", e);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeStatus.state, firmsInput, employees, ppmValue, prodSkillLevel, employeeEvents]);
  // Only true loss-makers: "critical" (quit risk / open retirement event) is a different story
  // and has its own badges; mixing it in here would break the check's "fire" filter link.
  const fireAdvice = (workforceAdvice || []).filter(a => a.verdict === "fire");
  const fireEmpIds = new Set(fireAdvice.map(a => String(a.empId)));

  // Switches to the workforce tab with the check view and the fire filter preselected.
  function openWorkforceCheck() {
    try {
      localStorage.setItem("warera_workforce_view", JSON.stringify("check"));
      localStorage.setItem("warera_workforce_check_filter", JSON.stringify("fire"));
    } catch {}
    setSubTab("workforce");
  }

  // ── Render ──
  const TH = getTH();
  const TD = getTD;

  const enemyWarnings = hasData ? getEnemyWarnings() : [];
  const coreSuggestions = hasData ? getCoreRegionSuggestions() : [];
  const allProducts = hasData ? getAllProductsRanked() : [];
  const globalOptimization = hasData ? getGlobalOptimization() : [];
  const totalWarnings = enemyWarnings.length + fireAdvice.length;

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
                {fireAdvice.length > 0 && <span>{L.warningWage(fireAdvice.length)}</span>}
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
              { key: "workforce", label: L.tabWorkforce, icon: "&#128101;" },
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
                      const hasWageLoss = emps.some(e => fireEmpIds.has(String(e._id)));
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
                                      const traits = traitList(emp);
                                      const tool = empToolInfo(emp);
                                      const toolPct = toolBonusNow(tool, comp.itemCode);
                                      const potential = typeof emp.potential === "number" ? emp.potential : null;
                                      const potentialMax = typeof emp.potentialMax === "number" ? emp.potentialMax : null;
                                      const happinessColor = happiness >= RULES.happinessGood ? C.green : happiness >= RULES.quitThreshold ? C.textDim : C.red;
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
                                            {traits.length > 0
                                              ? traits.map(t => formatCodeName(t.code)).join(", ")
                                              : <span style={{ color: C.textMuted }}>-</span>}
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

          {/* ── WORKFORCE TAB ── */}
          {subTab === "workforce" && (
            <WorkforceTab
              L={L}
              theme={theme}
              firmsInput={firmsInput}
              employeesByCompany={employees}
              employeeStatus={employeeStatus}
              events={employeeEvents}
              eventStatus={eventStatus}
              summary={summary}
              ppm={ppmValue}
              ppmEstimated={ppmEstimated}
              userSkills={userData?.skills}
              prodSkillLevel={prodSkillLevel}
              apiKeySet={!!apiKey.trim()}
              onReload={reloadEmployees}
              reloading={reloading}
              getEmployeeStateText={getEmployeeStateText}
              scrapPrice={getItemPrice("scraps")}
            />
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

              {/* Employee events moved to the workforce tab ("Heute"). */}

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

              {/* Loss-making employees → workforce check (the advisor computes this correctly,
                  including coworker effects) */}
              {fireAdvice.length > 0 && (
                <GlassCard glow="rgba(255,153,0,0.15)" style={{ borderColor: "#ff990033" }}>
                  <div onClick={openWorkforceCheck} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <span style={{ fontSize: 20 }}>&#128184;</span>
                    <span style={{ fontFamily: F.m, fontSize: 13, color: C.text }}>{L.warningWageLink(fireAdvice.length)}</span>
                    <span style={{ color: C.accent, fontSize: 16 }}>&rarr;</span>
                  </div>
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
                      {coreSuggestions.map((s, i) => {
                        // A row with a negative steady gain is information, not a recommendation
                        // (e.g. an expat bonus outweighs the tax advantage): dim it and say so.
                        const recommended = s.dailyGain > 0.005;
                        return (
                          <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent", opacity: recommended ? 1 : 0.6 }}>
                            <td style={TD(false)}>
                              <div>{s.company.name || s.company.itemCode}</div>
                              <div style={{ fontSize: 10, color: C.textMuted }}>{s.company.itemCode}</div>
                            </td>
                            <td style={TD(false)}>
                              <div>{s.currentRegion?.name || "?"}</div>
                              <div style={{ fontSize: 10, color: C.textMuted }}>{getCountryName(s.company.region)} &middot; {L.taxShort(fmt(s.fromTax, 0))}</div>
                            </td>
                            <td style={{ ...TD(false), color: recommended ? C.accent : C.textMuted, fontSize: 18 }}>{recommended ? "→" : "✕"}</td>
                            <td style={TD(false)}>
                              <div style={{ color: recommended ? C.green : C.textDim }}>{s.homeRegion?.name || ownerCountry?.name || "?"}</div>
                              <div style={{ fontSize: 10, color: recommended ? C.green : C.textMuted }}>{L.coreYes} &middot; {L.taxShort(fmt(s.toTax, 0))}</div>
                            </td>
                            <td style={{ ...TD(false), color: s.dailyGain >= 0 ? C.green : C.red, fontWeight: 700 }}>{s.dailyGain >= 0 ? "+" : ""}{fmt(s.dailyGain, 2)} G</td>
                            <td style={{ ...TD(false), color: C.textDim }}>
                              <div>{fmt(s.relocCost, 2)} G{s.concreteNeeded === 0 && <span style={{ color: C.green, fontSize: 10, marginLeft: 6 }}>{L.freeMove}</span>}</div>
                              <div style={{ fontSize: 10, color: C.textMuted }}>{L.moveCostBreakdown(fmt(s.concreteCost, 2), fmt(s.happinessLoss, 2))}</div>
                            </td>
                            <td style={{ ...TD(false), fontWeight: 700, color: s.paybackDays <= 7 ? C.green : s.paybackDays <= 30 ? C.accent : C.red }}>
                              {recommended
                                ? (s.paybackDays === Infinity ? L.never : L.days(fmt(s.paybackDays, 1)))
                                : <Tip text={L.coreStayTip} wrap><span><Bdg color={C.textDim}>{L.coreStayBadge}</Bdg></span></Tip>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </GlassCard>

              {/* The greedy per-employee move list was replaced by the distribution plan in the
                  workforce tab (slot-aware, coworker traits, executable step list). */}

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
                            {s.toolRemove && <div style={{ fontSize: 10, color: "#ff9900" }}>{L.globalOptRemoveTool}</div>}
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
