// Aion2DpsMeter : radar à familiers (onglet « Familiers » du panneau Événements).
//
// - Autour de toi : les monstres présents qui donnent l'âme d'un familier que
//   tu n'as pas encore monté au niveau 3 ;
// - Familiers suivis : ceux dont tu as allumé la cloche, avec les âmes qu'il
//   leur manque et où les trouver ;
// - une alerte (popup + son) quand un monstre d'un familier suivi apparaît.
//
// Familiers et monstres : lus sur le réseau par le meter (src-tauri/src/a2d_radar.rs).
// Quel monstre donne quelle âme : a2dPetsData.js (Pet Soul Tracker d'A2Tools, GPL-3.0).
(() => {
  const DATA = window.A2D_PETS_DATA;
  if (!DATA) return;
  const NEEDED = DATA.needed || [5, 25, 75];
  const TO_MAX = NEEDED.map((_, l) => NEEDED.slice(l).reduce((n, x) => n + x, 0)); // [105, 100, 75]
  const PINS_KEY = "a2d.petPins";
  const ALERT_EVERY_MS = 60_000; // une alerte par espèce au plus chaque minute

  const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const BELL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

  // Nom de chaque monstre à âme, depuis les sources des familiers.
  const npcInfo = {};
  for (const [id, p] of Object.entries(DATA.pets)) {
    for (const d of p.drops || []) if (!npcInfo[d.npc]) npcInfo[d.npc] = { name: d.name, level: d.level, zone: d.zone, map: d.map };
  }

  let pins = new Set((() => { try { return JSON.parse(store.get(PINS_KEY) || "[]").map(String); } catch { return []; } })());
  let state = { pets: null, nearby: [], now: Date.now() };
  const lastSeenByCode = new Map();
  const lastAlertByCode = new Map();
  let firstPoll = true;
  const VIEW_KEY = "a2d.petView";
  let view = ["near", "missing", "collection"].includes(store.get(VIEW_KEY)) ? store.get(VIEW_KEY) : "near";
  // Cette session : âmes ramassées, montées de niveau, nouveaux familiers.
  const session = { souls: 0, ups: 0, fresh: 0 };
  let prevPets = null;
  let capture = null;
  const GENUS = [["fera", "Bestia", "#f0a13c"], ["natura", "Natura", "#5fd08a"], ["varian", "Varius", "#c49bf0"], ["cogni", "Intellia", "#59c2e8"]];
  const genusColor = (g) => (GENUS.find((x) => x[0] === g) || [0, 0, "#aaa"])[2];

  const petLevel = (id) => Number(state.pets?.levels?.[id] ?? 0);
  const petPoints = (id) => Number(state.pets?.points?.[id] ?? 0);
  const known = () => !!state.pets && Object.keys(state.pets.levels || {}).length + Object.keys(state.pets.points || {}).length > 0;
  // Âmes qu'il manque pour le niveau 3 (null si les familiers ne sont pas encore lus).
  const left = (id) => {
    if (!known()) return null;
    const l = petLevel(id);
    return l >= NEEDED.length ? 0 : Math.max(0, TO_MAX[l] - petPoints(id));
  };
  const petName = (id) => DATA.pets[id]?.name || `Familier ${id}`;
  // « âme de Brax », « âme d'Ouvrier Krall ».
  const soulOf = (id) => { const n = petName(id); return /^[aeiouyhàâéèêëîïôöûü]/i.test(n) ? `âme d'${n}` : `âme de ${n}`; };
  // Les familiers qu'un monstre peut faire avancer (pas déjà au niveau 3).
  const petsOf = (code) => (DATA.byNpc[code] || [])
    .map(([pet, chance]) => ({ pet: String(pet), chance, left: left(String(pet)) }))
    // Seulement les familiers qu'il te reste à compléter (niveau 3 non atteint).
    .filter((p) => p.left != null && p.left > 0);

  // La miniature du familier (portrait du jeu, 64 px).
  const ico = (pet) => `<img class="a2dPetIco" src="/src/assets/pets/${esc(pet)}.webp" alt="" loading="lazy" decoding="async">`;

  function bell(pet) {
    const on = pins.has(pet);
    return `<button type="button" class="a2dEvBell a2dPetBell${on ? " isOn" : ""}" data-pet="${esc(pet)}" title="${on ? "Suivi : clique pour arrêter" : "Suivre ce familier : alerte quand un de ses monstres apparaît"}">${BELL}</button>`;
  }

  // ●○○ : le niveau du familier ; la barre : ses âmes vers le niveau suivant.
  function progress(id) {
    const l = Math.min(petLevel(id), NEEDED.length);
    const need = NEEDED[l];
    const pts = petPoints(id);
    const col = genusColor(DATA.pets[id]?.genus);
    const dots = [0, 1, 2].map((i) => `<i class="${i < l ? "isOn" : ""}" style="--c:${col}"></i>`).join("");
    const bar = need ? `<span class="a2dPetBar" style="--c:${col}"><b style="width:${Math.min(100, (pts / need) * 100).toFixed(0)}%"></b></span><span class="a2dPetPts">${pts}/${need}</span>` : `<span class="a2dPetPts">MAX</span>`;
    return `<span class="a2dPetProg"><span class="a2dPetDots">${dots}</span>${bar}</span>`;
  }

  function nearbyRows() {
    if (!known()) return `<li class="a2dEvNote">Le radar attend la liste de tes familiers pour n'afficher que ceux qu'il te manque.</li>`;
    const rows = state.nearby
      .map((n) => ({ ...n, info: npcInfo[n.code], pets: petsOf(n.code) }))
      .filter((n) => n.info && n.pets.length)
      .sort((a, b) => Number(b.pets.some((p) => pins.has(p.pet))) - Number(a.pets.some((p) => pins.has(p.pet)))
        || b.count - a.count || a.info.name.localeCompare(b.info.name, "fr"));
    if (!rows.length) return `<li class="a2dEvNote">Aucun monstre autour de toi ne donne l'âme d'un familier qu'il te manque.</li>`;
    return rows.slice(0, 20).map((n) => {
      const main = n.pets.slice().sort((a, b) => Number(pins.has(b.pet)) - Number(pins.has(a.pet)))[0];
      const more = n.pets.length > 1 ? ` +${n.pets.length - 1}` : "";
      const pinned = n.pets.some((p) => pins.has(p.pet));
      return `<li class="a2dEvRow${pinned ? " isSoon" : ""}">
        ${bell(main.pet)}${ico(main.pet)}
        <span class="a2dEvWho"><b>${esc(n.info.name)}${n.count > 1 ? ` ×${n.count}` : ""}</b><small>${esc(soulOf(main.pet))}${more} · ${esc(main.chance)}</small>${progress(main.pet)}</span>
        <span class="a2dEvWhen"><b>${main.left == null ? `niv. ${n.info.level}` : `−${main.left} âmes`}</b><small>${esc(n.info.zone || n.info.map || "")}</small></span>
      </li>`;
    }).join("");
  }

  function pinnedRows() {
    if (!pins.size) return "";
    let html = `<li class="a2dEvHead">Familiers suivis</li>`;
    for (const pet of pins) {
      const p = DATA.pets[pet];
      if (!p) continue;
      const l = left(pet);
      const best = (p.drops || []).slice().sort((a, b) => (b.spawns || 0) - (a.spawns || 0))[0];
      const done = l === 0;
      html += `<li class="a2dEvRow${done ? " isLive" : ""}">
        ${bell(pet)}${ico(pet)}
        <span class="a2dEvWho"><b>${esc(p.name)}</b><small>${best ? `${esc(best.name)} · ${esc(best.zone || best.map)}${best.tp ? ` · TP ${esc(best.tp)}` : ""}` : "seulement dans les coffres d'âmes"}</small></span>
        <span class="a2dEvWhen"><b>${l == null ? "–" : done ? "niveau 3" : `−${l} âmes`}</b><small>${l == null ? "" : `niv. ${petLevel(pet)} · ${petPoints(pet)} âme${petPoints(pet) > 1 ? "s" : ""}`}</small></span>
      </li>`;
    }
    return html;
  }

  function summary() {
    if (!known()) return `<li class="a2dEvNote">Connecte-toi (ou change de personnage) avec le meter ouvert : il lira tes familiers et les âmes qu'il te manque.</li>`;
    const ids = Object.keys(DATA.pets).filter((id) => !DATA.pets[id].chestOnly);
    const open = ids.filter((id) => (left(id) ?? 1) > 0);
    const souls = open.reduce((n, id) => n + (left(id) || 0), 0);
    const g = state.pets.lastGain;
    const last = g && Date.now() - g[1] < 30 * 60_000 ? ` · dernière âme : ${esc(petName(String(g[0])))}` : "";
    return `<li class="a2dEvNote"><b>${souls.toLocaleString("fr-FR")}</b> âmes à trouver pour <b>${open.length}</b> familiers${last}</li>`;
  }

  // Les familiers qu'il te reste à compléter, les plus proches du niveau 3 d'abord.
  function missingRows(max = 12) {
    if (!known()) return "";
    const list = Object.entries(DATA.pets)
      .filter(([id, p]) => !p.chestOnly && !pins.has(id) && (left(id) ?? 0) > 0)
      .map(([id, p]) => ({ id, p, left: left(id) }))
      .sort((a, b) => a.left - b.left || a.p.name.localeCompare(b.p.name, "fr"));
    if (!list.length) return `<li class="a2dEvHead">Il te manque</li><li class="a2dEvNote">Tous tes familiers sont au niveau 3 !</li>`;
    let html = `<li class="a2dEvHead">Il te manque · ${list.length} familiers</li>`;
    for (const { id, p, left: l } of list.slice(0, max)) {
      const best = (p.drops || []).slice().sort((a, b) => (b.spawns || 0) - (a.spawns || 0))[0];
      html += `<li class="a2dEvRow">
        ${bell(id)}${ico(id)}
        <span class="a2dEvWho"><b>${esc(p.name)}</b><small>${best ? `${esc(best.name)} · ${esc(best.zone || best.map)}` : ""}</small>${progress(id)}</span>
        <span class="a2dEvWhen"><b>−${l} âmes</b><small>niv. ${petLevel(id)}</small></span>
      </li>`;
    }
    if (list.length > max) html += `<li class="a2dEvNote">… et ${list.length - max} autres. Allume une cloche pour suivre un familier.</li>`;
    return html;
  }

  function collection() {
    if (!known()) return `<li class="a2dEvNote">Connecte-toi (ou change de personnage) avec le meter ouvert : il lira ta collection.</li>`;
    const owned = Object.entries(state.pets.levels || {}).filter(([, l]) => Number(l) >= 1).map(([id]) => id);
    const inData = owned.filter((id) => DATA.pets[id]);
    const total = Object.values(DATA.pets).length;
    const stage = (n) => owned.filter((id) => Math.min(petLevel(id), 3) === n).length;
    let html = `<li class="a2dPetColl"><b>Collection</b> <strong>${inData.length}/${total}</strong></li>`;
    for (const [g, name, col] of GENUS) {
      const all = Object.keys(DATA.pets).filter((id) => DATA.pets[id].genus === g).length;
      const mine = inData.filter((id) => DATA.pets[id].genus === g).length;
      html += `<li class="a2dPetGenus" style="--c:${col}"><span class="a2dPetGName">${name}</span><span class="a2dPetBar isWide"><b style="width:${all ? ((mine / all) * 100).toFixed(1) : 0}%"></b></span><span class="a2dPetPts">${mine}/${all}</span></li>`;
    }
    const special = owned.length - inData.length;
    if (special > 0) html += `<li class="a2dPetGenus" style="--c:#f07aa8"><span class="a2dPetGName">Spéciaux</span><span></span><span class="a2dPetPts">${special}</span></li>`;
    html += `<li class="a2dEvNote">Niveaux : <b>${stage(3)}</b> MAX · <b>${stage(2)}</b> au niv. 2 · <b>${stage(1)}</b> au niv. 1${special > 0 ? " · les spéciaux ne comptent pas dans le total" : ""}</li>`;
    html += captureRow();
    html += `<li class="a2dEvNote">Cette session : +${session.souls} âme${session.souls > 1 ? "s" : ""} · ${session.ups} niveau${session.ups > 1 ? "x" : ""} · ${session.fresh} nouveau${session.fresh > 1 ? "x" : ""}</li>`;
    return html;
  }

  // Carte du radar : il faut ta position, que le meter ne sait pas encore lire.
  function captureRow() {
    const c = capture;
    const left = c?.recording ? Math.max(0, Math.round((c.until - c.now) / 1000)) : 0;
    const btn = c?.recording
      ? `<button type="button" class="a2dCubeOpt isOn" data-pet-capture="stop">Arrêter (${left} s)</button>`
      : `<button type="button" class="a2dCubeOpt" data-pet-capture="start">Enregistrer 2 min</button>`;
    const done = !c?.recording && c?.path ? ` <button type="button" class="a2dCubeOpt" data-pet-capture="reveal">Voir le fichier</button>` : "";
    return `<li class="a2dEvHead">Capture pour le développement</li>
      <li class="a2dEvNote">Si le radar se trompe, enregistre 2 min de jeu et envoie le fichier : il contient les noms des joueurs autour de toi et le chat.</li>
      <li class="a2dCubeSound"><span>${c?.recording ? `Enregistrement… ${((c.bytes || 0) / 1048576).toFixed(1)} Mo` : c?.path ? "Capture prête" : "Capture du trafic du jeu"}</span><span class="a2dCubeOpts">${btn}${done}</span></li>`;
  }

  function nav() {
    const b = (v, label) => `<button type="button" class="a2dCubeOpt${view === v ? " isOn" : ""}" data-pet-view="${v}">${label}</button>`;
    return `<li class="a2dPetNav"><span class="a2dCubeOpts">${b("near", "Autour")}${b("missing", "Il te manque")}${b("collection", "Collection")}</span><small>+${session.souls} âmes · ${session.ups} niv. · ${session.fresh} nouv.</small>${window.A2D_PETS_WINDOW ? "" : `<button type="button" class="a2dCubeOpt a2dPetDetach" data-pet-detach="1" title="Ouvrir le radar dans sa propre fenêtre">⧉ Détacher</button>`}</li>`;
  }

  function render() {
    if (view === "collection") return `${nav()}${collection()}`;
    if (view === "missing") return `${nav()}${summary()}${pinnedRows()}${missingRows(60)}`;
    return `${nav()}${summary()}<li class="a2dEvHead isLive">Autour de toi</li>${nearbyRows()}${pinnedRows()}`;
  }

  function setView(v) {
    if (!["near", "missing", "collection"].includes(v)) return;
    view = v;
    store.set(VIEW_KEY, v);
  }

  async function captureAction(what) {
    try {
      if (what === "start") capture = await invoke("a2d_capture_start", { seconds: 120 });
      else if (what === "stop") capture = await invoke("a2d_capture_stop");
      else if (what === "reveal") await invoke("a2d_capture_reveal");
    } catch {}
  }

  // Compte les âmes, niveaux et nouveaux familiers depuis l'ouverture du meter.
  function countSession(pets) {
    if (!pets || !Object.keys(pets.levels || {}).length) return;
    if (prevPets) {
      const ids = new Set([...Object.keys(pets.levels || {}), ...Object.keys(pets.points || {})]);
      for (const id of ids) {
        const l0 = Number(prevPets.levels?.[id] ?? 0), l1 = Number(pets.levels?.[id] ?? 0);
        const p0 = Number(prevPets.points?.[id] ?? 0), p1 = Number(pets.points?.[id] ?? 0);
        if (l1 > l0) {
          session.ups += l1 - l0;
          if (l0 === 0) session.fresh += 1;
          let gained = p1;
          for (let l = l0; l < l1; l++) gained += NEEDED[l] - (l === l0 ? p0 : 0);
          session.souls += Math.max(0, gained);
        } else if (l1 === l0 && p1 > p0) session.souls += p1 - p0;
      }
    }
    prevPets = JSON.parse(JSON.stringify(pets));
  }

  function toggle(pet) {
    if (pins.has(pet)) pins.delete(pet); else pins.add(pet);
    store.set(PINS_KEY, JSON.stringify([...pins]));
  }

  // Un monstre d'un familier suivi vient d'apparaître : popup + son.
  function checkSpawns() {
    for (const n of state.nearby) {
      const before = lastSeenByCode.get(n.code) || 0;
      lastSeenByCode.set(n.code, n.lastSeen);
      if (firstPoll || n.lastSeen <= before) continue;
      const followed = petsOf(n.code).filter((p) => pins.has(p.pet));
      if (!followed.length) continue;
      if (Date.now() - (lastAlertByCode.get(n.code) || 0) < ALERT_EVERY_MS) continue;
      lastAlertByCode.set(n.code, Date.now());
      const info = npcInfo[n.code] || { name: "Monstre à âme" };
      const p = followed[0];
      window.A2dEvents?.notify?.({
        title: `${info.name} est apparu`,
        detail: `${soulOf(p.pet)}${p.left != null ? ` · il manque ${p.left} âmes` : ""}${info.zone ? ` · ${info.zone}` : ""}`,
      });
    }
    firstPoll = false;
  }

  async function poll() {
    try {
      const s = await invoke("a2d_radar_state");
      if (s && typeof s === "object") {
        state = { pets: s.pets || null, nearby: Array.isArray(s.nearby) ? s.nearby : [], now: s.now || Date.now() };
        countSession(state.pets);
        checkSpawns();
      }
    } catch {}
    try { capture = (await invoke("a2d_capture_state")) || capture; } catch {}
  }
  setInterval(poll, 3000);
  poll();

  // Les cloches et la vue, partagées avec la fenêtre détachée.
  window.addEventListener("storage", (e) => {
    if (e.key === PINS_KEY) { try { pins = new Set(JSON.parse(e.newValue || "[]").map(String)); } catch {} }
    if (e.key === VIEW_KEY && ["near", "missing", "collection"].includes(e.newValue)) view = e.newValue;
  });
  // Une miniature absente : on la cache (pas d'attribut onerror, interdit par la CSP).
  document.addEventListener("error", (e) => { if (e.target?.classList?.contains("a2dPetIco")) e.target.style.visibility = "hidden"; }, true);

  window.A2dPets = { render, toggle, poll, setView, captureAction };
})();
