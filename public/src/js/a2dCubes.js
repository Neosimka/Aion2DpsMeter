// Aion2DpsMeter : alerte des cubes cachés près de toi.
//
// Le jeu n'envoie un cube que quand il entre dans ton champ de vue : dès qu'il
// apparaît dans la liste (a2d_cubes), il est près de toi. Rouge : cube à clé ;
// doré : cube normal. Distance, hauteur et direction s'affichent quand le jeu
// a donné ta position il y a moins d'une minute (il ne l'envoie pas toujours).
(() => {
  if (window.A2_VIEW && window.A2_VIEW !== "main") return;
  const invoke = (...a) => window.__TAURI__?.core?.invoke?.(...a);
  const K = { on: "a2d.cubes.on", sound: "a2d.cubes.sound", noRed: "a2d.cubes.noRed" };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const on = () => get(K.on, "1") !== "0";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const resize = () => requestAnimationFrame(() => window.javaBridge?.updateOverlaySize?.());
  // Flèche comme sur la carte (le haut = le nord de la carte).
  const ARROWS = ["→", "↗", "↑", "↖", "←", "↙", "↓", "↘"];
  // angle : degrés depuis l'est, sens inverse des aiguilles, carte nord en haut (même calcul que Questlog).
  const arrow = (deg) => ARROWS[((Math.round(deg / 45) % 8) + 8) % 8];
  const since = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`; };

  let el = null;
  const node = () => {
    if (el?.isConnected) return el;
    const anchor = document.querySelector(".a2dGuide") || document.querySelector(".a2dBossRow") || document.querySelector(".meter > .header");
    if (!anchor) return null;
    el = document.createElement("div");
    el.className = "a2dCubes";
    el.hidden = true;
    anchor.insertAdjacentElement("afterend", el);
    return el;
  };

  const alerted = new Set();
  async function tick() {
    const e = node();
    if (!e) return;
    if (!on()) { if (!e.hidden) { e.hidden = true; resize(); } return; }
    let list = [];
    try { list = (await invoke("a2d_cubes")) || []; } catch { return; }
    if (get(K.noRed, "0") === "1") list = list.filter((c) => !c.red);
    const now = Date.now();
    for (const c of list) {
      if (alerted.has(c.key) || c.takenAt) continue;
      alerted.add(c.key);
      if (get(K.sound, "1") !== "0") window.A2dEvents?.chime?.("bell");
    }
    if (alerted.size > 500) alerted.clear();
    const html = list.slice(0, 3).map((c) => {
      const kind = c.red ? "Cube à clé" : "Cube doré";
      const where = c.distance != null ? ` · <b>${c.distance} m</b> ${arrow(c.angle)}${c.rise ? ` · ${c.rise > 0 ? "+" : ""}${c.rise} m` : ""}` : " · près de toi";
      const state = c.takenAt ? " · ouvert" : ` · depuis ${since(now - c.seenAt)}`;
      return `<div class="a2dCube${c.red ? " isRed" : ""}${c.takenAt ? " isTaken" : ""}"><span class="a2dCubeDot"></span>${kind}${where}<span class="a2dCubeAge">${state}</span></div>`;
    }).join("") + (list.length > 3 ? `<div class="a2dCubeMore">+${list.length - 3} autre${list.length > 4 ? "s" : ""}</div>` : "");
    if (e.innerHTML !== html) e.innerHTML = html;
    const hide = !list.length;
    if (e.hidden !== hide) { e.hidden = hide; resize(); }
  }

  function bind() {
    const box = (cls, key, def) => {
      const cb = document.querySelector(cls);
      if (!cb) return;
      cb.checked = get(key, def) === "1";
      cb.addEventListener("change", () => { set(key, cb.checked ? "1" : "0"); tick(); });
    };
    box(".a2dCubesCheckbox", K.on, "1");
    box(".a2dCubesSoundCheckbox", K.sound, "1");
    box(".a2dCubesNoRedCheckbox", K.noRed, "0");
    setInterval(tick, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
  window.A2dCubes = { tick, arrow };
})();
