
const API = "https://api2.warera.io/trpc/";

async function apiCall(endpoint, body) {
  const r = await fetch(API + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.data?.code || d.error.message || "API Error");
  return d.result.data;
}

async function testSearch(input) {
  console.log(`--- Teste Suche für: "${input}" ---`);
  
  try {
    const search = await apiCall("search.searchAnything", { searchText: input });
    console.log("Suchergebnisse (UserIDs):", search.userIds);

    if (!search.userIds || search.userIds.length === 0) {
      console.log("Keine Ergebnisse gefunden.");
      return;
    }

    let userId = search.userIds[0];
    let username = "Unknown";
    let foundExact = false;

    for (const uid of search.userIds) {
      const u = await apiCall("user.getUserLite", { userId: uid });
      console.log(`Prüfe ID ${uid}: Name = "${u.username}"`);
      
      if (u.username.toLowerCase() === input.toLowerCase()) {
        console.log(">> EXAKTER TREFFER GEFUNDEN!");
        userId = uid;
        username = u.username;
        foundExact = true;
        break;
      }
      
      if (uid === search.userIds[0]) {
        console.log(">> Merke Fallback (erster Treffer):", u.username);
        username = u.username;
      }
    }

    console.log(`--- FINALES ERGEBNIS ---`);
    console.log(`ID: ${userId}`);
    console.log(`Name: ${username}`);
    console.log(`Exakt gefunden: ${foundExact}`);

  } catch (e) {
    console.error("Fehler im Test:", e.message);
  }
}

testSearch("El-GREGiablo");
