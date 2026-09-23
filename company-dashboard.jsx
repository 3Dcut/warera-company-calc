import { useState, useEffect, useLayoutEffect, useRef, useId, Fragment } from "react";
import { THEMES, C, F, setThemeVars, glass, fmt, fmtClock, GlassCard, Sec, Bdg, Tip, Btn, Kpi, getTH, getTD, useSort, SortTh, useIsMobile, apiCall } from "./shared.jsx";
import FactoryOptimizer from "./factory-optimizer.jsx";
import { getLang, itemName } from "./translations.jsx";

// ── Local styles (load spinner, blinking background progress) ──
if (typeof document !== "undefined" && !document.getElementById("dash-styles")) {
  const s = document.createElement("style");
  s.id = "dash-styles";
  s.textContent = `
    @keyframes dashSpin { to { transform: rotate(360deg); } }
    @keyframes dashBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .dash-spinner { display: inline-block; width: 0.85em; height: 0.85em; margin-right: 10px; vertical-align: -0.08em;
      border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: dashSpin 0.8s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .dash-spinner { animation: none; border-right-color: currentColor; opacity: 0.6; } }
    div.dash-scroll[tabindex]:focus-visible { outline-offset: -2px !important; }
  `;
  document.head.appendChild(s);
}

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

// Player explicitly given in the URL (deep link) -> auto-load once on first mount.
const URL_USER = getUrlParam("user", "username", "id");

const TAB_KEYS = ["overview", "optimize", "market", "build"];
function getInitialTab() {
  const t = getUrlParam("tab");
  return TAB_KEYS.includes(t) ? t : "overview";
}

// Change query params in place (history.replaceState), keeping all others.
function updateUrlParams(mutate) {
  try {
    const url = new URL(window.location.href);
    const before = url.search;
    mutate(url.searchParams);
    if (url.search !== before) window.history.replaceState(window.history.state, "", url);
  } catch {}
}

// ── Errors ──
function appError(code, extra) {
  const e = new Error(code);
  e.code = code;
  return Object.assign(e, extra);
}

// Map raw errors to a kind the UI can explain (texts come from translations).
function classifyError(e, input) {
  const msg = String(e?.message || e || "");
  if (e?.code === "PLAYER_NOT_FOUND") return { kind: "notFound", name: input };
  if (e?.code === "NO_EXACT_MATCH") return { kind: "noExactMatch", name: input };
  if (e?.code === "NO_FACTORIES") return { kind: "noFactories", name: e.username || input };
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (offline || (e instanceof TypeError && /fetch|network|load failed/i.test(msg))) return { kind: "network" };
  if (/UNAUTHORIZED|FORBIDDEN|token required|api.?key|\b40[13]\b/i.test(msg)) return { kind: "auth" };
  if (/\b429\b|TOO_MANY_REQUESTS|rate.?limit/i.test(msg)) return { kind: "rateLimit" };
  return { kind: "generic", detail: msg };
}

// Opaque version of the glass card background (for sticky table cells).
function blendWhite(hex, a) {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0;
  const ch = sh => Math.round(((n >> sh) & 255) * (1 - a) + 255 * a);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

// ── Small presentational helpers ──
function Stats({ items, min = 120 }) {
  return <dl style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: "10px 14px", margin: 0 }}>
    {items.filter(Boolean).map((it, i) => (
      <div key={i} style={{ minWidth: 0, gridColumn: it.full ? "1 / -1" : undefined }}>
        <dt style={{ fontFamily: F.h, fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", overflowWrap: "break-word", hyphens: "auto" }}>{it.label}</dt>
        <dd style={{ margin: "2px 0 0", fontFamily: F.m, fontSize: it.big ? 18 : 15, fontWeight: it.bold ? 700 : 400, color: it.color || C.text, overflowWrap: "anywhere", fontVariantNumeric: "tabular-nums" }}>
          {it.value}
          {it.sub && <div style={{ fontSize: 12, fontWeight: 400, color: C.textMuted, marginTop: 2 }}>{it.sub}</div>}
        </dd>
      </div>
    ))}
  </dl>;
}

// `ink`: text colour that stays readable on the accent tint
function ProvisionalBadge({ L, ink }) {
  return <Tip text={L.provisionalTip}>
    <span tabIndex={0} style={{ display: "inline-flex", cursor: "help", borderRadius: 4 }}>
      <Bdg color={C.accent}><span style={{ color: ink }}><span aria-hidden="true">⏳ </span>{L.provisional}</span></Bdg>
    </span>
  </Tip>;
}

const FOCUS_GAP = 6; // room for the 2px focus ring + 2px offset

// First sticky cell of a table row (the pinned name column), if any.
function stickyCell(tr) {
  return tr ? [...tr.cells].find(c => getComputedStyle(c).position === "sticky") || null : null;
}

// Horizontal scroller for wide tables. Only while the table really overflows it is a focusable, named
// region (so keyboard users can scroll it). Keyboard focus inside is kept clear of the sticky name column.
function ScrollX({ label, style, children }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);
  const [stickyW, setStickyW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const head = () => stickyCell(el.querySelector(":scope > table > thead > tr"));
    const measure = () => {
      setOver(el.scrollWidth > el.clientWidth + 1);
      setStickyW(head()?.offsetWidth || 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const n of [el, el.firstElementChild, head()]) if (n) ro.observe(n);
    return () => ro.disconnect();
  }, []);

  // After the browser's own focus scrolling (next frame): scroll so the focused control is fully visible,
  // right of the sticky column and inside the scroller (the browser leaves partly visible ones alone).
  const onFocusCapture = e => {
    const el = ref.current, t = e.target;
    if (!el || t === el) return;
    try { if (!t.matches(":focus-visible")) return; } catch {} // pointer focus: leave the scroll position alone
    requestAnimationFrame(() => {
      if (document.activeElement !== t || el.scrollWidth <= el.clientWidth + 1) return;
      const cell = stickyCell(t.closest("tr"));
      if (cell && cell.contains(t)) return; // the sticky column is always in view
      const box = el.getBoundingClientRect(), r = t.getBoundingClientRect();
      const lo = box.left + el.clientLeft + (cell ? cell.offsetWidth : 0) + FOCUS_GAP;
      const hi = box.left + el.clientLeft + el.clientWidth - FOCUS_GAP;
      const d = r.left < lo ? r.left - lo // hidden under the sticky column / left edge
        : r.right > hi && r.width <= hi - lo ? r.right - hi : 0; // cut off on the right (and fits)
      if (Math.abs(d) < 1) return;
      let reduce = false;
      try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch {}
      el.scrollTo({ left: el.scrollLeft + d, behavior: reduce ? "auto" : "smooth" });
    });
  };

  return <div ref={ref} className="dash-scroll" onFocusCapture={onFocusCapture}
    {...(over ? { tabIndex: 0, role: "region", "aria-label": label } : {})}
    style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", maxWidth: "100%", scrollPaddingLeft: stickyW ? stickyW + FOCUS_GAP : undefined, ...style }}>
    {children}
  </div>;
}

// ── Helpers ──
async function resolveUser(input) {
  try {
    const u = await apiCall("user.getUserLite", { userId: input });
    if (u && u.username) return u;
  } catch {}
  const search = await apiCall("search.searchAnything", { searchText: input });
  if (!search.userIds?.length) throw appError("PLAYER_NOT_FOUND");
  for (const uid of search.userIds) {
    try {
      const u = await apiCall("user.getUserLite", { userId: uid });
      if (u.username.toLowerCase() === input.toLowerCase()) return u;
    } catch {}
  }
  throw appError("NO_EXACT_MATCH");
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

  const isIndustrialTarget = ['steel', 'concrete', 'oil', 'lightAmmo', 'ammo', 'heavyAmmo', 'lead', 'petroleum', 'iron', 'limestone', 'wood'].includes(itemCode);
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
  const T = THEMES[theme] || THEMES.grau;
  const L = getLang(lang);
  const isMobile = useIsMobile();
  const uid = useId();

  const [userInput, setUserInput] = useState(getInitialUserInput);
  const [apiKey, setApiKey] = useState(getInitialApiKey);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState(null); // { step: 0..5, n?: count } while loading
  const [rateWait, setRateWait] = useState(0); // seconds left of a rate-limit pause
  const [ratePause, setRatePause] = useState(0); // length of that pause (announced once)
  const [error, setError] = useState(null); // { kind, name?, detail? }
  const [loadedAt, setLoadedAt] = useState(null);
  const loadingRef = useRef(false);
  const autoLoadRef = useRef(false);
  const focusRetryRef = useRef(false); // a Retry failed again -> focus the new Retry button

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

  const [subTab, setSubTab] = useState(getInitialTab);
  const [expandedCompany, setExpandedCompany] = useState(null);
  const ovSort = useSort(null); // null = API order
  const mkSort = useSort(null); // null = efficiency ranking
  const hasData = companies.length > 0;

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

  // The key is kept in localStorage (above); drop it from the address bar so it does not stay in the history.
  useEffect(() => {
    updateUrlParams(p => { p.delete("apikey"); p.delete("apiKey"); });
  }, []);

  // Deep link: ?user= / ?username= / ?id= loads once (ref guards against StrictMode double effects).
  useEffect(() => {
    if (autoLoadRef.current) return;
    autoLoadRef.current = true;
    if (URL_USER) loadData();
  }, []);

  // A Retry that failed again: move focus from the load button to the new Retry button
  // (unless the user has moved on to something else meanwhile).
  useEffect(() => {
    if (!error || !focusRetryRef.current) return;
    focusRetryRef.current = false;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.id !== `${uid}-load`) return;
    document.getElementById(`${uid}-retry`)?.focus();
  }, [error]);

  // Retry unmounts the error box: keep focus on the load button, which stays.
  function retryLoad() {
    document.getElementById(`${uid}-load`)?.focus();
    loadData({ fromRetry: true });
  }

  // Persist the active tab as ?tab=
  useEffect(() => {
    updateUrlParams(p => {
      if (p.get("tab") == null && subTab === "overview") return;
      p.set("tab", subTab);
    });
  }, [subTab]);

  // Keep the selected tab visible in the horizontally scrolling tab bar (mobile).
  useEffect(() => {
    if (!hasData) return;
    const el = document.getElementById(`${uid}-tab-${subTab}`);
    const box = el?.parentElement;
    if (!el || !box || box.scrollWidth <= box.clientWidth) return;
    const left = el.offsetLeft, right = left + el.offsetWidth;
    if (left < box.scrollLeft || right > box.scrollLeft + box.clientWidth) box.scrollLeft = Math.max(0, left - 8);
  }, [subTab, hasData, isMobile]);

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
      setRateWait(remaining);
      setRatePause(remaining);
      clearInterval(interval);
      interval = setInterval(() => {
        remaining -= 1;
        setRateWait(Math.max(0, remaining));
        if (remaining <= 0) clearInterval(interval);
      }, 1000);
    };
    window.addEventListener('warera-rate-limit', handleRL);
    return () => {
      window.removeEventListener('warera-rate-limit', handleRL);
      clearInterval(interval);
    };
  }, []);

  async function loadData({ fromRetry = false } = {}) {
    const input = userInput.trim();
    if (!input || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true); setError(null); setRateWait(0); setPhase({ step: 0 });
    try {
      // Phase 1: Resolve user + load global data in parallel
      const [user, pricesData, regionsData, countriesData, configData] = await Promise.all([
        resolveUser(input),
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
      setPhase({ step: 1 });
      const userId = user._id || user.id || user.userId;
      const companiesResp = await apiCall("company.getCompanies", { userId, perPage: 100 });
      const companyIds = companiesResp?.items || [];
      if (!companyIds.length) {
        // Do not leave a previous player's factories under this player's name
        setCompanies([]); setWorkers({});
        throw appError("NO_FACTORIES", { username: user.username });
      }

      // Phase 3: Load company details + workers in parallel
      setPhase({ step: 1, n: companyIds.length });
      const companyDetails = await batchParallel(companyIds, async (cid) => {
        const [comp, wrk] = await Promise.all([
          apiCall("company.getById", { companyId: cid }),
          apiCall("worker.getWorkers", { companyId: cid }).catch(() => ({ workers: [] })),
        ]);
        return { comp, workers: Array.isArray(wrk) ? wrk : (wrk?.workers || wrk?.items || []) };
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
        setPhase({ step: 2, n: allWorkerUserIds.size });
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
      setPhase({ step: 3 });
      const wealthRanking = await apiCall("ranking.getRanking", { rankingType: "userWealth", limit: 100, skip: 0 }).catch(() => null);
      let totalWealth = 0;
      if (wealthRanking?.items) {
        const me = wealthRanking.items.find(i => (i.user?._id || i.user) === userId);
        if (me) totalWealth = me.value || 0;
      }
      const liquidAssets = totalWealth > 0 ? Math.max(0, totalWealth - totalCompaniesValue) : 0;
      setUserData(prev => ({ ...prev, liquidAssets, totalWealth, totalCompaniesValue }));

      // Phase 4: Load Party Ethics for factories' countries
      setPhase({ step: 4 });
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
              const c = queue.shift(); // each worker takes its own country
              let retryDelay = 0;
              try {
                const p = await apiCall("party.getById", { partyId: c.rulingParty });
                if (p?.ethics && thisBgFetch === currentBgFetch) {
                  setPartyEthics(prev => ({ ...prev, [c._id]: p.ethics }));
                }
                loaded++;
                if (thisBgFetch === currentBgFetch) setBgProgress({ loaded, total: remainingCountriesToFetch.length, status: "loading" });
              } catch (e) {
                queue.unshift(c); // retry it after the pause
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
      setPhase({ step: 5 });
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

      setLoadedAt(new Date());
      // Keep ?user= in step with the loaded player (reload / shared link shows the same one)
      updateUrlParams(p => { p.set("user", input); p.delete("username"); p.delete("id"); });
    } catch (e) {
      if (fromRetry) focusRetryRef.current = true;
      setError(classifyError(e, input));
    }
    loadingRef.current = false;
    setPhase(null);
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
  const THs = { ...TH, fontSize: 14 }; // headers with sort buttons (keeps the sort arrow >= 11px)
  const nowrap = { whiteSpace: "nowrap" };
  const sep = " ·\u00A0"; // separator that wraps together with the following part, never dangles at a line end
  // Small accent text on accent tints: the pink accent is below 4.5:1 there, so it gets a lighter tint.
  const accentInk = theme === "pink" ? blendWhite(C.accent, 0.4) : C.accent;
  const subText = { fontSize: 12, color: C.textMuted };
  const labelSmall = { fontFamily: F.h, fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase" };
  const headRow = { display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 10 };
  const cardPad = isMobile ? { padding: "14px" } : undefined;
  const mCard = { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 12, minWidth: 0 };
  // Base on the middle stop of the page gradient (what the glass cards mostly sit on), else the page colour.
  const cardSolid = blendWhite((String(T.bg).match(/#[0-9a-f]{6}(?= 40%)/i) || [])[0] || T.pageBg || "#0f172a", 0.05);
  // Sticky first column: opaque background (plus the row tint) so scrolled cells do not shine through.
  // Its table gets the same solid background, so the pinned cells match the rest of their row.
  const solidTable = { background: cardSolid };
  const sticky = (tint, z = 1, bar) => ({
    position: "sticky", left: 0, zIndex: z,
    background: tint ? `linear-gradient(${tint}, ${tint}), ${cardSolid}` : cardSolid,
    boxShadow: (bar ? "inset 3px 0 0 " + bar + ", " : "") + "inset -1px 0 0 rgba(255,255,255,0.08)",
  });

  const enemyWarnings = hasData ? getEnemyWarnings() : [];
  const wageWarnings = hasData ? getWageLossWarnings() : [];
  const betterRegions = hasData ? getBetterRegions() : [];
  const allProducts = hasData ? getAllProductsRanked() : [];
  const globalOptimization = hasData ? getGlobalOptimization() : [];
  const workerOptimization = hasData ? getWorkerOptimization() : [];
  const totalWarnings = enemyWarnings.length + wageWarnings.length;
  const anyWorkers = companies.some(c => (workers[c._id] || []).length > 0);
  const provisional = !!bgProgress; // remaining party ethics still loading -> bonuses may change

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

  // Overview rows: computed once in API order, then sorted for display.
  const ovRows = companies.map((comp, idx) => {
    const ws = workers[comp._id] || [];
    const bonus = getRegionBonus(comp);
    const enginePP = calcEnginePPDay(comp);
    const workerPPTotal = ws.reduce((sum, w) => sum + calcWorkerPPH(w, bonus) * 24, 0);
    return {
      comp, ws, bonus, enginePP, workerPPTotal,
      ppDay: enginePP + workerPPTotal,
      revenue: calcDailyRevenue(comp),
      cost: calcDailyCost(comp),
      profit: calcDailyProfit(comp),
      name: comp.name || L.factoryFallback(idx),
      isEnemy: enemyWarnings.some(w => w.company._id === comp._id),
      hasWageLoss: wageWarnings.some(w => w.company._id === comp._id),
      hasConfig: !!getPPPerUnit(comp.itemCode),
    };
  });
  const ovSorted = ovSort.apply(ovRows, {
    name: r => r.name, product: r => itemName(r.comp.itemCode, L), region: r => getRegionName(r.comp),
    bonus: r => r.bonus, workers: r => r.ws.length, pp: r => r.ppDay,
    revenue: r => r.revenue, cost: r => r.cost, profit: r => r.profit,
  });
  const totals = ovRows.reduce((t, r) => ({
    pp: t.pp + r.ppDay, engine: t.engine + r.enginePP, workerPP: t.workerPP + r.workerPPTotal,
    revenue: t.revenue + r.revenue, cost: t.cost + r.cost, profit: t.profit + r.profit, workers: t.workers + r.ws.length,
  }), { pp: 0, engine: 0, workerPP: 0, revenue: 0, cost: 0, profit: 0, workers: 0 });

  // Market rows keep their efficiency rank, whatever column they are sorted by.
  const mkRows = mkSort.apply(allProducts.map((p, i) => ({ ...p, rank: i + 1 })), {
    name: p => itemName(p.itemCode, L), type: p => p.type, price: p => p.price, material: p => p.materialCost,
    margin: p => p.netMargin, pp: p => p.pp, base: p => p.goldPerPP, max: p => p.maxGoldPerPP,
    factories: p => p.userCompanyCount || null, profit: p => p.userCompanyCount > 0 ? p.userTotalProfit : null,
  });

  // Loading progress
  const loadSteps = [L.loadStepPlayer, L.loadStepFactories, L.loadStepWorkers, L.loadStepWealth, L.loadStepEthics, L.loadStepDiplomacy];
  const phaseText = phase ? [
    L.loadingSearchPlayer,
    phase.n ? L.loadingFactoriesN(phase.n) : L.loadingFactories,
    L.loadingWorkerProfiles(phase.n || 0),
    L.loadingLiquid,
    L.loadingPartyEthics,
    L.loadingDiplomacy,
  ][phase.step] : "";

  let errorText = "";
  if (error) {
    switch (error.kind) {
      case "network": errorText = L.errNetwork; break;
      case "notFound": errorText = L.errPlayerNotFound(error.name); break;
      case "noExactMatch": errorText = L.errNoExactMatch(error.name); break;
      case "noFactories": errorText = L.errNoFactories(error.name); break;
      case "auth": errorText = L.errAuth; break;
      case "rateLimit": errorText = L.errRateLimit; break;
      default: errorText = L.errGeneric;
    }
  }

  // Tabs
  const TABS = [
    { key: "overview", label: L.tabOverview, icon: "🏭" },
    { key: "optimize", label: L.tabOptimize, icon: "💡" },
    { key: "market", label: L.tabMarket, icon: "💰" },
    { key: "build", label: L.tabOptimizerBuild, icon: "🏨" },
  ];
  const tabId = k => `${uid}-tab-${k}`;
  const panelId = `${uid}-panel`;
  function onTabKeyDown(e, i) {
    const last = TABS.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    setSubTab(TABS[next].key);
    document.getElementById(tabId(TABS[next].key))?.focus();
  }

  const inputStyle = { background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 8, color: C.text, padding: "10px 14px", fontSize: isMobile ? 16 : 15, fontFamily: F.m, outline: "none", width: "100%", minWidth: 0, boxSizing: "border-box" };
  const fieldHead = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 };
  const fieldLabel = { display: "flex", alignItems: "center", gap: 8, fontFamily: F.h, fontSize: 16, fontWeight: 700, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" };
  // Input hint next to the label (hover/tap); the input itself gets the same text as its description
  const infoMark = text => <Tip text={text}><span aria-hidden="true" style={{ color: C.textMuted, cursor: "help", fontSize: 16, padding: "0 4px" }}>&#9432;</span></Tip>;
  const toggleBtn = { all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "baseline", gap: 6, borderRadius: 3 };

  const statusBadges = r => <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
    {r.isEnemy && <Bdg color={C.red}>{L.badgeEnemy}</Bdg>}
    {r.hasWageLoss && <Bdg color="#ff9900">{L.badgeWageLoss}</Bdg>}
    {!r.hasConfig && <Bdg color={C.red}>{L.badgeConfigMissing}</Bdg>}
    {!r.isEnemy && !r.hasWageLoss && r.hasConfig && <Bdg color={C.green}>{L.badgeOk}</Bdg>}
  </div>;

  // Engine / worker PP breakdown; each part stays on one line, wrapping only at the separator
  const ppSplit = (engine, workerPP) => <>
    <span style={{ color: C.blue, whiteSpace: "nowrap" }}>{L.ppEngine(fmt(engine, 1))}</span>
    <span style={{ color: C.textMuted }}>{sep}</span>
    <span style={{ color: C.purple, whiteSpace: "nowrap" }}>{L.ppWorkers(fmt(workerPP, 1))}</span>
  </>;

  // Current -> recommended block for the phone cards
  const fromTo = (a, b) => <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", gap: 8, alignItems: "center", margin: "10px 0 12px" }}>
    <div style={{ minWidth: 0 }}>
      <div style={labelSmall}>{a.label}</div>
      <div style={{ color: C.text, overflowWrap: "anywhere" }}>{a.main}</div>
      {a.sub && <div style={subText}>{a.sub}</div>}
    </div>
    <span aria-hidden="true" style={{ color: C.accent, fontSize: 18 }}>→</span>
    <div style={{ minWidth: 0 }}>
      <div style={labelSmall}>{b.label}</div>
      <div style={{ color: C.green, fontWeight: 700, overflowWrap: "anywhere" }}>{b.main}</div>
      {b.sub && <div style={{ fontSize: 12, color: C.green }}>{b.sub}</div>}
    </div>
  </div>;

  function renderWorkerDetails(r) {
    const { comp, ws, bonus, enginePP, workerPPTotal, ppDay, cost } = r;
    const th = { ...TH, fontSize: 12, padding: "8px 10px", whiteSpace: "nowrap" };
    const td = extra => ({ ...TD(false), fontSize: 13, padding: "6px 10px", ...extra });
    const sumLabel = extra => td({ fontSize: 12, fontWeight: 700, color: C.textDim, textAlign: "right", ...extra });
    return <>
      <div style={{ fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
        {L.workerDetailsTitle(fmt(bonus, 2))}
      </div>
      <ScrollX label={`${r.name} – ${L.workerDetailsTitle(fmt(bonus, 2))}`}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>{L.colName}</th>
            <th style={th}>{L.colEnergy}</th>
            <th style={th}>{L.colProduction}</th>
            <th style={th}>{L.colFidelity}</th>
            <th style={th}>{L.colWage}</th>
            <th style={th}>{L.colFormula}</th>
            <th style={th}>{L.colPPH}</th>
            <th style={th}>{L.colPPDay}</th>
            <th style={th}>{L.colCostDay}</th>
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
                  <td style={td()}>{w.username || L.workerFallback(wi)}</td>
                  <td style={td(nowrap)}>
                    <span style={{ color: C.accent }}>{w.energy}</span>
                    <span style={{ color: C.textMuted, fontSize: 12 }}> {L.energyCurrent(fmt(w.energyCurrent || 0, 1))}</span>
                  </td>
                  <td style={td({ color: C.blue })}>{w.productivity}</td>
                  <td style={td({ color: fidelity > 0 ? C.green : C.textMuted })}>
                    {fidelity > 0 ? "+" + fmt(fidelity, 0) + "%" : "-"}
                  </td>
                  <td style={td(nowrap)}>
                    {fmt(w.wage || 0, 3)} G
                    <div style={{ fontSize: 12, color: C.textMuted }}>{L.basePPH(fmt(wBasePPH, 2))}</div>
                  </td>
                  <td style={td({ fontSize: 12, color: C.textMuted, fontFamily: F.m, whiteSpace: "nowrap" })}>
                    {w.energy}/100*{w.productivity}*(1+{fmt(bonus,1)}%)*(1+{fmt(fidelity,0)}%)
                  </td>
                  <td style={td({ color: C.purple, fontWeight: 700 })}>{fmt(wPPH, 2)}</td>
                  <td style={td({ color: C.purple })}>{fmt(wPPDay, 1)}</td>
                  <td style={td({ color: wCostDay > 0 ? C.red : C.textMuted, whiteSpace: "nowrap" })}>
                    {wCostDay > 0 ? fmt(wCostDay, 2) + " G" : "-"}
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
              <td colSpan={6} style={sumLabel()}>{L.sumWorkers}</td>
              <td style={td({ color: C.purple, fontWeight: 700 })}>{fmt(ws.reduce((s, w) => s + calcWorkerPPH(w, bonus), 0), 2)}</td>
              <td style={td({ color: C.purple, fontWeight: 700 })}>{fmt(workerPPTotal, 1)}</td>
              <td style={td({ color: C.red, fontWeight: 700, whiteSpace: "nowrap" })}>{fmt(cost, 2)} G</td>
            </tr>
            <tr>
              <td colSpan={6} style={sumLabel()}>{L.engineRow(comp.activeUpgradeLevels?.automatedEngine || 1)}</td>
              <td style={td({ color: C.blue, fontWeight: 700 })}>{fmt(enginePP / 24, 2)}</td>
              <td style={td({ color: C.blue, fontWeight: 700 })}>{fmt(enginePP, 1)}</td>
              <td style={td({ color: C.textMuted })}>-</td>
            </tr>
            <tr style={{ borderTop: "1px solid " + C.accent + "44" }}>
              <td colSpan={6} style={sumLabel({ fontSize: 13, color: C.accent })}>{L.totalRow}</td>
              <td style={td({ fontSize: 14, color: C.accent, fontWeight: 700 })}>{fmt(ppDay / 24, 2)}</td>
              <td style={td({ fontSize: 14, color: C.accent, fontWeight: 700 })}>{fmt(ppDay, 1)}</td>
              <td style={td({ color: C.red, fontWeight: 700, whiteSpace: "nowrap" })}>{fmt(cost, 2)} G</td>
            </tr>
          </tbody>
        </table>
      </ScrollX>
    </>;
  }

  // Phone variant of the worker details: one block per worker plus a small totals table.
  function renderWorkerDetailsCompact(r) {
    const { comp, ws, bonus, enginePP, workerPPTotal, ppDay, cost } = r;
    const th = { ...TH, fontSize: 12, letterSpacing: "0.04em", padding: "6px 5px", textAlign: "right", verticalAlign: "bottom" };
    const td = extra => ({ ...TD(false), fontSize: 12, padding: "6px 5px", whiteSpace: "nowrap", textAlign: "right", ...extra });
    const rowLabel = extra => td({ fontWeight: 700, color: C.textDim, textAlign: "left", whiteSpace: "normal", ...extra });
    return <>
      <div style={{ fontFamily: F.h, fontSize: 13, fontWeight: 700, color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
        {L.workerDetailsTitle(fmt(bonus, 2))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {ws.map((w, wi) => {
          const wPPH = calcWorkerPPH(w, bonus);
          const wCostDay = calcWorkerCostPerH(w) * 24;
          const fidelity = w.fidelity || 0;
          return <div key={wi} style={{ paddingBottom: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 8, overflowWrap: "anywhere" }}>{w.username || L.workerFallback(wi)}</div>
            <Stats min={120} items={[
              { label: L.colEnergy, value: w.energy, color: C.accent, sub: L.energyCurrent(fmt(w.energyCurrent || 0, 1)) },
              { label: L.colProduction, value: w.productivity, color: C.blue },
              { label: L.colFidelity, value: fidelity > 0 ? "+" + fmt(fidelity, 0) + "%" : "-", color: fidelity > 0 ? C.green : C.textMuted },
              { label: L.colWage, value: fmt(w.wage || 0, 3) + " G", sub: L.basePPH(fmt(calcWorkerBasePPH(w), 2)) },
              { label: L.colPPH, value: fmt(wPPH, 2), color: C.purple, bold: true },
              { label: L.colPPDay, value: fmt(wPPH * 24, 1), color: C.purple },
              { label: L.colCostDay, value: wCostDay > 0 ? fmt(wCostDay, 2) + " G" : "-", color: wCostDay > 0 ? C.red : C.textMuted },
              { label: L.colFormula, full: true, value: <span style={{ fontSize: 12, color: C.textMuted, overflowWrap: "anywhere" }}>{w.energy}/100*{w.productivity}*(1+{fmt(bonus,1)}%)*(1+{fmt(fidelity,0)}%)</span> },
            ]} />
          </div>;
        })}
      </div>
      <ScrollX label={`${r.name} – ${L.workerDetailsTitle(fmt(bonus, 2))}`} style={{ marginTop: 6 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={{ ...th, textAlign: "left" }}><span className="sr-only">{L.colName}</span></th>
            <th style={th}>{L.colPPH}</th>
            <th style={th}>{L.colPPDay}</th>
            <th style={th}>{L.colCostDay}</th>
          </tr></thead>
          <tbody>
            <tr>
              <td style={rowLabel()}>{L.sumWorkers}</td>
              <td style={td({ color: C.purple, fontWeight: 700 })}>{fmt(ws.reduce((s, w) => s + calcWorkerPPH(w, bonus), 0), 2)}</td>
              <td style={td({ color: C.purple, fontWeight: 700 })}>{fmt(workerPPTotal, 1)}</td>
              <td style={td({ color: C.red, fontWeight: 700 })}>{fmt(cost, 2)} G</td>
            </tr>
            <tr>
              <td style={rowLabel()}>{L.engineRow(comp.activeUpgradeLevels?.automatedEngine || 1)}</td>
              <td style={td({ color: C.blue, fontWeight: 700 })}>{fmt(enginePP / 24, 2)}</td>
              <td style={td({ color: C.blue, fontWeight: 700 })}>{fmt(enginePP, 1)}</td>
              <td style={td({ color: C.textMuted })}>-</td>
            </tr>
            <tr style={{ borderTop: "1px solid " + C.accent + "44" }}>
              <td style={rowLabel({ color: C.accent, fontSize: 13 })}>{L.totalRow}</td>
              <td style={td({ color: C.accent, fontWeight: 700 })}>{fmt(ppDay / 24, 2)}</td>
              <td style={td({ color: C.accent, fontWeight: 700 })}>{fmt(ppDay, 1)}</td>
              <td style={td({ color: C.red, fontWeight: 700 })}>{fmt(cost, 2)} G</td>
            </tr>
          </tbody>
        </table>
      </ScrollX>
    </>;
  }

  // ── Overview: table (desktop) ──
  function renderOverviewTable() {
    const thO = { ...THs, padding: "10px 10px" };
    const tdO = extra => ({ ...TD(false), padding: "8px 10px", ...extra });
    return <ScrollX label={L.sectionFactoryOverview(companies.length)} style={solidTable}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
        <thead><tr>
          <SortTh label={L.colName} k="name" sort={ovSort} style={{ ...thO, ...sticky(null, 2) }} />
          <SortTh label={L.colProduct} k="product" sort={ovSort} style={thO} />
          <th style={thO}>{L.colLevel}</th>
          <SortTh label={L.colRegion} k="region" sort={ovSort} style={thO} />
          <SortTh label={L.colBonus} k="bonus" sort={ovSort} style={thO} />
          <SortTh label={L.colWorkers} k="workers" sort={ovSort} style={thO} />
          <SortTh label={L.colTotalPP} k="pp" sort={ovSort} style={thO} />
          <SortTh label={L.colRevenue} k="revenue" sort={ovSort} style={thO} />
          <SortTh label={L.colCost} k="cost" sort={ovSort} style={thO} />
          <SortTh label={L.colProfit} k="profit" sort={ovSort} style={thO} />
          <th style={thO}>{L.colStatus}</th>
        </tr></thead>
        <tbody>
          {ovSorted.map((r, i) => {
            const id = r.comp._id;
            const hasW = r.ws.length > 0;
            const open = hasW && expandedCompany === id;
            const detailsId = `${uid}-w-${id}`;
            const tint = open ? C.accent + "0a" : i % 2 ? C.rowAlt : null; // light enough for muted text (4.5:1)
            const toggle = () => setExpandedCompany(open ? null : id);
            return <Fragment key={id}>
              <tr onClick={hasW ? toggle : undefined} style={{ background: tint || "transparent", cursor: hasW ? "pointer" : "default" }}>
                <td style={tdO(sticky(tint, 1, open ? C.accent : null))}>
                  {hasW
                    ? <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={e => { e.stopPropagation(); toggle(); }} style={toggleBtn}>
                        <span aria-hidden="true" style={{ fontSize: 11, color: C.accent, width: 12, flexShrink: 0 }}>{open ? "▼" : "▶"}</span>
                        <span>{r.name}</span>
                      </button>
                    : <span style={{ display: "inline-block", paddingLeft: 18 }}>{r.name}</span>}
                </td>
                <td style={tdO()}>{itemName(r.comp.itemCode, L)}</td>
                <td style={tdO(nowrap)}>
                  <div style={{ color: C.accent }}>{L.levelEngine(r.comp.activeUpgradeLevels?.automatedEngine || 1)}</div>
                  <div style={subText}>{L.levelStorage(r.comp.activeUpgradeLevels?.storage || 1)}</div>
                </td>
                <td style={tdO()}>
                  <div style={{ fontSize: 13 }}>{getRegionName(r.comp)}</div>
                  <div style={subText}>{getCountryName(r.comp.region)}</div>
                </td>
                <td style={tdO({ color: r.bonus > 0 ? C.green : C.textMuted, whiteSpace: "nowrap" })}>
                  {r.bonus > 0 ? "+" + fmt(r.bonus, 2) + "%" : "-"}
                </td>
                <td style={tdO()}>{r.ws.length}</td>
                <td style={tdO()}>
                  <div style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{fmt(r.ppDay, 1)}</div>
                  {r.workerPPTotal > 0 && <div style={{ fontSize: 12, marginTop: 2 }}>{ppSplit(r.enginePP, r.workerPPTotal)}</div>}
                </td>
                <td style={tdO({ color: C.accent, whiteSpace: "nowrap" })}>{fmt(r.revenue, 2)} G</td>
                <td style={tdO({ color: r.cost > 0 ? C.red : C.textMuted, whiteSpace: "nowrap" })}>
                  {r.cost > 0 ? fmt(r.cost, 2) + " G" : "-"}
                </td>
                <td style={tdO({ color: r.profit >= 0 ? C.green : C.red, fontWeight: 700, whiteSpace: "nowrap" })}>
                  {fmt(r.profit, 2)} G
                </td>
                <td style={tdO()}>{statusBadges(r)}</td>
              </tr>
              {hasW && (
                <tr id={detailsId} hidden={!open}>
                  <td colSpan={11} style={{ padding: 0, background: "rgba(0,0,0,0.2)" }}>
                    {/* inline-size containment: the wide worker table scrolls here instead of widening the main table */}
                    <div style={{ padding: "12px 20px 12px 36px", contain: "inline-size" }}>{renderWorkerDetails(r)}</div>
                  </td>
                </tr>
              )}
            </Fragment>;
          })}
        </tbody>
      </table>
    </ScrollX>;
  }

  // ── Overview: cards (phone) ──
  function renderOverviewCards() {
    return <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 12px 12px" }}>
      {ovSorted.map(r => {
        const id = r.comp._id;
        const hasW = r.ws.length > 0;
        const open = hasW && expandedCompany === id;
        const detailsId = `${uid}-w-${id}`;
        return <div key={id} style={{ ...mCard, borderColor: open ? C.accent + "66" : "rgba(255,255,255,0.08)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ minWidth: 0, flex: "1 1 150px" }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: C.text, overflowWrap: "anywhere" }}>{r.name}</div>
              <div style={{ fontSize: 13, color: C.textDim, marginTop: 2 }}>{itemName(r.comp.itemCode, L)}</div>
              <div style={subText}>{getRegionName(r.comp)}{sep}{getCountryName(r.comp.region)}</div>
            </div>
            {statusBadges(r)}
          </div>
          <Stats min={120} items={[
            { label: L.colBonus, value: r.bonus > 0 ? "+" + fmt(r.bonus, 2) + "%" : "-", color: r.bonus > 0 ? C.green : C.textMuted },
            { label: L.colLevel, value: L.levelEngine(r.comp.activeUpgradeLevels?.automatedEngine || 1), sub: L.levelStorage(r.comp.activeUpgradeLevels?.storage || 1), color: C.accent },
            { label: L.colWorkers, value: r.ws.length },
            { label: L.colTotalPP, value: fmt(r.ppDay, 1), bold: true, sub: r.workerPPTotal > 0 ? ppSplit(r.enginePP, r.workerPPTotal) : null },
            { label: L.colRevenue, value: fmt(r.revenue, 2) + " G", color: C.accent },
            { label: L.colCost, value: r.cost > 0 ? fmt(r.cost, 2) + " G" : "-", color: r.cost > 0 ? C.red : C.textMuted },
            { label: L.colProfit, value: fmt(r.profit, 2) + " G", color: r.profit >= 0 ? C.green : C.red, bold: true, big: true, full: true },
          ]} />
          {hasW && <>
            <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setExpandedCompany(open ? null : id)}
              aria-label={`${L.workerDetailsToggle(r.ws.length)}: ${r.name}`} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%", marginTop: 12, minHeight: 44, padding: "8px 12px", borderRadius: 8,
              border: "1px solid " + C.accent + "44", background: open ? C.accent + "18" : "rgba(255,255,255,0.03)", color: C.accent,
              fontFamily: F.h, fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", textAlign: "left", cursor: "pointer",
            }}>
              <span aria-hidden="true" style={{ fontSize: 11 }}>{open ? "▼" : "▶"}</span>
              {L.workerDetailsToggle(r.ws.length)}
            </button>
            <div id={detailsId} hidden={!open} style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(0,0,0,0.2)" }}>
              {renderWorkerDetailsCompact(r)}
            </div>
          </>}
        </div>;
      })}
    </div>;
  }

  return (
    <div>
      {/* User Input */}
      <GlassCard style={{ padding: isMobile ? "16px" : "20px 24px" }}>
        <div style={{ width: "100%", maxWidth: 640, margin: "0 auto" }}>
          <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: isMobile ? 14 : 16, marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={fieldHead}>
                <label htmlFor={`${uid}-player`} style={fieldLabel}>
                  <span aria-hidden="true" style={{ fontSize: 18 }}>👤</span>{L.sectionPlayer}
                </label>
                {infoMark(L.tipPlayerInput)}
              </div>
              <span id={`${uid}-player-hint`} hidden>{L.tipPlayerInput}</span>
              <input
                id={`${uid}-player`} aria-describedby={`${uid}-player-hint`}
                value={userInput} onChange={e => setUserInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && loadData()}
                placeholder={L.placeholderPlayer} autoComplete="off" spellCheck={false}
                style={inputStyle}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={fieldHead}>
                <label htmlFor={`${uid}-apikey`} style={fieldLabel}>
                  <span aria-hidden="true" style={{ fontSize: 18 }}>🔑</span>{L.sectionApiKey}
                </label>
                {infoMark(L.tipApiKey)}
              </div>
              <span id={`${uid}-apikey-hint`} hidden>{L.tipApiKey}</span>
              <input
                id={`${uid}-apikey`} aria-describedby={`${uid}-apikey-hint` + (apiKey ? "" : ` ${uid}-apikey-help`)}
                type="password"
                value={apiKey} onChange={e => setApiKey(e.target.value)}
                onKeyDown={e => e.key === "Enter" && loadData()}
                placeholder="wae_..." autoComplete="off" spellCheck={false}
                style={inputStyle}
              />
              {!apiKey && (
                <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 12, color: C.textDim, marginTop: 6, lineHeight: 1.4 }}>
                  <span aria-hidden="true" style={{ color: C.textMuted }}>ⓘ</span>
                  <span id={`${uid}-apikey-help`}>{L.apiKeyRequiredForWorkers}</span>
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Btn id={`${uid}-load`} on big color={C.accent} onClick={() => loadData()}
              disabled={!loading && !userInput.trim()}
              aria-disabled={loading || undefined} aria-busy={loading || undefined}
              style={loading ? { cursor: "progress" } : undefined}>
              {loading ? <><span className="dash-spinner" aria-hidden="true" />{L.loadingGeneric}</> : L.btnLoadData}
            </Btn>
          </div>
          {loading && phase && (
            <ol aria-label={L.loadProgressLabel} style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>
              {loadSteps.map((s, i) => {
                const done = i < phase.step, cur = i === phase.step;
                return <li key={i} aria-current={cur ? "step" : undefined} style={{
                  padding: "3px 10px", borderRadius: 999, fontSize: 12, fontFamily: F.m, whiteSpace: "nowrap",
                  border: "1px solid " + (cur ? C.accent + "88" : done ? C.green + "44" : "rgba(255,255,255,0.08)"),
                  background: cur ? C.accent + "18" : "transparent",
                  color: cur ? accentInk : done ? C.green : C.textMuted, fontWeight: cur ? 700 : 400,
                }}>
                  {done && <span aria-hidden="true">✓ </span>}
                  {s}
                  {done && <span className="sr-only"> ({L.loadStepDone})</span>}
                </li>;
              })}
            </ol>
          )}
          {/* Polite status: loading steps, a rate-limit pause (once, not every second) and the loaded result */}
          <div role="status" aria-live="polite" style={{ textAlign: "center", fontSize: 12, fontFamily: F.m }}>
            {loading && (rateWait > 0
              ? <span className="sr-only">{L.rateLimitAnnounce(ratePause)}</span>
              : phaseText && <div style={{ marginTop: 8, color: C.textDim }}>{phaseText}</div>)}
            {userData && !loading && !error && (
              <div style={{ marginTop: 12, color: C.green }}>
                {L.successLoaded(userData.username, companies.length)}
                {ownerCountry && <>{sep}{L.successCountryName(ownerCountry.name)}</>}
                {loadedAt && <span style={{ color: C.textDim }}>{sep}<span style={nowrap}>{L.pricesAsOf(fmtClock(loadedAt))}</span></span>}
              </div>
            )}
          </div>
          {loading && rateWait > 0 && (
            <div aria-hidden="true" style={{ marginTop: 8, textAlign: "center", fontSize: 12, fontFamily: F.m, color: "#f97316" }}>
              {L.rateLimitWait(rateWait)}
            </div>
          )}
          {error && (
            <div role="alert" style={{ marginTop: 14, padding: "12px 14px", borderRadius: 8, border: "1px solid " + C.red + "55", background: C.red + "14", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 14px" }}>
              <div style={{ flex: "1 1 240px", minWidth: 0, display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1.2, color: C.red }}>⚠</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: C.red, fontSize: 14, lineHeight: 1.45 }}>{errorText}</div>
                  {error.detail && <div style={{ color: C.textMuted, fontSize: 12, marginTop: 4, overflowWrap: "anywhere" }}>{L.errTechDetail(error.detail)}</div>}
                </div>
              </div>
              <Btn id={`${uid}-retry`} on color={C.red} onClick={retryLoad} disabled={loading || !userInput.trim()}>
                <span aria-hidden="true">↻ </span>{L.btnRetry}
              </Btn>
            </div>
          )}
        </div>
      </GlassCard>

      {/* Warnings Banner */}
      {totalWarnings > 0 && (
        <GlassCard glow="rgba(248,113,113,0.3)" style={{ borderColor: C.red + "44", ...cardPad }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span aria-hidden="true" style={{ fontSize: 24, color: C.red }}>⚠</span>
            <div>
              <div style={{ fontFamily: F.h, fontSize: 15, fontWeight: 700, color: C.red, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {L.warningsTitle(totalWarnings)}
              </div>
              <div style={{ fontSize: 12, color: C.textDim }}>
                {[
                  enemyWarnings.length > 0 && L.warningEnemy(enemyWarnings.length),
                  wageWarnings.length > 0 && L.warningWage(wageWarnings.length),
                ].filter(Boolean).join(sep)}
              </div>
            </div>
          </div>
        </GlassCard>
      )}

      {!hasData && !loading && !error && (
        <GlassCard>
          <div style={{ textAlign: "center", color: C.textDim, padding: isMobile ? "24px 0" : "40px 0" }}>
            {userInput.trim() ? L.emptyStateReady : L.emptyState}
          </div>
        </GlassCard>
      )}

      {hasData && (
        <>
          {/* Sub-Tab Navigation (+ background progress) */}
          <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", flexWrap: isMobile ? "nowrap" : "wrap", alignItems: isMobile ? "stretch" : "center", gap: 8, marginBottom: 14 }}>
            <div role="tablist" aria-label={L.tabsLabel} className={isMobile ? "hscroll" : undefined}
              style={isMobile ? { gap: 8, padding: 4, margin: -4, position: "relative" } : { display: "flex", flexWrap: "wrap", gap: 8, position: "relative" }}>
              {TABS.map((t, i) => {
                const sel = subTab === t.key;
                return (
                  <Btn key={t.key} id={tabId(t.key)} role="tab" aria-selected={sel} aria-controls={panelId} tabIndex={sel ? 0 : -1}
                    on={sel} color={C.accent} onClick={() => setSubTab(t.key)} onKeyDown={e => onTabKeyDown(e, i)} style={{ flexShrink: 0 }}>
                    <span aria-hidden="true">{t.icon}</span> {t.label}
                  </Btn>
                );
              })}
            </div>
            {bgProgress && (() => {
              const frac = bgProgress.loaded / Math.max(1, bgProgress.total);
              const waiting = bgProgress.status === "waiting";
              const col = waiting ? "#f97316" : C.green;
              return (
                <div style={{ flex: isMobile ? "none" : "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4, justifyContent: "center", ...glass(0.05, 8), padding: "8px 14px", borderRadius: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div id={`${uid}-bg`} style={{ fontSize: 12, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, whiteSpace: "nowrap" }}>
                      {L.bgDataLabel}
                    </div>
                    <div role="progressbar" aria-labelledby={`${uid}-bg`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}
                      style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${frac * 100}%`, height: "100%", background: col, transition: "width 0.3s", animation: waiting ? "dashBlink 2s infinite" : "none" }} />
                    </div>
                    <div style={{ fontSize: 12, color: col, fontWeight: 700, minWidth: 32, textAlign: "right" }}>
                      {Math.round(frac * 100)}%
                    </div>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.4, color: waiting ? "#f97316" : C.textMuted }}>
                    {waiting ? L.bgWaiting : L.bgLoading}
                  </div>
                </div>
              );
            })()}
          </div>

          <div role="tabpanel" id={panelId} aria-labelledby={tabId(subTab)} tabIndex={0} style={{ borderRadius: 12 }}>

          {/* ── OVERVIEW TAB ── */}
          {subTab === "overview" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 14 }}>
                <Kpi label={L.colProfit} value={fmt(totals.profit, 2) + " G"} color={totals.profit >= 0 ? C.green : C.red} />
                <Kpi label={L.colRevenue} value={fmt(totals.revenue, 2) + " G"} color={C.accent} />
                <Kpi label={L.colCost} value={fmt(totals.cost, 2) + " G"} color={totals.cost > 0 ? C.red : C.text} />
                <Kpi label={L.colTotalPP} value={fmt(totals.pp, 1)} sub={totals.workerPP > 0 ? ppSplit(totals.engine, totals.workerPP) : null} />
                <Kpi label={L.kpiFactories} value={companies.length} />
                <Kpi label={L.colWorkers} value={totals.workers} />
              </div>
              <GlassCard style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: isMobile ? "14px 14px 8px" : "16px 20px 8px" }}>
                  <Sec icon="🏭">{L.sectionFactoryOverview(companies.length)}</Sec>
                  {anyWorkers && !isMobile && <div style={{ fontSize: 12, color: C.textMuted, marginTop: -10, marginBottom: 8 }}>{L.tipClickWorkerDetails}</div>}
                  {!anyWorkers && !apiKey.trim() && (
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: -10, marginBottom: 8 }}>
                      <span aria-hidden="true">ⓘ </span>{L.workerDetailsNeedApiKey}
                    </div>
                  )}
                </div>
                {isMobile ? renderOverviewCards() : renderOverviewTable()}
              </GlassCard>
            </>
          )}

          {/* ── OPTIMIZATION TAB ── */}
          {subTab === "optimize" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Enemy Warnings */}
              {enemyWarnings.length > 0 && (
                <GlassCard glow="rgba(248,113,113,0.2)" style={{ borderColor: C.red + "33", ...cardPad }}>
                  <Sec icon="⚔️">{L.sectionEnemyWarnings(enemyWarnings.length)}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                    {L.enemyWarningDesc(ownerCountry?.name)}
                  </div>
                  {enemyWarnings.map((w, i) => (
                    <div key={i} style={{ ...glass(0.08, 10), borderRadius: 8, padding: "12px 16px", marginBottom: 8, borderColor: C.red + "33" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <span style={{ fontWeight: 700, color: C.text }}>{w.company.name || itemName(w.company.itemCode, L)}</span>
                          <span style={{ color: C.textMuted, marginLeft: 8 }}>({itemName(w.company.itemCode, L)})</span>
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
                <GlassCard glow="rgba(255,153,0,0.15)" style={{ borderColor: "#ff990033", ...cardPad }}>
                  <Sec icon="💸">{L.sectionWageWarnings(wageWarnings.length)}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                    {L.wageWarningDesc}
                  </div>
                  <ScrollX label={L.sectionWageWarnings(wageWarnings.length)} style={{ ...solidTable, borderRadius: 8 }}>
                    <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                      <thead><tr>
                        <th style={{ ...TH, ...sticky(null, 2) }}>{L.colName}</th>
                        <th style={TH}>{L.colWorkers}</th>
                        <th style={TH}>{L.colWage}</th>
                        <th style={TH}>{L.colMaxWage}</th>
                        <th style={TH}>{L.colCost}</th>
                        <th style={TH}>{L.colRevenue}</th>
                        <th style={TH}>{L.colProfit}</th>
                      </tr></thead>
                      <tbody>
                        {wageWarnings.map((w, i) => {
                          const tint = i % 2 ? C.rowAlt : null;
                          return (
                            <tr key={i} style={{ background: tint || "transparent" }}>
                              <td style={{ ...TD(false), ...sticky(tint) }}>{w.company.name || itemName(w.company.itemCode, L)}</td>
                              <td style={TD(false)}>
                                <div>{w.worker.username || w.worker.userId?.slice(0, 8) || L.workerGeneric}</div>
                                <div style={{ ...subText, whiteSpace: "nowrap" }}>{L.colEnergy} {w.worker.energy} · {L.colProduction} {w.worker.productivity}</div>
                              </td>
                              <td style={{ ...TD(false), color: C.red, ...nowrap }}>{fmt(w.worker.wage || 0, 3)} G</td>
                              <td style={{ ...TD(false), color: C.green, ...nowrap }}>{fmt(w.breakEvenWage, 3)} G</td>
                              <td style={{ ...TD(false), color: C.red, ...nowrap }}>{fmt(w.dailyWage, 2)} G</td>
                              <td style={{ ...TD(false), color: C.green, ...nowrap }}>{fmt(w.dailyContribution, 2)} G</td>
                              <td style={{ ...TD(false), color: C.red, fontWeight: 700, ...nowrap }}>-{fmt(w.loss, 2)} G</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </ScrollX>
                </GlassCard>
              )}

              {/* Better Regions */}
              <GlassCard glow={betterRegions.length > 0 ? C.greenGlow : undefined} style={cardPad}>
                <div style={headRow}>
                  <Sec icon="🌎">{L.sectionBetterRegions(betterRegions.length)}</Sec>
                  {provisional && <div style={{ marginBottom: 16 }}><ProvisionalBadge L={L} ink={accentInk} /></div>}
                </div>
                <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                  {L.betterRegionsDesc}
                </div>
                {betterRegions.length === 0 ? (
                  <div style={{ padding: "16px", textAlign: "center", color: C.green, background: "rgba(0,255,0,0.05)", borderRadius: 8, border: "1px solid " + C.green + "44" }}>
                    {L.allOptimalRegions}
                  </div>
                ) : isMobile ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {betterRegions.map((s, i) => (
                      <div key={i} style={mCard}>
                        <div style={{ fontWeight: 700, color: C.text, overflowWrap: "anywhere" }}>{s.company.name || itemName(s.company.itemCode, L)}</div>
                        <div style={subText}>{itemName(s.company.itemCode, L)}</div>
                        {fromTo(
                          { label: L.colCurrent, main: s.currentRegion?.name || "?", sub: "+" + fmt(s.currentBonus, 1) + "%" },
                          { label: L.colBestRegion, main: s.bestRegion?.name || "?", sub: "+" + fmt(s.bestBonus, 1) + "%" },
                        )}
                        <Stats min={120} items={[
                          { label: L.colExtraGain, value: "+" + fmt(s.dailyGain, 2) + " G", color: C.green, bold: true },
                          { label: L.colMoveCost, value: fmt(s.relocCost, 2) + " G", color: C.textDim },
                          { label: L.colPayback, value: s.paybackDays === Infinity ? L.never : L.days(fmt(s.paybackDays, 1)), bold: true,
                            color: s.paybackDays <= 7 ? C.green : s.paybackDays <= 30 ? C.accent : C.red },
                        ]} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <ScrollX label={L.sectionBetterRegions(betterRegions.length)}>
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
                              <div>{s.company.name || itemName(s.company.itemCode, L)}</div>
                              <div style={subText}>{itemName(s.company.itemCode, L)}</div>
                            </td>
                            <td style={TD(false)}>
                              <div>{s.currentRegion?.name || "?"}</div>
                              <div style={subText}>+{fmt(s.currentBonus, 1)}%</div>
                            </td>
                            <td style={{ ...TD(false), color: C.accent, fontSize: 18 }}>&rarr;</td>
                            <td style={TD(false)}>
                              <div style={{ color: C.green }}>{s.bestRegion?.name || "?"}</div>
                              <div style={{ fontSize: 12, color: C.green }}>+{fmt(s.bestBonus, 1)}%</div>
                            </td>
                            <td style={{ ...TD(false), color: C.green, fontWeight: 700, ...nowrap }}>+{fmt(s.dailyGain, 2)} G</td>
                            <td style={{ ...TD(false), color: C.textDim, ...nowrap }}>{fmt(s.relocCost, 2)} G</td>
                            <td style={{ ...TD(false), fontWeight: 700, whiteSpace: "nowrap", color: s.paybackDays <= 7 ? C.green : s.paybackDays <= 30 ? C.accent : C.red }}>
                              {s.paybackDays === Infinity ? L.never : L.days(fmt(s.paybackDays, 1))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollX>
                )}
              </GlassCard>

              {/* Worker Optimization */}
              {workerOptimization.length > 0 && (
                <GlassCard glow={C.blueGlow} style={cardPad}>
                  <Sec icon="👥">{L.sectionWorkerOpt(workerOptimization.length)}</Sec>
                  <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                    {L.workerOptDesc}
                  </div>
                  {workerOptimization.map((s, i) => (
                    <div key={i} style={{ ...glass(0.08, 10), borderRadius: 8, padding: isMobile ? "12px" : "12px 16px", marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <span style={{ color: C.accent, fontWeight: 700 }}>{s.worker.username || L.workerGeneric}</span>
                          <span style={{ color: C.textDim, margin: "0 8px" }}>{L.wordFrom}</span>
                          <span style={{ color: C.text, fontWeight: 600 }}>{s.fromCompany.name || itemName(s.fromCompany.itemCode, L)}</span>
                          <span style={{ color: C.textDim, fontSize: 12 }}> ({itemName(s.fromCompany.itemCode, L)}, {L.goldPerDay(fmt(s.currentNetPerDay, 2))})</span>
                          <span style={{ color: C.accent, margin: "0 10px", fontSize: 16 }}>&rarr;</span>
                          <span style={{ color: C.green, fontWeight: 600 }}>{s.toCompany.name || itemName(s.toCompany.itemCode, L)}</span>
                          <span style={{ color: C.green, fontSize: 12 }}> ({itemName(s.toCompany.itemCode, L)}, {L.goldPerDay(fmt(s.newNetPerDay, 2))})</span>
                        </div>
                        <Bdg color={C.green}>{L.goldPerDay("+" + fmt(s.dailyGain, 2))}</Bdg>
                      </div>
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                        <div style={{ color: C.textDim, minWidth: 0 }}>
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
              <GlassCard glow={globalOptimization.length > 0 ? C.accentGlow : undefined} style={cardPad}>
                <div style={headRow}>
                  <Sec icon="🔄">{L.sectionGlobalOpt(globalOptimization.length)}</Sec>
                  {provisional && <div style={{ marginBottom: 16 }}><ProvisionalBadge L={L} ink={accentInk} /></div>}
                </div>
                <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                  {L.globalOptDesc}
                </div>
                {globalOptimization.length === 0 ? (
                  <div style={{ padding: "16px", textAlign: "center", color: C.green, background: "rgba(0,255,0,0.05)", borderRadius: 8, border: "1px solid " + C.green + "44" }}>
                    {L.allOptimalGlobal}
                  </div>
                ) : isMobile ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {globalOptimization.map((s, i) => (
                      <div key={i} style={mCard}>
                        <div style={{ fontWeight: 700, color: C.text, overflowWrap: "anywhere" }}>{s.company.name || L.factoryFallback(companies.indexOf(s.company))}</div>
                        {fromTo(
                          { label: L.colCurrent, main: itemName(s.currentItem, L), sub: `${s.currentRegion?.name || "?"} (+${fmt(s.currentBonus, 1)}%)` },
                          { label: L.colGlobalRec, main: itemName(s.newItem, L), sub: `${s.newRegion?.name || "?"} (+${fmt(s.newBonus, 1)}%)` },
                        )}
                        <Stats min={120} items={[
                          { label: L.colOldProfit, value: fmt(s.currentProfit, 2) + " G", color: C.textDim },
                          { label: L.colNewProfit, value: fmt(s.newProfit, 2) + " G", color: C.green },
                          { label: L.colExtraProfit, value: "+" + fmt(s.dailyGain, 2) + " G", color: C.green, bold: true },
                          { label: L.colConcrete, value: s.concreteNeeded, sub: fmt(s.totalCost, 1) + " G", color: C.red },
                          { label: L.colPayback, value: L.days(fmt(s.paybackDays, 1)), bold: true,
                            color: s.paybackDays <= 2 ? C.green : s.paybackDays <= 7 ? C.accent : C.red },
                        ]} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <ScrollX label={L.sectionGlobalOpt(globalOptimization.length)}>
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
                            <td style={TD(false)}>{s.company.name || L.factoryFallback(companies.indexOf(s.company))}</td>
                            <td style={TD(false)}>
                              <div>{itemName(s.currentItem, L)}</div>
                              <div style={subText}>{s.currentRegion?.name} (+{fmt(s.currentBonus, 1)}%)</div>
                            </td>
                            <td style={{ ...TD(false), color: C.accent, fontSize: 18 }}>&rarr;</td>
                            <td style={TD(false)}>
                              <div style={{ color: C.green, fontWeight: 700 }}>{itemName(s.newItem, L)}</div>
                              <div style={{ fontSize: 12, color: C.green }}>{s.newRegion?.name} (+{fmt(s.newBonus, 1)}%)</div>
                            </td>
                            <td style={{ ...TD(false), color: C.textDim, ...nowrap }}>{fmt(s.currentProfit, 2)} G</td>
                            <td style={{ ...TD(false), color: C.green, ...nowrap }}>{fmt(s.newProfit, 2)} G</td>
                            <td style={{ ...TD(false), color: C.green, fontWeight: 700, ...nowrap }}>+{fmt(s.dailyGain, 2)} G</td>
                            <td style={{ ...TD(false), color: C.red, ...nowrap }}>{s.concreteNeeded} <span style={{ fontSize: 12 }}>({fmt(s.totalCost, 1)} G)</span></td>
                            <td style={{ ...TD(false), fontWeight: 700, whiteSpace: "nowrap", color: s.paybackDays <= 2 ? C.green : s.paybackDays <= 7 ? C.accent : C.red }}>
                              {L.days(fmt(s.paybackDays, 1))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollX>
                )}
              </GlassCard>
            </div>
          )}

          {/* ── MARKET TAB ── */}
          {subTab === "market" && (
            <GlassCard style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: isMobile ? "14px 14px 8px" : "16px 20px 8px" }}>
                <div style={headRow}>
                  <Sec icon="💰">{L.sectionMarket}</Sec>
                  {provisional && <div style={{ marginBottom: 16 }}><ProvisionalBadge L={L} ink={accentInk} /></div>}
                </div>
                <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12 }}>
                  {L.marketDesc}
                </div>
              </div>
              <ScrollX label={L.sectionMarket} style={solidTable}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 900 }}>
                  <thead><tr>
                    {!isMobile && <th style={THs}>#</th>}
                    <SortTh label={L.colName} k="name" sort={mkSort} style={{ ...THs, ...sticky(null, 2) }} />
                    <SortTh label={L.colType} k="type" sort={mkSort} style={THs} />
                    <SortTh label={L.colSellPerUnit} k="price" sort={mkSort} style={THs} />
                    <SortTh label={L.colMatCost} k="material" sort={mkSort} style={THs} />
                    <SortTh label={L.colMargin} k="margin" sort={mkSort} style={THs} />
                    <SortTh label={L.colPPUnit} k="pp" sort={mkSort} style={THs} />
                    <SortTh label={L.colBaseMarginPP} k="base" sort={mkSort} style={THs} />
                    <SortTh k="max" sort={mkSort} style={THs} tip={provisional ? L.provisionalTip : undefined}
                      label={provisional
                        ? <>{L.colMaxMarginPP}<br /><span style={{ color: accentInk, fontSize: 12, letterSpacing: "0.06em" }}><span aria-hidden="true">⏳ </span>{L.provisional}</span></>
                        : L.colMaxMarginPP} />
                    <SortTh label={L.colYourFactories} k="factories" sort={mkSort} style={THs} />
                    <SortTh label={L.colYourProfit} k="profit" sort={mkSort} style={THs} />
                  </tr></thead>
                  <tbody>
                    {mkRows.map((p, i) => {
                      const isProducing = p.userCompanyCount > 0;
                      const needsStr = p.needs ? Object.entries(p.needs).map(([k, v]) => v + "× " + itemName(k, L)).join(", ") : null;
                      const tint = isProducing ? C.accent + "0a" : i % 2 ? C.rowAlt : null;
                      const bar = isProducing ? C.accent : null;
                      const typeCol = p.type === "raw" ? C.blue : C.purple; // badge text a bit lighter: >= 4.5:1 on tinted rows
                      const rank = <span style={{ fontFamily: F.h, fontWeight: 700, color: p.rank <= 3 ? C.accent : C.textDim, fontSize: 16 }}>{p.rank}</span>;
                      return (
                        <tr key={p.itemCode} style={{ background: tint || "transparent" }}>
                          {!isMobile && <td style={{ ...TD(false), boxShadow: bar ? "inset 3px 0 0 " + bar : undefined }}>{rank}</td>}
                          <td style={{ ...TD(false), fontWeight: 700, ...sticky(tint, 1, isMobile ? bar : null) }}>
                            {isMobile
                              ? <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                                  <span style={{ flex: "0 0 22px" }}>{rank}</span>
                                  <span>{itemName(p.itemCode, L)}</span>
                                </div>
                              : itemName(p.itemCode, L)}
                          </td>
                          <td style={{ ...TD(false), fontSize: 12 }}>
                            <Bdg color={typeCol}><span style={{ color: blendWhite(typeCol, 0.25) }}>{p.type === "raw" ? L.badgeRaw : L.badgeProduct}</span></Bdg>
                          </td>
                          <td style={{ ...TD(false), color: C.accent, ...nowrap }}>{fmt(p.price, 4)} G</td>
                          <td style={TD(false)}>
                            {p.materialCost > 0
                              ? <div>
                                  <span style={{ color: C.red, ...nowrap }}>{fmt(p.materialCost, 4)} G</span>
                                  <div style={subText}>{needsStr}</div>
                                </div>
                              : <span style={{ color: C.textMuted }}>-</span>
                            }
                          </td>
                          <td style={{ ...TD(false), color: p.netMargin > 0 ? C.green : C.red, fontWeight: 700, ...nowrap }}>
                            {fmt(p.netMargin, 4)} G
                          </td>
                          <td style={TD(false)}>{p.pp}</td>
                          <td style={{ ...TD(false), fontWeight: 700, color: C.textDim, fontSize: 13, ...nowrap }}>
                            {fmt(p.goldPerPP, 4)} G
                          </td>
                          <td style={{ ...TD(false), fontWeight: 700, color: p.rank === 1 ? C.green : p.maxGoldPerPP > 0 ? C.text : C.red, fontSize: 15 }}>
                            <div style={nowrap}>{fmt(p.maxGoldPerPP, 4)} G</div>
                            <div style={{ fontSize: 12, fontWeight: 400, color: p.maxBonus > 0 ? C.green : C.textMuted }}>
                              {p.maxBonus > 0 ? `${p.bestRegionName} (+${fmt(p.maxBonus, 1)}%)` : "–"}
                            </div>
                          </td>
                          <td style={TD(false)}>
                            {isProducing
                              ? <span style={{ color: C.accent, ...nowrap }}>{L.factoriesCount(p.userCompanyCount)}</span>
                              : <span style={{ color: C.textMuted }}>-</span>
                            }
                          </td>
                          <td style={TD(false)}>
                            {isProducing
                              ? <span style={{ color: p.userTotalProfit >= 0 ? C.green : C.red, fontWeight: 700, ...nowrap }}>
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
              </ScrollX>
            </GlassCard>
          )}

          {/* ── OPTIMIZER BUILD TAB ── */}
          {subTab === "build" && optimizerProps && (
            <FactoryOptimizer theme={theme} setTheme={setTheme} optData={optimizerProps} lang={lang} />
          )}
          </div>
        </>
      )}
    </div>
  );
}
