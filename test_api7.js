const API_BASE = "https://api2.warera.io/trpc/";

async function test() {
  const cid = "69c31b0555ef3d24b4cff856"; // company ID
  
  let r = await fetch(API_BASE + "company.getById", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: cid })
  });
  console.log("POST company.getById:", await r.text());
}

test().catch(console.error);
