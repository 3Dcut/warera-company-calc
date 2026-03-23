
const apiKey = "wae_f6c46b1b30c0700a44155530965b96de8eca1e9e539a9710a6c0ac0499c6a306";

async function fetchCountries() {
  const res = await fetch("https://api2.warera.io/trpc/country.getAllCountries", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify({})
  });
  const data = await res.json();
  const countries = Array.isArray(data) ? data[0] : data;
  return countries.result.data.filter(c => c.rulingParty).map(c => c.rulingParty);
}

async function testDelay(delay, partyIds) {
  console.log(`\nTesting FULL LOAD with ${delay}ms delay per stream...`);
  const queue = [...partyIds];
  let successes = 0;
  let errors429 = 0;
  
  const worker = async () => {
    while (queue.length > 0) {
      const pid = queue.shift();
      try {
        const res = await fetch("https://api2.warera.io/trpc/party.getById", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partyId: pid })
        });
        if (res.status === 429) errors429++;
        else if (res.ok) successes++;
      } catch (e) {}
      await new Promise(r => setTimeout(r, delay));
    }
  };

  const start = Date.now();
  await Promise.all([worker(), worker()]); // 2 streams
  const time = Date.now() - start;
  
  console.log(`Result for ${delay}ms: ${successes} Success, ${errors429} Rate Limits (Took ${time}ms)`);
  return errors429 === 0;
}

async function run() {
  const partyIds = await fetchCountries();
  console.log(`Found ${partyIds.length} valid party IDs for testing.`);
  
  // Test steady states: 100ms, 200ms, 250ms
  for (const delay of [100, 150, 200, 250, 300]) {
    const success = await testDelay(delay, partyIds);
    if (success) {
      console.log(`\nSUCCESS: ${delay}ms works flawlessly without ANY 429s!`);
      break;
    }
    await new Promise(r => setTimeout(r, 6000)); // sleep 6 seconds to reset bucket
  }
}

run();
