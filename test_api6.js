const API_BASE = "https://api2.warera.io/trpc/";

async function test() {
  const cid = "69c31b0555ef3d24b4cff856"; // company ID for 3dsus_kistus
  
  // POST
  let r = await fetch(API_BASE + "worker.getWorkers", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: cid })
  });
  console.log("POST:", await r.text());

  // GET
  const url = new URL(API_BASE + "worker.getWorkers");
  url.searchParams.set("input", JSON.stringify({ "0": { json: { companyId: cid } } }));
  r = await fetch(url.toString(), { method: "GET" });
  console.log("GET:", await r.text());
}

test().catch(console.error);
