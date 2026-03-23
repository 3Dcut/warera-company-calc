const API_BASE = "https://api2.warera.io/trpc/";
const apiKey = "wae_f6c46b1b30c0700a44155530965b96de8eca1e9e539a9710a6c0ac0499c6a306";
async function api(path, body={}) {
  const r = await fetch(API_BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  return data[0]?.result?.data || data;
}

async function run() {
  try {
    const wealth = await api("ranking.getRanking", {"rankingType": "userWealth", "limit": 5});
    console.log(JSON.stringify(wealth, null, 2));
  } catch(e) { console.error(e) }
}
run();
