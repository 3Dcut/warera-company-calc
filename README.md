# WarEra Company Calculator

Browser-Tool für das Browserspiel [WarEra](https://app.warera.io): lädt die Firmen (Fabriken) eines Spielers über die öffentliche WarEra-API, berechnet den Gewinn pro Tag und schlägt Optimierungen sowie einen Ausbauplan vor.

**Live:** https://3dcut.github.io/warera-company-calc/

Die Anwendung ist eine reine Single-Page-App (React 18 + Vite) ohne eigenes Backend. Alle Spieldaten werden direkt aus dem Browser von `https://api2.warera.io` geladen; auf GitHub Pages liegen nur statische Dateien.

## Benutzung

1. **Spielername** (oder die 24-stellige User-ID) eingeben und laden. Der Name muss exakt stimmen (Groß-/Kleinschreibung ist egal); nach einer Umbenennung im Spiel funktioniert nur noch der neue Name.
2. **API-Key (optional):** Nur für die Arbeiter-Daten nötig. Der Endpunkt `worker.getWorkers` antwortet ohne Key mit `401`. Alles andere (Fabriken, Engine-Produktion, Marktpreise, Regionen, Länder, Parteien) wird auch ohne Key geladen. Ohne Key fehlen in der Übersicht die Arbeiter-PP und Löhne, und die Arbeiter-Optimierung bleibt leer.
3. **Sprache:** Deutsch, Englisch und Schwedisch, umschaltbar in der Kopfzeile oder per `?lang=`.

Nach dem Laden werden im Hintergrund noch die Parteien aller Länder (Ethiken) nachgeladen; solange der Fortschrittsbalken läuft, können sich die Bonus-Werte und damit die profitabelsten Produkte noch ändern.

### Die vier Tabs

| Tab | Inhalt |
|---|---|
| **Übersicht** | Alle Fabriken mit Produkt, Region/Land, Produktionsbonus, Engine-PP, Arbeiter-PP, Materialkosten und Gewinn pro Tag. Ein Klick auf eine Fabrik zeigt die Arbeiter-Details (nur mit API-Key). |
| **Optimierung** | Feindland-Warnungen (Arbeiter in Ländern, die mit deinem Land im Krieg sind), Lohnverlust-Warnungen (Lohn höher als Produktionsbeitrag), bessere Regionen (Umzug für 5 Beton ohne Produktwechsel), Arbeiter-Optimierung (Arbeiter in eine andere eigene Fabrik versetzen) und die globale Fabrik-Optimierung (Produktwechsel für 5 Beton bzw. Produktwechsel + Umzug für 10 Beton). |
| **Profitabelste Produkte** | Ranking aller produzierbaren Güter nach Gold pro Production Point auf Basis der aktuellen Marktpreise, inklusive des besten erreichbaren Bonus und deiner eigenen Fabriken pro Produkt. |
| **Fabrikausbau** | Planer für neue Fabriken und Engine-Upgrades. Strategien: Optimal (Dijkstra über alle Ausbaupfade), Billigstes zuerst, Fabriken zuerst, Upgrades zuerst. Zeigt die Reihenfolge der Aktionen, den Tag, an dem sie bezahlbar sind, und den Gewinnverlauf als Diagramm. |

## API-Key

Der Key wird nur an https://api2.warera.io gesendet und, wenn gewünscht, im Browser gespeichert.

Konkret:

- Ist ein Key hinterlegt, hängt die App ihn als Header (`Authorization: Bearer …` und `x-api-key`) an ihre Anfragen an `https://api2.warera.io` an. An keine andere Adresse. Die GitHub-Pages-Auslieferung ist statisch, es gibt keinen Server dieses Projekts, der den Key sehen könnte, und es gibt kein Tracking.
- Gespeichert wird der Key ausschließlich im `localStorage` deines Browsers (Schlüssel `warera_api_key`), damit du ihn nicht jedes Mal neu eingeben musst. Leeren des Feldes oder Löschen der Website-Daten entfernt ihn wieder.
- Der Key wird **nicht mehr** aus der URL (`?apikey=`) gelesen, weil URL-Parameter in Browser-Verlauf, Lesezeichen und Server-Logs landen. Falls du früher einen Link mit `?apikey=` verteilt hast, erzeuge im Spiel einen neuen Key.
- Wer die Seite in eine eigene Website einbettet, kann den Key stattdessen per `postMessage` übergeben (siehe unten).

## Einbettung als iframe

Die Seite kann in eine andere Website eingebettet werden und nimmt dann Konfiguration von der einbettenden Seite entgegen. Damit fremde Seiten keine Nachrichten einschleusen können, muss die Herkunft (Origin) der einbettenden Seite beim Einbetten als URL-Parameter `allowedOrigin` angegeben werden; ohne diesen Parameter (oder mit anderem Absender) werden alle Nachrichten ignoriert.

Ablauf:

1. Einbettende Seite lädt `https://3dcut.github.io/warera-company-calc/?allowedOrigin=<eigener Origin>` im iframe.
2. Sobald die App bereit ist, schickt sie `{ type: "warera:ready" }` an das Elternfenster.
3. Das Elternfenster antwortet mit `{ type: "warera:config", apiKey?, user?, lang? }`. Alle drei Felder sind optional und Strings.

```html
<iframe id="warera"
        src="https://3dcut.github.io/warera-company-calc/?allowedOrigin=https://example.org"
        width="100%" height="900"></iframe>
<script>
  const frame  = document.getElementById("warera");
  const target = "https://3dcut.github.io";
  window.addEventListener("message", (e) => {
    if (e.origin !== target || !e.data || e.data.type !== "warera:ready") return;
    frame.contentWindow.postMessage(
      { type: "warera:config", user: "3Dsus_renatus", lang: "de" /*, apiKey: "wae_…" */ },
      target
    );
  });
</script>
```

## URL-Parameter

| Parameter | Bedeutung |
|---|---|
| `?user=<Name oder User-ID>` | Spieler beim Öffnen direkt laden (`username` und `id` werden als Aliase akzeptiert). |
| `?lang=de` / `en` / `sv` | Sprache. |
| `?allowedOrigin=<Origin>` | Nur für die iframe-Einbettung, siehe oben. |
| `?apikey=` | **Wird nicht mehr unterstützt.** Key im Formular eingeben oder per `postMessage` übergeben. |

Beispiel: `https://3dcut.github.io/warera-company-calc/?user=3Dsus_renatus&lang=de`

## Entwicklung

Voraussetzung: Node.js >= 22 (siehe `engines` in `package.json`).

```sh
npm ci            # Abhängigkeiten exakt nach package-lock.json installieren
npm run dev       # Dev-Server mit Hot Reload
npm run build     # Produktions-Build nach dist/
npm run preview   # den Build lokal ausliefern
npm run probe -- <Spielername|UserId> [--workers]   # API-Sonde, siehe unten
```

### API-Sonde (`scripts/api-probe.mjs`)

Kleines Kommandozeilen-Werkzeug ohne Abhängigkeiten, um schnell zu prüfen, was die WarEra-API für einen Spieler liefert (Level, Prestige, `companies`-Skill, alle Firmen mit Produkt, Region, Upgrade-Stufen und Deaktivierungsstatus). Mit `--workers` werden zusätzlich die Arbeiter jeder Firma gelistet; dafür muss der API-Key in der Umgebungsvariablen `WARERA_API_KEY` stehen. Der Key wird nie als Argument entgegengenommen und nie ausgegeben.

```sh
node scripts/api-probe.mjs 3Dsus_renatus
WARERA_API_KEY=wae_… node scripts/api-probe.mjs 3Dsus_renatus --workers
```

Zwischen den Aufrufen wartet die Sonde 300 ms; bei HTTP 429 wird nach 3 s einmal wiederholt.

### Projektstruktur

- `main.jsx` – App-Shell, Sprachauswahl
- `company-dashboard.jsx` – Laden der API-Daten, alle Gewinnberechnungen, die Tabs Übersicht/Optimierung/Profitabelste Produkte
- `factory-optimizer.jsx` – Tab Fabrikausbau (Dijkstra- und Greedy-Planer, Diagramm)
- `shared.jsx` – Theme, UI-Bausteine, `apiCall` mit 429-Retry
- `translations.jsx` – Texte in de/en/sv
- `config.json` – Referenz-Snapshot der Spielkonfiguration (`gameConfig.getGameConfig`, Stand Juni 2026). Die App importiert diese Datei nicht, sondern lädt die Konfiguration zur Laufzeit live.
- `scripts/api-probe.mjs` – API-Sonde
- `.github/workflows/deploy.yml` – Build (Node 22, `npm ci`) und Deployment von `dist/` nach GitHub Pages bei jedem Push auf `main`; `.github/dependabot.yml` hält npm-Pakete und Actions wöchentlich aktuell.

## Modellierte Spielmechanik

Die Zahlen stammen aus der live geladenen Spielkonfiguration (`gameConfig.getGameConfig`) und aus dem Spiel-Client; Stand September 2026.

**Production Points (PP)**

- Automated Engine: **24 PP pro Tag und Level** (Level 1–7, also maximal 168 PP/Tag), multipliziert mit dem Produktionsbonus der Fabrik.
- Arbeiter: **PP/h = Energie/100 · Produktion · (1 + Bonus) · (1 + Treue %)**. Energie und Produktion sind die Skill-Werte des Arbeiters (inklusive Prestige), die Treue (Fidelity) geht bis 10, also maximal +10 %.

**Produktionsbonus einer Fabrik**

Der Bonus setzt sich aus vier Teilen zusammen; jeder Teil gilt nur unter seiner Bedingung:

| Teil | Wert | Bedingung |
|---|---|---|
| Spezialisierung des Landes | `strategicResources.bonuses.productionPercent` des Landes | nur wenn `specializedItem` des Landes genau das Produkt der Fabrik ist |
| Ethik-Bonus Industrialismus | +10 % (Stufe 1) bzw. +30 % (Stufe 2) | ebenfalls nur auf das spezialisierte Produkt des Landes |
| Deposit (Vorkommen) in der Region | `region.deposit.bonusPercent`, variabel (z. B. 23 %, 29 %, 39 %) | nur wenn in der Region gerade ein aktives Deposit desselben Typs liegt |
| Ethik-Bonus Agrarismus (Industrialismus −1/−2) | +10 % bzw. +30 % | ebenfalls nur bei aktivem, passendem Deposit |

Ohne passende Spezialisierung bzw. ohne passendes Deposit gibt es also **keinen** Ethik-Bonus. Deposits sind zeitlich begrenzt (`startsAt`/`endsAt`), ihr Bonus kann während eines Planungszeitraums wegfallen.

**Anzahl Fabriken**

- Grundlimit **12** (Skill `companies` auf Level 10). Jede Prestige-Stufe im Skill `companies` erhöht das Limit um 1.
- Die Prestige-Stufe *r* (0-basiert) kostet **2^r Prestige-Punkte**: die 13. Fabrik 1 Punkt, die 14. weitere 2 (3 gesamt), die 15. weitere 4 (7 gesamt), die 16. weitere 8 (15 gesamt).
- Prestige ist ab Level 50 möglich, kostet 65 000 XP und bringt einen Prestige-Punkt.

**Kosten**

- Bau der *n*-ten Fabrik: **50 · n Beton** (`constructionCostIncreasePerCompany` = 50).
- Umzug 5 Beton, Produktwechsel 5 Beton, Abrisswert 80 % des investierten Betons.
- Engine-Upgrade auf Level 1–7 kostet laut Spielkonfiguration **0 / 20 / 40 / 80 / 160 / 320 / 640 Stahl** (und 0 / 20 / 40 / 80 / 160 / 320 / 680 Construction Points).
- Zum Vergleich: Storage Level 1–7 kostet 0 / 10 / 20 / 40 / 80 / 160 / 320 Stahl (200 PP Lager pro Level), Break Room Level 1–5 kostet 0 / 10 / 20 / 40 / 80 Stahl (2 Arbeiter pro Level).

## Grenzen

- **Marktpreise sind Momentaufnahmen.** Die App nimmt die Preise von `itemTrading.getPrices` zum Ladezeitpunkt; es gibt keine Preishistorie und kein Orderbuch. Tatsächliche Verkaufserlöse können abweichen.
- **Marktsättigung wird nicht modelliert.** Das Modell nimmt an, dass beliebige Mengen zum aktuellen Preis verkauft werden können.
- **Construction Points werden angezeigt, aber nicht simuliert.** Der Ausbauplaner rechnet mit Stahl, Beton und Gold; ob genug Construction Points beisammen sind, prüft er nicht.
- Deposits laufen ab und Ethiken/Spezialisierungen von Ländern ändern sich; ein Plan über viele Tage rechnet mit den Werten vom Ladezeitpunkt.

Eine Lizenz ist für dieses Projekt noch nicht festgelegt.

---

## English summary

A browser tool for the game WarEra that loads a player's companies from the public WarEra API and computes daily profit, optimisation hints (better regions, worker reassignment, product changes) and a build plan (Dijkstra/greedy) for new factories and engine upgrades. Live at https://3dcut.github.io/warera-company-calc/.

- Enter a player name; an API key is only needed for worker data (`worker.getWorkers` returns 401 without one). The key is sent only to `https://api2.warera.io` and, if you want, kept in your browser's `localStorage`. `?apikey=` in the URL is no longer supported.
- URL params: `?user=<name or id>`, `?lang=de|en|sv`, `?allowedOrigin=<origin>` (iframe only).
- Embedding: load the page with `?allowedOrigin=<your origin>`, wait for `{type:"warera:ready"}`, then post `{type:"warera:config", apiKey?, user?, lang?}` to the iframe. Without `allowedOrigin` messages are ignored.
- Development: Node >= 22, `npm ci`, `npm run dev`, `npm run build`, `npm run probe -- <name> [--workers]` (key via `WARERA_API_KEY`).
- Modelled mechanics: engine 24 PP/day per level; worker PP/h = energy/100 · production · (1 + bonus) · (1 + fidelity %); specialization and industrialism bonus only on the country's specialized item, deposit and agrarian bonus only on an active matching deposit; company cap 12 + prestige rungs (rung r costs 2^r points); n-th company costs 50 · n concrete; engine steel costs from the game config. Limits: market prices are snapshots, market saturation is not modelled, construction points are shown but not simulated.
- No license has been chosen yet.
