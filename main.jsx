import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import CompanyDashboard from './company-dashboard.jsx'
import { THEMES, setThemeVars, setLocale, Tip } from './shared.jsx'
import { getLang } from './translations.jsx'

const LANGS = [
  { code: "de", label: "DE", flag: "🇩🇪", name: "Deutsch" },
  { code: "en", label: "EN", flag: "🇬🇧", name: "English" },
  { code: "sv", label: "SV", flag: "🇸🇪", name: "Svenska" },
];

const VALID_LANGS = LANGS.map(l => l.code);

function getInitialLang() {
  try {
    const urlLang = new URLSearchParams(window.location.search).get("lang");
    if (urlLang && VALID_LANGS.includes(urlLang)) return urlLang;
  } catch {}
  try {
    const stored = localStorage.getItem("warera_lang");
    if (stored && VALID_LANGS.includes(stored)) return stored;
  } catch {}
  return "de";
}

function getInitialTheme() {
  try {
    const stored = localStorage.getItem("warera_theme");
    if (stored && THEMES[stored]) return stored;
  } catch {}
  return "grau";
}

function Shell() {
  const [theme, setTheme] = useState(getInitialTheme);
  const [lang, setLang] = useState(getInitialLang);

  setThemeVars(theme);
  setLocale(lang);
  const T = THEMES[theme];
  const C = T.C;
  const F = T.F;
  const L = getLang(lang);

  useEffect(() => {
    try { localStorage.setItem("warera_theme", theme); } catch {}
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = L.appTitle + " · WarEra";
  }, [lang]);

  function switchLang(code) {
    setLang(code);
    try { localStorage.setItem("warera_lang", code); } catch {}
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("lang", code);
      window.history.replaceState({}, "", url);
    } catch {}
  }

  const otherTheme = theme === "grau" ? "pink" : "grau";
  const themeLabel = t => t === "pink" ? L.themePink : L.themeGrau;

  return (
    <div style={{
      background: T.bg,
      color: C.text, minHeight: "100vh", fontFamily: F.m, padding: "clamp(16px, 3vw, 28px) clamp(16px, 3vw, 24px)",
      transition: "background 0.5s",
    }}>
      {/* BG glow orbs (clipped so they never widen the page) */}
      <div aria-hidden="true" style={{ position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}>
        <div style={{ position: "absolute", top: -200, right: -200, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb1 + " 0%, transparent 70%)", transition: "background 0.5s" }} />
        <div style={{ position: "absolute", bottom: -300, left: -200, width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, " + T.orb2 + " 0%, transparent 70%)", transition: "background 0.5s" }} />
      </div>

      <div style={{ position: "relative", zIndex: 1, maxWidth: 1680, margin: "0 auto" }}>
        {/* Header */}
        <header style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "12px 16px", marginBottom: 20, paddingBottom: 20, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <div style={{ fontFamily: F.h, fontSize: 13, color: C.textMuted, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 6 }}>{L.appSubtitle}</div>
            <h1 style={{ fontFamily: F.h, fontSize: "clamp(24px, 6vw, 32px)", fontWeight: 700, color: C.accent, margin: 0, letterSpacing: "0.04em", textShadow: "0 0 30px " + C.accentGlow, lineHeight: 1.2 }}>
              {L.appTitle}<br />
              <span style={{ fontSize: "clamp(14px, 3.6vw, 18px)", fontWeight: 600, color: C.textDim, letterSpacing: "0.08em" }}>{L.appByline}</span>
            </h1>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            {/* Language switcher */}
            <div role="group" aria-label="Language" style={{ display: "flex", gap: 4 }}>
              {LANGS.map(l => (
                <button key={l.code} type="button" lang={l.code} title={l.name} aria-pressed={lang === l.code} onClick={() => switchLang(l.code)} style={{
                  padding: "6px 10px", borderRadius: 16,
                  border: "1px solid " + (lang === l.code ? C.accent + "88" : "rgba(255,255,255,0.1)"),
                  background: lang === l.code ? C.accent + "22" : "rgba(255,255,255,0.03)",
                  color: lang === l.code ? C.accent : C.textDim,
                  cursor: "pointer", fontSize: 12, fontFamily: F.h, fontWeight: 700,
                  letterSpacing: "0.06em", transition: "all 0.2s", whiteSpace: "nowrap",
                }}>
                  <span aria-hidden="true">{l.flag}</span> {l.label}
                </button>
              ))}
            </div>
            <Tip text={L.themeSwitchTo(themeLabel(otherTheme))} pos="bottom">
              <button type="button" aria-label={L.themeSwitchTo(themeLabel(otherTheme))} onClick={() => setTheme(otherTheme)} style={{
                padding: "6px 16px", borderRadius: 20,
                border: "1px solid " + (theme === "pink" ? "rgba(255,107,157,0.5)" : "rgba(255,255,255,0.1)"),
                background: theme === "pink"
                  ? "linear-gradient(135deg, rgba(255,107,157,0.2), rgba(200,130,255,0.15))"
                  : "rgba(255,255,255,0.04)",
                color: theme === "pink" ? "#ff6b9d" : C.textDim,
                cursor: "pointer", fontSize: 13, fontFamily: F.h, fontWeight: 700,
                letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.3s", whiteSpace: "nowrap",
                boxShadow: theme === "pink" ? "0 0 16px rgba(255,107,157,0.2)" : "0 2px 8px rgba(0,0,0,0.2)",
              }}>
                <span aria-hidden="true">{theme === "pink" ? "♥" : "◉"}</span> {themeLabel(theme)}
              </button>
            </Tip>
          </div>
        </header>

        {/* Page Content */}
        <main>
          <CompanyDashboard theme={theme} setTheme={setTheme} lang={lang} setLang={switchLang} />
        </main>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
)
