import { useState, useEffect } from "react";
import { THEMES, C, F, setThemeVars, glass, fmt, fmtT, fmtN, GlassCard, Sec, Bdg, Tip, Btn, getTH, getTD, apiCall } from "./shared.jsx";
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
// These constants live in the game client, not in gameConfig.getGameConfig.
// They are only used when the API does not deliver its own estimate for an employee.
const RULES = {
  outputDivisor: 4,              // PP per hour = production stat / 4
  happinessNeutral: 50,
  happinessPercentPerPoint: 1,   // each point above/below 50 = ±1 % output
  managementPercentPerPoint: 2,  // owner + manager management, +2 % per point
  coreRegionBonusPercent: 5,     // company in a core region of the owner's country
  moveHappinessPenalty: 5,       // employee moved between own companies (7 days)
  companyMoveHappinessPenalty: 10, // company moved to another region (7 days)
  movePenaltyDays: 7,
  taxHappinessPerPercent: 1,     // each 1 % income tax = -1 happiness
};

// Only procedures documented in the official WarEra API (https://api2.warera.io/docs,
// spec at https://api2.warera.io/openapi.json) may be called, with or without the personal
// API key. Internal game endpoints such as employee.getCompanyRoster are off limits.
// As of v0.27 the public API publishes no employee data at all. Once WarEra documents an
// employee endpoint, put its procedure name here; until then employees stay unavailable.
const OFFICIAL_EMPLOYEE_ROSTER_ENDPOINT = null;

// ── Helpers ──
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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

// Parse whatever employee.getCompanyRoster returns into { employees, cap }.
function parseRoster(r) {
  if (!r) return { employees: [], cap: null };
  const list = Array.isArray(r) ? r : (r.employees || r.items || r.roster || []);
  const cap = typeof r?.hourly?.cap === "number" ? r.hourly.cap : (typeof r?.cap === "number" ? r.cap : null);
  return { employees: (Array.isArray(list) ? list : []).filter(isActiveEmployee), cap };
}

function isActiveEmployee(emp) {
  return !!emp && !emp.leftAt;
}

// Effective stat value (production / luck / responsibility) of an employee.
function statValue(emp, stat) {
  const b = emp?.breakdown?.[stat];
  if (typeof b === "number") return b;
  if (b && typeof b === "object") {
    for (const k of ["total", "value", "effective", "current"]) if (typeof b[k] === "number") return b[k];
  }
  const base = emp?.base?.[stat] ?? emp?.stats?.[stat] ?? emp?.[stat];
  return num(base, 0);
}

function empHappiness(emp) {
  const hb = emp?.happinessBreakdown;
  if (typeof hb === "number") return hb;
  if (hb && typeof hb.value === "number") return hb.value;
  if (typeof emp?.happiness === "number") return emp.happiness;
  return RULES.happinessNeutral;
}

function empTraits(emp) {
  const t = emp?.traits;
  if (!Array.isArray(t)) return [];
  return t.map(x => (typeof x === "string" ? x : x?.code || x?.trait?.code || "")).filter(Boolean);
}

function empToolInfo(emp) {
  const t = emp?.tool;
  if (!t) return null;
  if (typeof t === "string") return { code: t, bonus: null, durability: null, maxDurability: null };
  const code = t.itemCode || t.code || t.item?.code || t.type || "tool";
  const bonus = [t.production, t.stats?.production, t.productionPercent, t.bonus].find(v => typeof v === "number");
  return {
    code,
    bonus: typeof bonus === "number" ? bonus : null,
    durability: typeof t.durability === "number" ? t.durability : null,
    maxDurability: typeof t.maxDurability === "number" ? t.maxDurability : null,
  };
}

function empWagePerHour(emp) {
  for (const v of [emp?.estimate?.wage, emp?.hourlyWage, emp?.wage]) if (typeof v === "number") return v;
  return 0;
}

function empHasEstimate(emp) {
  return typeof emp?.estimate?.production === "number";
}

function coreFactor(isCore) {
  return 1 + (isCore ? RULES.coreRegionBonusPercent : 0) / 100;
}

// PP per hour of one employee. Uses the game's own estimate when present,
// otherwise the public formula: Production/4 × happiness × management × core region × tool.
function calcEmployeePPH(emp, ctx) {
  if (empHasEstimate(emp)) return Math.max(0, emp.estimate.production);
  const prod = statValue(emp, "production");
  const base = prod / RULES.outputDivisor;
  const happiness = 1 + (empHappiness(emp) - RULES.happinessNeutral) * RULES.happinessPercentPerPoint / 100;
  const mgmt = 1 + (ctx?.managementPoints || 0) * RULES.managementPercentPerPoint / 100;
  const core = coreFactor(ctx?.isCore);
  const tool = 1 + (empToolInfo(emp)?.bonus || 0) / 100;
  return Math.max(0, base * happiness * mgmt * core * tool);
}

function formatTraitName(code) {
  return String(code).toLowerCase().replace(/_/g, " ");
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
  const [employees, setEmployees] = useState({});     // companyId -> employee[]
  const [rosterMeta, setRosterMeta] = useState({});   // companyId -> { cap, error }
  const [regions, setRegions] = useState({});         // regionId -> region
  const [countries, setCountries] = useState({});     // countryId -> country
  const [prices, setPrices] = useState({});           // itemCode -> number
  const [ownerCountry, setOwnerCountry] = useState(null);
  const [gameConfig, setGameConfig] = useState(null);

  const [subTab, setSubTab] = useState("overview");
  const [expandedCompany, setExpandedCompany] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem("warera_user_input", userInput.trim());
    } catch {}
  }, [userInput]);

  useEffect(() => {
    try {
      localStorage.setItem("warera_api_key", apiKey.trim());
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
    setLoading(true); setError(""); setLoadingMsg(L.loadingSearchPlayer);
    try {
      // Phase 1: Resolve user + load global data in parallel
      const [user, pricesData, regionsData, countriesData, configData] = await Promise.all([
        resolveUser(userInput.trim()),
        apiCall("itemTrading.getPrices", {}).catch(() => ({})),
        apiCall("region.getRegionsObject", {}).catch(() => ({})),
        apiCall("country.getAllCountries", {}).catch(() => []),
        apiCall("gameConfig.getGameConfig", {}).catch(() => null),
      ]);

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
      const companyIds = companiesResp?.items || [];
      if (!companyIds.length) throw new Error("Keine Fabriken gefunden");

      // Phase 3: Load company details (documented) and, only if WarEra has published one,
      // the employee roster of each company. See OFFICIAL_EMPLOYEE_ROSTER_ENDPOINT.
      setLoadingMsg(L.loadingFactoriesN(companyIds.length));
      const companyDetails = await batchParallel(companyIds, async (cid) => {
        const [comp, roster] = await Promise.all([
          apiCall("company.getById", { companyId: cid }),
          OFFICIAL_EMPLOYEE_ROSTER_ENDPOINT
            ? apiCall(OFFICIAL_EMPLOYEE_ROSTER_ENDPOINT, { companyId: cid }).then(r => ({ ok: true, data: r })).catch(e => ({ ok: false, error: e?.message || "ERROR" }))
            : Promise.resolve({ ok: false, error: "NOT_AVAILABLE" }),
        ]);
        return { comp, roster };
      });

      const comps = [];
      const empMap = {};
      const metaMap = {};
      let totalCompaniesValue = 0;
      for (const { comp, roster } of companyDetails) {
        if (!comp?._id) continue;
        const id = comp._id;
        comps.push(comp);
        totalCompaniesValue += (comp.estimatedValue || 0);
        if (roster.ok) {
          const parsed = parseRoster(roster.data);
          empMap[id] = parsed.employees;
          metaMap[id] = { cap: parsed.cap, error: null };
        } else {
          empMap[id] = [];
          metaMap[id] = { cap: null, error: roster.error };
        }
      }

      setCompanies(comps);
      setEmployees(empMap);
      setRosterMeta(metaMap);

      // Phase 3b: Calculate Liquid Assets (Geld + Items + Waffen)
      setLoadingMsg(L.loadingLiquid);
      const wealthRanking = await apiCall("ranking.getRanking", { rankingType: "userWealth", limit: 100, skip: 0 }).catch(() => null);
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
          setOwnerCountry(oc);
          if (oc) cntMap[oc._id] = oc;
        } catch { setOwnerCountry(null); }
      }

      setLoadingMsg("");
    } catch (e) {
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

  // Income tax costs employees 1 happiness per percent, i.e. 1 % output. Output factor when
  // employees move from one region's country to another's.
  function taxHappinessFactor(fromRegionId, toRegionId) {
    const delta = (getIncomeTaxPct(fromRegionId) - getIncomeTaxPct(toRegionId)) * RULES.taxHappinessPerPercent;
    return Math.max(0, 1 + delta / 100);
  }

  // A battle in the region costs every employee 5 happiness and carries a 1 % death risk.
  function hasActiveBattle(comp) {
    return !!regions[comp.region]?.activeBattle;
  }

  // Concrete needed to move the company: v0.27 granted everyone one free move (company.freeMoves).
  function getMoveConcreteCost(comp) {
    const moveCost = gameConfig?.company?.moveCost || 5;
    return num(comp.freeMoves, 0) > 0 ? 0 : moveCost;
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

  function getEmployees(comp) {
    return employees[comp._id] || [];
  }

  function getEmployeeCap(comp) {
    const metaCap = rosterMeta[comp._id]?.cap;
    if (typeof metaCap === "number") return metaCap;
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

  // A hired manager would add their own management points, but manager contracts are not
  // part of the official API, so only the owner's management counts here.
  function empCtx(comp) {
    return {
      isCore: isCoreRegion(comp),
      managementPoints: getOwnerManagementPoints(),
    };
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

    for (const comp of companies) {
      if (isCoreRegion(comp) || !hasEmployees(comp)) continue;
      const goldPerPP = calcGoldPerPP(comp.itemCode);
      const empGoldDay = calcEmployeesPPDay(comp) * goldPerPP;
      const newEmpGoldDay = empGoldDay * coreFactor(true) * taxHappinessFactor(comp.region, homeRegion._id);
      const dailyGain = newEmpGoldDay - empGoldDay;
      // Moving the company costs concrete (unless a free move is left) and -10 happiness for 7 days.
      const happinessLoss = newEmpGoldDay * (RULES.companyMoveHappinessPenalty / 100) * RULES.movePenaltyDays;
      const concreteNeeded = getMoveConcreteCost(comp);
      const concreteCost = concreteNeeded * betonPrice;
      const relocCost = concreteCost + happinessLoss;
      const paybackDays = dailyGain > 0 ? relocCost / dailyGain : Infinity;
      suggestions.push({
        company: comp,
        currentRegion: regions[comp.region],
        homeRegion,
        dailyGain,
        relocCost,
        concreteNeeded,
        concreteCost,
        happinessLoss,
        paybackDays,
        fromTax: getIncomeTaxPct(comp.region),
        toTax: getIncomeTaxPct(homeRegion._id),
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
      const currentProfit = calcDailyProfit(comp);
      const enginePP = calcEnginePPDay(comp);
      const empPP = calcEmployeesPPDay(comp);
      const cost = calcDailyCost(comp);

      let bestDailyGain = 0;
      let bestSuggestion = null;

      const regionOptions = [{ region: regions[comp.region], isCore: currentCore, move: false }];
      if (!currentCore && homeRegion && empPP > 0) regionOptions.push({ region: homeRegion, isCore: true, move: true });

      for (const prod of allProducts) {
        for (const opt of regionOptions) {
          if (prod.itemCode === currentItem && !opt.move) continue;
          const taxFactor = opt.move ? taxHappinessFactor(comp.region, opt.region._id) : 1;
          const newEmpPP = empPP / coreFactor(currentCore) * coreFactor(opt.isCore) * taxFactor;
          const newRevenue = (enginePP + newEmpPP) * prod.goldPerPP;
          const newProfit = newRevenue - cost;
          const dailyGain = newProfit - currentProfit;

          if (dailyGain > bestDailyGain) {
            let concreteNeeded = 0;
            if (opt.move) concreteNeeded += getMoveConcreteCost(comp);
            if (prod.itemCode !== currentItem) concreteNeeded += changeCost;
            const totalCost = concreteNeeded * betonPrice;
            const paybackDays = totalCost / dailyGain;

            bestDailyGain = dailyGain;
            bestSuggestion = {
              company: comp,
              currentItem,
              currentRegion: regions[comp.region],
              currentCore,
              currentProfit,
              newItem: prod.itemCode,
              newRegion: opt.region,
              newCore: opt.isCore,
              moveFree: opt.move && getMoveConcreteCost(comp) === 0,
              newProfit,
              dailyGain,
              totalCost,
              concreteNeeded,
              paybackDays,
            };
          }
        }
      }
      if (bestSuggestion) suggestions.push(bestSuggestion);
    }
    return suggestions.sort((a, b) => a.paybackDays - b.paybackDays);
  }

  // For each employee: the own company where they would earn the most net gold.
  function getEmployeeOptimization() {
    if (!gameConfig) return [];
    const suggestions = [];

    for (const fromComp of companies) {
      const fromCore = isCoreRegion(fromComp);
      const fromGoldPerPP = calcGoldPerPP(fromComp.itemCode);
      const fromTax = getIncomeTaxPct(fromComp.region);
      for (const emp of getEmployees(fromComp)) {
        const ppDay = calcEmployeePPDay(emp, fromComp);
        const costDay = calcEmployeeCostDay(emp); // wage is set by the employee, same everywhere
        const currentNetPerDay = ppDay * fromGoldPerPP - costDay;

        let bestComp = null;
        let bestNetPerDay = currentNetPerDay;
        let bestPPDay = ppDay;

        for (const toComp of companies) {
          if (toComp._id === fromComp._id) continue;
          if (getEmployees(toComp).length >= getEmployeeCap(toComp)) continue; // break room full
          const newPPDay = ppDay / coreFactor(fromCore) * coreFactor(isCoreRegion(toComp)) * taxHappinessFactor(fromComp.region, toComp.region);
          const netPerDay = newPPDay * calcGoldPerPP(toComp.itemCode) - costDay;
          if (netPerDay > bestNetPerDay) {
            bestNetPerDay = netPerDay;
            bestComp = toComp;
            bestPPDay = newPPDay;
          }
        }

        if (bestComp) {
          const toTax = getIncomeTaxPct(bestComp.region);
          // Moving costs -5 happiness for 7 days (= -5 % output), tax difference changes happiness permanently.
          const moveLoss = bestPPDay * calcGoldPerPP(bestComp.itemCode) * (RULES.moveHappinessPenalty / 100) * RULES.movePenaltyDays;
          const dailyGain = bestNetPerDay - currentNetPerDay;
          suggestions.push({
            employee: emp,
            fromCompany: fromComp,
            toCompany: bestComp,
            currentNetPerDay,
            newNetPerDay: bestNetPerDay,
            dailyGain,
            moveLoss,
            paybackDays: dailyGain > 0 ? moveLoss / dailyGain : Infinity,
            fromTax,
            toTax,
            happinessDelta: (fromTax - toTax) * RULES.taxHappinessPerPercent,
          });
        }
      }
    }
    return suggestions.sort((a, b) => b.dailyGain - a.dailyGain);
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

  const rosterUnavailable = hasData && companies.some(c => rosterMeta[c._id]?.error === "NOT_AVAILABLE");
  const rosterFailedCount = hasData ? companies.filter(c => rosterMeta[c._id]?.error && rosterMeta[c._id].error !== "NOT_AVAILABLE").length : 0;
  const totalEmployees = hasData ? companies.reduce((s, c) => s + getEmployees(c).length, 0) : 0;
  const anyEstimateMissing = hasData && companies.some(c => getEmployees(c).some(e => !empHasEstimate(e)));

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
                    onKeyDown={e => e.key === "Enter" && loadData()}
                    placeholder={L.placeholderPlayer}
                    style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 8, color: C.text, padding: "10px 14px", fontSize: 14, fontFamily: F.m, outline: "none", width: "100%", boxSizing: "border-box" }}
                  />
                </Tip>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                  <Sec icon="&#128273;">{L.sectionApiKey}</Sec>
                </div>
                <Tip text={L.tipApiKey}>
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
            {hasData && !rosterUnavailable && rosterFailedCount === 0 && <span>{L.successEmployees(totalEmployees)}</span>}
            {rosterFailedCount > 0 && <div style={{ color: C.accent, marginTop: 4 }}>{L.rosterFailed(rosterFailedCount)}</div>}
            {rosterUnavailable && <div style={{ color: C.accent, marginTop: 4 }}>{L.rosterUnavailable}</div>}
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
                  {rosterUnavailable ? L.engineOnlyNote : L.tipClickWorkerDetails}
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
                      const rosterError = rosterMeta[compId]?.error;
                      const rosterMissing = rosterError === "NOT_AVAILABLE";
                      const rosterFailed = rosterError && !rosterMissing;
                      const canExpand = emps.length > 0;
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
                          <td style={{ ...TD(false), color: rosterMissing ? C.textMuted : C.text }}>
                            {rosterMissing ? "?" : emps.length}/{cap}
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
                            {rosterFailed && <Bdg color="#ff9900">{L.badgeRosterFailed}</Bdg>}
                            {!getPPPerUnit(comp.itemCode) && <Bdg color={C.red}>{L.badgeConfigMissing}</Bdg>}
                            {!isEnemy && !inBattle && !hasWageLoss && !rosterFailed && getPPPerUnit(comp.itemCode) && <Bdg color={C.green}>{L.badgeOk}</Bdg>}
                          </td>
                        </tr>,
                        // Expanded employee details
                        isExpanded && canExpand && (
                          <tr key={compId + "-employees"}>
                            <td colSpan={14} style={{ padding: 0, background: "rgba(0,0,0,0.2)" }}>
                              <div style={{ padding: "12px 20px 12px 36px" }}>
                                <div style={{ fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
                                  {L.employeeDetailsTitle(emps.length, cap)}
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
                                      const happiness = empHappiness(emp);
                                      const traits = empTraits(emp);
                                      const tool = empToolInfo(emp);
                                      const potential = typeof emp.potential === "number" ? emp.potential : null;
                                      const potentialMax = typeof emp.potentialMax === "number" ? emp.potentialMax : null;
                                      const happinessColor = happiness >= 50 ? C.green : happiness >= 30 ? C.accent : C.red;
                                      return (
                                        <tr key={emp._id || ei} style={{ background: ei % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                                          <td style={{ ...TD(false), fontSize: 13 }}>
                                            {emp.name || L.employeeFallback(ei)}
                                            {typeof emp.age === "number" && <span style={{ color: C.textMuted, fontSize: 10, marginLeft: 6 }}>{L.ageLabel(emp.age)}</span>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, whiteSpace: "nowrap" }}>
                                            <span style={{ color: C.blue }}>{fmt(statValue(emp, "production"), 0)}</span>
                                            <span style={{ color: C.textMuted }}> / </span>
                                            <span style={{ color: C.accent }}>{fmt(statValue(emp, "luck"), 0)}</span>
                                            <span style={{ color: C.textMuted }}> / </span>
                                            <span style={{ color: C.purple }}>{fmt(statValue(emp, "responsibility"), 0)}</span>
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: happinessColor }}>{fmt(happiness, 0)}</td>
                                          <td style={{ ...TD(false), fontSize: 11, color: C.textDim }}>
                                            {traits.length ? traits.map(formatTraitName).join(", ") : <span style={{ color: C.textMuted }}>-</span>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 11, color: C.textDim }}>
                                            {tool ? (
                                              <div>
                                                <div>{tool.code}{tool.bonus != null && <span style={{ color: C.green }}> +{fmt(tool.bonus, 0)}%</span>}</div>
                                                {tool.durability != null && <div style={{ fontSize: 9, color: C.textMuted }}>{fmt(tool.durability, 0)}{tool.maxDurability != null ? "/" + fmt(tool.maxDurability, 0) : ""} h</div>}
                                              </div>
                                            ) : <span style={{ color: C.textMuted }}>-</span>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.textDim }}>
                                            {potential != null ? `${potential}${potentialMax != null ? "/" + potentialMax : ""}` : "-"}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.purple, fontWeight: 700 }}>
                                            {fmt(pph, 2)}
                                            {!empHasEstimate(emp) && <span title={L.estimateFallbackNote} style={{ color: C.textMuted, fontSize: 9, marginLeft: 4 }}>~</span>}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.purple }}>{fmt(ppDayE, 1)}</td>
                                          <td style={{ ...TD(false), fontSize: 13 }}>{fmt(wageH, 3)} G</td>
                                          <td style={{ ...TD(false), fontSize: 13, color: costDay > 0 ? C.red : C.textMuted }}>
                                            {costDay > 0 ? fmt(costDay, 2) + " G" : "-"}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: netDay >= 0 ? C.green : C.red, fontWeight: 700 }}>
                                            {fmt(netDay, 2)} G
                                          </td>
                                        </tr>
                                      );
                                    })}
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
              {/* Employee features wait for official API support */}
              {rosterUnavailable && (
                <GlassCard style={{ borderColor: C.accent + "44" }}>
                  <Sec icon="&#9203;">{L.sectionEmployeePending}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim }}>{L.employeeFeaturesPending}</div>
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
                              P:{fmt(statValue(w.employee, "production"), 0)} · {L.colHappiness} {fmt(empHappiness(w.employee), 0)}
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
                  rosterUnavailable ? (
                    <div style={{ padding: "16px", textAlign: "center", color: C.textDim, background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}>
                      {L.employeeFeaturesPendingShort}
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
                            {s.concreteNeeded} <span style={{fontSize:10}}>({fmt(s.totalCost, 1)} G)</span>
                            {s.moveFree && <div style={{ fontSize: 10, color: C.green }}>{L.freeMove}</div>}
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
