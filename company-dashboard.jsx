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

function calcTotalBonus(region, itemCode, country, gameConfig, countryEthics) {
  if (!gameConfig) return 0;
  let bonus = 0;

  const isIndustrialTarget = ['steel', 'concrete', 'oil', 'lightAmmo', 'ammo', 'heavyAmmo', 'lead', 'petroleum', 'iron', 'limestone', 'wood', 'paper'].includes(itemCode);
  const isAgrarianTarget = ['coca', 'grain', 'livestock', 'fish'].includes(itemCode);
  const indVal = countryEthics?.industrialism || 0;

  // 1. Party Ethics Bonus
  if (indVal === 1 && isIndustrialTarget) {
    bonus += 10;
  } else if (indVal >= 2 && isIndustrialTarget) {
    bonus += 30;
  }

  if (indVal === -1 && isAgrarianTarget) {
    bonus += 10;
  } else if (indVal <= -2 && isAgrarianTarget) {
    bonus += 30;
  }

  // 2. Country specialization bonus
  // Agrar 2 (industrialism <= -2) deactivates the country specialization completely
  if (indVal > -2) {
    if (country?.specializedItem === itemCode) {
      if (country?.strategicResources?.bonuses?.productionPercent) {
        bonus += country.strategicResources.bonuses.productionPercent;
      }
    }
  }

  if (!region) return bonus;



  // 4. Actual Deposit Bonus
  const depositItem = region.deposit?.type || region.deposit;
  if (depositItem === itemCode) {
    const depositBonus = region.deposit?.bonusPercent || gameConfig.company?.depositResourceBonus || 30;
    // "Fanatischer Industrieller" (>= 2) deactivates natural deposits
    if (indVal < 2) {
      bonus += depositBonus;
    }
  }

  return bonus;
}

let currentBgFetch = 0;

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
  const [workers, setWorkers] = useState({}); // companyId -> workers[]
  const [regions, setRegions] = useState({}); // regionId -> region
  const [countries, setCountries] = useState({}); // countryId -> country
  const [prices, setPrices] = useState({}); // itemCode -> number
  const [ownerCountry, setOwnerCountry] = useState(null);
  const [allRegions, setAllRegions] = useState({});
  const [gameConfig, setGameConfig] = useState(null);
  const [partyEthics, setPartyEthics] = useState({}); // countryId -> { industrialism, ... }
  const [bgProgress, setBgProgress] = useState(null);

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
      console.log("GAMECONFIG", JSON.stringify(configData));

      // Build region lookup (object keyed by _id)
      const regMap = {};
      if (regionsData && typeof regionsData === "object") {
        if (Array.isArray(regionsData)) {
          for (const r of regionsData) if (r?._id) regMap[r._id] = r;
        } else {
          // Already keyed by ID
          for (const [k, r] of Object.entries(regionsData)) {
            regMap[r?._id || k] = r;
          }
        }
      }
      setAllRegions(regMap);
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

      // Phase 3: Load company details + workers in parallel
      setLoadingMsg(L.loadingFactoriesN(companyIds.length));
      const companyDetails = await batchParallel(companyIds, async (cid) => {
        const [comp, wrk] = await Promise.all([
          apiCall("company.getById", { companyId: cid }),
          apiCall("worker.getWorkers", { companyId: cid }).catch(() => ({ workers: [] })),
        ]);
        return { comp, workers: wrk?.workers || wrk?.items || [] };
      });

      const comps = [];
      const workersMap = {};
      const allWorkerUserIds = new Set();
      let totalCompaniesValue = 0;
      for (const { comp, workers: w } of companyDetails) {
        const id = comp._id;
        comps.push(comp);
        totalCompaniesValue += (comp.estimatedValue || 0);
        const wArr = Array.isArray(w) ? w : [];
        workersMap[id] = wArr;
        for (const wr of wArr) if (wr.user) allWorkerUserIds.add(wr.user);
      }

      // Phase 3b: Load worker user profiles to get energy/production skills
      if (allWorkerUserIds.size > 0) {
        setLoadingMsg(L.loadingWorkerProfiles(allWorkerUserIds.size));
        const userProfiles = await batchParallel([...allWorkerUserIds], async (uid) => {
          try {
            const u = await apiCall("user.getUserLite", { userId: uid });
            return { uid, user: u };
          } catch { return { uid, user: null }; }
        });
        const profileMap = {};
        for (const { uid, user: u } of userProfiles) if (u) profileMap[uid] = u;

        // Enrich workers with energy/productivity from user profiles
        for (const wArr of Object.values(workersMap)) {
          for (const wr of wArr) {
            const profile = profileMap[wr.user];
            if (profile) {
              wr.energy = profile.skills?.energy?.value || 0;
              wr.energyCurrent = profile.skills?.energy?.currentBarValue || 0;
              wr.productivity = profile.skills?.production?.value || 0;
              wr.username = profile.username;
            }
          }
        }
      }

      setCompanies(comps);
      setWorkers(workersMap);

      // Phase 3c: Calculate Liquid Assets (Geld + Items + Waffen) based on liquid_assets.py
      setLoadingMsg(L.loadingLiquid);
      const wealthRanking = await apiCall("ranking.getRanking", { rankingType: "userWealth", limit: 100, skip: 0 }).catch(() => null);
      let totalWealth = 0;
      if (wealthRanking?.items) {
        const me = wealthRanking.items.find(i => (i.user?._id || i.user) === userId);
        if (me) totalWealth = me.value || 0;
      }
      const liquidAssets = totalWealth > 0 ? Math.max(0, totalWealth - totalCompaniesValue) : 0;
      setUserData(prev => ({ ...prev, liquidAssets, totalWealth, totalCompaniesValue }));

      // Phase 4: Load Party Ethics for factories' countries
      setLoadingMsg(L.loadingPartyEthics);
      const relevantCountryIds = new Set();
      for (const comp of comps) {
        const reg = regMap[comp.region];
        if (reg?.country) relevantCountryIds.add(reg.country);
      }
      const ethicsMap = {};
      const relevantCountriesToFetch = Object.values(cntMap).filter(c => c.rulingParty && relevantCountryIds.has(c._id));
      if (relevantCountriesToFetch.length > 0) {
        const partyResults = await batchParallel(relevantCountriesToFetch, async (c) => {
          try {
            const p = await apiCall("party.getById", { partyId: c.rulingParty });
            return { countryId: c._id, ethics: p?.ethics || null };
          } catch { return { countryId: c._id, ethics: null }; }
        });
        for (const { countryId, ethics } of partyResults) {
          if (ethics) ethicsMap[countryId] = ethics;
        }
      }
      setPartyEthics(ethicsMap);

      // Background Phase: Load remaining party ethics
      const thisBgFetch = ++currentBgFetch;
      const remainingCountriesToFetch = Object.values(cntMap).filter(c => c.rulingParty && !relevantCountryIds.has(c._id));
      if (remainingCountriesToFetch.length > 0) {
        setBgProgress({ loaded: 0, total: remainingCountriesToFetch.length });
        (async () => {
          let loaded = 0;
          const queue = [...remainingCountriesToFetch];
          const worker = async () => {
            while (queue.length > 0) {
              if (thisBgFetch !== currentBgFetch) break; // aborted
              const c = queue[0];
              let retryDelay = 0;
              try {
                const p = await apiCall("party.getById", { partyId: c.rulingParty });
                if (p?.ethics && thisBgFetch === currentBgFetch) {
                  setPartyEthics(prev => ({ ...prev, [c._id]: p.ethics }));
                }
                queue.shift();
                loaded++;
                if (thisBgFetch === currentBgFetch) setBgProgress({ loaded, total: remainingCountriesToFetch.length, status: "loading" });
              } catch (e) {
                retryDelay = 5000;
                if (thisBgFetch === currentBgFetch) setBgProgress(prev => prev ? { ...prev, status: "waiting" } : prev);
              }
              await new Promise(res => setTimeout(res, retryDelay || 10));
            }
          };
          await Promise.all([worker(), worker()]);
          if (thisBgFetch === currentBgFetch) setBgProgress(null);
        })();
      } else {
        setBgProgress(null);
      }

      // Phase 5: Load owner's country for enemy check
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

  // ── Calculations ──
  function getRegionBonus(comp) {
    const region = regions[comp.region];
    const country = getCountryForRegion(comp.region);
    const ethics = country?._id ? partyEthics[country._id] : null;
    return calcTotalBonus(region, comp.itemCode, country, gameConfig, ethics);
  }

  function getWorkTaxRate(comp) {
    // WarEra delivers income tax as a percent (e.g. 1 = 1%); normalize to fraction.
    const country = getCountryForRegion(comp.region);
    const pct = Number(country?.taxes?.income) || 0;
    return pct / 100;
  }

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

  function calcEnginePPDay(comp) {
    const engineLevel = comp.activeUpgradeLevels?.automatedEngine || 1;
    const bonus = getRegionBonus(comp);
    return engineLevel * 24 * (1 + bonus / 100);
  }

  function calcWorkerPPH(worker, bonus) {
    const energy = worker.energy || 0;
    const productivity = worker.productivity || 0;
    const fidelity = worker.fidelity || 0;
    // energy/10 * production_skill per 10h → energy/100 * production_skill per hour
    const basePP = (energy / 100) * productivity;
    return basePP * (1 + bonus / 100) * (1 + fidelity / 100);
  }

  function calcCompanyPPDay(comp) {
    const bonus = getRegionBonus(comp);
    const enginePP = calcEnginePPDay(comp);
    const compId = comp._id;
    const ws = workers[compId] || [];
    const workerPP = ws.reduce((sum, w) => sum + calcWorkerPPH(w, bonus) * 24, 0);
    return enginePP + workerPP;
  }

  function calcWorkerBasePPH(w) {
    // Base PP per hour BEFORE bonuses/fidelity
    return ((w.energy || 0) / 100) * (w.productivity || 0);
  }

  function calcWorkerCostPerH(w) {
    // Wage is per PP produced (before bonuses), not per hour
    return calcWorkerBasePPH(w) * (w.wage || 0);
  }

  function calcDailyCost(comp) {
    const compId = comp._id;
    const ws = workers[compId] || [];
    return ws.reduce((sum, w) => sum + calcWorkerCostPerH(w) * 24, 0);
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
    const ppPerUnit = getPPPerUnit(comp.itemCode);
    if (!ppPerUnit) return 0;
    const ppDay = calcCompanyPPDay(comp);
    const margin = calcNetMarginPerUnit(comp.itemCode);
    const revenue = (ppDay / ppPerUnit) * margin;
    console.log(`[Revenue] ${comp.itemCode} | ppDay=${ppDay.toFixed(1)} | ppPerUnit=${ppPerUnit} | margin=${margin.toFixed(3)} | revenue=${revenue.toFixed(2)}`);
    return revenue;
  }

  function calcDailyProfit(comp) {
    return calcDailyRevenue(comp) - calcDailyCost(comp);
  }

  // ── Optimization Analysis ──
  function getWageLossWarnings() {
    const warnings = [];
    for (const comp of companies) {
      const compId = comp._id;
      const ws = workers[compId] || [];
      const bonus = getRegionBonus(comp);
      const ppPerUnit = getPPPerUnit(comp.itemCode);
      const margin = calcNetMarginPerUnit(comp.itemCode);
      for (const w of ws) {
        const workerPPDay = calcWorkerPPH(w, bonus) * 24;
        const unitsPerDay = ppPerUnit ? workerPPDay / ppPerUnit : 0;
        const dailyContribution = unitsPerDay * margin;
        const dailyWage = calcWorkerCostPerH(w) * 24;
        if (dailyWage > dailyContribution && dailyWage > 0) {
          const wBasePPH = calcWorkerBasePPH(w);
          const breakEvenWage = wBasePPH > 0 ? dailyContribution / (wBasePPH * 24) : 0;
          warnings.push({
            company: comp,
            worker: w,
            dailyWage,
            dailyContribution,
            loss: dailyWage - dailyContribution,
            breakEvenWage,
          });
        }
      }
    }
    return warnings.sort((a, b) => b.loss - a.loss);
  }

  function getBetterRegions() {
    const suggestions = [];
    const betonPrice = getItemPrice("concrete") || 1;
    const moveCost = gameConfig?.company?.moveCost || 5;

    for (const comp of companies) {
      const currentBonus = getRegionBonus(comp);
      const itemCode = comp.itemCode;
      const ppPerUnit = getPPPerUnit(itemCode);
      const price = getItemPrice(itemCode);
      const currentPPDay = calcCompanyPPDay(comp);

      let bestRegion = null;
      let bestBonus = currentBonus;

      for (const region of Object.values(allRegions)) {
        const regionCountry = countries[region.country] || null;
        const regionEthics = regionCountry?._id ? partyEthics[regionCountry._id] : null;
        const regionBonus = calcTotalBonus(region, itemCode, regionCountry, gameConfig, regionEthics);
        if (regionBonus > bestBonus) {
          bestBonus = regionBonus;
          bestRegion = region;
        }
      }

      if (bestRegion && bestBonus > currentBonus) {
        const engineLevel = comp.activeUpgradeLevels?.automatedEngine || 1;
        const newEnginePP = engineLevel * 24 * (1 + bestBonus / 100);
        const compId = comp._id;
        const ws = workers[compId] || [];
        const newWorkerPP = ws.reduce((sum, w) => sum + calcWorkerPPH(w, bestBonus) * 24, 0);
        const newPPDay = newEnginePP + newWorkerPP;
        const ppDayGain = newPPDay - currentPPDay;
        const unitsGain = ppDayGain / ppPerUnit;
        const dailyGain = unitsGain * price;
        const relocCost = moveCost * betonPrice;
        const paybackDays = dailyGain > 0 ? relocCost / dailyGain : Infinity;

        suggestions.push({
          company: comp,
          currentRegion: regions[comp.region],
          currentBonus,
          bestRegion,
          bestBonus,
          dailyGain,
          relocCost,
          paybackDays,
        });
      }
    }
    return suggestions.sort((a, b) => a.paybackDays - b.paybackDays);
  }

  function getEnemyWarnings() {
    if (!ownerCountry) return [];
    const warsWith = ownerCountry.warsWith || [];
    if (!warsWith.length) return [];

    const warnings = [];
    for (const comp of companies) {
      const compId = comp._id;
      const ws = workers[compId] || [];
      if (!ws.length) continue;

      const factoryCountry = getCountryForRegion(comp.region);
      if (!factoryCountry) continue;
      const factoryCountryId = factoryCountry._id;

      if (warsWith.includes(factoryCountryId)) {
        warnings.push({
          company: comp,
          factoryCountry,
          workerCount: ws.length,
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
      // Check if user produces this
      const userComps = companies.filter(c => c.itemCode === code);
      // Calculate maximum possible global efficiency
      let maxBonus = 0;
      let bestRegionName = "N/A";
      for (const regionId of Object.keys(regions)) {
        const region = regions[regionId];
        const country = getCountryForRegion(regionId);
        const cEthics = country?._id ? partyEthics[country._id] : null;
        const bonus = calcTotalBonus(region, code, country, gameConfig, cEthics);
        if (bonus > maxBonus) {
          maxBonus = bonus;
          bestRegionName = region.name;
        }
      }
      const maxGoldPerPP = goldPerPP * (1 + maxBonus / 100);

      products.push({
        itemCode: code, type: item.type, price: price, pp, materialCost, netMargin, goldPerPP, needs,
        maxBonus, maxGoldPerPP, bestRegionName,
        userCompanyCount: userComps.length,
        userTotalProfit: userComps.reduce((s, c) => s + calcDailyProfit(c), 0),
        userTotalRevenue: userComps.reduce((s, c) => s + calcDailyRevenue(c), 0),
        userTotalCost: userComps.reduce((s, c) => s + calcDailyCost(c), 0),
      });
    }
    return products.sort((a, b) => b.maxGoldPerPP - a.maxGoldPerPP);
  }

  function getGlobalOptimization() {
    if (!gameConfig) return [];
    const allProducts = getAllProductsRanked();
    const betonPrice = getItemPrice("concrete") || 1;
    const moveCost = gameConfig.company?.moveCost || 5;
    const changeCost = gameConfig.company?.changeItemCost || 5;
    
    const suggestions = [];
    
    for (const comp of companies) {
      const currentItem = comp.itemCode;
      const currentRegion = comp.region;
      const currentBonus = getRegionBonus(comp);
      const currentRevenue = calcDailyRevenue(comp);
      const currentCost = calcDailyCost(comp);
      const currentProfit = currentRevenue - currentCost;
      const engineLevel = comp.activeUpgradeLevels?.automatedEngine || 1;
      const compId = comp._id;
      const ws = workers[compId] || [];
      
      let bestDailyGain = 0;
      let bestSuggestion = null;
      
      for (const prod of allProducts) {
        for (const regionId of Object.keys(regions)) {
          if (prod.itemCode === currentItem && regionId === currentRegion) continue;
          
          const region = regions[regionId];
          const country = getCountryForRegion(regionId);
          const optEthics = country?._id ? partyEthics[country._id] : null;
          const newBonus = calcTotalBonus(region, prod.itemCode, country, gameConfig, optEthics);
          
          const newEnginePP = engineLevel * 24 * (1 + newBonus / 100);
          // Assuming workers are fired and re-hired? No, workers move with the factory (is loyalty kept? Let's assume yes).
          const newWorkerPP = ws.reduce((sum, w) => {
            const basePPH = calcWorkerBasePPH(w);
            return sum + basePPH * (1 + newBonus / 100) * (1 + (w.fidelity || 0) / 100) * 24;
          }, 0);
          const newTotalPP = newEnginePP + newWorkerPP;
          const newRevenue = (newTotalPP / prod.pp) * prod.netMargin;
          const newCost = ws.reduce((sum, w) => sum + calcWorkerCostPerH(w) * 24, 0);
          const newProfit = newRevenue - newCost;
          const dailyGain = newProfit - currentProfit;
          
          if (dailyGain > bestDailyGain) {
            let concreteNeeded = 0;
            if (regionId !== currentRegion) concreteNeeded += moveCost;
            if (prod.itemCode !== currentItem) concreteNeeded += changeCost;
            
            const totalCost = concreteNeeded * betonPrice;
            const paybackDays = totalCost / dailyGain;
            
            bestDailyGain = dailyGain;
            bestSuggestion = {
              company: comp,
              currentItem,
              currentRegion: regions[currentRegion],
              currentBonus,
              currentProfit,
              newItem: prod.itemCode,
              newRegion: region,
              newBonus,
              newProfit,
              dailyGain,
              totalCost,
              concreteNeeded,
              paybackDays
            };
          }
        }
      }
      if (bestSuggestion) {
        suggestions.push(bestSuggestion);
      }
    }
    return suggestions.sort((a, b) => a.paybackDays - b.paybackDays);
  }

  function getWorkerOptimization() {
    // For each worker, find the factory (among user's factories) where they'd generate most net profit
    if (!gameConfig) return [];
    const suggestions = [];

    // Build a list of all workers with their current factory
    const allWorkers = [];
    for (const comp of companies) {
      const ws = workers[comp._id] || [];
      for (const w of ws) {
        allWorkers.push({ worker: w, currentCompany: comp });
      }
    }

    for (const { worker, currentCompany } of allWorkers) {
      const currentBonus = getRegionBonus(currentCompany);
      const currentPPPerUnit = getPPPerUnit(currentCompany.itemCode);
      const currentPrice = getItemPrice(currentCompany.itemCode);
      const basePPH = calcWorkerBasePPH(worker);
      const fidelity = worker.fidelity || 0;

      const currentPPH = basePPH * (1 + currentBonus / 100) * (1 + fidelity / 100);
      const currentMargin = calcNetMarginPerUnit(currentCompany.itemCode);
      const currentRevPerH = currentPPPerUnit ? (currentPPH / currentPPPerUnit) * currentMargin : 0;
      const costPerH = basePPH * (worker.wage || 0); // same everywhere
      const currentNetPerH = currentRevPerH - costPerH;

      let bestFactory = null;
      let bestNetPerH = currentNetPerH;

      for (const comp of companies) {
        if (comp._id === currentCompany._id) continue;
        const bonus = getRegionBonus(comp);
        const ppPerUnit = getPPPerUnit(comp.itemCode);
        const margin = calcNetMarginPerUnit(comp.itemCode);

        const pph = basePPH * (1 + bonus / 100) * (1 + fidelity / 100);
        const revPerH = ppPerUnit ? (pph / ppPerUnit) * margin : 0;
        const netPerH = revPerH - costPerH;

        if (netPerH > bestNetPerH) {
          bestNetPerH = netPerH;
          bestFactory = comp;
        }
      }

      if (bestFactory) {
        const dailyGain = (bestNetPerH - currentNetPerH) * 24;
        const fromTax = getWorkTaxRate(currentCompany);
        const toTax = getWorkTaxRate(bestFactory);
        const grossWagePerH = costPerH; // basePPH * wage, factory-independent
        const workerNetWageFromPerDay = grossWagePerH * (1 - fromTax) * 24;
        const workerNetWageToPerDay = grossWagePerH * (1 - toTax) * 24;
        const workerWageGainPerDay = workerNetWageToPerDay - workerNetWageFromPerDay;
        suggestions.push({
          worker,
          fromCompany: currentCompany,
          toCompany: bestFactory,
          currentNetPerDay: currentNetPerH * 24,
          newNetPerDay: bestNetPerH * 24,
          dailyGain,
          fromTax,
          toTax,
          workerNetWageFromPerDay,
          workerNetWageToPerDay,
          workerWageGainPerDay,
        });
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
  const betterRegions = hasData ? getBetterRegions() : [];
  const allProducts = hasData ? getAllProductsRanked() : [];
  const globalOptimization = hasData ? getGlobalOptimization() : [];
  const workerOptimization = hasData ? getWorkerOptimization() : [];
  const totalWarnings = enemyWarnings.length + wageWarnings.length;

  const optimizerProps = hasData ? {
    liquidAssets: userData?.liquidAssets || 0,
    totalWealth: userData?.totalWealth || 0,
    totalCompaniesValue: userData?.totalCompaniesValue || 0,
    prices: prices,
    bestProduct: allProducts[0],
    facs: companies.map(c => {
      const bonus = getRegionBonus(c);
      const baseGoldPerPP = calcGoldPerPP(c.itemCode);
      const goldPerPPWithBonus = baseGoldPerPP * (1 + bonus / 100);
      return {
        level: c.activeUpgradeLevels?.automatedEngine || 1,
        name: c.name || c.itemCode,
        item: c.itemCode,
        goldPerLevelPerDay: 24 * goldPerPPWithBonus,
        workerGoldPerDay: (workers[c._id] || []).reduce((sum, w) => {
          const wPPDay = calcWorkerPPH(w, bonus) * 24;
          const wGoldDaily = wPPDay * baseGoldPerPP;
          const wWageDaily = calcWorkerCostPerH(w) * 24;
          return sum + (wGoldDaily - wWageDaily);
        }, 0)
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
            {bgProgress && (
              <div style={{ flex: 1, minWidth: 280, display: "flex", flexDirection: "column", gap: 4, justifyContent: "center", ...glass(0.05, 8), padding: "8px 14px", borderRadius: 12 }}>
                <style>{`@keyframes slowOrangeBlink { 0% { opacity: 1; background: #f97316; } 50% { opacity: 0.4; background: #f97316; } 100% { opacity: 1; background: #f97316; } }`}</style>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, whiteSpace: "nowrap" }}>
                    {L.bgDataLabel}
                  </div>
                  <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${(bgProgress.loaded / Math.max(1, bgProgress.total)) * 100}%`, height: "100%", background: bgProgress.status === "waiting" ? "#f97316" : C.green, transition: "width 0.3s", animation: bgProgress.status === "waiting" ? "slowOrangeBlink 2s infinite" : "none" }} />
                  </div>
                  <div style={{ fontSize: 11, color: bgProgress.status === "waiting" ? "#f97316" : C.green, fontWeight: 700, minWidth: 25, textAlign: "right" }}>
                    {Math.round((bgProgress.loaded / Math.max(1, bgProgress.total)) * 100)}%
                  </div>
                </div>
                <div style={{ fontSize: 10, color: bgProgress.status === "waiting" ? "#f97316" : C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {bgProgress.status === "waiting" ? L.bgWaiting : L.bgLoading}
                </div>
              </div>
            )}
          </div>

          {/* ── OVERVIEW TAB ── */}
          {subTab === "overview" && (
            <GlassCard style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px 8px" }}>
                <Sec icon="&#127981;">{L.sectionFactoryOverview(companies.length)}</Sec>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: -10, marginBottom: 8 }}>{L.tipClickWorkerDetails}</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
                  <thead><tr>
                    <th style={TH}>{L.colName}</th>
                    <th style={TH}>{L.colProduct}</th>
                    <th style={TH}>{L.colEngine}</th>
                    <th style={TH}>{L.colStorage}</th>
                    <th style={TH}>{L.colRegion}</th>
                    <th style={TH}>{L.colBonus}</th>
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
                      const ws = workers[compId] || [];
                      const bonus = getRegionBonus(comp);
                      const enginePP = calcEnginePPDay(comp);
                      const workerPPTotal = ws.reduce((sum, w) => sum + calcWorkerPPH(w, bonus) * 24, 0);
                      const ppDay = enginePP + workerPPTotal;
                      const revenue = calcDailyRevenue(comp);
                      const cost = calcDailyCost(comp);
                      const profit = calcDailyProfit(comp);
                      const isEnemy = enemyWarnings.some(w => w.company._id === compId);
                      const hasWageLoss = wageWarnings.some(w => w.company._id === compId);
                      const isExpanded = expandedCompany === compId;

                      return [
                        <tr key={compId} onClick={() => setExpandedCompany(isExpanded ? null : compId)}
                          style={{ background: i % 2 ? C.rowAlt : "transparent", cursor: ws.length > 0 ? "pointer" : "default",
                            outline: isExpanded ? "1px solid " + C.accent + "44" : "none" }}>
                          <td style={TD(false)}>
                            {ws.length > 0 && <span style={{ marginRight: 6, fontSize: 10, color: C.accent }}>{isExpanded ? "\u25BC" : "\u25B6"}</span>}
                            {comp.name || L.factoryFallback(i)}
                          </td>
                          <td style={TD(false)}>{comp.itemCode}</td>
                          <td style={TD(true)}>Lv {comp.activeUpgradeLevels?.automatedEngine || 1}</td>
                          <td style={TD(false)}>Lv {comp.activeUpgradeLevels?.storage || 1}</td>
                          <td style={TD(false)}>
                            <div style={{ fontSize: 13 }}>{getRegionName(comp)}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>{getCountryName(comp.region)}</div>
                          </td>
                          <td style={{ ...TD(false), color: bonus > 0 ? C.green : C.textMuted }}>
                            {bonus > 0 ? "+" + fmt(bonus, 2) + "%" : "-"}
                          </td>
                          <td style={TD(false)}>{ws.length}</td>
                          <td style={{ ...TD(false), color: C.blue }}>{fmt(enginePP, 1)}</td>
                          <td style={{ ...TD(false), color: workerPPTotal > 0 ? C.purple : C.textMuted }}>
                            {workerPPTotal > 0 ? fmt(workerPPTotal, 1) : "-"}
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
                            {hasWageLoss && <Bdg color="#ff9900">{L.badgeWageLoss}</Bdg>}
                            {!getPPPerUnit(comp.itemCode) && <Bdg color={C.red}>{L.badgeConfigMissing}</Bdg>}
                            {!isEnemy && !hasWageLoss && getPPPerUnit(comp.itemCode) && <Bdg color={C.green}>{L.badgeOk}</Bdg>}
                          </td>
                        </tr>,
                        // Expanded worker details
                        isExpanded && ws.length > 0 && (
                          <tr key={compId + "-workers"}>
                            <td colSpan={14} style={{ padding: 0, background: "rgba(0,0,0,0.2)" }}>
                              <div style={{ padding: "12px 20px 12px 36px" }}>
                                <div style={{ fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
                                  {L.workerDetailsTitle(fmt(bonus, 2))}
                                </div>
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                  <thead><tr>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colName}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colEnergy}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colProduction}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colFidelity}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colWage}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colFormula}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colPPH}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colPPDay}</th>
                                    <th style={{ ...TH, fontSize: 11 }}>{L.colCostDay}</th>
                                  </tr></thead>
                                  <tbody>
                                    {ws.map((w, wi) => {
                                      const wPPH = calcWorkerPPH(w, bonus);
                                      const wPPDay = wPPH * 24;
                                      const wBasePPH = calcWorkerBasePPH(w);
                                      const wCostDay = calcWorkerCostPerH(w) * 24;
                                      const fidelity = w.fidelity || 0;
                                      return (
                                        <tr key={wi} style={{ background: wi % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                                          <td style={{ ...TD(false), fontSize: 13 }}>{w.username || "Arbeiter " + (wi+1)}</td>
                                          <td style={{ ...TD(false), fontSize: 13 }}>
                                            <span style={{ color: C.accent }}>{w.energy}</span>
                                            <span style={{ color: C.textMuted, fontSize: 10 }}> (aktuell: {fmt(w.energyCurrent || 0, 1)})</span>
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.blue }}>{w.productivity}</td>
                                          <td style={{ ...TD(false), fontSize: 13, color: fidelity > 0 ? C.green : C.textMuted }}>
                                            {fidelity > 0 ? "+" + fmt(fidelity, 0) + "%" : "-"}
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13 }}>
                                            {fmt(w.wage || 0, 3)} G
                                            <div style={{ fontSize: 9, color: C.textMuted }}>Basis: {fmt(wBasePPH, 2)} PP/h</div>
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 10, color: C.textMuted, fontFamily: F.m, whiteSpace: "nowrap" }}>
                                            {w.energy}/100*{w.productivity}*(1+{fmt(bonus,1)}%)*(1+{fmt(fidelity,0)}%)
                                          </td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.purple, fontWeight: 700 }}>{fmt(wPPH, 2)}</td>
                                          <td style={{ ...TD(false), fontSize: 13, color: C.purple }}>{fmt(wPPDay, 1)}</td>
                                          <td style={{ ...TD(false), fontSize: 13, color: wCostDay > 0 ? C.red : C.textMuted }}>
                                            {wCostDay > 0 ? fmt(wCostDay, 2) + " G" : "-"}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    <tr style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                                      <td colSpan={6} style={{ ...TD(false), fontSize: 12, fontWeight: 700, color: C.textDim, textAlign: "right" }}>{L.sumWorkers}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.purple, fontWeight: 700 }}>{fmt(ws.reduce((s, w) => s + calcWorkerPPH(w, bonus), 0), 2)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.purple, fontWeight: 700 }}>{fmt(workerPPTotal, 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.red, fontWeight: 700 }}>{fmt(cost, 2)} G</td>
                                    </tr>
                                    <tr>
                                      <td colSpan={6} style={{ ...TD(false), fontSize: 12, fontWeight: 700, color: C.textDim, textAlign: "right" }}>{L.engineRow(comp.activeUpgradeLevels?.automatedEngine || 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.blue, fontWeight: 700 }}>{fmt(enginePP / 24, 2)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.blue, fontWeight: 700 }}>{fmt(enginePP, 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.textMuted }}>-</td>
                                    </tr>
                                    <tr style={{ borderTop: "1px solid " + C.accent + "44" }}>
                                      <td colSpan={6} style={{ ...TD(false), fontSize: 13, fontWeight: 700, color: C.accent, textAlign: "right" }}>{L.totalRow}</td>
                                      <td style={{ ...TD(false), fontSize: 14, color: C.accent, fontWeight: 700 }}>{fmt(ppDay / 24, 2)}</td>
                                      <td style={{ ...TD(false), fontSize: 14, color: C.accent, fontWeight: 700 }}>{fmt(ppDay, 1)}</td>
                                      <td style={{ ...TD(false), fontSize: 13, color: C.red, fontWeight: 700 }}>{fmt(cost, 2)} G</td>
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
                        {L.enemyWorkerWarning(w.workerCount)}
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
                      <th style={TH}>{L.colWorkers}</th>
                      <th style={TH}>{L.colWage}</th>
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
                            <div>{w.worker.username || w.worker.userId?.slice(0, 8) || L.workerFallback(0).replace(" 1","")}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>E:{w.worker.energy} P:{w.worker.productivity}</div>
                          </td>
                          <td style={{ ...TD(false), color: C.red }}>{fmt(w.worker.wage || 0, 3)} G</td>
                          <td style={{ ...TD(false), color: C.green }}>{fmt(w.breakEvenWage, 3)} G</td>
                          <td style={{ ...TD(false), color: C.red }}>{fmt(w.dailyWage, 2)} G</td>
                          <td style={{ ...TD(false), color: C.green }}>{fmt(w.dailyContribution, 2)} G</td>
                          <td style={{ ...TD(false), color: C.red, fontWeight: 700 }}>-{fmt(w.loss, 2)} G</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </GlassCard>
              )}

              {/* Better Regions */}
              <GlassCard glow={betterRegions.length > 0 ? C.greenGlow : undefined}>
                <Sec icon="&#127758;">{L.sectionBetterRegions(betterRegions.length)}</Sec>
                <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                  {L.betterRegionsDesc}
                </div>
                {betterRegions.length === 0 ? (
                  <div style={{ padding: "16px", textAlign: "center", color: C.green, background: "rgba(0,255,0,0.05)", borderRadius: 8, border: "1px solid " + C.green + "44" }}>
                    {L.allOptimalRegions}
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={TH}>{L.colName}</th>
                      <th style={TH}>{L.colCurrent}</th>
                      <th style={TH}></th>
                      <th style={TH}>{L.colBestRegion}</th>
                      <th style={TH}>{L.colExtraGain}</th>
                      <th style={TH}>{L.colMoveCost}</th>
                      <th style={TH}>{L.colPayback}</th>
                    </tr></thead>
                    <tbody>
                      {betterRegions.map((s, i) => (
                        <tr key={i} style={{ background: i % 2 ? C.rowAlt : "transparent" }}>
                          <td style={TD(false)}>
                            <div>{s.company.name || s.company.itemCode}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>{s.company.itemCode}</div>
                          </td>
                          <td style={TD(false)}>
                            <div>{s.currentRegion?.name || "?"}</div>
                            <div style={{ fontSize: 10, color: C.textMuted }}>+{fmt(s.currentBonus, 1)}%</div>
                          </td>
                          <td style={{ ...TD(false), color: C.accent, fontSize: 18 }}>&rarr;</td>
                          <td style={TD(false)}>
                            <div style={{ color: C.green }}>{s.bestRegion?.name || "?"}</div>
                            <div style={{ fontSize: 10, color: C.green }}>+{fmt(s.bestBonus, 1)}%</div>
                          </td>
                          <td style={{ ...TD(false), color: C.green, fontWeight: 700 }}>+{fmt(s.dailyGain, 2)} G</td>
                          <td style={{ ...TD(false), color: C.textDim }}>{fmt(s.relocCost, 2)} G</td>
                          <td style={{ ...TD(false), fontWeight: 700, color: s.paybackDays <= 7 ? C.green : s.paybackDays <= 30 ? C.accent : C.red }}>
                            {s.paybackDays === Infinity ? L.never : L.days(fmt(s.paybackDays, 1))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </GlassCard>

              {/* Worker Optimization */}
              {workerOptimization.length > 0 && (
                <GlassCard glow={C.blueGlow}>
                  <Sec icon="&#128101;">{L.sectionWorkerOpt(workerOptimization.length)}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                    {L.workerOptDesc}
                  </div>
                  {workerOptimization.map((s, i) => (
                    <div key={i} style={{ ...glass(0.08, 10), borderRadius: 8, padding: "12px 16px", marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <div>
                          <span style={{ color: C.accent, fontWeight: 700 }}>{s.worker.username || L.workerFallback(0).replace(" 1","")}</span>
                          <span style={{ color: C.textDim, margin: "0 8px" }}>{L.wordFrom}</span>
                          <span style={{ color: C.text, fontWeight: 600 }}>{s.fromCompany.name || s.fromCompany.itemCode}</span>
                          <span style={{ color: C.textDim, fontSize: 12 }}> ({s.fromCompany.itemCode}, {fmt(s.currentNetPerDay, 2)} G/Tag)</span>
                          <span style={{ color: C.accent, margin: "0 10px", fontSize: 16 }}>&rarr;</span>
                          <span style={{ color: C.green, fontWeight: 600 }}>{s.toCompany.name || s.toCompany.itemCode}</span>
                          <span style={{ color: C.green, fontSize: 12 }}> ({s.toCompany.itemCode}, {fmt(s.newNetPerDay, 2)} G/Tag)</span>
                        </div>
                        <Bdg color={C.green}>+{fmt(s.dailyGain, 2)} G/Tag</Bdg>
                      </div>
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                        <div style={{ color: C.textDim }}>
                          {L.laborTax}{" "}
                          <span style={{ color: C.text }}>{fmt(s.fromTax * 100, 1)}%</span>
                          <span style={{ margin: "0 6px" }}>&rarr;</span>
                          <span style={{ color: s.toTax <= s.fromTax ? C.green : C.red }}>{fmt(s.toTax * 100, 1)}%</span>
                          <span style={{ marginLeft: 8, color: C.textDim }}>
                            {L.netWageLine(fmt(s.workerNetWageFromPerDay, 2), fmt(s.workerNetWageToPerDay, 2))}
                          </span>
                        </div>
                        <Bdg color={s.workerWageGainPerDay >= 0 ? C.green : C.red}>
                          {L.workerGainBadge((s.workerWageGainPerDay >= 0 ? "+" : "") + fmt(s.workerWageGainPerDay, 2))}
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
                            <div style={{ fontSize: 10, color: C.textMuted }}>{s.currentRegion?.name} (+{fmt(s.currentBonus, 1)}%)</div>
                          </td>
                          <td style={{ ...TD(false), color: C.accent, fontSize: 18 }}>&rarr;</td>
                          <td style={TD(false)}>
                            <div style={{ color: C.green, fontWeight: 700 }}>{s.newItem}</div>
                            <div style={{ fontSize: 10, color: C.green }}>{s.newRegion?.name} (+{fmt(s.newBonus, 1)}%)</div>
                          </td>
                          <td style={{ ...TD(false), color: C.textDim }}>{fmt(s.currentProfit, 2)} G</td>
                          <td style={{ ...TD(false), color: C.green }}>{fmt(s.newProfit, 2)} G</td>
                          <td style={{ ...TD(false), color: C.green, fontWeight: 700 }}>+{fmt(s.dailyGain, 2)} G</td>
                          <td style={{ ...TD(false), color: C.red }}>{s.concreteNeeded} <span style={{fontSize:10}}>({fmt(s.totalCost, 1)} G)</span></td>
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
                    <th style={TH}>{L.colMaxMarginPP}</th>
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
                          <td style={{ ...TD(false), fontWeight: 700, color: C.textDim, fontSize: 13 }}>
                            {fmt(p.goldPerPP, 4)} G
                          </td>
                          <td style={{ ...TD(false), fontWeight: 700, color: i === 0 ? C.green : p.maxGoldPerPP > 0 ? C.text : C.red, fontSize: 15 }}>
                            <div>{fmt(p.maxGoldPerPP, 4)} G</div>
                            <div style={{ fontSize: 10, color: C.green }}>{p.bestRegionName} (+{fmt(p.maxBonus, 1)}%)</div>
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
