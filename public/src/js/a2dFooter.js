// Aion2DpsMeter : le bas du meter moins chargé. Les petites infos (joueurs
// autour, Points Abyssaux, énergie d'Odyle, vol) passent sur une ligne fine
// au-dessus du bas, qui ne garde que le minuteur, le total du groupe et les
// boutons. La ligne disparaît quand elle n'a rien à montrer ; un clic dessus
// ouvre le même menu que le minuteur (choisir ce qui s'affiche).
(() => {
  if (window.A2_VIEW && window.A2_VIEW !== "main") return;
  let strip = null;

  function make() {
    if (strip?.isConnected) return strip;
    const footer = document.querySelector(".meter .meterFooter");
    if (!footer) return null;
    strip = document.createElement("div");
    strip.className = "a2dFootStrip";
    strip.hidden = true;
    strip.setAttribute("data-no-drag", "true");
    footer.insertAdjacentElement("beforebegin", strip);
    strip.addEventListener("click", (e) => {
      if (e.target.closest(".a2dAbyss")) return; // son clic remet le compteur à zéro
      const app = window.dpsApp;
      app?.setFooterMenuOpen?.(!app.footerMenuOpen);
    });
    return strip;
  }

  // Odyle et vol : déplacés une fois (leurs styles ne dépendent pas du bas).
  function adopt() {
    const s = make();
    if (!s) return;
    for (const sel of [".meter .meterFooter .odyleDisplay", ".meter .meterFooter .fpTimer"]) {
      const el = document.querySelector(sel);
      if (el) s.appendChild(el);
    }
  }

  function sync() {
    const s = make();
    if (!s) return;
    adopt();
    const any = [...s.children].some((c) => !c.hidden && getComputedStyle(c).display !== "none" && c.textContent.trim());
    if (s.hidden === any) {
      s.hidden = !any;
      requestAnimationFrame(() => window.javaBridge?.updateOverlaySize?.());
    }
  }

  window.A2dFooter = { strip: make };
  const start = () => { sync(); new MutationObserver(sync).observe(make() || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] }); setInterval(sync, 1000); };
  window.addEventListener("a2d:footer", () => setTimeout(sync, 50));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(start, 200));
  else setTimeout(start, 200);
})();
