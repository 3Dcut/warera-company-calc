// ═══════════════════════════════════════════════════════
//   SHARED: Theme, Primitives, API, Formatters
// ═══════════════════════════════════════════════════════
import { useState, useEffect, useLayoutEffect, useRef, useId, isValidElement, cloneElement } from "react";

const fl = document.createElement("link");
fl.rel = "stylesheet";
fl.href = "https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500;600;700&family=Quicksand:wght@400;500;600;700&display=swap";
document.head.appendChild(fl);

const styleEl = document.createElement("style");
styleEl.textContent = `
  @keyframes tipIn { from { opacity: 0; translate: 0 4px; } to { opacity: 1; translate: 0 0; } }
  @keyframes copyFlash { 0% { box-shadow: 0 0 0 rgba(52,211,153,0); } 50% { box-shadow: 0 0 24px rgba(52,211,153,0.5); } 100% { box-shadow: 0 0 0 rgba(52,211,153,0); } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--page-bg, #0f172a); color-scheme: dark; }
  .tip-wrap { position: relative; display: inline-flex; }
  .tip-wrap.tip-block { display: flex; width: 100%; }
  .tip-wrap.tip-block > * { flex: 1 1 auto; min-width: 0; }
  .tip-wrap .tip-box {
    display: none; position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    padding: 8px 12px; border-radius: 6px; font-size: 13px; line-height: 1.4; z-index: 100; pointer-events: none;
    width: max-content; max-width: min(320px, calc(100vw - 32px)); white-space: normal; overflow-wrap: anywhere;
    background: rgba(15,20,35,0.95); border: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: #e4e4dc;
    font-family: 'Source Code Pro', monospace; font-weight: 400; letter-spacing: 0; text-transform: none; text-align: left;
    animation: tipIn 0.15s ease-out;
  }
  .tip-wrap .tip-box::after {
    content: ''; position: absolute; top: 100%; left: var(--tip-arrow, 50%); transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: rgba(255,255,255,0.12);
  }
  .tip-wrap .tip-box.tip-below { bottom: auto; top: calc(100% + 8px); }
  .tip-wrap .tip-box.tip-below::after { top: auto; bottom: 100%; border-top-color: transparent; border-bottom-color: rgba(255,255,255,0.12); }
  .tip-wrap.tip-open .tip-box { display: block; }
  .copy-flash { animation: copyFlash 0.6s ease-out; }
  button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible, summary:focus-visible {
    outline: 2px solid var(--accent, #f0b429) !important; outline-offset: 2px !important;
  }
  .hscroll { display: flex; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .hscroll::-webkit-scrollbar { display: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;
document.head.appendChild(styleEl);

export const THEMES = {
  grau: {
    F: { h: "'Rajdhani', sans-serif", m: "'Source Code Pro', monospace" },
    bg: "linear-gradient(135deg, #0a0e1a 0%, #111827 40%, #0f172a 100%)", pageBg: "#0f172a",
    orb1: "rgba(240,180,41,0.04)", orb2: "rgba(96,165,250,0.03)",
    C: {
      accent: "#f0b429", accentGlow: "rgba(240,180,41,0.25)",
      green: "#34d399", greenGlow: "rgba(52,211,153,0.2)",
      red: "#f87171",
      blue: "#60a5fa", blueGlow: "rgba(96,165,250,0.2)",
      purple: "#a78bfa",
      stahl: "#f0a060", betonC: "#90b0a0",
      text: "#f0f0ec", textDim: "#a0a8b4", textMuted: "#8792a3",
      inputBg: "rgba(0,0,0,0.3)", inputBorder: "rgba(255,255,255,0.1)",
      rowAlt: "rgba(255,255,255,0.02)",
    },
  },
  pink: {
    F: { h: "'Quicksand', sans-serif", m: "'Source Code Pro', monospace" },
    bg: "linear-gradient(135deg, #1f001f 0%, #300040 40%, #1a001a 100%)", pageBg: "#1f001f",
    orb1: "rgba(255,0,255,0.1)", orb2: "rgba(0,255,255,0.06)",
    C: {
      accent: "#ff00ff", accentGlow: "rgba(255,0,255,0.5)",
      green: "#00ffcc", greenGlow: "rgba(0,255,204,0.4)",
      red: "#ff3366",
      blue: "#00ccff", blueGlow: "rgba(0,204,255,0.4)",
      purple: "#cc66ff",
      stahl: "#ff9966", betonC: "#66ffcc",
      text: "#ffffff", textDim: "#ffccff", textMuted: "#c08ac0",
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
  try {
    const root = document.documentElement.style;
    root.setProperty("--accent", T.C.accent);
    root.setProperty("--page-bg", T.pageBg);
  } catch {}
}

export const glass = (opacity = 0.06, blur = 16) => ({
  background: `rgba(255,255,255,${opacity})`,
  backdropFilter: `blur(${blur}px)`,
  WebkitBackdropFilter: `blur(${blur}px)`,
  border: "1px solid rgba(255,255,255,0.1)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)",
});

// ── Locale (set by the shell via setLocale(lang), like setThemeVars) ──
const LOCALES = { de: "de-DE", en: "en-GB", sv: "sv-SE" };
const NOW_LABEL = { de: "sofort", en: "now", sv: "nu" };
let LANG = "de";
export function setLocale(lang) { LANG = LOCALES[lang] ? lang : "de"; }
export function getLocale() { return LOCALES[LANG]; }

// ── Formatters ──
const nfCache = new Map();
export function fmt(n, d = 1) {
  const key = LANG + "|" + d;
  let f = nfCache.get(key);
  if (!f) { f = new Intl.NumberFormat(LOCALES[LANG], { minimumFractionDigits: 0, maximumFractionDigits: d }); nfCache.set(key, f); }
  return f.format(n);
}
export function fmtT(h) { if (h <= 0) return NOW_LABEL[LANG]; if (h < 1) return fmt(h*60, 0) + "m"; if (h < 24) return fmt(h, 1) + "h"; const d = h / 24; return d < 365 ? fmt(d, 1) + "d" : fmt(d/365, 1) + "y"; }
export function fmtN(n) { if (Math.abs(n) >= 1e6) return fmt(n/1e6, 1) + "M"; if (Math.abs(n) >= 1e3) return fmt(n/1e3, 1) + "k"; return fmt(n, 1); }
export function fmtClock(date) {
  try { return new Intl.DateTimeFormat(LOCALES[LANG], { hour: "2-digit", minute: "2-digit" }).format(date); } catch { return ""; }
}

// ── Hooks ──
export function useMediaQuery(query) {
  const get = () => { try { return window.matchMedia(query).matches; } catch { return false; } };
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia(query); } catch { return; }
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener ? mq.addEventListener("change", onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", onChange) : mq.removeListener(onChange); };
  }, [query]);
  return matches;
}
// Phone layout breakpoint (cards instead of wide tables etc.)
export const useIsMobile = () => useMediaQuery("(max-width: 700px)");

// Sortable tables: const sort = useSort("profit"); rows = sort.apply(rows, { profit: r => r.profit, name: r => r.name })
export function useSort(initialKey = null, initialDir = "desc") {
  const [state, setState] = useState({ key: initialKey, dir: initialDir });
  const toggle = key => setState(s => s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  const apply = (rows, getters) => {
    const g = state.key && getters[state.key];
    if (!g) return rows;
    const m = state.dir === "asc" ? 1 : -1;
    return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
      const va = g(a), vb = g(b);
      let c;
      if (va == null && vb == null) c = 0;
      else if (va == null) return 1;   // empty values always last
      else if (vb == null) return -1;
      else if (typeof va === "string" || typeof vb === "string") c = String(va).localeCompare(String(vb), getLocale());
      else c = va - vb;
      return c !== 0 ? m * c : ia - ib;
    }).map(([r]) => r);
  };
  return { key: state.key, dir: state.dir, toggle, apply };
}
export function SortTh({ label, k, sort, style, tip }) {
  const active = sort.key === k;
  const btn = <button type="button" onClick={() => sort.toggle(k)} style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, borderRadius: 3 }}>
    <span>{label}</span>
    <span aria-hidden="true" style={{ opacity: active ? 1 : 0.35, fontSize: "0.8em" }}>{active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
  </button>;
  return <th style={style} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
    {tip ? <Tip text={tip}>{btn}</Tip> : btn}
  </th>;
}

// ── Styled Primitives ──
export function GlassCard({ children, style, glow }) {
  return <div style={{ ...glass(0.05, 20), borderRadius: 12, padding: "16px 20px", marginBottom: 14, ...(glow ? { boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 24px " + glow } : {}), ...style }}>{children}</div>;
}
export function Sec({ children, icon }) {
  return <div role="heading" aria-level={2} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
    {icon && <span aria-hidden="true" style={{ fontSize: 20 }}>{icon}</span>}
    <span style={{ fontFamily: F.h, fontSize: 17, fontWeight: 700, color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>{children}</span>
  </div>;
}
// KPI tile for headline numbers; place several in a grid, e.g. gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))"
export function Kpi({ label, value, color, sub }) {
  return <div style={{ ...glass(0.05, 16), borderRadius: 12, padding: "14px 16px", minWidth: 0 }}>
    <div style={{ fontFamily: F.h, fontSize: 12, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>{label}</div>
    <div style={{ fontFamily: F.h, fontSize: 26, fontWeight: 700, color: color || C.text, lineHeight: 1.2, marginTop: 4, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{sub}</div>}
  </div>;
}
export function Inp({ label, value, onChange, step = 1, suffix, tip, min }) {
  const id = useId();
  const inner = <div style={{ marginBottom: 12 }}>
    <label htmlFor={id} style={{ fontFamily: F.m, fontSize: 14, color: C.textDim, marginBottom: 5, display: "block", letterSpacing: "0.03em" }}>{label} {tip && <span aria-hidden="true" style={{ color: C.textMuted, cursor: "help" }}>&#9432;</span>}</label>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input id={id} type="number" inputMode="decimal" step={step} min={min} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ background: C.inputBg, border: "1px solid " + C.inputBorder, borderRadius: 6, color: C.text,
          padding: "9px 12px", fontSize: 15, width: "100%", minWidth: 0, boxSizing: "border-box", outline: "none",
          fontFamily: F.m, transition: "border-color 0.2s, box-shadow 0.2s" }}
        onFocus={e => { e.target.style.borderColor = C.accent + "88"; e.target.style.boxShadow = "0 0 12px " + C.accentGlow; }}
        onBlur={e => { e.target.style.borderColor = C.inputBorder; e.target.style.boxShadow = "none"; }} />
      {suffix && <span style={{ fontFamily: F.m, fontSize: 14, color: C.textMuted, whiteSpace: "nowrap" }}>{suffix}</span>}
    </div>
  </div>;
  return tip ? <Tip text={tip} block>{inner}</Tip> : inner;
}
export function Bdg({ color, children }) {
  return <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 4, fontSize: 13, fontWeight: 700, fontFamily: F.h, background: color + "25", color, border: "1px solid " + color + "44", letterSpacing: "0.06em", textTransform: "uppercase", textShadow: "0 0 8px " + color + "44", whiteSpace: "nowrap" }}>{children}</span>;
}
// Tooltip: opens on hover, keyboard focus and tap (auto-hides after a moment on touch),
// stays inside the viewport and is linked to its trigger via aria-describedby.
// `block` makes the wrapper span the full width (use it around inputs and block content).
export function Tip({ text, children, pos = "top", block }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ shift: 0, below: pos === "bottom" });
  const boxRef = useRef(null);
  const timer = useRef(null);

  useLayoutEffect(() => {
    if (!open || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let shift = 0;
    if (r.left < 8) shift = 8 - r.left;
    else if (r.right > vw - 8) shift = vw - 8 - r.right;
    const below = pos === "bottom" || r.top < 8;
    setPlace({ shift, below });
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!text) return children;
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { clearTimeout(timer.current); setOpen(false); setPlace({ shift: 0, below: pos === "bottom" }); };
  const onTouch = () => { show(); timer.current = setTimeout(hide, 2500); };
  const child = isValidElement(children) ? cloneElement(children, { "aria-describedby": id }) : children;

  return <span className={"tip-wrap" + (block ? " tip-block" : "") + (open ? " tip-open" : "")}
    onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onTouchStart={onTouch}
    onKeyDown={e => { if (e.key === "Escape") hide(); }}>
    {child}
    <span ref={boxRef} id={id} role="tooltip" className={"tip-box" + (place.below ? " tip-below" : "")}
      style={place.shift ? { transform: `translateX(calc(-50% + ${place.shift}px))`, "--tip-arrow": `calc(50% - ${place.shift}px)` } : undefined}>{text}</span>
  </span>;
}
export function Btn({ on, color, children, onClick, big, disabled, style, ...rest }) {
  const c = color || C.accent;
  return <button type="button" onClick={onClick} disabled={disabled} {...rest} style={{
    padding: big ? "14px 32px" : "8px 18px", borderRadius: 8, border: "1px solid " + (on ? c + "88" : "rgba(255,255,255,0.08)"),
    background: on ? c + "18" : "rgba(255,255,255,0.03)", color: disabled ? C.textMuted : on ? c : C.textDim,
    cursor: disabled ? "not-allowed" : "pointer", fontSize: big ? 18 : 14, fontFamily: F.h, fontWeight: 700,
    letterSpacing: "0.08em", textTransform: "uppercase", transition: "all 0.2s", opacity: disabled ? 0.55 : 1,
    boxShadow: on ? "0 0 16px " + c + "22, inset 0 1px 0 rgba(255,255,255,0.06)" : "0 2px 8px rgba(0,0,0,0.2)",
    textShadow: on ? "0 0 10px " + c + "44" : "none", whiteSpace: "nowrap", ...style,
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
