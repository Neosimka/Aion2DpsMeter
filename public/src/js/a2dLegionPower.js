// Aion2DpsMeter : puissance de combat des membres de La Chevrerie, d'après le
// relevé quotidien du site, pour l'afficher à côté de leur nom quand ils ne
// sont pas dans ton groupe (le jeu ne la donne que pour ton groupe).
(() => {
  const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);
  const norm = (n) => String(n || "").trim().toLowerCase();
  let power = {};
  async function load() {
    try {
      const p = await invoke("a2d_legion_power");
      if (p && typeof p === "object") power = Object.fromEntries(Object.entries(p).map(([k, v]) => [norm(k), Number(v) || 0]));
    } catch {}
  }
  load();
  setInterval(load, 30 * 60_000);
  window.A2dLegionPower = { of: (name) => power[norm(name)] || 0, reload: load };
})();
