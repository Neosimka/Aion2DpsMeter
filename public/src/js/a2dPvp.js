// Aion2DpsMeter : vue PvP. Choisie dans le menu du bouton BOSS/ALL (en bas du
// meter), elle remplace la liste des dégâts par les joueurs que tu as tués ou
// aidé à tuer, avec les Points Abyssaux gagnés sur chacun (a2d_pvp.rs).
(() => {
  if (window.A2_VIEW && window.A2_VIEW !== "main") return;
  const KEY = "a2d.pvp.on";
  let on = false;
  try { on = localStorage.getItem(KEY) === "1"; } catch {}
  let box = null;
  let timer = null;
  const fmt = (n) => Math.round(n).toLocaleString("fr-FR");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function node() {
    if (box?.isConnected) return box;
    const list = document.querySelector(".meter > .list, .meter .list:not(.barPreviewList)");
    if (!list) return null;
    box = document.createElement("div");
    box.className = "a2dPvp";
    box.hidden = true;
    list.insertAdjacentElement("afterend", box);
    box.addEventListener("click", (e) => {
      if (!e.target.closest(".a2dPvpReset")) return;
      e.stopPropagation();
      window.__TAURI__?.core?.invoke?.("a2d_pvp_reset").catch(() => {});
      setTimeout(tick, 100);
    });
    return box;
  }

  function render(v) {
    const b = node();
    if (!b) return;
    // 12 joueurs au plus (les plus rentables) ; les totaux comptent tout le monde.
    const MAX_ROWS = 12;
    const all = v?.players || [];
    const players = all.slice(0, MAX_ROWS);
    const hidden = all.length - players.length;
    const top = Math.max(1, ...players.map((p) => p.ap || 0));
    const head = `<div class="a2dPvpHead"><span>⚔ <b>${v?.kills || 0}</b> kill${(v?.kills || 0) > 1 ? "s" : ""}</span>` +
      `<span>🤝 <b>${v?.assists || 0}</b> assist${(v?.assists || 0) > 1 ? "s" : ""}</span>` +
      `<span class="a2dPvpTot">◆ <b>+${fmt(v?.pvpAp || 0)}</b> AP</span>` +
      `<button type="button" class="a2dPvpReset" title="Remettre la vue PvP à zéro">↺</button></div>`;
    const rows = players.length
      ? players.map((p, i) => {
          const n = (p.kills || 0) + (p.assists || 0);
          const tip = `${p.kills || 0} kill${p.kills > 1 ? "s" : ""}, ${p.assists || 0} assist${p.assists > 1 ? "s" : ""}`;
          return `<div class="a2dPvpRow${p.kills ? "" : " isAssist"}" title="${esc(tip)}">
            <span class="a2dPvpFill" style="width:${((p.ap || 0) / top) * 100}%"></span>
            <span class="a2dPvpRank">${i + 1}</span>
            <span class="a2dPvpName">${esc(p.name)}${n > 1 ? `<small>×${n}</small>` : ""}</span>
            <span class="a2dPvpAp">${p.ap ? `+${fmt(p.ap)}` : "—"}<small>AP</small></span>
          </div>`;
        }).join("")
      : `<div class="a2dPvpEmpty">Aucun joueur tué pour l'instant.<br><small>Chaque kill ou assist s'ajoute ici avec les AP gagnés.</small></div>`;
    const html = head + `<div class="a2dPvpRows">${rows}</div>` +
      (hidden > 0 ? `<div class="a2dPvpOther">+ ${hidden} autre${hidden > 1 ? "s" : ""} joueur${hidden > 1 ? "s" : ""} (compté${hidden > 1 ? "s" : ""} dans le total)</div>` : "") +
      (v?.otherAp ? `<div class="a2dPvpOther">+${fmt(v.otherAp)} AP gagnés hors PvP</div>` : "");
    if (b.innerHTML !== html) b.innerHTML = html;
  }

  async function tick() {
    if (!on) return;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    try { render(await invoke("a2d_pvp_state")); } catch {}
  }

  function apply() {
    document.querySelector(".meter")?.classList.toggle("a2dPvpOn", on);
    const b = node();
    if (b) b.hidden = !on;
    clearInterval(timer);
    timer = on ? setInterval(tick, 1000) : null;
    if (on) tick();
    requestAnimationFrame(() => window.javaBridge?.updateOverlaySize?.());
  }

  window.A2dPvp = {
    isOn: () => on,
    setOn(v) {
      on = !!v;
      try { localStorage.setItem(KEY, on ? "1" : "0"); } catch {}
      apply();
    },
  };
  const start = () => { apply(); window.dpsApp?.updateTargetModeButton?.(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(start, 300));
  else setTimeout(start, 300);
})();
