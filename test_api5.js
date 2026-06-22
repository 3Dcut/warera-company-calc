const API_BASE = "https://api2.warera.io/trpc/";

async function apiCallGet(endpoint, body) {
  const url = new URL(API_BASE + endpoint);
  url.searchParams.set("input", JSON.stringify({ "0": { json: body } }));
  const r = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  let d = await r.json();
  return d?.result?.data || (Array.isArray(d) ? d[0]?.result?.data : null);
}

async function apiCallPost(endpoint, body) {
  const r = await fetch(API_BASE + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let d = await r.json();
  return d?.result?.data || (Array.isArray(d) ? d[0]?.result?.data : null);
}

async function test() {
  const userId = "6976afb9713451d626e54737";
  const data = await apiCallPost("company.getCompanies", { userId, perPage: 100 });
  const companyIds = data?.items || [];
  
  if (companyIds.length > 0) {
     const cid = companyIds[0];
     console.log("Fetching workers for company via POST:", cid);
     const wrkPost = await apiCallPost("worker.getWorkers", { companyId: cid });
     console.log("Worker POST:", JSON.stringify(wrkPost, null, 2));
     
     console.log("Fetching workers for company via GET:", cid);
     const wrkGet = await apiCallGet("worker.getWorkers", { companyId: cid });
     console.log("Worker GET:", JSON.stringify(wrkGet, null, 2));
  }
}

test().catch(console.error);
