import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import CompanyDashboard from './company-dashboard.jsx'
import { THEMES, setThemeVars, glass, Tip, GlassCard } from './shared.jsx'

function Shell() {
  const [theme, setTheme] = useState("grau");

  setThemeVars(theme);
  const T = THEMES[theme];
  const C = T.C;
  const F = T.F;

  return (
    <div style={{
      background: T.bg,
      color: C.text, minHeight: "100vh", fontFamily: F.m, padding: "28px 24px", margin: "0 auto",
      transition: "background 0.5s",
    }}>
      {/* BG glow orbs */}
      <div style={{ position: "fixed", top: -200, right: -200, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb1 + " 0%, transparent 70%)", pointerEvents: "none", transition: "background 0.5s" }} />
      <div style={{ position: "fixed", bottom: -300, left: -200, width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb2 + " 0%, transparent 70%)", pointerEvents: "none", transition: "background 0.5s" }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.h, fontSize: 13, color: C.textMuted, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 6 }}>WarEra Produktions-Planungstool</div>
          <h1 style={{ fontFamily: F.h, fontSize: 32, fontWeight: 700, color: C.accent, margin: 0, letterSpacing: "0.04em", textShadow: "0 0 30px " + C.accentGlow, lineHeight: 1.2 }}>
            Firmen-Dashboard<br />
            <span style={{ fontSize: 18, fontWeight: 600, color: C.textDim, letterSpacing: "0.08em" }}>des Hebelministeriums Deutschland</span>
          </h1>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <Tip text={"Theme wechseln: " + (theme === "grau" ? "Pink" : "Grau")}>
            <button onClick={() => setTheme(t => t === "grau" ? "pink" : "grau")} style={{
              padding: "8px 18px", borderRadius: 20,
              border: "1px solid " + (theme === "pink" ? "rgba(255,107,157,0.5)" : "rgba(255,255,255,0.1)"),
              background: theme === "pink"
                ? "linear-gradient(135deg, rgba(255,107,157,0.2), rgba(200,130,255,0.15))"
                : "rgba(255,255,255,0.04)",
              color: theme === "pink" ? "#ff6b9d" : C.textDim,
              cursor: "pointer", fontSize: 13, fontFamily: F.h, fontWeight: 700,
              letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.3s",
              boxShadow: theme === "pink" ? "0 0 16px rgba(255,107,157,0.2)" : "0 2px 8px rgba(0,0,0,0.2)",
            }}>
              {theme === "pink" ? "\u2665 PINK" : "\u25C9 GRAU"}
            </button>
          </Tip>
        </div>
      </div>

      {/* Banner */}
      <GlassCard glow="rgba(248,113,113,0.3)" style={{ borderColor: C.red + "44", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24 }}>&#9888;</span>
          <div>
            <div style={{ fontFamily: F.h, fontSize: 15, fontWeight: 700, color: C.red, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Achtung
            </div>
            <div style={{ fontSize: 12, color: C.textDim }}>
              Die Profitberechnung hat momentan einen Fehler. Wird im laufe des tages behoben.
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Page Content */}
      <CompanyDashboard theme={theme} setTheme={setTheme} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
)
