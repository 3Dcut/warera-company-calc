// ═══════════════════════════════════════════════════════════════════════════
//   EMPLOYEE MODEL — pure WarEra v0.27.4/v0.28 employee mechanics
//
//   No React, no JSX, no network. Every time-dependent function takes nowMs
//   (default Date.now()) so tests can pin the clock.
//
//   Sources of truth, in order: the project spec's truth table (M1–M33),
//   live API data verified 2026-11-06 (39 employees, estimate reproduced
//   exactly for 39/39), the game client bundle (build 1793817408002) and the
//   official devlogs v0.27–v0.28. Key facts:
//   - PP/h = max(1, production stat)/4 × (1 + Σ bonus percents/100).
//   - Happiness = clamp(50 + Σ contribution deltas + mitigated, 0, 100);
//     `mitigated` adds back half of all negative deltas and exists only for
//     the loyal trait. Responsibility contributes +3 base happiness per point
//     (since v0.27.3 it no longer dampens losses). Income tax costs
//     1 happiness per percent, undampened.
//   - Transfers between own companies are free since v0.27.3 (no happiness
//     penalty, no cooldown); only specialization, tenure traits and coworker
//     traits change. Moving the COMPANY still costs −10 happiness for 7 days
//     plus 5 concrete, unless a free move is left.
//   - Employees age 1 year per day worked or trained (a disabled company
//     pauses aging and training). Retirement is a RANDOM EVENT from age 65,
//     repeating every 10 days, with keep odds falling 5 points per year over
//     65 — never a hard cutoff. survivalCurve() models it.
//   - Wage is set by the NPC: ≈ production/4 × ppMoneyValue × expectation
//     (0.7–1.3; greedy +20 %, modest −15 %, climber drifts +0.02/week).
//     Live data (39/39) prices the stat WITHOUT trait flats ("bt" basis);
//     detectWageBasis() keeps checking so a server change is picked up.
// ═══════════════════════════════════════════════════════════════════════════

export const RULES = {
  outputDivisor: 4,              // PP per hour = production stat / 4, before bonuses
  minStat: 1,                    // no stat goes below 1
  happinessNeutral: 50,
  happinessMin: 0,
  happinessMax: 100,
  happinessPercentPerPoint: 1,   // each point above/below 50 = ±1 % output
  happinessGood: 60,             // game colours: green from 60
  quitThreshold: 30,             // quit chance starts below 30 happiness ...
  flightRiskQuitThreshold: 50,   // ... or below 50 with the flightRisk trait
  quitMaxPerHour: 0.05,          // 5 %/h at happiness 0, linear from the threshold
  managementPercentPerPoint: 2,  // owner AND hired manager: +2 % per point (points = 1 + level)
  coreRegionBonusPercent: 5,     // company in a core region of the owner's country
  specializationPercentPerDay: 1, // +1 % per day worked in a good, kept per good ...
  specializationMaxPercent: 20,  // ... up to +20 % (quickStudy doubles the rate)
  responsibilityHappinessPerPoint: 3, // v0.27.3: +3 base happiness per Responsibility point
  loyalLossMultiplier: 0.5,      // loyal halves negative happiness deltas (API: `mitigated`)
  taxShyPercentPerTaxPercent: 1, // trait "taxShy": -1 % output per 1 % income tax ...
  taxShyMaxPercent: 30,          // ... down to -30 %
  taxHappinessPerPercent: 1,     // each 1 % income tax = -1 happiness (undampened)
  companyMoveHappinessPenalty: 10, // company moved to another region (7 days, not on a free move)
  movePenaltyDays: 7,
  battleHappinessPenalty: 5,     // battle in the region
  storageFullHappiness: 10,      // full storage: -10 happiness (stockpiler ignores it)
  unpaidHappiness: 10,           // unpaid hour: -10 happiness
  retirementAge: 65,
  retirementRepeatDays: 10,      // the retirement event repeats every 10 days ...
  retirementOddsPerYear: 5,      // ... and keeping gets 5 points harder per year over 65
  notNowBase: 70,                // "not now": LUCK check, fail = leaves
  convinceBase: 65,              // "convince": STANDARD check, only a crit-fail loses them
  convinceLoyalBonus: 15,
  convinceCostWageDays: 0.75,    // convince costs 0.75 × 24 × hourly wage
  critShare: 0.1,                // share of fails that are critical (gambler: 0.2)
  gamblerCritShare: 0.2,
  fireLockHours: 12,             // new hires cannot be fired for 12 h
  trainingEnergy: 10,            // per session; always spends 1 potential
  hireEnergy: 10,
  potentialMaxCap: 15,           // secondWind raises potentialMax up to 15
  wageExpectationFloor: 0.7,     // negotiation cards cannot push expectation below 0.7
  climberDriftPerWeek: 0.02,
  greedyMarkup: 0.2,
  modestMarkup: -0.15,
  toolboxPerLuckHour: 0.001,     // toolbox find chance per luck point per worked hour
  nationalistHappiness: 10,      // v0.28
  outputVarianceSpread: 0.1,     // hourly output varies ±10 % around the estimate
};

// Goods each tool family boosts (from the game client). A tool in a company making another
// good sits idle.
export const TOOL_FAMILY_GOODS = {
  sickle: ["grain", "livestock", "coca", "wood", "fish"],
  pickaxe: ["limestone", "iron", "lead", "petroleum"],
  skillet: ["bread", "steak", "cookedFish"],
  hammer: ["steel", "concrete"],
  flask: ["oil", "paper", "cocain"],
  caliper: ["lightAmmo", "ammo", "heavyAmmo"],
};

// Company decisions (product/region) are evaluated day by day for this long; after it every
// temporary effect of such a change is over: specialization rebuilds in ≤ 20 days, veteran
// returns after 30, diamondInTheRough tops out by 40, burnout by 60, a company move costs
// happiness for 7. Personal decisions (keep/fire/train) use the employee's own expected
// remaining days instead — at day 61 hardly anyone of the current roster would still be there.
export const TRANSITION_DAYS = 61;

// All 53 trait codes (client build 1793817408002). kind: P = place/good/tax/storage,
// C = coworkers, T = tenure, A = age, W = wage, N = neutral (location-independent).
// negative: counts for rehab/rehabAll. Effects are implemented in contextEffects().
export const TRAIT_DEFS = {
  handy:            { kind: "P", negative: false },
  improviser:       { kind: "P", negative: false },
  nationalist:      { kind: "C", negative: false },
  xenophobe:        { kind: "C", negative: true },
  cosmopolitan:     { kind: "C", negative: false },
  loner:            { kind: "C", negative: false },
  sociable:         { kind: "C", negative: false },
  comic:            { kind: "C", negative: false },
  mentor:           { kind: "C", negative: false },
  foreman:          { kind: "C", negative: false },
  rival:            { kind: "C", negative: false },
  primaDonna:       { kind: "C", negative: false },
  bully:            { kind: "C", negative: true },
  envious:          { kind: "C", negative: true },
  oldFriends:       { kind: "C", negative: false },
  nemesis:          { kind: "C", negative: true },
  sweethearts:      { kind: "C", negative: false },
  girlPower:        { kind: "C", negative: false },
  bandOfBrothers:   { kind: "C", negative: false },
  manHater:         { kind: "C", negative: true },
  misogynist:       { kind: "C", negative: true },
  specialist:       { kind: "P", negative: false },
  craftsman:        { kind: "P", negative: false },
  laborer:          { kind: "P", negative: false },
  quickStudy:       { kind: "T", negative: false },
  stockpiler:       { kind: "P", negative: false },
  talksToMachines:  { kind: "C", negative: false },
  claustrophobe:    { kind: "P", negative: true },
  veteran:          { kind: "T", negative: false },
  creatureOfHabit:  { kind: "T", negative: true },
  diamondInTheRough:{ kind: "T", negative: false },
  burnout:          { kind: "T", negative: true },
  lateBloomer:      { kind: "A", negative: false },
  earlyBloomer:     { kind: "A", negative: false },
  wornOut:          { kind: "A", negative: true },
  patriot:          { kind: "P", negative: false },
  homesick:         { kind: "P", negative: true },
  expat:            { kind: "P", negative: false },
  taxShy:           { kind: "P", negative: true },
  statist:          { kind: "P", negative: false },
  greedy:           { kind: "W", negative: true },
  modest:           { kind: "W", negative: false },
  climber:          { kind: "W", negative: true },
  loyal:            { kind: "N", negative: false },
  flightRisk:       { kind: "N", negative: true },
  anchor:           { kind: "N", negative: false },
  scavenger:        { kind: "N", negative: true },
  salvager:         { kind: "N", negative: false },
  gambler:          { kind: "N", negative: true },
  luckyCharm:       { kind: "C", negative: false },
  jinx:             { kind: "C", negative: true },
  recruiter:        { kind: "N", negative: false },
  trainer:          { kind: "N", negative: false },
};

// ── Basic helpers ──
export function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function idString(v) {
  if (v == null) return null;
  return String(typeof v === "object" ? v._id : v);
}

// Employees who left stay listed (with leftAt) until the owner acknowledges it in the game.
export function hasLeft(emp) {
  return !!emp?.leftAt;
}

export function daysSince(date, nowMs = Date.now()) {
  const since = Date.parse(date);
  return Number.isFinite(since) ? Math.max(0, (nowMs - since) / 86400000) : null;
}

// ── Traits ──
// The live API (v0.27.3+) sends every trait with its code in the open (verified: 0 hidden in
// 39); an entry without a code counts as hidden.
export function traitList(emp) {
  return (Array.isArray(emp?.traits) ? emp.traits : [])
    .filter(t => t && typeof t.code === "string")
    .map(t => ({ code: t.code, arg: t.arg }));
}

export function hasTrait(emp, code) {
  return traitList(emp).some(t => t.code === code);
}

// Share of a negative happiness delta that reaches the employee: only loyal halves losses
// (the API adds the blocked half back as `mitigated`).
export function happinessLossFactor(emp) {
  return hasTrait(emp, "loyal") ? RULES.loyalLossMultiplier : 1;
}

// ── Stats ──
// Stat before the floor of 1: breakdown base + trained + flat (non-percent) contributions.
// percent:true entries (e.g. specialization) are production-bonus percents, not stat points.
// Fallback without a breakdown: the top-level `base` — which ALREADY contains the training
// (M1: emp.base[s] = breakdown[s].base + breakdown[s].trained), so never add `trained` to it.
export function rawStatValue(emp, stat) {
  const b = emp?.breakdown?.[stat];
  if (b && typeof b === "object") {
    const flat = (Array.isArray(b.contributions) ? b.contributions : []).reduce(
      (s, c) => (c && !c.percent ? s + num(c.delta) : s), 0);
    if (typeof b.base === "number" || typeof b.trained === "number") return num(b.base) + num(b.trained) + flat;
    if (typeof b.total === "number") return b.total;
  }
  const base = emp?.base?.[stat];
  return typeof base === "number" ? base : null;
}

// Stat as the game shows it (at least 1); null while unknown.
export function statValue(emp, stat) {
  const raw = rawStatValue(emp, stat);
  return raw == null ? null : Math.max(RULES.minStat, raw);
}

export function empHappiness(emp) {
  const v = emp?.happinessBreakdown?.value;
  return typeof v === "number" ? v : RULES.happinessNeutral;
}

// Chance per hour that the employee quits (0 while happy enough). Prefers the game's value.
export function empQuitChance(emp) {
  const q = emp?.happinessBreakdown?.quitChance;
  if (typeof q === "number" && q > 0) return q;
  return quitChanceAt(emp, empHappiness(emp));
}

// M17: linear from 0 at the threshold (30; flightRisk 50) to 5 %/h at happiness 0.
// anchor never quits (it takes -50 % output below 30 instead).
export function quitChanceAt(emp, happiness) {
  if (hasTrait(emp, "anchor")) return 0;
  const thr = hasTrait(emp, "flightRisk") ? RULES.flightRiskQuitThreshold : RULES.quitThreshold;
  return RULES.quitMaxPerHour * clamp((thr - happiness) / thr, 0, 1);
}

// ── Tools ──
// Equipped tool: toolItem is the item, toolStatus its effect right now.
export function empToolInfo(emp) {
  const item = emp?.toolItem;
  if (!item || typeof item !== "object") return null;
  const status = emp?.toolStatus;
  const rolled = [status?.rolledPercent, item.skills?.production].find(v => typeof v === "number");
  return {
    code: item.code || "tool",
    bonus: typeof status?.bonusPercent === "number" ? status.bonusPercent : null, // applied now
    rolled: typeof rolled === "number" ? rolled : null,
    broken: !!status?.isBroken || (typeof item.state === "number" && item.state <= 0),
    usable: status?.isUsable !== false,
    durability: typeof item.state === "number" ? item.state : null,
    maxDurability: typeof item.maxState === "number" ? item.maxState : 100,
  };
}

export function toolFitsGood(tool, itemCode) {
  const goods = TOOL_FAMILY_GOODS[String(tool.code).replace(/\d+$/, "")];
  return !goods || goods.includes(itemCode);
}

// Bonus the tool would give in a company making itemCode: its rolled percent, unless it is
// broken or belongs to another tool family.
export function toolBonusFor(tool, itemCode) {
  if (!tool || tool.broken || !toolFitsGood(tool, itemCode)) return 0;
  return tool.rolled ?? tool.bonus ?? 0;
}

export function toolBonusNow(tool, itemCode) {
  if (!tool) return 0;
  return tool.bonus ?? toolBonusFor(tool, itemCode);
}

// ── Event modifiers / away ──
function activeModifiers(emp, nowMs = Date.now()) {
  return (Array.isArray(emp?.eventModifiers) ? emp.eventModifiers : [])
    .filter(m => m && Date.parse(m.until) > nowMs);
}

// An "away" event modifier means no work and no wage until it runs out.
export function isAway(emp, nowMs = Date.now()) {
  return activeModifiers(emp, nowMs).some(m => m.kind === "away");
}

export function awayUntilMs(emp, nowMs = Date.now()) {
  let until = null;
  for (const m of activeModifiers(emp, nowMs)) {
    if (m.kind !== "away") continue;
    const u = Date.parse(m.until);
    if (Number.isFinite(u) && (until == null || u > until)) until = u;
  }
  return until;
}

// ── Wage ──
// Wage cost per hour: the game's estimate, otherwise the contract wage.
export function empWagePerHour(emp, nowMs = Date.now()) {
  if (hasLeft(emp)) return 0;
  if (isAway(emp, nowMs)) return 0;
  if (typeof emp?.estimate?.wage === "number") return Math.max(0, emp.estimate.wage);
  return Math.max(0, num(emp?.wage, 0));
}

export function empHasEstimate(emp) {
  return typeof emp?.estimate?.production === "number";
}

// ── Specialization ──
export function specializationPercent(emp, itemCode) {
  const days = Math.max(0, num(emp?.specializations?.[itemCode], 0));
  return Math.min(RULES.specializationMaxPercent, days * RULES.specializationPercentPerDay);
}

// Specialization in a good after working it `days` more days: +1 % a day (twice as fast for
// quickStudy) up to the cap. Each good keeps its own stored days.
export function specializationAfter(emp, itemCode, days) {
  const rate = RULES.specializationPercentPerDay * (hasTrait(emp, "quickStudy") ? 2 : 1);
  return Math.min(RULES.specializationMaxPercent, specializationPercent(emp, itemCode) + rate * days);
}

// ── Legacy-compatible output helpers ──
// Sum of all production bonuses in percent. The game adds them all up (productionBonus.total);
// without it, the known parts are added up here.
export function empBonusPercent(emp, ctx, nowMs = Date.now()) {
  if (typeof emp?.productionBonus?.total === "number") return emp.productionBonus.total;
  return (empHappiness(emp) - RULES.happinessNeutral) * RULES.happinessPercentPerPoint
    + (ctx?.managementPoints || 0) * RULES.managementPercentPerPoint
    + (ctx?.isCore ? RULES.coreRegionBonusPercent : 0)
    + toolBonusNow(empToolInfo(emp), ctx?.itemCode)
    + specializationPercent(emp, ctx?.itemCode);
}

// PP per hour of one employee. Uses the game's own estimate when present,
// otherwise Production/4 × (1 + sum of bonuses / 100).
export function calcEmployeePPH(emp, ctx, nowMs = Date.now()) {
  if (hasLeft(emp)) return 0;
  if (isAway(emp, nowMs)) return 0;
  if (empHasEstimate(emp)) return Math.max(0, emp.estimate.production);
  const base = num(statValue(emp, "production"), 0) / RULES.outputDivisor;
  return Math.max(0, base * (1 + empBonusPercent(emp, ctx, nowMs) / 100));
}

// Without the game's estimate an unknown Production stat leaves the output unknown.
export function empOutputKnown(emp, nowMs = Date.now()) {
  return hasLeft(emp) || empHasEstimate(emp) || isAway(emp, nowMs) || statValue(emp, "production") != null;
}

// PP per hour before any bonus: the stat over the divisor (M2/M3); the back-division through
// the bonus total is only a fallback for shapes without a breakdown.
export function baseEmployeePPH(emp, ctx, nowMs = Date.now()) {
  const stat = statValue(emp, "production");
  if (stat != null) return stat / RULES.outputDivisor;
  const factor = 1 + empBonusPercent(emp, ctx, nowMs) / 100;
  if (factor > 0.01) return calcEmployeePPH(emp, ctx, nowMs) / factor;
  return 0;
}

export function taxShyPercent(emp, taxPct) {
  if (!hasTrait(emp, "taxShy")) return 0;
  return -Math.min(RULES.taxShyMaxPercent, Math.max(0, taxPct) * RULES.taxShyPercentPerTaxPercent);
}

// ── Tenure / age trait effects ──
// Output percent and flat Production points from traits that depend on the time in a company
// or on age: veteran (+20 % from day 30), creatureOfHabit (-30 % for 3 days after a transfer),
// diamondInTheRough (+1 on its arg stat per 10 tenure days, max +4; only production affects
// output), burnout (-1 per 20 days, max -3), earlyBloomer / lateBloomer / wornOut (age-based).
// Tenure resets on a transfer (assumption, marked "estimate" in the UI).
export function careerEffects(emp, tenureDays, sinceMoveDays, ageYears) {
  let percent = 0, stat = 0;
  for (const t of traitList(emp)) {
    if (t.code === "veteran" && tenureDays >= 30) percent += 20;
    else if (t.code === "creatureOfHabit" && sinceMoveDays != null && sinceMoveDays < 3) percent += -30;
    else if (t.code === "diamondInTheRough" && (t.arg == null || t.arg === "production")) {
      stat += Math.min(4, Math.floor(tenureDays / 10));
    } else if (t.code === "burnout") {
      stat -= Math.min(3, Math.floor(tenureDays / 20));
    } else if (t.code === "earlyBloomer" && ageYears != null) {
      stat += ageYears < 40 ? 6 : Math.max(0, 6 - 2 * Math.floor((ageYears - 30) / 10));
    } else if (t.code === "lateBloomer" && ageYears != null) {
      stat += Math.min(6, 2 * Math.floor(Math.max(0, ageYears - 40) / 10));
    } else if (t.code === "wornOut" && ageYears != null) {
      stat -= Math.min(6, 2 * Math.floor(Math.max(0, ageYears - 50) / 10));
    }
  }
  return { percent, stat };
}

// Bonus of the company's hired manager in the employee's own bonus breakdown (0 if none).
export function managerPercent(emp) {
  const contributions = Array.isArray(emp?.productionBonus?.contributions) ? emp.productionBonus.contributions : [];
  return num(contributions.find(c => c?.source === "manager")?.percent, 0);
}

// Owner management level, read back from the management bonus the API reports
// (M15: percent = 2 × points, points = 1 + level).
export function ownerManagementLevel(emps) {
  let pct = 0;
  for (const emp of Array.isArray(emps) ? emps : []) {
    const c = (emp?.productionBonus?.contributions || []).find(x => x?.source === "management");
    if (c && num(c.percent) > pct) pct = num(c.percent);
  }
  return Math.max(0, Math.round(pct / RULES.managementPercentPerPoint) - 1);
}

// ── Wage model (M9) ──
function wageMarkup(emp) {
  let m = 0;
  if (hasTrait(emp, "greedy")) m += RULES.greedyMarkup;
  if (hasTrait(emp, "modest")) m += RULES.modestMarkup;
  return m;
}

function climberDrift(emp, extraDays, nowMs) {
  if (!hasTrait(emp, "climber")) return 0;
  const since = daysSince(emp?.createdAt, nowMs) ?? 0;
  return RULES.climberDriftPerWeek * Math.floor((since + extraDays) / 7);
}

function wageBasisValue(emp, basis) {
  if (basis === "bt") {
    const b = emp?.base?.production;
    if (typeof b === "number") return b;
  }
  return num(rawStatValue(emp, "production"), 0);
}

// k_eff: the multiplier on the market rate (expectation + climber drift, times trait markup).
function kEff(emp, d, expectationDelta, nowMs) {
  const exp = Math.max(RULES.wageExpectationFloor, num(emp?.wageExpectation, 1) + expectationDelta);
  return (exp + climberDrift(emp, d, nowMs)) * (1 + wageMarkup(emp));
}

// Which production value the server prices: "bt" (top-level base, without trait flats) or
// "total" (with flats). Live 2026-11-06 the data fits "bt" for 39/39; a server-side change
// (the v0.27.4 devlog claims trait production counts) would flip the detection.
export function detectWageBasis(emps, ppm, nowMs = Date.now()) {
  const xs = { bt: [], total: [] };
  let differing = 0;
  for (const emp of Array.isArray(emps) ? emps : []) {
    if (hasLeft(emp) || isAway(emp, nowMs)) continue;
    const wage = num(emp?.wage, 0);
    if (wage <= 0) continue;
    const k = kEff(emp, 0, 0, nowMs);
    if (k <= 0) continue;
    const bBt = wageBasisValue(emp, "bt");
    const bTotal = wageBasisValue(emp, "total");
    if (bBt <= 0 || bTotal <= 0) continue;
    if (bBt !== bTotal) differing++;
    xs.bt.push(wage / ((bBt / RULES.outputDivisor) * k));
    xs.total.push(wage / ((bTotal / RULES.outputDivisor) * k));
  }
  const cv = list => {
    if (list.length < 2) return Infinity;
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    if (mean <= 0) return Infinity;
    const varc = list.reduce((s, v) => s + (v - mean) * (v - mean), 0) / list.length;
    return Math.sqrt(varc) / mean;
  };
  const cvBt = cv(xs.bt), cvTotal = cv(xs.total);
  const winner = cvBt <= cvTotal ? "bt" : "total";
  const decided = differing >= 3 && Math.min(cvBt, cvTotal) < 0.01;
  const winnerXs = xs[winner].slice().sort((a, b) => a - b);
  const impliedPpm = winnerXs.length ? winnerXs[Math.floor(winnerXs.length / 2)] : num(ppm, 0.1);
  return { basis: decided ? winner : "total", decided, cv: { bt: cvBt, total: cvTotal }, impliedPpm };
}

// Hourly wage on day d, scaled from today's wage: stat growth (extraP trained production
// points) and expectation changes move it proportionally (M9).
export function wageOnDay(emp, d, { basis = "total", extraP = 0, expectationDelta = 0, nowMs = Date.now() } = {}) {
  const wageNow = typeof emp?.estimate?.wage === "number" ? emp.estimate.wage : num(emp?.wage, 0);
  const b0 = wageBasisValue(emp, basis);
  const k0 = kEff(emp, 0, 0, nowMs);
  if (wageNow <= 0 || b0 <= 0 || k0 <= 0) return Math.max(0, wageNow);
  return wageNow * ((b0 + extraP) / b0) * (kEff(emp, d, expectationDelta, nowMs) / k0);
}

// Extra hourly wage per additional trained production point (M9: wage scales with the stat).
export function marginalWagePerPoint(emp, basis = "total", ppm = 0.1, nowMs = Date.now()) {
  const wageNow = typeof emp?.estimate?.wage === "number" ? emp.estimate.wage : num(emp?.wage, 0);
  const b0 = wageBasisValue(emp, basis);
  if (wageNow > 0 && b0 > 0) return wageNow / b0;
  return (num(ppm, 0.1) * kEff(emp, 0, 0, nowMs)) / RULES.outputDivisor;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Context effects, neutralization, projection
// ═══════════════════════════════════════════════════════════════════════════
//
// Place: { companyId, itemCode, itemType, g, isCore, regionCountry, regionInitialCountry,
//          taxPct, storageLevel, storageFull, unpaid, regionAttacked, managerPct,
//          engineLevel, disabled }
// t:     { nowMs, d = 0, moved = false, steady = false, keepTool = false,
//          specializationOverride? }
//
// contextEffects returns everything that CHANGES with the place or the coworkers:
//   { flat, pct, hap, luck, engineDouble, codes: [{code, kind, value}] }
// It deliberately leaves out what never changes with an internal transfer: the owner
// management bonus, wage markups, scavenger/gambler percents and event modifiers — those sit
// in the neutral part. Negative happiness deltas are already multiplied by the loyal factor.

// Only the coworker-dependent part: the employee's own C-traits plus what the coworkers give
// (comic, foreman, bully, mentor, luckyCharm, jinx). Cheap enough for the optimizer's inner
// loop; contextEffects builds on it so there is exactly one implementation.
export function coworkerEffects(emp, coworkers) {
  const O = (Array.isArray(coworkers) ? coworkers : []).filter(o => o && !hasLeft(o) && idString(o._id) !== idString(emp._id));
  const lf = happinessLossFactor(emp);
  const codes = [];
  let engineDouble = false;
  const add = (code, kind, value) => { if (value) codes.push({ code, kind, value }); };
  const myNat = idString(emp?.nationality);
  const myBaseP = num(emp?.base?.production, 0);
  const myWage = num(emp?.wage, 0);

  for (const tr of traitList(emp)) {
    switch (tr.code) {
      case "nationalist":
        if (O.length > 0 && O.filter(o => idString(o.nationality) === myNat).length >= O.length / 2) {
          add("nationalist", "hap", RULES.nationalistHappiness);
        }
        break;
      case "xenophobe":
        if (O.some(o => idString(o.nationality) !== myNat)) { add("xenophobe", "flat", -2); add("xenophobe", "hap", -5 * lf); }
        break;
      case "cosmopolitan": {
        const foreign = new Set(O.map(o => idString(o.nationality)).filter(n => n && n !== myNat));
        add("cosmopolitan", "flat", Math.min(4, 2 * foreign.size));
        break;
      }
      case "loner":
        if (O.length === 0) { add("loner", "pct", 100); add("loner", "hap", 5); }
        break;
      case "sociable":
        if (O.length > 0) add("sociable", "pct", Math.min(50, 25 * O.length));
        else add("sociable", "hap", -10 * lf);
        break;
      case "comic":
        if (O.length > 0) add("comic", "flat", -1);
        break;
      case "mentor":
        if (O.some(o => num(o?.base?.production, 0) < myBaseP)) add("mentor", "flat", -1);
        break;
      case "rival":
        add("rival", "flat", O.some(o => num(o?.base?.production, 0) > myBaseP) ? 3 : -1);
        break;
      case "primaDonna":
        if (O.every(o => num(o?.wage, 0) < myWage)) add("primaDonna", "pct", 20);
        break;
      case "bully":
        if (O.length > 0) add("bully", "flat", 2);
        break;
      case "envious": {
        const richer = O.filter(o => num(o?.wage, 0) > myWage).length;
        if (richer > 0) add("envious", "hap", -5 * Math.min(2, richer) * lf);
        break;
      }
      case "oldFriends":
        if (O.some(o => idString(o._id) === idString(tr.arg))) add("oldFriends", "pct", 15);
        break;
      case "nemesis":
        if (O.some(o => idString(o._id) === idString(tr.arg))) add("nemesis", "pct", -15);
        break;
      case "sweethearts":
        if (O.some(o => idString(o._id) === idString(tr.arg))) add("sweethearts", "pct", 20);
        break;
      case "girlPower":
        add("girlPower", "pct", Math.min(30, 15 * O.filter(o => o.gender === "female").length));
        break;
      case "bandOfBrothers":
        add("bandOfBrothers", "pct", Math.min(30, 15 * O.filter(o => o.gender === "male").length));
        break;
      case "manHater":
        add("manHater", "pct", -Math.min(30, 15 * O.filter(o => o.gender === "male").length));
        break;
      case "misogynist":
        add("misogynist", "pct", -Math.min(30, 15 * O.filter(o => o.gender === "female").length));
        break;
      case "talksToMachines":
        engineDouble = O.length === 0;
        break;
      default:
        break;
    }
  }
  for (const o of O) {
    for (const tr of traitList(o)) {
      if (tr.code === "comic") add("comic", "hap", 10);
      else if (tr.code === "foreman") add("foreman", "hap", 9);
      else if (tr.code === "bully") add("bully", "hap", -10 * lf);
      else if (tr.code === "mentor" && myBaseP < num(o?.base?.production, 0)) add("mentor", "flat", 2);
      else if (tr.code === "luckyCharm") add("luckyCharm", "luck", 3);
      else if (tr.code === "jinx") add("jinx", "luck", -2);
    }
  }
  let flat = 0, pct = 0, hap = 0, luck = 0;
  for (const c of codes) {
    if (c.kind === "flat") flat += c.value;
    else if (c.kind === "pct") pct += c.value;
    else if (c.kind === "hap") hap += c.value;
    else if (c.kind === "luck") luck += c.value;
  }
  return { flat, pct, hap, luck, engineDouble, codes };
}

export function contextEffects(emp, place, coworkers, t = {}) {
  const nowMs = t.nowMs ?? Date.now();
  const d = num(t.d, 0);
  const O = (Array.isArray(coworkers) ? coworkers : []).filter(o => o && !hasLeft(o) && idString(o._id) !== idString(emp._id));
  const lf = happinessLossFactor(emp);
  const codes = [];
  let flat = 0, pct = 0, hap = 0, luck = 0, engineDouble = false;
  const add = (code, kind, value) => {
    if (!value) return;
    if (kind === "flat") flat += value;
    else if (kind === "pct") pct += value;
    else if (kind === "hap") hap += value;
    else if (kind === "luck") luck += value;
    codes.push({ code, kind, value });
  };

  const itemCode = place?.itemCode;
  const myNat = idString(emp?.nationality);

  // 1: own place traits
  for (const tr of traitList(emp)) {
    switch (tr.code) {
      case "specialist":
        if (tr.arg === itemCode) { add("specialist", "flat", 3); add("specialist", "hap", 5); }
        break;
      case "craftsman":
        if (place?.itemType) add("craftsman", "flat", place.itemType === "raw" ? -1 : 3);
        break;
      case "laborer":
        if (place?.itemType) add("laborer", "flat", place.itemType === "raw" ? 3 : -1);
        break;
      case "claustrophobe":
        if (place?.storageLevel != null && place.storageLevel <= 2) add("claustrophobe", "pct", -20);
        break;
      case "patriot":
        if (myNat && idString(place?.regionInitialCountry) === myNat && idString(place?.regionCountry) === myNat) {
          add("patriot", "flat", 2); add("patriot", "hap", 10);
        }
        break;
      case "homesick":
        if (myNat && place?.regionInitialCountry != null && idString(place.regionInitialCountry) !== myNat) {
          add("homesick", "flat", -2); add("homesick", "hap", -10 * lf);
        }
        break;
      case "expat":
        if (myNat && place?.regionInitialCountry != null && idString(place.regionInitialCountry) !== myNat) {
          add("expat", "flat", 2);
        }
        break;
      case "taxShy":
        add("taxShy", "pct", -Math.min(RULES.taxShyMaxPercent, Math.max(0, num(place?.taxPct, 0))));
        break;
      case "statist":
        if (num(place?.taxPct, 0) >= 20) add("statist", "hap", 6);
        break;
      default:
        break;
    }
  }

  // 2+3: coworker-dependent traits, own and given (single source of truth: coworkerEffects)
  const cw = coworkerEffects(emp, O);
  for (const c of cw.codes) add(c.code, c.kind, c.value);
  engineDouble = cw.engineDouble;

  // 4: tool. Without a move the game's current bonus applies; with a move (or product change)
  // the tool only works if it fits, and returning an unfitting tool flips handy/improviser.
  const tool = empToolInfo(emp);
  const movedGood = !!t.moved;
  let toolPct = 0, toolHeld = !!tool;
  if (tool) {
    if (!movedGood) toolPct = toolBonusNow(tool, itemCode);
    else if (t.keepTool) { toolPct = toolFitsGood(tool, itemCode) ? toolBonusFor(tool, itemCode) : 0; }
    else if (toolFitsGood(tool, itemCode)) toolPct = toolBonusFor(tool, itemCode);
    else { toolPct = 0; toolHeld = false; } // returned to the inventory
  }
  add("tool", "pct", toolPct);
  if (hasTrait(emp, "handy") && toolHeld && !tool?.broken) add("handy", "pct", 40);
  if (hasTrait(emp, "improviser") && !toolHeld) add("improviser", "pct", 25);

  // 5: specialization — each good keeps its stored value; it grows +1 %/day (quickStudy ×2)
  // in whichever good is worked.
  // In the steady comparison BOTH sides sit at their long-run value (after the 20-day ramp),
  // movers and stayers alike — otherwise a mover's natural growth would read as a move gain.
  let spec;
  if (t.specializationOverride != null) spec = t.specializationOverride;
  else if (t.steady) spec = specializationAfter(emp, itemCode, Math.max(d, 20));
  else spec = specializationAfter(emp, itemCode, d);
  add("specialization", "pct", spec);

  // 6: tenure and age, each under its own code (the API reports them per code too).
  // Tenure resets on a TRANSFER of the employee (assumption), not on a product change of the
  // company (t.transferred defaults to t.moved); in the steady comparison it runs on as if the
  // employee had stayed, and creatureOfHabit does not fire.
  const transferred = t.transferred ?? t.moved;
  const tenureNow = daysSince(emp?.lastMovedAt || emp?.createdAt, nowMs) ?? 0;
  const sinceNow = daysSince(emp?.lastMovedAt, nowMs);
  const tenure = transferred && !t.steady ? d : tenureNow + d;
  const sinceMove = transferred && !t.steady ? d : (sinceNow == null ? null : sinceNow + d);
  const age = num(emp?.age, 30) + (place?.disabled ? 0 : d); // 1 year per worked day
  for (const tr of traitList(emp)) {
    switch (tr.code) {
      case "veteran":
        if (tenure >= 30) add("veteran", "pct", 20);
        break;
      case "creatureOfHabit":
        if (sinceMove != null && sinceMove < 3) add("creatureOfHabit", "pct", -30);
        break;
      case "diamondInTheRough":
        if (tr.arg == null || tr.arg === "production") add("diamondInTheRough", "flat", Math.min(4, Math.floor(tenure / 10)));
        break;
      case "burnout":
        add("burnout", "flat", -Math.min(3, Math.floor(tenure / 20)));
        break;
      case "earlyBloomer":
        add("earlyBloomer", "flat", age < 40 ? 6 : Math.max(0, 6 - 2 * Math.floor((age - 30) / 10)));
        break;
      case "lateBloomer":
        add("lateBloomer", "flat", Math.min(6, 2 * Math.floor(Math.max(0, age - 40) / 10)));
        break;
      case "wornOut":
        add("wornOut", "flat", -Math.min(6, 2 * Math.floor(Math.max(0, age - 50) / 10)));
        break;
      default:
        break;
    }
  }

  // 7: company states
  if (place?.isCore) add("coreRegion", "pct", RULES.coreRegionBonusPercent);
  if (num(place?.managerPct, 0) > 0) add("manager", "pct", num(place.managerPct, 0));
  const taxPct = Math.max(0, num(place?.taxPct, 0));
  if (taxPct) add("incomeTax", "hap", -taxPct * RULES.taxHappinessPerPercent * lf);
  if (place?.storageFull && !hasTrait(emp, "stockpiler")) add("storageFull", "hap", -RULES.storageFullHappiness * lf);
  if (place?.unpaid) add("unpaid", "hap", -RULES.unpaidHappiness * lf);
  if (place?.regionAttacked) add("regionAttacked", "hap", -RULES.battleHappinessPenalty * lf);

  return { flat, pct, hap, luck, engineDouble, codes };
}

// anchor loses 50 % output while below the quit threshold.
function anchorPct(emp, happiness) {
  return hasTrait(emp, "anchor") && happiness < RULES.quitThreshold ? -50 : 0;
}

// Neutralize: strip today's context from the observed API values, leaving the
// location-independent rest {P0, T0, H0} plus the timed event modifiers. Calibration compares
// every model-produced code with the API's contribution of the same code; |Δ| > 0.5 or an
// API trait code the model did not produce marks the employee `uncertain`.
export function neutralize(emp, placeCur, coworkersCur, nowMs = Date.now()) {
  const e = contextEffects(emp, placeCur, coworkersCur, { nowMs, d: 0 });
  const lf = happinessLossFactor(emp);
  const Praw = num(rawStatValue(emp, "production"), 0);
  const hb = emp?.happinessBreakdown || {};
  const contribs = Array.isArray(hb.contributions) ? hb.contributions : [];
  const sumDeltas = contribs.reduce((s, c) => s + num(c?.delta), 0);
  const Hobs = RULES.happinessNeutral + sumDeltas + num(hb.mitigated);
  const HobsClamped = typeof hb.value === "number" ? hb.value : clamp(Hobs, RULES.happinessMin, RULES.happinessMax);
  const Tobs = num(emp?.productionBonus?.total, 0);

  const P0 = Praw - e.flat;
  const H0 = Hobs - e.hap;
  const T0 = Tobs - e.pct - (HobsClamped - RULES.happinessNeutral) * RULES.happinessPercentPerPoint - anchorPct(emp, HobsClamped);

  // Timed happiness rows (events, manager care, …) carry an `until`; they stay inside H0 and
  // are blanked out as they expire. They mirror the active eventModifiers, so they are read
  // from the contributions to avoid double counting; production events only exist as
  // eventModifiers (the bonus list pools them under source "event" without a timestamp).
  // H0 carries a loyal employee's negative event at HALF weight (full delta + pooled
  // `mitigated`), so the expiry list stores negatives already halved — otherwise the output
  // would jump too high once the event runs out.
  const eventPct = [], eventHap = [];
  const hapDelta = v => (v < 0 ? v * lf : v);
  for (const m of activeModifiers(emp, nowMs)) {
    if (m.kind === "production") eventPct.push({ delta: num(m.delta), untilMs: Date.parse(m.until) });
  }
  for (const c of contribs) {
    const until = c?.until != null ? Date.parse(c.until) : NaN;
    if (Number.isFinite(until) && until > nowMs) eventHap.push({ delta: hapDelta(num(c.delta)), untilMs: until });
  }
  if (!eventHap.length) {
    for (const m of activeModifiers(emp, nowMs)) {
      if (m.kind === "happiness") eventHap.push({ delta: hapDelta(num(m.delta)), untilMs: Date.parse(m.until) });
    }
  }

  // Calibration against the API's own contribution lists. Production percents and flat stat
  // points are reported per code; happiness trait rows only say reason:"trait", so those are
  // compared as an aggregate.
  const mismatches = [];
  const pctByCode = {}, flatByCode = {};
  for (const c of emp?.productionBonus?.contributions || []) {
    if (c?.source) pctByCode[c.source] = num(pctByCode[c.source]) + num(c.percent);
  }
  for (const c of emp?.breakdown?.production?.contributions || []) {
    // percent:true rows (specialization) duplicate the productionBonus entries — skip them.
    if (c?.code && !c.percent) flatByCode[c.code] = num(flatByCode[c.code]) + num(c.delta);
  }
  const modelByKind = { pct: {}, flat: {} };
  let modelHapTax = 0, modelHapOther = 0;
  for (const c of e.codes) {
    if (c.kind === "luck") continue;
    if (c.kind === "hap") {
      if (c.code === "incomeTax") modelHapTax += c.value;
      else modelHapOther += c.value;
      continue;
    }
    modelByKind[c.kind][c.code] = num(modelByKind[c.kind][c.code]) + c.value;
  }
  const apiPools = { pct: pctByCode, flat: flatByCode };
  for (const kind of ["pct", "flat"]) {
    for (const [code, model] of Object.entries(modelByKind[kind])) {
      const api = num(apiPools[kind][code], 0);
      if (Math.abs(model - api) > 0.5) mismatches.push({ code: `${kind}:${code}`, model, api });
    }
  }
  // Codes the API reports but the model did not produce (unknown or mis-modelled traits).
  // Constant, location-independent percents (scavenger, gambler) stay inside T0 by design.
  const ignoreApi = new Set(["management", "happiness", "event", "scavenger", "gambler"]);
  for (const kind of ["pct", "flat"]) {
    for (const [code, api] of Object.entries(apiPools[kind])) {
      if (ignoreApi.has(code)) continue;
      if (!TRAIT_DEFS[code] && !["tool", "specialization", "coreRegion", "manager"].includes(code)) continue;
      if (modelByKind[kind][code] == null && Math.abs(num(api)) > 0.5) {
        mismatches.push({ code: `${kind}:${code}`, model: 0, api: num(api) });
      }
    }
  }
  // Happiness: the tax row per code, everything else (trait effects given and own, firm
  // states) as one aggregate of the untimed rows.
  let apiHapTax = 0, apiHapOther = 0;
  for (const c of contribs) {
    const until = c?.until != null ? Date.parse(c.until) : NaN;
    if (Number.isFinite(until)) continue; // timed → eventHap
    const reason = c?.reason || c?.code;
    if (reason === "incomeTax") apiHapTax += num(c.delta);
    else if (reason !== "responsibility") apiHapOther += num(c.delta);
  }
  // Loyal mitigation is reported as one pooled `mitigated`; fold the model's halving out of
  // the comparison by comparing against (api + its share of mitigated) only loosely: the
  // aggregate tolerance is 1 point.
  // The API stores full deltas and pools the loyal half as `mitigated`; the model halves each
  // negative delta directly, so the API row is compared after the same halving.
  if (Math.abs(modelHapTax - apiHapTax * lf) > 1) mismatches.push({ code: "hap:incomeTax", model: modelHapTax, api: apiHapTax * lf });
  if (Math.abs(modelHapOther - apiHapOther) > 1) {
    const mit = num(hb.mitigated);
    if (Math.abs(modelHapOther - (apiHapOther + mit)) > 1 && Math.abs(modelHapOther - (apiHapOther - mit)) > 1) {
      mismatches.push({ code: "hap:other", model: modelHapOther, api: apiHapOther });
    }
  }

  return {
    P0, T0, H0, eventPct, eventHap,
    awayUntilMs: awayUntilMs(emp, nowMs),
    uncertain: mismatches.length > 0,
    mismatches,
  };
}

// Happiness on day t.d in the given context (before output conversion).
export function happinessAt(emp, neutral, place, coworkers, t = {}) {
  const nowMs = t.nowMs ?? Date.now();
  const d = num(t.d, 0);
  const e = contextEffects(emp, place, coworkers, t);
  const expiredHap = neutral.eventHap.reduce(
    (s, m) => s + (m.untilMs <= nowMs + d * 86400000 ? m.delta : 0), 0);
  return clamp(neutral.H0 + e.hap - expiredHap, RULES.happinessMin, RULES.happinessMax);
}

// PP/h on day t.d in the given context. Invariant: with the current place/coworkers and d = 0
// this reproduces the API value max(1,P)/4 × (1 + total/100) exactly.
export function pphAt(emp, neutral, place, coworkers, t = {}) {
  if (hasLeft(emp)) return 0;
  if (place?.disabled) return 0;
  const nowMs = t.nowMs ?? Date.now();
  const d = num(t.d, 0);
  if (neutral.awayUntilMs != null && nowMs + d * 86400000 < neutral.awayUntilMs) return 0;
  const e = contextEffects(emp, place, coworkers, t);
  const P = Math.max(RULES.minStat, neutral.P0 + e.flat);
  const H = happinessAt(emp, neutral, place, coworkers, t);
  const expiredPct = neutral.eventPct.reduce(
    (s, m) => s + (m.untilMs <= nowMs + d * 86400000 ? m.delta : 0), 0);
  const T = neutral.T0 + e.pct
    + (H - RULES.happinessNeutral) * RULES.happinessPercentPerPoint
    + anchorPct(emp, H)
    - expiredPct;
  return Math.max(0, (P / RULES.outputDivisor) * (1 + T / 100));
}

// Builds a Place from the dashboard's legacy ctx {isCore, managementPoints, itemCode,
// itemType, taxPct} — enough for the company-level what-ifs.
function placeFromCtx(ctx) {
  return {
    itemCode: ctx?.itemCode ?? null,
    itemType: ctx?.itemType ?? null,
    isCore: !!ctx?.isCore,
    taxPct: num(ctx?.taxPct, 0),
    regionCountry: ctx?.regionCountry ?? null,
    regionInitialCountry: ctx?.regionInitialCountry ?? null,
    storageLevel: ctx?.storageLevel ?? null,
    storageFull: !!ctx?.storageFull,
    unpaid: !!ctx?.unpaid,
    regionAttacked: !!ctx?.regionAttacked,
    managerPct: num(ctx?.managerPct, 0),
    engineLevel: num(ctx?.engineLevel, 1),
    disabled: !!ctx?.disabled,
  };
}

// PP per hour if the employee worked under other conditions. `change` accepts the legacy
// fields (itemCode, itemType, isCore, taxPct, toolReturned, specialization, happinessDelta,
// bonusDelta, statDelta) plus `place` (full target Place), `coworkers` (target roster),
// `coworkersCur` (today's roster), `day` and `moved`. Without a coworker list the coworker
// effects stay exactly as the API reports them (they cancel out of the comparison).
export function projectEmployeePPH(emp, ctx, change = {}, nowMs = Date.now()) {
  if (hasLeft(emp)) return 0;
  const placeCur = placeFromCtx(ctx);
  const coworkersCur = change.coworkersCur ?? [];
  const neutral = change.neutral ?? neutralize(emp, placeCur, coworkersCur, nowMs);
  const placeTgt = change.place ? { ...placeCur, ...change.place } : {
    ...placeCur,
    ...(change.itemCode !== undefined ? { itemCode: change.itemCode } : {}),
    ...(change.itemType !== undefined ? { itemType: change.itemType } : {}),
    ...(change.isCore !== undefined ? { isCore: change.isCore } : {}),
    ...(change.taxPct !== undefined ? { taxPct: change.taxPct } : {}),
  };
  const movedGood = change.moved ?? (placeTgt.itemCode !== placeCur.itemCode);
  const t = {
    nowMs,
    d: num(change.day, 0),
    moved: movedGood,
    transferred: change.transferred ?? change.moved ?? false, // a product change is no transfer
    steady: !!change.steady,
    keepTool: change.toolReturned === false,
    specializationOverride: change.specialization,
  };
  let pph = pphAt(emp, neutral, placeTgt, change.coworkers ?? coworkersCur, t);
  const lf = happinessLossFactor(emp);
  const hapDelta = num(change.happinessDelta, 0);
  const extraPct = num(change.bonusDelta, 0) + (hapDelta < 0 ? hapDelta * lf : hapDelta) * RULES.happinessPercentPerPoint;
  const extraStat = num(change.statDelta, 0);
  if (extraPct || extraStat) {
    const e = contextEffects(emp, placeTgt, change.coworkers ?? coworkersCur, t);
    const P = Math.max(RULES.minStat, neutral.P0 + e.flat + extraStat);
    const factorNow = pph > 0 ? pph / Math.max(RULES.minStat, neutral.P0 + e.flat) * RULES.outputDivisor : 0;
    pph = Math.max(0, (P / RULES.outputDivisor) * (factorNow + extraPct / 100));
  }
  return pph;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Survival: quitting and the retirement event (M17, M19–M21)
// ═══════════════════════════════════════════════════════════════════════════
// Retirement is a random event, never a fixed date: it fires when the employee turns 65
// (age rises 1 year per worked/trained day) and repeats every 10 days. Each event the keep
// check loses 5 points per year over 65. Policy "notNow" loses them on any fail; "convince"
// costs 0.75 day-wages per event and loses them only on a critical fail (10 %, gambler 20 %).
export function survivalCurve(emp, days, {
  policy = "convince",
  ownerMgmtLevel = 0,
  happiness,
  nowMs = Date.now(),
  disabled = false,
  wagePerHour,
} = {}) {
  const n = Math.max(1, Math.floor(days));
  const s = new Float64Array(n);
  const retireCost = new Float64Array(n);
  const retireEventDays = [];
  s[0] = 1;
  const H = typeof happiness === "number" ? happiness : empHappiness(emp);
  const luck = num(statValue(emp, "luck"), 0);
  const age0 = num(emp?.age, 30);
  const loyal = hasTrait(emp, "loyal");
  const gambler = hasTrait(emp, "gambler");
  const qh = quitChanceAt(emp, H);
  const qDay = disabled ? 0 : 1 - Math.pow(1 - qh, 24);
  // Contract wage WITHOUT the away gate: a 4–48 h absence must not zero the convince costs of
  // every retirement event in the window (estimate.wage can be 0 while away, so `wage` first).
  const wageH = typeof wagePerHour === "number"
    ? wagePerHour
    : Math.max(0, num(emp?.wage, typeof emp?.estimate?.wage === "number" ? emp.estimate.wage : 0));
  const hT = Math.trunc((H - RULES.happinessNeutral) / 5);

  for (let d = 0; d < n - 1; d++) {
    let r = 0, cost = 0;
    const age = disabled ? age0 : age0 + d;
    if (!disabled && age >= RULES.retirementAge && (age - RULES.retirementAge) % RULES.retirementRepeatDays === 0) {
      retireEventDays.push(d);
      const yrs = age - RULES.retirementAge;
      if (policy === "notNow") {
        const p = clamp(RULES.notNowBase - RULES.retirementOddsPerYear * yrs + 2 * ownerMgmtLevel + hT + 2 * luck, 5, 90) / 100;
        r = 1 - p;
      } else {
        const p = clamp(RULES.convinceBase + (loyal ? RULES.convinceLoyalBonus : 0) - RULES.retirementOddsPerYear * yrs + 2 * ownerMgmtLevel + hT, 5, 90) / 100;
        r = (1 - p) * (gambler ? RULES.gamblerCritShare : RULES.critShare);
        cost = RULES.convinceCostWageDays * 24 * wageH;
      }
    }
    retireCost[d] = s[d] * cost;
    s[d + 1] = s[d] * (1 - qDay) * (1 - r);
  }
  let expectedDays = 0;
  for (let d = 0; d < n; d++) expectedDays += s[d];
  const retireInDays = Math.max(0, RULES.retirementAge - age0);
  let retireTailDays = 0;
  for (let d = Math.ceil(retireInDays); d < n; d++) retireTailDays += s[d];
  return { s, retireCost, expectedDays, retireTailDays, retireEventDays };
}

// ═══════════════════════════════════════════════════════════════════════════
//   compareOverTime v2
// ═══════════════════════════════════════════════════════════════════════════
// Compares a change with carrying on as before, day by day. gainOnDay(d) is the extra gold on
// day d (0 = the first day after the change); gainOnDay(d, true) is the same without the
// temporary effects of the change. Without options this behaves exactly like the original
// (steady at TRANSITION_DAYS); with {horizon, steadyDay} it evaluates a finite window and
// paybackDays becomes Infinity when the change never pays back inside it.
export function compareOverTime(gainOnDay, upfront = 0, { horizon = TRANSITION_DAYS, steadyDay = TRANSITION_DAYS } = {}) {
  const dailyGain = steadyDay >= horizon && horizon === TRANSITION_DAYS
    ? gainOnDay(TRANSITION_DAYS)
    : gainOnDay(steadyDay, true);
  let sum = -upfront, transitionLoss = 0, horizonGain = -upfront;
  let paybackDays = sum >= 0 ? 0 : null;
  for (let d = 0; d < horizon; d++) {
    const gain = gainOnDay(d);
    horizonGain += gain;
    transitionLoss += gainOnDay(d, true) - gain;
    const next = sum + gain;
    if (next < 0) paybackDays = null;
    else if (paybackDays === null) paybackDays = d - sum / gain;
    sum = next;
  }
  if (paybackDays === null) {
    paybackDays = horizon === TRANSITION_DAYS && dailyGain > 0 ? horizon - sum / dailyGain : Infinity;
  }
  return { dailyGain, transitionLoss: Math.max(0, transitionLoss), paybackDays, horizonGain };
}

// "primaDonna" -> "prima donna"
export function formatCodeName(code) {
  return String(code).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}
