// Aion2DpsMeter : joueurs autour de toi, alliés et ennemis, en bas du meter.
// Les chiffres viennent du réseau (a2d_nearby.rs) : les joueurs que le jeu
// t'envoie autour de toi, toi exclu.
(() => {
  if (window.A2_VIEW && window.A2_VIEW !== "main") return;
  let el = null;
  function node() {
    if (el?.isConnected) return el;
    const anchor = document.querySelector(".meterFooter .odyleDisplay");
    if (!anchor) return null;
    el = document.createElement("div");
    el.className = "a2dNearby";
    el.hidden = true;
    anchor.insertAdjacentElement("afterend", el);
    return el;
  }
  async function tick() {
    const invoke = window.__TAURI__?.core?.invoke;
    const e = node();
    if (!invoke || !e) return;
    let n;
    try { n = await invoke("a2d_nearby_players"); } catch { return; }
    if (!n) { e.hidden = true; return; }
    const allies = (n.allies || 0) + (n.factionKnown ? 0 : n.unknown || 0);
    const enemies = n.enemies || 0;
    const unknown = n.factionKnown ? n.unknown || 0 : 0;
    if (!allies && !enemies && !unknown) { e.hidden = true; return; }
    const html = `<span class="a2dNbAllies">👥 ${allies + unknown}</span>${enemies ? `<span class="a2dNbEnemies">⚔ ${enemies}</span>` : ""}`;
    if (e.innerHTML !== html) e.innerHTML = html;
    e.title = n.factionKnown
      ? `${allies} allié${allies > 1 ? "s" : ""} et ${enemies} ennemi${enemies > 1 ? "s" : ""} autour de toi` +
        (unknown ? `\n${unknown} joueur${unknown > 1 ? "s" : ""} de faction inconnue (comptés avec les alliés)` : "")
      : `${allies} joueur${allies > 1 ? "s" : ""} autour de toi (ta faction n'est pas encore connue)`;
    e.hidden = false;
  }
  setInterval(tick, 2000);
  setTimeout(tick, 1500);
})();
