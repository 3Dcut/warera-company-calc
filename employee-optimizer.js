// ═══════════════════════════════════════════════════════════════════════════
//   EMPLOYEE OPTIMIZER — workforce distribution, advisor and extras
//
//   Pure JS (no React). Builds on employee-model.js. All money values are gold,
//   all rates per hour unless a name says perDay. The optimizer maximizes the
//   survival-weighted net value over `horizonDays`; wages are location-
//   independent (they never appear in the distribution objective) and firing
//   is free, so the distribution and the keep/fire questions separate cleanly.
// ═══════════════════════════════════════════════════════════════════════════

import {
  RULES, TRAIT_DEFS, TOOL_FAMILY_GOODS, num, clamp, idString, hasLeft, traitList, hasTrait,
  rawStatValue, statValue, empHappiness, empQuitChance, quitChanceAt,
  empToolInfo, toolFitsGood, toolBonusFor, isAway, empWagePerHour,
  specializationPercent, managerPercent, ownerManagementLevel,
  detectWageBasis, wageOnDay, marginalWagePerPoint,
  contextEffects, coworkerEffects, neutralize, pphAt, happinessAt,
  survivalCurve, compareOverTime, daysSince,
} from "./employee-model.js";

export const OPT_DEFAULTS = {
  horizonDays: 30,
  minGainPerMoveDay: 0.5,
  epsilon: 0.5,
  maxSweeps: 50,
  timeBudgetMs: 400,
  polish3: true,
  happinessSafety: 5,
  pinUncertain: true,
  advisorHorizonDays: 60,
  retirementPolicy: "convince",
  replaceMinGain: 10,
  replaceMinGainDay: 0.5,
  toolboxValue: 0,
  energyPrice: null, // null = self-work value of 10 energy (M32)
  survivalWindowDays: 120,
  onlyPaybackBeforeRetire: true,
};

// Negative traits for rehab (client polarity list).
const NEGATIVE_TRAITS = Object.entries(TRAIT_DEFS).filter(([, d]) => d.negative).map(([c]) => c);

// Reason parameters are inserted into the i18n templates as-is; the whole app formats numbers
// de-DE (same in every language), so the engine hands them over already formatted.
const fmtDE = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtG = n => fmtDE.format(Math.round(n * 100) / 100);

// Interaction traits that make a firm worth a 3-firm polish pass / an "estimate" confidence.
const INTERACTION_TRAITS = new Set([
  "sweethearts", "oldFriends", "nemesis", "girlPower", "bandOfBrothers", "manHater",
  "misogynist", "sociable", "loner", "talksToMachines", "primaDonna", "envious", "rival",
  "mentor", "nationalist", "xenophobe", "cosmopolitan", "comic", "bully", "foreman",
]);
const SOFT_INTERACTION = new Set(["rival", "mentor", "envious", "primaDonna", "nationalist",
  "xenophobe", "comic", "bully"]);

// ── Model building ─────────────────────────────────────────────────────────

// Reads a firm's effective states back from its own roster (the API values on the employees
// are the ground truth); an empty firm keeps the dashboard-provided values.
function inferPlace(firm, roster) {
  const place = {
    companyId: firm.id,
    itemCode: firm.itemCode,
    itemType: firm.itemType ?? null,
    g: num(firm.g, 0),
    isCore: !!firm.isCore,
    regionCountry: firm.regionCountry ?? null,
    regionInitialCountry: firm.regionInitialCountry ?? null,
    taxPct: num(firm.taxPct, 0),
    storageLevel: firm.storageLevel ?? null,
    storageFull: !!firm.storageFull,
    unpaid: !!firm.unpaid,
    regionAttacked: !!firm.regionAttacked,
    managerPct: num(firm.managerPct, 0),
    engineLevel: num(firm.engineLevel, 1),
    disabled: !!firm.disabled,
  };
  for (const emp of roster) {
    if (hasLeft(emp)) continue;
    for (const c of emp?.productionBonus?.contributions || []) {
      if (c?.source === "coreRegion") place.isCore = true;
      if (c?.source === "manager") place.managerPct = Math.max(place.managerPct, num(c.percent));
    }
    for (const c of emp?.happinessBreakdown?.contributions || []) {
      const reason = c?.reason || c?.code;
      // The API stores the FULL tax delta even for loyal employees (the blocked half sits in
      // `mitigated`), so the tax percent is simply the negated delta.
      if (reason === "incomeTax") place.taxPct = Math.max(place.taxPct, Math.round(-num(c.delta)));
      else if (reason === "storageFull") place.storageFull = true;
      else if (reason === "unpaid") place.unpaid = true;
      else if (reason === "regionAttacked") place.regionAttacked = true;
    }
    if (emp.companyDisabled) place.disabled = true;
  }
  return place;
}

export function buildWorkforceModel({ firmsInput, employeesByCompany, ppm, prodSkillLevel = 0, nowMs = Date.now(), events = [], settings = {} }) {
  const opts = { ...OPT_DEFAULTS, ...settings };
  const firms = new Map();
  const emps = new Map();
  const current = {};
  const allEmps = [];

  for (const f of firmsInput || []) {
    const roster = (employeesByCompany?.[f.id] || []).filter(e => e && typeof e === "object");
    const active = roster.filter(e => !hasLeft(e));
    // The dashboard may know about leavers that are not in the roster payload (f.leavers).
    const leavers = Math.max(num(f.leavers, 0), roster.length - active.length);
    const place = inferPlace(f, roster);
    firms.set(String(f.id), {
      id: String(f.id),
      name: f.name || f.itemCode || String(f.id),
      itemCode: f.itemCode,
      g: num(f.g, 0),
      cap: num(f.cap, 1),
      leavers,
      slots: Math.max(0, num(f.cap, 1) - leavers),
      locked: (settings.locks || settings.lockedFirmIds || []).includes(String(f.id)) || place.disabled,
      place,
      engineLevel: num(f.engineLevel, 1),
    });
    for (const e of active) allEmps.push(e);
  }

  const wb = detectWageBasis(allEmps, ppm, nowMs);
  const ownerMgmtLevel = ownerManagementLevel(allEmps);
  let bestG = 0;
  for (const f of firms.values()) bestG = Math.max(bestG, f.g);
  const energyPrice = opts.energyPrice != null
    ? num(opts.energyPrice, 0)
    : (30 + 3 * num(prodSkillLevel, 0)) * bestG; // self-work PP of 10 energy × best gold/PP

  const pins = new Set((settings.pins || settings.pinnedEmpIds || []).map(String));
  const window = Math.max(opts.horizonDays, opts.advisorHorizonDays, opts.survivalWindowDays);

  for (const f of firms.values()) {
    const roster = (employeesByCompany?.[f.id] || []).filter(e => e && !hasLeft(e));
    for (const emp of roster) {
      const id = idString(emp._id) || `${f.id}:${roster.indexOf(emp)}`;
      const coworkers = roster.filter(o => o !== emp);
      const neutral = neutralize(emp, f.place, coworkers, nowMs);
      const H = empHappiness(emp);
      const survival = survivalCurve(emp, window, {
        policy: opts.retirementPolicy,
        ownerMgmtLevel,
        happiness: H,
        nowMs,
        disabled: f.place.disabled,
      });
      const pinned = pins.has(id) || (opts.pinUncertain && neutral.uncertain);
      emps.set(id, {
        id, raw: emp, firmId: f.id, neutral, survival,
        pinned, uncertain: neutral.uncertain,
        wageH: empWagePerHour(emp, nowMs),
        expectedDays: survival.expectedDays,
        happiness: H,
      });
      current[id] = f.id;
    }
  }

  return {
    firms, emps, current,
    ctx: { ppm: num(ppm, 0.1), ownerMgmtLevel, wageBasis: wb.basis, wageBasisDecided: wb.decided, energyPrice, nowMs, prodSkillLevel: num(prodSkillLevel, 0) },
    settings: opts,
    events: Array.isArray(events) ? events : [],
  };
}

// ── Precomputed per-(employee, firm) tables, without coworker effects ──────
export function precomputeTables(model, horizonDays) {
  const H = Math.max(1, Math.floor(horizonDays));
  const nowMs = model.ctx.nowMs;
  const tables = new Map(); // empId -> Map(firmId -> {S_pa, S_p, S_a, S_w, H0c, base0})
  for (const e of model.emps.values()) {
    const perFirm = new Map();
    for (const f of model.firms.values()) {
      const moved = f.id !== e.firmId;
      let S_pa = 0, S_p = 0, S_a = 0, S_w = 0, H0c = 0;
      for (let d = 0; d < H; d++) {
        const w = e.survival.s[Math.min(d, e.survival.s.length - 1)];
        const t = { nowMs, d, moved, steady: false };
        const hap = happinessAt(e.raw, e.neutral, f.place, [], t);
        if (d === 0) H0c = hap;
        const pph = pphAt(e.raw, e.neutral, f.place, [], t);
        const eff = contextEffects(e.raw, f.place, [], t);
        const P = Math.max(RULES.minStat, e.neutral.P0 + eff.flat);
        const p = P / RULES.outputDivisor;
        const a = p > 0 ? pph / p : 0;
        S_pa += w * pph;
        S_p += w * p;
        S_a += w * a;
        S_w += w;
      }
      perFirm.set(f.id, { S_pa, S_p, S_a, S_w, H0c });
    }
    tables.set(e.id, perFirm);
  }
  return tables;
}

// Coworker-dependent delta of one employee in a group (time-invariant: day-0 stats/wages).
// The precomputed tables already contain the alone-state (O = ∅), so the delta is the
// coworker part with the group minus the coworker part alone.
function coworkerDelta(model, emp, firm, groupEmps) {
  const O = groupEmps.filter(o => o.id !== emp.id).map(o => o.raw);
  const full = coworkerEffects(emp.raw, O);
  const base = coworkerEffects(emp.raw, []);
  return {
    flat: full.flat - base.flat,
    pct: full.pct - base.pct,
    hap: full.hap - base.hap,
    engineDouble: full.engineDouble,
  };
}

function anchorShiftPct(emp, hWith, hWithout) {
  if (!hasTrait(emp.raw, "anchor")) return 0;
  const a = h => (h < RULES.quitThreshold ? -50 : 0);
  return a(hWith) - a(hWithout);
}

// Survival-weighted value of employee i in firm c with coworker set O (G over the horizon).
function valInGroup(model, tables, emp, firm, groupEmps) {
  const tab = tables.get(emp.id).get(firm.id);
  const cw = coworkerDelta(model, emp, firm, groupEmps);
  const hWithout = tab.H0c;
  const hWith = clamp(hWithout + cw.hap, RULES.happinessMin, RULES.happinessMax);
  const hPct = (hWith - clamp(hWithout, RULES.happinessMin, RULES.happinessMax)) * RULES.happinessPercentPerPoint
    + anchorShiftPct(emp, hWith, hWithout);
  return 24 * firm.g * (
    tab.S_pa
    + ((cw.pct + hPct) / 100) * tab.S_p
    + (cw.flat / RULES.outputDivisor) * tab.S_a
    + (cw.flat * (cw.pct + hPct)) / (RULES.outputDivisor * 100) * tab.S_w
  );
}

// ── Group value with memo ──────────────────────────────────────────────────
export function groupValue(model, tables, firmId, empIds, memo, opts = model.settings) {
  const key = firmId + "|" + empIds.slice().sort().join(",");
  if (memo && memo.has(key)) return memo.get(key);
  const firm = model.firms.get(firmId);
  const group = empIds.map(id => model.emps.get(id)).filter(Boolean);
  let v = 0;
  if (group.length > firm.slots) v = -1e9;
  else {
    for (const emp of group) {
      v += valInGroup(model, tables, emp, firm, group);
      if (emp.firmId !== firmId) v -= num(opts.minGainPerMoveDay, 0.5) * num(opts.horizonDays, 30);
      // Happiness guard: never push someone below the quit threshold who is safe today.
      const tab = tables.get(emp.id).get(firmId);
      const cw = coworkerDelta(model, emp, firm, group);
      const hNew = clamp(tab.H0c + cw.hap, RULES.happinessMin, RULES.happinessMax);
      const thr = hasTrait(emp.raw, "flightRisk") ? RULES.flightRiskQuitThreshold : RULES.quitThreshold;
      if (!hasTrait(emp.raw, "anchor") && hNew < thr + num(opts.happinessSafety, 5) && emp.happiness >= thr + num(opts.happinessSafety, 5)) {
        v -= 1e9;
      }
    }
    // talksToMachines doubles the automated engine while its holder is alone.
    if (group.length === 1 && hasTrait(group[0].raw, "talksToMachines")) {
      const tab = tables.get(group[0].id).get(firmId);
      v += 24 * firm.g * firm.engineLevel * tab.S_w;
    }
  }
  if (memo) memo.set(key, v);
  return v;
}

// ── Hungarian algorithm (min-cost assignment, square matrix, potentials) ───
export function hungarian(cost) {
  const n = cost.length;
  const INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const result = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) result[p[j] - 1] = j - 1;
  return result;
}

// ── Distribution optimizer ─────────────────────────────────────────────────
function objective(model, tables, assignment, memo, opts) {
  const byFirm = new Map();
  for (const f of model.firms.keys()) byFirm.set(f, []);
  for (const [empId, firmId] of Object.entries(assignment)) {
    if (byFirm.has(firmId)) byFirm.get(firmId).push(empId);
  }
  let sum = 0;
  for (const [firmId, ids] of byFirm) sum += groupValue(model, tables, firmId, ids, memo, opts);
  return sum;
}

// frozen: employees re-pinned by the payback filter for the re-improve passes.
function allowedFirms(model, emp, frozen) {
  // Pinned employees AND every member of a locked (or disabled) firm stay where they are;
  // locked firms also accept nobody (spec §5.4).
  if (emp.pinned || frozen?.has(emp.id) || model.firms.get(emp.firmId)?.locked) return [emp.firmId];
  const out = [];
  for (const f of model.firms.values()) {
    if (f.id === emp.firmId) { out.push(f.id); continue; }
    if (f.locked || f.place.disabled || f.slots <= 0) continue;
    out.push(f.id);
  }
  return out;
}

function improve(model, tables, assignment, memo, opts, deadline, frozen) {
  const firmIds = [...model.firms.keys()].sort();
  const maxSweeps = num(opts.maxSweeps, 50);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let improved = false;
    for (let a = 0; a < firmIds.length; a++) {
      for (let b = a + 1; b < firmIds.length; b++) {
        const fa = firmIds[a], fb = firmIds[b];
        const membersA = Object.keys(assignment).filter(id => assignment[id] === fa);
        const membersB = Object.keys(assignment).filter(id => assignment[id] === fb);
        const movable = [...membersA, ...membersB].filter(id => {
          const e = model.emps.get(id);
          if (e.pinned || frozen?.has(id)) return false;
          const other = assignment[id] === fa ? fb : fa;
          return allowedFirms(model, e, frozen).includes(other);
        });
        if (!movable.length) continue;
        const fixedA = membersA.filter(id => !movable.includes(id));
        const fixedB = membersB.filter(id => !movable.includes(id));
        const slotsA = model.firms.get(fa).slots, slotsB = model.firms.get(fb).slots;
        let bestV = groupValue(model, tables, fa, membersA, memo, opts) + groupValue(model, tables, fb, membersB, memo, opts);
        let bestMask = null;
        const n = movable.length;
        for (let mask = 0; mask < (1 << n); mask++) {
          const A = fixedA.slice(), B = fixedB.slice();
          for (let i = 0; i < n; i++) (mask & (1 << i) ? A : B).push(movable[i]);
          if (A.length > slotsA || B.length > slotsB) continue;
          const v = groupValue(model, tables, fa, A, memo, opts) + groupValue(model, tables, fb, B, memo, opts);
          if (v > bestV + num(opts.epsilon, 0.5)) { bestV = v; bestMask = mask; }
        }
        if (bestMask != null) {
          for (let i = 0; i < n; i++) assignment[movable[i]] = bestMask & (1 << i) ? fa : fb;
          improved = true;
        }
        if (Date.now() > deadline) return { assignment, sweeps: sweep + 1, timedOut: true };
      }
    }
    if (!improved) return { assignment, sweeps: sweep + 1, timedOut: false };
  }
  return { assignment, sweeps: num(opts.maxSweeps, 50), timedOut: false };
}

function polish3(model, tables, assignment, memo, opts, deadline, frozen) {
  const all = [...model.firms.keys()].sort();
  // With few firms every triple is affordable (group values are memoized); with many, anchor
  // on firms that hold interaction-trait carriers or are slot-bound (where pair sweeps stall).
  let anchors;
  if (all.length <= 8) anchors = all;
  else {
    const carriers = new Set();
    for (const e of model.emps.values()) {
      if (traitList(e.raw).some(t => INTERACTION_TRAITS.has(t.code))) carriers.add(assignment[e.id]);
    }
    for (const f of model.firms.values()) {
      const used = Object.values(assignment).filter(x => x === f.id).length;
      if (used >= f.slots) carriers.add(f.id);
    }
    anchors = all.filter(id => carriers.has(id));
  }
  const seenTrios = new Set();
  for (let a = 0; a < anchors.length; a++) {
    for (let b = 0; b < all.length; b++) {
      for (let c = b + 1; c < all.length; c++) {
        const trio = [...new Set([anchors[a], all[b], all[c]])];
        if (trio.length < 3) continue;
        const key = trio.slice().sort().join("|");
        if (seenTrios.has(key)) continue;
        seenTrios.add(key);
        const members = Object.keys(assignment).filter(id => trio.includes(assignment[id]));
        const movable = members.filter(id => !model.emps.get(id).pinned && !frozen?.has(id)
          && trio.every(f => f === assignment[id] || allowedFirms(model, model.emps.get(id), frozen).includes(f)));
        if (movable.length === 0 || movable.length > 9) continue;
        const fixedBy = new Map(trio.map(f => [f, members.filter(id => !movable.includes(id) && assignment[id] === f)]));
        const slots = new Map(trio.map(f => [f, model.firms.get(f).slots]));
        const n = movable.length;
        // Precompute each firm's group value per movable-subset bitmask (shared groupValue memo),
        // then scan all 3^n distributions with pure integer math — this is what makes the full
        // triple polish affordable inside the time budget.
        const maskIds = mask => {
          const ids = [];
          for (let i = 0; i < n; i++) if (mask & (1 << i)) ids.push(movable[i]);
          return ids;
        };
        const valByFirm = trio.map(f => {
          const cap = slots.get(f) - fixedBy.get(f).length;
          const arr = new Float64Array(1 << n).fill(-1e15);
          for (let mask = 0; mask < (1 << n); mask++) {
            let bits = 0;
            for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
            if (bits > cap) continue;
            arr[mask] = groupValue(model, tables, f, fixedBy.get(f).concat(maskIds(mask)), memo, opts);
          }
          return arr;
        });
        const curMask = [0, 1, 2].map(fi => {
          let m = 0;
          for (let i = 0; i < n; i++) if (assignment[movable[i]] === trio[fi]) m |= 1 << i;
          return m;
        });
        let bestV = valByFirm[0][curMask[0]] + valByFirm[1][curMask[1]] + valByFirm[2][curMask[2]];
        let bestMasks = null;
        const FULL = (1 << n) - 1;
        for (let m0 = 0; m0 <= FULL; m0++) {
          const v0 = valByFirm[0][m0];
          if (v0 < -1e14) continue;
          const rest = FULL ^ m0;
          for (let m1 = rest; ; m1 = (m1 - 1) & rest) {
            const v1 = valByFirm[1][m1];
            if (v1 > -1e14) {
              const m2 = rest ^ m1;
              const v = v0 + v1 + valByFirm[2][m2];
              if (v > bestV + num(opts.epsilon, 0.5) && valByFirm[2][m2] > -1e14) { bestV = v; bestMasks = [m0, m1, m2]; }
            }
            if (m1 === 0) break;
          }
        }
        if (bestMasks) {
          for (let i = 0; i < n; i++) {
            const bit = 1 << i;
            assignment[movable[i]] = bestMasks[0] & bit ? trio[0] : bestMasks[1] & bit ? trio[1] : trio[2];
          }
        }
        if (Date.now() > deadline) return true;
      }
    }
  }
  return false;
}

export function optimizeDistribution(model, optsIn = {}) {
  const opts = { ...OPT_DEFAULTS, ...model.settings, ...optsIn };
  const t0 = Date.now();
  const deadline = t0 + num(opts.timeBudgetMs, 400);
  const tables = precomputeTables(model, opts.horizonDays);
  const memo = new Map();
  const empIds = [...model.emps.keys()].sort();

  const A0 = {};
  for (const id of empIds) A0[id] = model.emps.get(id).firmId;
  const startObjective = objective(model, tables, A0, memo, opts);

  // Start B: Hungarian over slot-expanded columns with frozen coworker effects.
  const cols = [];
  for (const f of [...model.firms.values()].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    for (let s = 0; s < f.slots; s++) cols.push(f.id);
  }
  const N = Math.max(empIds.length, cols.length);
  const cost = [];
  for (let i = 0; i < N; i++) {
    const row = new Array(N).fill(0);
    if (i < empIds.length) {
      const emp = model.emps.get(empIds[i]);
      const allowed = new Set(allowedFirms(model, emp));
      const curRoster = empIds.filter(id => model.emps.get(id).firmId === emp.firmId && id !== emp.id)
        .map(id => model.emps.get(id));
      for (let j = 0; j < N; j++) {
        if (j >= cols.length) { row[j] = 0; continue; }
        const fid = cols[j];
        if (!allowed.has(fid)) { row[j] = 1e12; continue; }
        const firm = model.firms.get(fid);
        const frozen = valInGroup(model, tables, emp, firm, [emp, ...curRoster]);
        row[j] = -frozen + (fid !== emp.firmId ? num(opts.minGainPerMoveDay, 0.5) * num(opts.horizonDays, 30) : 0);
      }
    }
    cost.push(row);
  }
  const hung = hungarian(cost);
  const B0 = { ...A0 };
  for (let i = 0; i < empIds.length; i++) {
    const j = hung[i];
    if (j >= 0 && j < cols.length && cost[i][j] < 1e11) B0[empIds[i]] = cols[j];
  }

  const candA = improve(model, tables, { ...A0 }, memo, opts, deadline);
  const candB = improve(model, tables, { ...B0 }, memo, opts, deadline);
  const vA = objective(model, tables, candA.assignment, memo, opts);
  const vB = objective(model, tables, candB.assignment, memo, opts);
  let best = vB > vA ? candB : candA; // tie → A0 side (deterministic)
  let timedOut = candA.timedOut || candB.timedOut;

  let polished = false;
  if (opts.polish3 && Date.now() < deadline) {
    const cut = polish3(model, tables, best.assignment, memo, opts, deadline);
    timedOut = timedOut || cut;
    const after = improve(model, tables, best.assignment, memo, opts, deadline);
    best = after;
    polished = true;
  }

  // Only moves that pay back inside the movers' expected remaining days. Moves are judged in
  // CONNECTED GROUPS (a rotation only makes sense as a whole; its single legs look like
  // losses), grouped by the firms their from→to edges connect. Rejected movers go into the
  // `frozen` set that the re-improve passes respect — and the filter repeats until no group
  // is rejected any more, because the re-improve may propose new moves.
  const pinnedIds = [...new Set(empIds.filter(id => model.emps.get(id).pinned))];
  const frozen = new Set();
  if (opts.onlyPaybackBeforeRetire) {
    for (let pass = 0; pass < 5; pass++) {
      const movers = empIds.filter(id => best.assignment[id] !== A0[id]);
      const parent = new Map();
      const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent.set(a, b); };
      for (const f of model.firms.keys()) parent.set(f, f);
      for (const id of movers) union(A0[id], best.assignment[id]);
      const groups = new Map();
      for (const id of movers) {
        const root = find(A0[id]);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(id);
      }
      let changed = false;
      for (const group of groups.values()) {
        const trial = { ...A0 };
        for (const id of group) trial[id] = best.assignment[id];
        const minExpected = Math.min(...group.map(id => model.emps.get(id).expectedDays));
        const horizon = Math.max(1, Math.min(opts.horizonDays, Math.ceil(minExpected) || opts.horizonDays));
        const ev = evaluatePlanInternal(model, tables, A0, trial, horizon, opts);
        if (!(ev.paybackDays <= Math.min(minExpected, opts.horizonDays))) {
          for (const id of group) {
            best.assignment[id] = A0[id];
            frozen.add(id);
          }
          changed = true;
        }
      }
      if (!changed) break;
      best = improve(model, tables, best.assignment, memo, opts, deadline, frozen);
    }
  }

  return {
    assignment: best.assignment,
    objective: objective(model, tables, best.assignment, memo, opts),
    startObjective,
    sweeps: best.sweeps,
    polished,
    timedOut,
    ms: Date.now() - t0,
    pinnedIds,
    paybackRevertedIds: [...frozen],
    tables,
  };
}

// ── Exact per-day plan evaluation ──────────────────────────────────────────
function rosterOf(model, assignment, firmId) {
  return Object.keys(assignment).filter(id => assignment[id] === firmId).map(id => model.emps.get(id));
}

function dayValueFirm(model, assignment, firmId, d, steady, baseAssignment) {
  const firm = model.firms.get(firmId);
  const group = rosterOf(model, assignment, firmId);
  let sum = 0;
  for (const emp of group) {
    const moved = emp.firmId !== firmId;
    const w = emp.survival.s[Math.min(d, emp.survival.s.length - 1)];
    // steady applies to EVERYONE (movers and stayers), so natural specialization growth
    // cancels out of steady comparisons instead of reading as a move gain.
    const t = { nowMs: model.ctx.nowMs, d, moved, steady: !!steady };
    const pph = pphAt(emp.raw, emp.neutral, firm.place, group.filter(o => o !== emp).map(o => o.raw), t);
    sum += 24 * firm.g * pph * w;
  }
  if (group.length === 1 && hasTrait(group[0].raw, "talksToMachines")) {
    const w = group[0].survival.s[Math.min(d, group[0].survival.s.length - 1)];
    sum += 24 * firm.g * firm.engineLevel * w;
  }
  return sum;
}

function evaluatePlanInternal(model, tables, fromAssignment, toAssignment, horizon, opts) {
  const firmIds = [...model.firms.keys()];
  const gainOnDay = (d, steady) => {
    let s = 0;
    for (const f of firmIds) {
      s += dayValueFirm(model, toAssignment, f, d, !!steady) - dayValueFirm(model, fromAssignment, f, d, !!steady);
    }
    return s;
  };
  const res = compareOverTime(gainOnDay, 0, { horizon, steadyDay: 0 });
  return res;
}

export function evaluatePlan(model, assignment, optsIn = {}) {
  const opts = { ...OPT_DEFAULTS, ...model.settings, ...optsIn };
  const tables = optsIn.tables || precomputeTables(model, opts.horizonDays);
  const current = model.current;
  const horizon = num(opts.horizonDays, 30);
  const core = evaluatePlanInternal(model, tables, current, assignment, horizon, opts);

  // Before/after on the SAME steady basis, so Vorher + dailyGain = Nachher holds.
  const perFirm = [];
  let beforeNetDay = 0, afterNetDay = 0;
  for (const f of model.firms.values()) {
    const before = dayValueFirm(model, current, f.id, 0, true);
    const after = dayValueFirm(model, assignment, f.id, 0, true);
    const wagesBefore = rosterOf(model, current, f.id).reduce((s, e) => s + 24 * e.wageH, 0);
    const wagesAfter = rosterOf(model, assignment, f.id).reduce((s, e) => s + 24 * e.wageH, 0);
    perFirm.push({ id: f.id, name: f.name, beforeDay: before - wagesBefore, afterDay: after - wagesAfter });
    beforeNetDay += before - wagesBefore;
    afterNetDay += after - wagesAfter;
  }

  const perEmp = [];
  for (const [empId, firmId] of Object.entries(assignment)) {
    if (firmId === current[empId]) continue;
    const emp = model.emps.get(empId);
    // Own delta: the employee's value in the new place vs the old, coworkers as assigned.
    const tNew = { nowMs: model.ctx.nowMs, d: 0, moved: true, steady: true };
    const tOld = { nowMs: model.ctx.nowMs, d: 0, moved: false, steady: true };
    const newFirm = model.firms.get(firmId), oldFirm = model.firms.get(current[empId]);
    const own = 24 * (newFirm.g * pphAt(emp.raw, emp.neutral, newFirm.place,
      rosterOf(model, assignment, firmId).filter(o => o.id !== empId).map(o => o.raw), tNew)
      - oldFirm.g * pphAt(emp.raw, emp.neutral, oldFirm.place,
        rosterOf(model, current, current[empId]).filter(o => o.id !== empId).map(o => o.raw), tOld));
    perEmp.push({ id: empId, ownDelta: own });
  }

  return {
    beforeNetDay, afterNetDay,
    dailyGain: core.dailyGain,
    horizonGain: core.horizonGain,
    transitionLoss: core.transitionLoss,
    paybackDays: core.paybackDays,
    perFirm, perEmp,
  };
}

// ── Executable move sequence ───────────────────────────────────────────────
export function buildMoveSequence(model, assignment) {
  const state = { ...model.current };
  const steps = [];
  const slotsUsed = new Map();
  const slotBonus = new Map();   // slots freed by confirmLeaver steps (no model mutation)
  const confirmed = new Map();
  for (const f of model.firms.keys()) slotsUsed.set(f, 0);
  for (const fid of Object.values(state)) slotsUsed.set(fid, (slotsUsed.get(fid) || 0) + 1);
  const free = fid => model.firms.get(fid).slots + (slotBonus.get(fid) || 0) - (slotsUsed.get(fid) || 0);

  const pending = () => Object.keys(assignment).filter(id => assignment[id] !== state[id]);
  let cycleCounter = 0;
  let guard = 0;

  const gainOfStep = (before, after) => {
    const firms = new Set([...Object.values(before), ...Object.values(after)]);
    let g = 0;
    for (const f of firms) g += dayValueFirm(model, after, f, 0, true) - dayValueFirm(model, before, f, 0, true);
    return g;
  };

  const nameOfEmp = id => {
    for (const e of model.emps.values()) if (idString(e.raw._id) === idString(id)) return e.raw.name || String(id);
    return String(id);
  };
  // Warning codes follow the spec contract (specLoss, toolReturned, pairSplit, nemesisJoin,
  // veteranReset, loneEngine, disabledTarget, creatureOfHabit); params are ready-made arrays
  // for the matching L.warn* functions.
  const stepWarnings = (empId, fromId, toId) => {
    const emp = model.emps.get(empId);
    const from = model.firms.get(fromId), to = model.firms.get(toId);
    const warnings = [];
    if (hasTrait(emp.raw, "creatureOfHabit")) warnings.push({ code: "creatureOfHabit", params: [0] });
    if (from.itemCode !== to.itemCode) {
      warnings.push({
        code: "specLoss",
        params: [emp.raw.name, from.itemCode, specializationPercent(emp.raw, from.itemCode), to.itemCode],
      });
      const tool = empToolInfo(emp.raw);
      if (tool && !toolFitsGood(tool, to.itemCode)) {
        warnings.push({ code: "toolReturned", params: [tool.code, tool.rolled ?? 0, to.itemCode] });
      }
    }
    if (hasTrait(emp.raw, "veteran")) warnings.push({ code: "veteranReset", params: [] });
    for (const tr of traitList(emp.raw)) {
      if (tr.code === "sweethearts" || tr.code === "oldFriends") {
        const partnerHere = rosterOf(model, { ...state }, fromId).some(o => idString(o.raw._id) === idString(tr.arg));
        const partnerThere = rosterOf(model, { ...state }, toId).some(o => idString(o.raw._id) === idString(tr.arg));
        if (partnerHere && !partnerThere) warnings.push({ code: "pairSplit", params: [emp.raw.name, nameOfEmp(tr.arg)] });
      }
      if (tr.code === "nemesis") {
        const foeThere = rosterOf(model, { ...state }, toId).some(o => idString(o.raw._id) === idString(tr.arg));
        if (foeThere) warnings.push({ code: "nemesisJoin", params: [emp.raw.name, nameOfEmp(tr.arg)] });
      }
      if (tr.code === "talksToMachines") warnings.push({ code: "loneEngine", params: [] });
    }
    if (to.place.disabled) warnings.push({ code: "disabledTarget", params: [] });
    return warnings;
  };

  const confidenceOf = (empId, fromId, toId) => {
    const involved = [model.emps.get(empId),
      ...rosterOf(model, state, fromId), ...rosterOf(model, state, toId)];
    for (const e of involved) {
      if (!e) continue;
      if (e.uncertain) return "estimate";
      if (traitList(e.raw).some(t => SOFT_INTERACTION.has(t.code))) return "estimate";
    }
    return "sure";
  };

  const pushMove = (empId, toId, extra = {}) => {
    const fromId = state[empId];
    const before = { ...state };
    state[empId] = toId;
    slotsUsed.set(fromId, slotsUsed.get(fromId) - 1);
    slotsUsed.set(toId, (slotsUsed.get(toId) || 0) + 1);
    steps.push({
      n: steps.length + 1,
      kind: "move",
      empId, fromId, toId,
      gainDay: gainOfStep(before, state),
      warnings: stepWarnings(empId, fromId, toId),
      confidence: confidenceOf(empId, fromId, toId),
      ...extra,
    });
  };

  const pushSwap = (empA, empB, extra = {}) => {
    const fa = state[empA], fb = state[empB];
    const before = { ...state };
    state[empA] = fb; state[empB] = fa;
    steps.push({
      n: steps.length + 1,
      kind: "swap",
      empId: empA, fromId: fa, toId: fb, withEmpId: empB,
      gainDay: gainOfStep(before, state),
      warnings: [...stepWarnings(empA, fa, fb), ...stepWarnings(empB, fb, fa)],
      confidence: confidenceOf(empA, fa, fb) === "estimate" || confidenceOf(empB, fb, fa) === "estimate" ? "estimate" : "sure",
      ...extra,
    });
  };

  while (pending().length && guard++ < 500) {
    const pend = pending();
    // (a) direct moves into free slots; prefer one whose departure frees a needed source.
    const direct = pend.filter(id => free(assignment[id]) > 0);
    if (direct.length) {
      const needed = new Set(pend.map(id => assignment[id]));
      direct.sort((x, y) => {
        const fx = needed.has(state[x]) ? 0 : 1;
        const fy = needed.has(state[y]) ? 0 : 1;
        return fx - fy || (x < y ? -1 : 1);
      });
      pushMove(direct[0], assignment[direct[0]]);
      continue;
    }
    // (b) find a cycle among pending edges (firm → firm), deterministic DFS.
    const edges = new Map(); // firmId -> [{empId, toId}]
    for (const id of pend.sort()) {
      const from = state[id];
      if (!edges.has(from)) edges.set(from, []);
      edges.get(from).push({ empId: id, toId: assignment[id] });
    }
    let cycle = null;
    const visit = (start) => {
      const path = [];
      const seen = new Map();
      let cur = start;
      while (true) {
        if (seen.has(cur)) {
          const idx = seen.get(cur);
          return path.slice(idx);
        }
        const out = edges.get(cur);
        if (!out || !out.length) return null;
        seen.set(cur, path.length);
        path.push(out[0]);
        cur = out[0].toId;
      }
    };
    for (const start of [...edges.keys()].sort()) {
      cycle = visit(start);
      if (cycle && cycle.length) break;
    }
    if (cycle && cycle.length >= 2) {
      // Anchor so that most intermediate parkers tolerate the anchor firm's good (tool fit).
      let bestRot = 0, bestScore = -1;
      for (let r = 0; r < cycle.length; r++) {
        const anchorFirm = state[cycle[r].empId];
        let score = 0;
        for (let k = 1; k < cycle.length; k++) {
          const e = model.emps.get(cycle[(r + k) % cycle.length].empId);
          const tool = empToolInfo(e.raw);
          if (!tool || toolFitsGood(tool, model.firms.get(anchorFirm).itemCode)) score++;
        }
        if (score > bestScore) { bestScore = score; bestRot = r; }
      }
      const rot = cycle.slice(bestRot).concat(cycle.slice(0, bestRot));
      const cid = ++cycleCounter;
      // k−1 swaps: e1@c1 ↔ e2@c2, then e2@c1 ↔ e3@c3, …
      for (let k = 1; k < rot.length; k++) {
        pushSwap(rot[k - 1].empId, rot[k].empId, { cycleId: cid });
      }
      continue;
    }
    // (c) blocked purely by leavers: confirming a leave in the game frees the slot.
    const blockedTarget = pend.map(id => assignment[id]).find(fid => {
      const f = model.firms.get(fid);
      const confirmedHere = confirmed.get(fid) || 0;
      return f.leavers - confirmedHere > 0 && f.cap - confirmedHere - (slotsUsed.get(fid) || 0) > 0;
    });
    if (blockedTarget) {
      confirmed.set(blockedTarget, (confirmed.get(blockedTarget) || 0) + 1);
      slotBonus.set(blockedTarget, (slotBonus.get(blockedTarget) || 0) + 1);
      steps.push({
        n: steps.length + 1, kind: "confirmLeaver",
        firmId: blockedTarget, toId: blockedTarget, fromId: blockedTarget,
        empId: null, gainDay: 0, warnings: [], confidence: "sure",
      });
      continue;
    }
    break; // nothing feasible — should not happen with a slot-valid assignment
  }

  // Per-step payback (one step alone, from its pre-state), plus cycle sums and dependencies.
  const horizon = num(model.settings.horizonDays, 30);
  let pre = { ...model.current };
  for (const st of steps) {
    const post = { ...pre };
    if (st.kind === "move") post[st.empId] = st.toId;
    else if (st.kind === "swap") { post[st.empId] = st.toId; post[st.withEmpId] = st.fromId; }
    if (st.kind !== "confirmLeaver") {
      const firmSet = [...new Set([st.fromId, st.toId])];
      const gainOnDay = (d, steady) => firmSet.reduce((s, f) =>
        s + dayValueFirm(model, post, f, d, !!steady) - dayValueFirm(model, pre, f, d, !!steady), 0);
      const ev = compareOverTime(gainOnDay, 0, { horizon, steadyDay: 0 });
      st.transitionLoss = ev.transitionLoss;
      st.paybackDays = ev.paybackDays;
      for (const w of st.warnings) {
        if (w.code === "creatureOfHabit") w.params = [Math.round(ev.transitionLoss * 100) / 100];
      }
    }
    pre = post;
  }
  const byCycle = new Map();
  for (const st of steps) if (st.cycleId) {
    if (!byCycle.has(st.cycleId)) byCycle.set(st.cycleId, []);
    byCycle.get(st.cycleId).push(st);
  }
  for (const list of byCycle.values()) {
    const sum = list.reduce((s, x) => s + x.gainDay, 0);
    for (const st of list) st.cycleGainDay = sum;
  }
  // Dependencies: a move into a slot freed by an earlier step.
  const freed = new Map();
  let used = new Map();
  for (const f of model.firms.keys()) used.set(f, 0);
  for (const fid of Object.values(model.current)) used.set(fid, used.get(fid) + 1);
  for (const st of steps) {
    if (st.kind === "confirmLeaver") { freed.set(st.firmId, st.n); continue; }
    if (st.kind === "move") {
      const f = model.firms.get(st.toId);
      if (f.slots - (used.get(st.toId) || 0) <= 0 && freed.has(st.toId)) st.after = freed.get(st.toId);
      used.set(st.fromId, used.get(st.fromId) - 1);
      used.set(st.toId, (used.get(st.toId) || 0) + 1);
      freed.set(st.fromId, st.n);
    }
  }
  return steps;
}

// ── Training EV (§5.5) ─────────────────────────────────────────────────────
function rarityWeights(mgmtLevel, luck) {
  const M = Math.max(0, num(mgmtLevel, 0)), L = Math.max(0, num(luck, 0));
  const u = 25 + M + 0.5 * L;
  const r = 13 + 0.6 * M + 0.3 * L;
  const e = 5 + 0.3 * M + 0.15 * L;
  const l = 2 + 0.1 * M + 0.05 * L;
  const c = Math.max(0, 100 - u - r - e - l);
  return { common: c, uncommon: u, rare: r, epic: e, legendary: l };
}

// Value in G/day of a trait's CURRENT effects in the given context (for rehab).
function traitValuePerDay(model, emp, firm, group, code) {
  const O = group.filter(o => o.id !== emp.id).map(o => o.raw);
  const t = { nowMs: model.ctx.nowMs, d: 0, moved: false };
  const eff = contextEffects(emp.raw, firm.place, O, t);
  const basePPH = Math.max(RULES.minStat, emp.neutral.P0 + eff.flat) / RULES.outputDivisor;
  let pct = 0, flat = 0, hap = 0;
  for (const c of eff.codes) {
    if (c.code !== code) continue;
    if (c.kind === "pct") pct += c.value;
    else if (c.kind === "flat") flat += c.value;
    else if (c.kind === "hap") hap += c.value;
  }
  // Constant percents that sit in the neutral part (scavenger, gambler).
  if (code === "scavenger" && hasTrait(emp.raw, "scavenger")) pct += -25;
  if (code === "gambler" && hasTrait(emp.raw, "gambler")) pct += -15;
  const pctTotal = pct + hap * RULES.happinessPercentPerPoint;
  return 24 * firm.g * (basePPH * pctTotal / 100 + (flat / RULES.outputDivisor));
}

export function trainingEV(model, empId, firmId, rosterIds, optsIn = {}) {
  const opts = { ...OPT_DEFAULTS, ...model.settings, ...optsIn };
  const emp = model.emps.get(empId);
  const firm = model.firms.get(firmId);
  if (!emp || !firm) return { evSession: 0, evNet: 0, weights: rarityWeights(0, 0), bestByRarity: {} };
  const group = (rosterIds || []).map(id => model.emps.get(id)).filter(Boolean);
  const luck = num(statValue(emp.raw, "luck"), 0);
  const weights = rarityWeights(model.ctx.ownerMgmtLevel, luck);
  const HB = num(opts.advisorHorizonDays, 60);
  let D = 0;
  for (let d = 1; d < HB; d++) D += emp.survival.s[Math.min(d, emp.survival.s.length - 1)];

  const O = group.filter(o => o.id !== emp.id).map(o => o.raw);
  const t0 = { nowMs: model.ctx.nowMs, d: 0, moved: false };
  const eff = contextEffects(emp.raw, firm.place, O, t0);
  const basePPH = Math.max(RULES.minStat, emp.neutral.P0 + eff.flat) / RULES.outputDivisor;
  const pph0 = pphAt(emp.raw, emp.neutral, firm.place, O, t0);
  const a = basePPH > 0 ? pph0 / basePPH : 1; // 1 + T/100
  const mwpp = marginalWagePerPoint(emp.raw, model.ctx.wageBasis, model.ctx.ppm, model.ctx.nowMs);
  const mP = 24 * (firm.g * a / RULES.outputDivisor - mwpp); // G/day per production point
  const H = emp.happiness;
  const wageNow = emp.wageH;
  const kNow = Math.max(0.0001, num(emp.raw.wageExpectation, 1));
  const toolboxValue = num(opts.toolboxValue, 0);
  const negTraits = traitList(emp.raw).filter(t => NEGATIVE_TRAITS.includes(t.code));
  // potential counts USED capacity: remaining sessions = potentialMax − potential.
  const potentialMax = num(emp.raw.potentialMax, 0);
  const potentialLeft = Math.max(0, potentialMax - num(emp.raw.potential, potentialMax));

  const drillP = k => k * mP * D;
  const drillR = k => (Math.min(3 * k, Math.max(0, 100 - H)) / 100) * basePPH * firm.g * 24 * D * 0; // R raises happiness ceiling? No:
  // Responsibility gives +3 base happiness per point (M7) → output +3 % per point via happiness,
  // capped at happiness 100.
  const drillRVal = k => (Math.min(RULES.responsibilityHappinessPerPoint * k, Math.max(0, RULES.happinessMax - H)) / 100) * basePPH * firm.g * 24 * D;
  const drillL = k => k * RULES.toolboxPerLuckHour * (hasTrait(emp.raw, "scavenger") ? 2 : 1) * 24 * toolboxValue * D;
  const negotiation = x => {
    const exp = num(emp.raw.wageExpectation, 1);
    if (exp - x < RULES.wageExpectationFloor - 1e-9) return null;
    return (wageNow * x / kNow) * 24 * D;
  };
  const rehabVal = () => {
    if (!negTraits.length) return null;
    const vals = negTraits.map(t => Math.max(0, -traitValuePerDay(model, emp, firm, group, t.code) * D));
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const rehabAllVal = () => {
    if (negTraits.length < 2) return null;
    return negTraits.reduce((s, t) => s + Math.max(0, -traitValuePerDay(model, emp, firm, group, t.code) * D), 0);
  };

  const cE = model.ctx.energyPrice;
  const build = evSessionGuess => {
    const secondWind = s => {
      const sCap = Math.min(s, Math.max(0, RULES.potentialMaxCap - potentialMax));
      if (sCap <= 0) return null;
      const usable = Math.min(sCap, Math.max(0, Math.floor(emp.expectedDays) - 1 - potentialLeft));
      if (usable <= 0) return 0;
      return usable * Math.max(0, evSessionGuess - cE) * Math.max(0, 1 - (potentialLeft + usable / 2) / Math.max(1, emp.expectedDays));
    };
    const wild = (2 * mP * D + drillRVal(2) + drillL(2)) / 3;
    const cards = {
      common: [drillP(1), drillRVal(1), drillL(1), negotiation(0.05)].filter(v => v != null),
      uncommon: [drillP(2), drillRVal(2), drillL(2), negotiation(0.10), evSessionGuess].filter(v => v != null), // reroll = EV
      rare: [rehabVal(), wild, secondWind(2), negotiation(0.20)].filter(v => v != null),
      epic: [drillP(3), drillRVal(3), drillL(3), 0 /* habit */, secondWind(3)].filter(v => v != null),
      legendary: [drillP(4), drillRVal(4), drillL(4), rehabAllVal(), 0 /* habitPair */, secondWind(4)].filter(v => v != null),
    };
    const meanBestOf3 = list => {
      if (!list.length) return 0;
      if (list.length <= 3) return Math.max(...list);
      // mean of max over all 3-subsets
      let sum = 0, cnt = 0;
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          for (let k = j + 1; k < list.length; k++) { sum += Math.max(list[i], list[j], list[k]); cnt++; }
      return cnt ? sum / cnt : 0;
    };
    const bestByRarity = {};
    let ev = 0;
    for (const [rar, w] of Object.entries(weights)) {
      const Er = meanBestOf3(cards[rar]);
      bestByRarity[rar] = Er;
      ev += (w / 100) * Er;
    }
    return { ev, bestByRarity };
  };

  let evSession = 0, bestByRarity = {};
  for (let i = 0; i < 5; i++) {
    const r = build(evSession);
    evSession = r.ev;
    bestByRarity = r.bestByRarity;
  }
  const evNet = evSession - cE;

  let trainValue = 0;
  for (let j = 0; j < potentialLeft; j++) {
    let Dj = 0;
    for (let d = j + 1; d < HB; d++) Dj += emp.survival.s[Math.min(d, emp.survival.s.length - 1)];
    trainValue += Math.max(0, evSession * (D > 0 ? Dj / D : 0) - cE);
  }

  return { evSession, evNet, weights, bestByRarity, trainValue, mP, D };
}

// ── Replacement benchmark (§5.5) ───────────────────────────────────────────
function expectedBestStat(k) {
  // E[max of k uniform draws from {1..4}]
  const table = { 3: 3.44, 4: 3.61, 5: 3.72, 6: 3.81 };
  return table[clamp(Math.round(k), 3, 6)] ?? 3.44;
}

export function candidateValue(model, firmId, rosterIds, profile, optsIn = {}) {
  const opts = { ...OPT_DEFAULTS, ...model.settings, ...optsIn };
  const firm = model.firms.get(firmId);
  if (!firm) return { value: 0 };
  const HB = num(opts.advisorHorizonDays, 60);
  const nowMs = model.ctx.nowMs;
  const group = (rosterIds || []).map(id => model.emps.get(id)).filter(Boolean);

  const recruiters = [...model.emps.values()].filter(e => hasTrait(e.raw, "recruiter")).length;
  const K = Math.min(6, 3 + recruiters);
  const P = profile.production ?? expectedBestStat(K);
  const L = profile.luck ?? 2.5;
  const R = profile.responsibility ?? 2.5;
  const age = profile.age ?? 31.5;
  const k = profile.k ?? 1.0;
  const potentialMax = profile.potentialMax ?? 6.5;
  const traitPct = profile.traitPct ?? 0;

  const wageH = profile.wageH ?? (P / RULES.outputDivisor) * model.ctx.ppm * k;
  // Candidate happiness: same place/tax/coworker parts, own responsibility contribution.
  const cand = {
    _id: "candidate", name: "candidate", age,
    base: { production: P, luck: L, responsibility: R },
    breakdown: {
      production: { base: P, trained: 0, contributions: [], total: Math.max(1, P) },
      luck: { base: L, trained: 0, contributions: [], total: Math.max(1, L) },
      responsibility: { base: R, trained: 0, contributions: [], total: Math.max(1, R) },
    },
    traits: [], specializations: {}, wage: wageH, wageExpectation: k,
    potential: Math.round(potentialMax), potentialMax: Math.round(potentialMax),
    createdAt: new Date(nowMs).toISOString(),
    happinessBreakdown: { base: 50, contributions: [], mitigated: 0, value: 50, quitChance: 0 },
    productionBonus: { total: 0, contributions: [] },
  };
  const O = group.map(o => o.raw);
  const placeEff = contextEffects(cand, firm.place, O, { nowMs, d: 0, moved: false });
  const H0 = 50 + R * RULES.responsibilityHappinessPerPoint + placeEff.hap;
  const survival = survivalCurve(cand, HB, {
    policy: opts.retirementPolicy, ownerMgmtLevel: model.ctx.ownerMgmtLevel,
    happiness: clamp(H0, 0, 100), nowMs, wagePerHour: wageH,
  });
  const mgmtPct = RULES.managementPercentPerPoint * (1 + model.ctx.ownerMgmtLevel);
  const perDay = [];
  let value = 0;
  for (let d = 0; d < HB; d++) {
    const spec = Math.min(RULES.specializationMaxPercent, d * RULES.specializationPercentPerDay);
    const Hd = clamp(H0, 0, 100);
    const T = mgmtPct + (firm.place.isCore ? RULES.coreRegionBonusPercent : 0) + num(firm.place.managerPct, 0)
      + spec + traitPct + placeEff.pct + (Hd - 50);
    const pph = Math.max(0, (Math.max(1, P + placeEff.flat) / RULES.outputDivisor) * (1 + T / 100));
    const n = 24 * (firm.g * pph - wageH);
    const w = survival.s[Math.min(d, survival.s.length - 1)];
    perDay.push(n * w);
    value += n * w - survival.retireCost[Math.min(d, survival.retireCost.length - 1)];
  }
  // Training potential of the fresh hire (approximate: own trainingEV-like drill value).
  const mwppCand = (model.ctx.ppm * k) / RULES.outputDivisor;
  const aCand = 1 + (mgmtPct + (firm.place.isCore ? 5 : 0) + traitPct) / 100;
  const mPc = 24 * (firm.g * aCand / RULES.outputDivisor - mwppCand);
  let Dc = 0;
  for (let d = 1; d < HB; d++) Dc += survival.s[Math.min(d, survival.s.length - 1)];
  const weights = rarityWeights(model.ctx.ownerMgmtLevel, L);
  const evDrill = (weights.common * 1 + weights.uncommon * 2 + weights.rare * 2 + weights.epic * 3 + weights.legendary * 4) / 100;
  let trainValue = 0;
  for (let j = 0; j < Math.round(potentialMax); j++) {
    const Dj = Math.max(0, Dc - j);
    trainValue += Math.max(0, Math.max(0, evDrill * mPc) * (Dc > 0 ? Dj / Dc : 0) - model.ctx.energyPrice);
  }
  value += trainValue - model.ctx.energyPrice; // hire costs 10 energy
  return { value, perDay, trainValue, K };
}

// ── Advisor (§5.5) ─────────────────────────────────────────────────────────
export function adviseAll(model, assignment, optsIn = {}) {
  const opts = { ...OPT_DEFAULTS, ...model.settings, ...optsIn };
  const HB = num(opts.advisorHorizonDays, 60);
  const nowMs = model.ctx.nowMs;
  const out = [];

  const pendingRetireByEmp = new Map();
  for (const ev of model.events || []) {
    if (ev?.status !== "pending") continue;
    const code = String(ev.code || "");
    if (!/retire/i.test(code)) continue;
    for (const c of Array.isArray(ev.cast) ? ev.cast : []) {
      const eid = idString(c?.employee ?? c?._id ?? c);
      if (eid) pendingRetireByEmp.set(eid, ev);
    }
  }

  for (const [empId, firmId] of Object.entries(assignment)) {
    const emp = model.emps.get(empId);
    const firm = model.firms.get(firmId);
    if (!emp || !firm) continue;
    const rosterIds = Object.keys(assignment).filter(id => assignment[id] === firmId);
    const group = rosterIds.map(id => model.emps.get(id));
    const others = rosterIds.filter(id => id !== empId);

    // Marginal day value: group with vs without the employee (coworker effects included).
    const dayWith = dayValueFirm(model, Object.fromEntries(rosterIds.map(id => [id, firmId])), firmId, 0, true);
    const dayWithout = dayValueFirm(model, Object.fromEntries(others.map(id => [id, firmId])), firmId, 0, true);
    const w0 = emp.survival.s[0] || 1;
    const grossMarginal = (dayWith - dayWithout) / w0;
    const marginalDay = grossMarginal - 24 * emp.wageH;

    const tOwn = { nowMs, d: 0, moved: false };
    const ownPPH = pphAt(emp.raw, emp.neutral, firm.place, others.map(id => model.emps.get(id).raw), tOwn);
    const netNow = 24 * (firm.g * ownPPH - emp.wageH);
    const coworkerDeltaDay = grossMarginal - 24 * firm.g * ownPPH;

    // keepBase: survival-weighted marginal net over the advisor horizon, minus retirement costs.
    let keepBase = 0;
    for (let d = 0; d < HB; d++) {
      const w = emp.survival.s[Math.min(d, emp.survival.s.length - 1)];
      const wage = wageOnDay(emp.raw, d, { basis: model.ctx.wageBasis, nowMs });
      keepBase += w * (grossMarginal - 24 * wage) - emp.survival.retireCost[Math.min(d, emp.survival.retireCost.length - 1)];
    }

    const tev = trainingEV(model, empId, firmId, rosterIds, opts);
    const trainValue = num(tev.trainValue, 0);
    const potentialMax = num(emp.raw.potentialMax, 0);
    const potentialLeft = Math.max(0, potentialMax - num(emp.raw.potential, potentialMax));
    const trainableToday = !firm.place.disabled
      && num(emp.raw.trainingsToday, 0) < num(emp.raw.trainingsPerDay, 1)
      && potentialLeft > 0;

    const mk = p => candidateValue(model, firmId, others, p, opts).value;
    const replaceMid = mk({ potentialMax: 6.5, traitPct: 0 });
    const replaceLow = mk({ potentialMax: 3, traitPct: -25 });
    const replaceHigh = mk({ potentialMax: 10, traitPct: 20 });
    const keepValue = keepBase + trainValue;
    const replaceAdvantage = replaceMid - keepValue;

    const quit = empQuitChance(emp.raw);
    const retireEvent = pendingRetireByEmp.get(empId);
    let hoursLeft = null;
    if (retireEvent?.expiresAt) {
      const ms = Date.parse(retireEvent.expiresAt) - nowMs;
      if (Number.isFinite(ms)) hoursLeft = ms / 3600000;
    }

    const fireAllowedAtMs = Date.parse(emp.raw.createdAt) + RULES.fireLockHours * 3600000;
    const mwpp = marginalWagePerPoint(emp.raw, model.ctx.wageBasis, model.ctx.ppm, nowMs);
    const basePPHv = Math.max(RULES.minStat, num(rawStatValue(emp.raw, "production"), 1)) / RULES.outputDivisor;
    const aFac = basePPHv > 0 ? ownPPH / basePPHv : 1;
    const marginPerPoint = 6 * (firm.g * aFac - mwpp * RULES.outputDivisor);

    const reasons = [];
    let verdict = "keep";
    const minAdv = Math.max(num(opts.replaceMinGain, 10), num(opts.replaceMinGainDay, 0.5) * Math.min(emp.expectedDays, HB));
    if (quit > 0 || (retireEvent && hoursLeft != null && hoursLeft < 12)) {
      verdict = "critical";
      if (quit > 0) reasons.push({ key: "whyQuit", params: [Math.max(1, Math.round(1 / Math.max(quit, 1e-6)))] });
      if (retireEvent && hoursLeft != null) reasons.push({ key: "whyRetireEvent", params: [Math.max(0, Math.round(hoursLeft))] });
    } else if (keepValue < 0 && replaceMid <= 0) {
      verdict = "fire";
      reasons.push({ key: "whyFire", params: [fmtG(Math.abs(marginalDay))] });
    } else if (replaceAdvantage >= minAdv && replaceLow >= keepValue) {
      verdict = "replace";
      reasons.push({ key: "whyReplace", params: [fmtG(replaceAdvantage)] });
      if (potentialLeft <= 0) {
        reasons.push({ key: "whyNoPotential", params: [num(emp.raw.potential, 0), potentialMax] });
      }
    } else if (trainableToday && tev.evNet > 0) {
      verdict = "train";
      reasons.push({ key: "whyTrain", params: [fmtG(tev.evNet)] });
    } else if (replaceAdvantage >= minAdv && replaceLow < keepValue) {
      reasons.push({ key: "whyKeepLuck", params: [] });
    }
    // Someone whose own net is negative can still carry the team (foreman, comic, pairs):
    // say so whenever it is the case, whatever the verdict ended up being.
    if (verdict !== "fire" && verdict !== "critical" && netNow < 0 && coworkerDeltaDay > 0) {
      reasons.push({ key: "whyKeepCoworkers", params: [fmtG(netNow), fmtG(coworkerDeltaDay)] });
    }
    // Every verdict carries at least one reason the UI can show.
    if (!reasons.length) reasons.push({ key: "whyKeep", params: [fmtG(marginalDay)] });
    if (verdict === "fire" || verdict === "replace") {
      if (fireAllowedAtMs > nowMs) reasons.push({ key: "whyFireLock", params: [fireAllowedAtMs] });
    }

    // Badge codes follow the spec contract (what the UI's badgeInfo/hasBadge expect).
    const badges = [];
    const retireIn = Math.max(0, RULES.retirementAge - num(emp.raw.age, 30));
    if (retireIn <= 7) badges.push({ code: "retireSoon", params: { days: Math.round(retireIn) } });
    if (hasTrait(emp.raw, "climber")) badges.push("climber");
    if (firm.place.disabled) badges.push("paused");
    if (netNow < 0) badges.push("loss");
    if (trainableToday) badges.push("trainToday");
    const tool = empToolInfo(emp.raw);
    if (tool?.broken) badges.push("toolBroken");
    else if (tool && !toolFitsGood(tool, firm.itemCode)) badges.push("toolMismatch");
    if (emp.uncertain) badges.push("uncertain");

    // First retirement event: stay chance and per-event cost.
    const yrs0 = 0;
    const hT = Math.trunc((emp.happiness - 50) / 5);
    const stayP = opts.retirementPolicy === "notNow"
      ? clamp(RULES.notNowBase - 0 + 2 * model.ctx.ownerMgmtLevel + hT + 2 * num(statValue(emp.raw, "luck"), 0), 5, 90)
      : 100 - (100 - clamp(RULES.convinceBase + (hasTrait(emp.raw, "loyal") ? RULES.convinceLoyalBonus : 0) + 2 * model.ctx.ownerMgmtLevel + hT, 5, 90)) * (hasTrait(emp.raw, "gambler") ? RULES.gamblerCritShare : RULES.critShare);

    out.push({
      empId, verdict, badges, reasons,
      numbers: {
        netNow, marginalDay, grossMarginalDay: grossMarginal, coworkerDeltaDay,
        keepValue, keepBase, trainValue, evSession: tev.evSession, evNet: tev.evNet,
        replaceMid, replaceLow, replaceHigh, replaceAdvantage,
        expectedDays: emp.expectedDays,
        retireTailDays: emp.survival.retireTailDays,
        retireInDays: retireIn,
        wageDriftPerWeek: hasTrait(emp.raw, "climber")
          ? 24 * (wageOnDay(emp.raw, 7, { basis: model.ctx.wageBasis, nowMs }) - emp.wageH) : 0,
        marginPerPoint,
        retireStayPct: stayP,
        retireCostPerEvent: opts.retirementPolicy === "convince" ? RULES.convinceCostWageDays * 24 * emp.wageH : 0,
      },
      fireAllowedAtMs: Number.isFinite(fireAllowedAtMs) ? fireAllowedAtMs : null,
      trainableToday,
    });
  }
  const order = { critical: 0, fire: 1, replace: 2, train: 3, keep: 4 };
  out.sort((a, b) => (order[a.verdict] - order[b.verdict])
    || (Math.abs(b.numbers.replaceAdvantage) - Math.abs(a.numbers.replaceAdvantage)));
  return out;
}

// Smallest candidate card that reliably beats the employee (§5.5). `ctx` names the slot the
// advice was computed in (plan target firm and roster); without it the current state is used.
export function minCandidate(model, advice, optsIn = {}, ctx = {}) {
  const opts = { ...OPT_DEFAULTS, ...model.settings, ...optsIn };
  const emp = model.emps.get(advice.empId);
  if (!emp) return null;
  const firmId = ctx.firmId ?? emp.firmId;
  const others = Array.isArray(ctx.rosterIds)
    ? ctx.rosterIds.filter(id => id !== advice.empId)
    : Object.keys(model.current).filter(id => model.current[id] === firmId && id !== advice.empId);
  const minAdv = Math.max(num(opts.replaceMinGain, 10), num(opts.replaceMinGainDay, 0.5) * Math.min(emp.expectedDays, num(opts.advisorHorizonDays, 60)));
  const keep = advice.numbers.keepValue;
  for (let P = 1; P <= 4; P++) {
    // oldest acceptable age, then highest acceptable k by bisection
    let bestAge = null;
    for (let age = 45; age >= 18; age -= 1) {
      const v = candidateValue(model, firmId, others, { production: P, age, k: 1.0, potentialMax: 6.5, traitPct: 0 }, opts).value;
      if (v - keep >= minAdv) { bestAge = age; break; }
    }
    if (bestAge == null) continue;
    let lo = 0.7, hi = 1.56;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const v = candidateValue(model, firmId, others, { production: P, age: bestAge, k: mid, potentialMax: 6.5, traitPct: 0 }, opts).value;
      if (v - keep >= minAdv) lo = mid; else hi = mid;
    }
    return { production: P, maxAge: bestAge, maxWageH: (P / RULES.outputDivisor) * model.ctx.ppm * lo };
  }
  return null;
}

// ── Manager ROI (§5.6) ─────────────────────────────────────────────────────
export function managerROI({ ppp, g, roster = [], rate, sumP = 0 }) {
  const perPointGainH = num(ppp, 0) * num(g, 0);
  const perPointNetH = perPointGainH - num(rate, 0);
  const top2 = roster.map(r => num(r.basePPH, 0)).sort((a, b) => b - a).slice(0, 2);
  const careH = 0.05 * top2.reduce((s, v) => s + v, 0) * num(g, 0); // +5 happiness for 48 h ⇒ ~2 at once
  const byPoints = [];
  for (let p = 2; p <= 11; p++) byPoints.push({ points: p, netDay: 24 * (p * perPointNetH + careH) });
  const kappa = sumP > 0 ? num(ppp, 0) / (0.02 * sumP / RULES.outputDivisor) : 1;
  const breakEvenSumP = kappa > 0 && g > 0 ? (RULES.outputDivisor * num(rate, 0)) / (0.02 * kappa * num(g, 1)) : Infinity;
  const recommendation = perPointNetH > 0 ? "max"
    : (careH > 2 * Math.abs(perPointNetH) ? "min" : null);
  return { perPointGainH, perPointNetH, careH, byPoints, breakEvenRate: perPointGainH, breakEvenSumP, recommendation };
}

// ── Toolbox balance ────────────────────────────────────────────────────────
export function toolboxBalance(summary, model) {
  const foundPerDay = 24 * num(summary?.toolboxesPerHour, 0);
  let toolUsers = 0;
  for (const e of model.emps.values()) {
    const firm = model.firms.get(e.firmId);
    const family = firm && Object.entries(TOOL_FAMILY_GOODS).some(([, goods]) => goods.includes(firm.itemCode));
    if (family) toolUsers++;
  }
  const needPerDay = toolUsers / (500 / 24);
  const state = foundPerDay > needPerDay * 1.2 ? "surplus" : foundPerDay < needPerDay * 0.8 ? "deficit" : "balanced";
  return { foundPerDay, needPerDay, state };
}
