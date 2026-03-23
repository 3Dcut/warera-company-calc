// ═══════════════════════════════════════════════════════
//   SHARED: Theme, Primitives, API, Formatters
// ═══════════════════════════════════════════════════════

const fl = document.createElement("link");
fl.rel = "stylesheet";
fl.href = "https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500;600;700&family=Quicksand:wght@400;500;600;700&display=swap";
document.head.appendChild(fl);

const styleEl = document.createElement("style");
styleEl.textContent = `
  @keyframes tipIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes copyFlash { 0% { box-shadow: 0 0 0 rgba(52,211,153,0); } 50% { box-shadow: 0 0 24px rgba(52,211,153,0.5); } 100% { box-shadow: 0 0 0 rgba(52,211,153,0); } }
  * { box-sizing: border-box; }
  body, html { margin: 0; padding: 0; overflow-x: hidden; }
  .tip-wrap { position: relative; display: inline-flex; }
  .tip-wrap .tip-box {
    display: none; position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    padding: 8px 12px; border-radius: 6px; font-size: 13px; line-height: 1.4; white-space: nowrap; z-index: 100; pointer-events: none;
    background: rgba(15,20,35,0.92); border: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: #d4d4cc;
    font-family: 'Source Code Pro', monospace; animation: tipIn 0.15s ease-out;
  }
  .tip-wrap .tip-box::after {
    content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: rgba(255,255,255,0.12);
  }
  .tip-wrap:hover .tip-box { display: block; }
  .copy-flash { animation: copyFlash 0.6s ease-out; }
`;
document.head.appendChild(styleEl);

export const THEMES = {
  grau: {
    F: { h: "'Rajdhani', sans-serif", m: "'Source Code Pro', monospace" },
    bg: "linear-gradient(135deg, #0a0e1a 0%, #111827 40%, #0f172a 100%)",
    orb1: "rgba(240,180,41,0.04)", orb2: "rgba(96,165,250,0.03)",
    C: {
      accent: "#f0b429", accentGlow: "rgba(240,180,41,0.25)",
      green: "#34d399", greenGlow: "rgba(52,211,153,0.2)",
      red: "#f87171",
      blue: "#60a5fa", blueGlow: "rgba(96,165,250,0.2)",
      purple: "#a78bfa",
      stahl: "#f0a060", betonC: "#90b0a0",
      text: "#f0f0ec", textDim: "#a0a8b4", textMuted: "#556070",
      inputBg: "rgba(0,0,0,0.3)", inputBorder: "rgba(255,255,255,0.1)",
      rowAlt: "rgba(255,255,255,0.02)",
    },
  },
  pink: {
    F: { h: "'Quicksand', sans-serif", m: "'Source Code Pro', monospace" },
    bg: "linear-gradient(135deg, #1f001f 0%, #300040 40%, #1a001a 100%)",
    orb1: "rgba(255,0,255,0.1)", orb2: "rgba(0,255,255,0.06)",
    C: {
      accent: "#ff00ff", accentGlow: "rgba(255,0,255,0.5)",
      green: "#00ffcc", greenGlow: "rgba(0,255,204,0.4)",
      red: "#ff3366",
      blue: "#00ccff", blueGlow: "rgba(0,204,255,0.4)",
      purple: "#cc66ff",
      stahl: "#ff9966", betonC: "#66ffcc",
      text: "#ffffff", textDim: "#ffccff", textMuted: "#996699",
      inputBg: "rgba(255,0,255,0.05)", inputBorder: "rgba(255,0,255,0.3)",
      rowAlt: "rgba(255,0,255,0.04)",
    },
  },
};

// Mutable theme vars - set by consumers via setThemeVars()
export let C = THEMES.grau.C;
export let F = THEMES.grau.F;

export function setThemeVars(theme) {
  const T = THEMES[theme] || THEMES.grau;
  C = T.C;
  F = T.F;
}

export const glass = (opacity = 0.06, blur = 16) => ({
  background: `rgba(255,255,255,${opacity})`,
  backdropFilter: `blur(${blur}px)`,
  WebkitBackdropFilter: `blur(${blur}px)`,
  border: "1px solid rgba(255,255,255,0.1)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)",
});

// ── Formatters ──
export function fmt(n, d = 1) {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: d }).format(n);
}
export function fmtT(h) { if (h <= 0) return "sofort"; if (h < 1) return fmt(h*60, 0) + "m"; if (h < 24) return fmt(h, 1) + "h"; const d = h / 24; return d < 365 ? fmt(d, 1) + "d" : fmt(d/365, 1) + "y"; }
export function fmtN(n) { if (Math.abs(n) >= 1e6) return fmt(n/1e6, 1) + "M"; if (Math.abs(n) >= 1e3) return fmt(n/1e3, 1) + "k"; return fmt(n, 1); }

// ── Styled Primitives ──
export function GlassCard({ children, style, glow }) {
  return <div style={{ ...glass(0.05, 20), borderRadius: 12, padding: "16px 20px", marginBottom: 14, ...(glow ? { boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 24px " + glow } : {}), ...style }}>{children}</div>;
}
export function Sec({ children, icon }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
    {icon && <span style={{ fontSize: 20 }}>{icon}</span>}
    <span style={{ fontFamily: F.h, fontSize: 17, fontWeight: 700, color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>{children}</span>
  </div>;
}
export function Inp({ label, value, onChange, step = 1, suffix, tip }) {
  const inner = <div style={{ marginBottom: 12 }}>
    <label style={{ fontFamily: F.m, fontSize: 14, color: C.textDim, marginBottom: 5, display: "block", letterSpacing: "0.03em" }}>{label} {tip && <span style={{ color: C.textMuted, cursor: "help" }}>&#9432;</span>}</label>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="number" step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text,
          padding: "9px 12px", fontSize: 15, width: "100%", boxSizing: "border-box", outline: "none",
          fontFamily: F.m, transition: "border-color 0.2s, box-shadow 0.2s" }}
        onFocus={e => { e.target.style.borderColor = C.accent + "88"; e.target.style.boxShadow = "0 0 12px " + C.accentGlow; }}
        onBlur={e => { e.target.style.borderColor = C.inputBorder; e.target.style.boxShadow = "none"; }} />
      {suffix && <span style={{ fontFamily: F.m, fontSize: 14, color: C.textMuted, whiteSpace: "nowrap" }}>{suffix}</span>}
    </div>
  </div>;
  return tip ? <Tip text={tip}>{inner}</Tip> : inner;
}
export function Bdg({ color, children }) {
  return <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 4, fontSize: 13, fontWeight: 700, fontFamily: F.h, background: color + "25", color, border: "1px solid " + color + "44", letterSpacing: "0.06em", textTransform: "uppercase", textShadow: "0 0 8px " + color + "44" }}>{children}</span>;
}
export function Tip({ text, children, pos = "top" }) {
  if (!text) return children;
  return <span className="tip-wrap">{children}<span className="tip-box" style={pos === "bottom" ? { bottom: "auto", top: "calc(100% + 8px)" } : {}}>{text}</span></span>;
}
export function Btn({ on, color, children, onClick, big, disabled }) {
  const c = color || C.accent;
  return <button onClick={onClick} disabled={disabled} style={{
    padding: big ? "14px 32px" : "8px 18px", borderRadius: 8, border: "1px solid " + (on ? c + "88" : "rgba(255,255,255,0.08)"),
    background: on ? c + "18" : "rgba(255,255,255,0.03)", color: disabled ? C.textMuted : on ? c : C.textDim,
    cursor: disabled ? "not-allowed" : "pointer", fontSize: big ? 18 : 14, fontFamily: F.h, fontWeight: 700,
    letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.2s", opacity: disabled ? 0.4 : 1,
    boxShadow: on ? "0 0 16px " + c + "22, inset 0 1px 0 rgba(255,255,255,0.06)" : "0 2px 8px rgba(0,0,0,0.2)",
    textShadow: on ? "0 0 10px " + c + "44" : "none",
  }}>{children}</button>;
}
export const getTH = () => ({ textAlign: "left", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", color: C.textDim, fontSize: 13, fontFamily: F.h, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 });
export const getTD = (hl) => ({ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: hl ? C.accent : C.text, fontSize: 15, fontFamily: F.m });

// ── API ──
const API_BASE = "https://api2.warera.io/trpc/";

export async function apiCall(endpoint, body, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    const headers = { "Content-Type": "application/json" };
    try {
      const apiKey = localStorage.getItem("warera_api_key");
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
        headers["x-api-key"] = apiKey.trim();
      }
    } catch {}

    const r = await fetch(API_BASE + endpoint, {
      method: "POST", headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (r.status === 429 && attempt < maxRetries) {
        attempt++;
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        window.dispatchEvent(new CustomEvent('warera-rate-limit', { detail: { delay, attempt, endpoint } }));
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      let d;
      try { d = await r.json(); } catch (e) { throw new Error(`HTTP Error ${r.status}`); }
      if (Array.isArray(d)) d = d[0];
      if (d && d.error) throw new Error(d.error.data?.code || d.error.message || `API Error HTTP ${r.status}`);
      throw new Error(`API Error HTTP ${r.status}`);
    }
    let d;
    try { d = await r.json(); } catch (e) { throw new Error("Invalid JSON response"); }
    if (Array.isArray(d)) d = d[0];
    if (d && d.error) throw new Error(d.error.data?.code || d.error.message || "API Error");
    return d?.result?.data;
  }
}
