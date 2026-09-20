#!/usr/bin/env node
// Small read-only probe for the WarEra API (https://api2.warera.io/trpc/).
//
// Usage:
//   node scripts/api-probe.mjs <username-or-userId> [--workers]
//   npm run probe -- <username-or-userId> [--workers]
//
// Prints the user's level / prestige / "companies" skill and every company the
// user owns. With --workers it additionally lists the workers of each company;
// that endpoint needs an API key, which is read ONLY from the environment
// variable WARERA_API_KEY (never from the command line, never printed).
//
// No dependencies, Node >= 22 (global fetch).

const API_BASE = "https://api2.warera.io/trpc/";
const DELAY_MS = 300;        // pause between calls (the API rate-limits aggressively)
const RETRY_429_MS = 3000;   // one retry after HTTP 429
const OBJECT_ID = /^[0-9a-f]{24}$/;

const args = process.argv.slice(2);
const wantWorkers = args.includes("--workers");
const target = args.find(a => !a.startsWith("--"));

if (!target) {
  console.error("Usage: node scripts/api-probe.mjs <username-or-userId> [--workers]");
  console.error("       set WARERA_API_KEY in the environment to fetch workers (never pass it as an argument)");
  process.exit(1);
}

const apiKey = (process.env.WARERA_API_KEY || "").trim();
if (wantWorkers && !apiKey) {
  console.error("note: --workers ignored because WARERA_API_KEY is not set");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let callCount = 0;
async function api(proc, input, { auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }
  if (callCount++ > 0) await sleep(DELAY_MS);

  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API_BASE + proc, { method: "POST", headers, body: JSON.stringify(input) });
    if (r.status === 429 && attempt === 0) {
      console.error(`  ${proc}: HTTP 429, retrying once in ${RETRY_429_MS / 1000}s`);
      await sleep(RETRY_429_MS);
      continue;
    }
    let d;
    try { d = await r.json(); } catch { throw new Error(`${proc}: HTTP ${r.status}, non-JSON body`); }
    if (Array.isArray(d)) d = d[0];
    if (d?.error) {
      const code = d.error.data?.code || d.error.message || "unknown";
      throw new Error(`${proc}: ${code} (HTTP ${r.status})`);
    }
    if (!r.ok) throw new Error(`${proc}: HTTP ${r.status}`);
    return d?.result?.data;
  }
}

async function resolveUser(input) {
  if (OBJECT_ID.test(input)) {
    return api("user.getUserLite", { userId: input });
  }
  const search = await api("search.searchAnything", { searchText: input });
  const ids = search?.userIds || [];
  if (!ids.length) throw new Error(`no user found for "${input}" (note: exact username search; the player may have renamed)`);
  const candidates = [];
  for (const uid of ids) {
    const u = await api("user.getUserLite", { userId: uid });
    if (u?.username?.toLowerCase() === input.toLowerCase()) return u;
    if (u?.username) candidates.push(u.username);
  }
  throw new Error(`no exact match for "${input}"; search returned: ${candidates.join(", ")}`);
}

const fmt = v => (v === undefined || v === null ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v));

async function main() {
  const user = await resolveUser(target);
  if (!user?._id) throw new Error("user lookup returned no _id");

  const lv = user.leveling || {};
  const sc = user.skills?.companies || {};
  console.log(`user      : ${user.username}  (${user._id})`);
  console.log(`level     : ${fmt(lv.level ?? user.level)}`);
  console.log(`prestige  : prestigeLevel=${fmt(lv.prestigeLevel)}  prestige(points)=${fmt(lv.prestige)}`);
  console.log(`companies : level=${fmt(sc.level)}  prestige=${fmt(sc.prestige)}  total=${fmt(sc.total)}`);

  const list = await api("company.getCompanies", { userId: user._id, perPage: 100 });
  const ids = (list?.items || []).map(c => (typeof c === "string" ? c : c?._id)).filter(Boolean);
  console.log(`\n${ids.length} companies`);

  let n = 0;
  for (const companyId of ids) {
    n++;
    let c;
    try {
      c = await api("company.getById", { companyId });
    } catch (e) {
      console.log(`#${String(n).padStart(2)} ${companyId}  ERROR ${e.message}`);
      continue;
    }
    const up = c?.activeUpgradeLevels || {};
    const status = c?.disabledAt ? `DISABLED since ${c.disabledAt}` : "active";
    console.log(
      `#${String(n).padStart(2)} ${fmt(c?.name).padEnd(24)} item=${fmt(c?.itemCode).padEnd(10)} region=${fmt(c?.region)}  ` +
      `storage=${fmt(up.storage)} engine=${fmt(up.automatedEngine)} breakRoom=${fmt(up.breakRoom)}  workers=${fmt(c?.workerCount)}  ${status}`
    );

    if (wantWorkers && apiKey) {
      try {
        const w = await api("worker.getWorkers", { companyId }, { auth: true });
        const workers = Array.isArray(w) ? w : (w?.workers || w?.items || []);
        if (!workers.length) {
          console.log("     workers: none");
        }
        for (const wk of workers) {
          const u = wk?.user && typeof wk.user === "object" ? wk.user : null;
          const name = u?.username || (typeof wk?.user === "string" ? wk.user : wk?._id);
          console.log(`     worker: ${fmt(name)}  wage=${fmt(wk?.wage ?? wk?.salary)}  fidelity=${fmt(wk?.fidelity)}`);
        }
      } catch (e) {
        console.log(`     workers: ERROR ${e.message}`);
      }
    }
  }
}

main().catch(e => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
