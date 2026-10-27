// Aion2DpsMeter : meter transparent hors combat.
// Quelques secondes après le dernier coup, le meter s'efface jusqu'à l'opacité choisie ;
// il revient dès que le combat reprend, au survol de la souris, ou quand un panneau est ouvert.
(() => {
  // Seule la fenêtre du meter s'efface ; la fenêtre des réglages sert juste à les régler.
  const isMeterWindow = () => (window.A2_VIEW === undefined || window.A2_VIEW === "main")
    && !document.documentElement.classList.contains("detailsWindow");
  const K = { on: "a2d.fade.on", op: "a2d.fade.opacity", delay: "a2d.fade.delay" };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const cfg = () => ({ on: get(K.on, "1") === "1", op: num(get(K.op, 25), 25, 0, 50), delay: num(get(K.delay, 5), 5, 2, 30) });
  const PANELS = ".meter.a2dEventsOpen, .settingsPanel.isOpen, .detailsPanel.open, .historyPanel.open";
  let hover = false;

  const tick = () => {
    const meter = document.querySelector(".meter");
    if (!meter || !isMeterWindow()) return;
    const c = cfg();
    const app = window.dpsApp;
    const frozen = app?.battleTime?.getFrozenMs?.(app.nowMs ? app.nowMs() : performance.now()) ?? 0;
    const faded = c.on && !hover && frozen >= c.delay * 1000 && !document.querySelector(PANELS);
    document.documentElement.style.setProperty("--a2d-fade-opacity", String(c.op / 100));
    meter.classList.toggle("a2dFaded", faded);
  };

  document.documentElement.addEventListener("mouseenter", () => { hover = true; tick(); });
  document.documentElement.addEventListener("mouseleave", () => { hover = false; });
  document.addEventListener("mousemove", () => { if (!hover) { hover = true; tick(); } }, { passive: true });
  window.addEventListener("blur", () => { hover = false; });

  // Réglages (Apparence › Opacité).
  const bind = () => {
    const c = cfg();
    const on = document.querySelector(".a2dFadeCheckbox");
    const op = document.querySelector(".a2dFadeOpacityInput"), opV = document.querySelector(".a2dFadeOpacityValue");
    const de = document.querySelector(".a2dFadeDelayInput"), deV = document.querySelector(".a2dFadeDelayValue");
    const rows = document.querySelectorAll(".a2dFadeSub");
    const show = () => rows.forEach((r) => { r.style.display = on?.checked ? "" : "none"; });
    if (on) { on.checked = c.on; on.addEventListener("change", () => { set(K.on, on.checked ? "1" : "0"); show(); tick(); }); }
    if (op) { op.value = c.op; opV.textContent = `${c.op}%`; op.addEventListener("input", () => { set(K.op, op.value); opV.textContent = `${op.value}%`; tick(); }); }
    if (de) { de.value = c.delay; deV.textContent = `${c.delay} s`; de.addEventListener("input", () => { set(K.delay, de.value); deV.textContent = `${de.value} s`; tick(); }); }
    show();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
  setInterval(tick, 250);
})();
