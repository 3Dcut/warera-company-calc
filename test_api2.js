const API_BASE = "https://api2.warera.io/trpc/";

async function apiCallGet(endpoint, body) {
  const url = new URL(API_BASE + endpoint);
  url.searchParams.set("input", JSON.stringify({ "0": { json: body } }));
  const r = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  let d = await r.json();
  return d;
}

async function apiCallPost(endpoint, body) {
  const r = await fetch(API_BASE + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let d = await r.json();
  return d;
}

async function test() {
  console.log("Searching for user 3dsus_kistus via GET...");
  let searchResp = await apiCallGet("search.searchAnything", { searchText: "3dsus_kistus" });
  console.log("GET searchResp:", JSON.stringify(searchResp).substring(0, 200));

  let userId;
  try {
     userId = searchResp[0].result.data.json.find(x => x.username === "3dsus_kistus" || x.name === "3dsus_kistus")._id;
  } catch (e) {}

  if (!userId) {
     console.log("Searching for user 3dsus_kistus via POST...");
     searchResp = await apiCallPost("search.searchAnything", { searchText: "3dsus_kistus" });
     console.log("POST searchResp:", JSON.stringify(searchResp).substring(0, 200));
     try {
       userId = searchResp[0].result.data.find(x => x.username === "3dsus_kistus")._id;
     } catch(e) {}
  }

  if (!userId) return console.log("User not found.");

  console.log("Found user ID:", userId);

  console.log("Fetching companies via POST...");
  const companiesResp = await apiCallPost("company.getCompanies", { userId, perPage: 100 });
  console.log("Companies POST resp:", JSON.stringify(companiesResp).substring(0, 200));

  let companies = [];
  try { companies = companiesResp[0].result.data.items || companiesResp[0].result.data; } catch(e){}

  if (companies.length > 0) {
     const cid = companies[0]._id;
     console.log("Fetching workers for company via POST:", cid);
     const wrkPost = await apiCallPost("worker.getWorkers", { companyId: cid });
     console.log("Worker POST:", JSON.stringify(wrkPost, null, 2));
     
     console.log("Fetching workers for company via GET:", cid);
     const wrkGet = await apiCallGet("worker.getWorkers", { companyId: cid });
     console.log("Worker GET:", JSON.stringify(wrkGet, null, 2));
  }
}

test().catch(console.error);
