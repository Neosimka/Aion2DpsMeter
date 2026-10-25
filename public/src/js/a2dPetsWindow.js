// Aion2DpsMeter : la fenêtre détachée du radar à familiers (a2d-pets.html).
(() => {
  const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);
  const list = document.querySelector(".a2dEvList");
  let last = "";
  function render() {
    const html = window.A2dPets?.render?.() ?? "";
    if (html !== last) {
      const top = list.scrollTop;
      list.innerHTML = html;
      list.scrollTop = top;
      last = html;
    }
  }
  list.addEventListener("click", (e) => {
    const bell = e.target.closest("[data-pet]");
    if (bell) { window.A2dPets.toggle(bell.dataset.pet); last = ""; render(); return; }
    const pv = e.target.closest("[data-pet-view]");
    if (pv) { window.A2dPets.setView(pv.dataset.petView); last = ""; render(); return; }
    const pc = e.target.closest("[data-pet-capture]");
    if (pc) window.A2dPets.captureAction(pc.dataset.petCapture).then(() => window.A2dPets.poll()).then(render);
  });
  document.querySelector(".a2dPetWinClose")?.addEventListener("click", () => {
    invoke("close_tool_window").catch(() => window.close());
  });
  // Déplacement : WebView2 suit la zone « drag » ; ailleurs, on la demande.
  document.querySelector(".a2dPetWinHead")?.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button") || !/Linux/i.test(navigator.userAgent)) return;
    invoke("start_tool_drag").catch(() => {});
  });
  setInterval(render, 1000);
  render();
})();
