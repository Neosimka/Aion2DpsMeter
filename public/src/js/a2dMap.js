// Aion2DpsMeter : la carte du radar (familiers et cubes).
//
// Toi au centre, nord en haut. Positions lues sur le réseau par le meter
// (src-tauri/src/a2d_pos.rs), en centimètres : x vers le nord, y vers l'est
// (repère d'Unreal Engine). Si la carte paraît tournée par rapport à la
// mini-carte du jeu, le bouton ↻ la fait pivoter d'un quart de tour.
(() => {
  const ROT_KEY = "a2d.mapRot";
  const RANGE_M = 130; // rayon montré
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  let rot = [0, 90, 180, 270].includes(Number(store.get(ROT_KEY))) ? Number(store.get(ROT_KEY)) : 0;

  // Vers l'écran (haut = nord, droite = est), puis la rotation choisie.
  function toScreen(me, p) {
    const north = (p.x - me.x) / 100, east = (p.y - me.y) / 100;
    const a = (rot * Math.PI) / 180;
    const sx = east * Math.cos(a) + north * Math.sin(a);
    const sy = -north * Math.cos(a) + east * Math.sin(a);
    return { sx, sy };
  }

  // Distance au sol (m), différence de hauteur (m), angle à l'écran (degrés, 0 = haut).
  // Une position de plus de 15 s n'est pas montrée : le meter ne sait pas
  // encore suivre tes déplacements en continu.
  const FRESH_MS = 15_000;
  const fresh = (me) => !!me && Date.now() - me.at < FRESH_MS;

  function rel(me, p) {
    if (!fresh(me) || !p || p.x == null) return null;
    const { sx, sy } = toScreen(me, p);
    return {
      dist: Math.hypot(sx, sy),
      dz: ((p.z ?? me.z) - me.z) / 100,
      angle: ((Math.atan2(sx, -sy) * 180) / Math.PI + 360) % 360,
    };
  }

  const ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
  const arrow = (angle) => ARROWS[Math.round(angle / 45) % 8];

  function label(r) {
    if (!r) return "";
    const h = Math.abs(r.dz) >= 3 ? ` <small class="a2dMapDz">${r.dz > 0 ? "▲" : "▼"}${Math.round(Math.abs(r.dz))}</small>` : "";
    return `<span class="a2dMapRel"><i style="transform:rotate(${Math.round(r.angle)}deg)">↑</i>${Math.round(r.dist)} m${h}</span>`;
  }

  // points : [{x, y, z, kind: "mob" | "cube" | "spot", color, big}]
  function svg(me, points) {
    const S = 220, C = S / 2, k = (C - 8) / RANGE_M;
    let dots = "";
    for (const p of points) {
      const r = rel(me, p);
      if (!r || r.dist > RANGE_M + 4) continue;
      const { sx, sy } = toScreen(me, p);
      const x = (C + sx * k).toFixed(1), y = (C + sy * k).toFixed(1);
      if (p.kind === "spot") dots += `<rect x="${x - 3}" y="${y - 3}" width="6" height="6" class="a2dMapSpot" style="--c:${p.color}"/>`;
      else if (p.kind === "cube") dots += `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" transform="rotate(45 ${x} ${y})" class="a2dMapCube" style="--c:${p.color}"/>`;
      else dots += `<circle cx="${x}" cy="${y}" r="${p.big ? 5 : 3.5}" class="a2dMapMob" style="--c:${p.color}"/>`;
    }
    const ring = (m) => `<circle cx="${C}" cy="${C}" r="${(m * k).toFixed(1)}" class="a2dMapRing"/><text x="${C}" y="${(C + m * k - 3).toFixed(1)}" class="a2dMapTxt">${m} m</text>`;
    const head = me?.heading != null ? (me.heading * 180) / Math.PI + rot : null;
    const you = head == null
      ? `<circle cx="${C}" cy="${C}" r="4" class="a2dMapYou"/>`
      : `<path d="M${C} ${C - 8} L${C + 6} ${C + 6} L${C} ${C + 2} L${C - 6} ${C + 6} Z" class="a2dMapYou" transform="rotate(${head.toFixed(0)} ${C} ${C})"/>`;
    const nAngle = (rot * Math.PI) / 180;
    const nx = C - Math.sin(nAngle) * (C - 9), ny = C - Math.cos(nAngle) * (C - 9);
    return `<svg class="a2dMap" viewBox="0 0 ${S} ${S}" role="img" aria-label="Carte du radar">
      ${ring(50)}${ring(100)}${dots}${you}
      <text x="${nx.toFixed(1)}" y="${(ny + 4).toFixed(1)}" class="a2dMapN">N</text>
    </svg>`;
  }

  function rotate() {
    rot = (rot + 90) % 360;
    store.set(ROT_KEY, String(rot));
  }

  // Le bloc complet : la carte, et une ligne d'état sous elle.
  function block(me, points, now) {
    if (!fresh(me)) return `<li class="a2dEvNote">Carte du radar en mise au point : le meter ne sait pas encore suivre ta position en continu.</li>`;
    const age = Math.round(((now || Date.now()) - me.at) / 1000);
    return `<li class="a2dMapBox">${svg(me, points)}
      <span class="a2dMapFoot"><span>${age > 30 ? `position d'il y a ${age < 120 ? `${age} s` : `${Math.round(age / 60)} min`}` : "position lue sur le réseau"}</span>
      <button type="button" class="a2dCubeOpt" data-map-rot="1" title="Faire pivoter la carte d'un quart de tour">↻</button></span></li>`;
  }

  window.A2dMap = { svg, rel, arrow, label, block, rotate };
})();
