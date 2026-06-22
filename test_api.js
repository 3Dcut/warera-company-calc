const API_BASE = "https://api2.warera.io/trpc/";

async function apiCall(endpoint, body) {
  const r = await fetch(API_BASE + endpoint, {
    method: "POST", 
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let d = await r.json();
  if (Array.isArray(d)) d = d[0];
  return d?.result?.data;
}

async function test() {
  console.log("Searching for user 3dsus_kistus...");
  const searchResp = await apiCall("search.searchAnything", { searchText: "3dsus_kistus" });
  console.log("Search response:", JSON.stringify(searchResp, null, 2));

  let userId;
  if (searchResp && Array.isArray(searchResp)) {
    userId = searchResp.find(r => r.name === "3dsus_kistus" || r.username === "3dsus_kistus")?._id;
  } else if (searchResp && searchResp.users) {
    userId = searchResp.users.find(u => u.username === "3dsus_kistus")?._id;
  }
  
  if (!userId) {
     console.log("Could not find user.");
     return;
  }
  console.log("Found userId:", userId);

  console.log("Fetching companies...");
  const companiesResp = await apiCall("company.getCompanies", { userId, perPage: 100 });
  const companies = companiesResp?.items || [];
  console.log(`Found ${companies.length} companies.`);

  if (companies.length > 0) {
    const cid = companies[0]._id;
    console.log(`Fetching workers for company ${cid} (${companies[0].name})...`);
    const wrk = await apiCall("worker.getWorkers", { companyId: cid });
    console.log("Worker API response:", JSON.stringify(wrk, null, 2));
  }
}

test().catch(console.error);
