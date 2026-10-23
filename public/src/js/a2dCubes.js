// Aion2DpsMeter : cubes cachés (onglet « Cubes » du panneau Événements).
//
// Le serveur envoie au jeu chaque cube caché à environ 110 m de toi ; le meter
// le lit sur le réseau (src-tauri/src/a2d_cubes.rs) et l'affiche ici, avec
// une alerte (popup + son) quand un cube apparaît.
// Codes et emplacements des cubes : RiftConsole (licence MIT).
(() => {
  const SOUND_KEY = "a2d.cubeAlert"; // "red" (défaut), "all", "off"
  const ALERT_GAP_MS = 10_000;

  const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const MAPS = { 1010: "Verteron", 1011: "Eltnen", 1110: "Altgard", 1111: "Morheim" };
  // Les secteurs, d'après le nom des groupes de cubes du jeu.
  const AREAS = {
    AltamiaCanyon: "Canyon d'Altamia", AltamiaHighland: "Plateau d'Altamia", Altamia_Southern: "Sud du Plateau d'Altamia",
    Cantas: "Vallée de Cantas", DranaPlantation: "Exploitation de Drana", EllunMarsh: "Marais de la Rivière Ellun",
    EllunRiver: "Prairies de la Rivière Ellun", IoE: "Île de l'Éternité", KrakaFootPath: "Sentier de Kraka",
    NahidArmy: "Forteresse du Bataillon de Nahid", Owllau: "Village Aullaeu", PilgrimsRidge: "Col du Pèlerin",
    RedForest: "Forêt Rouge", TF: "Forêt de Tolbas", VF: "Ruines de la Forteresse de Verteron",
    BasfeltRuins: "Ruines de Basfelt", BlackClawVillage: "Village des Griffes Noires", CalderonHill: "Canyon de Calderon",
    Dranactus: "Dranactus", Dredgion_Crash_Site: "Site de Crash du Dredgion", EastGribadeCanyon: "Est des Collines de Gribade",
    FafniteDeposit: "Gisement de Fafnite", FierceFightHill: "Colline de l'Acharnement", GribadeCanyon: "Collines de Gribade",
    ImpetusiumSquare: "Esplanade de l'Impetusium", IslandOfSpirit: "Île des Esprits", IslandofImmortality: "Île de l'Immortalité",
    LagtaFortress: "Forteresse de Lagta", MoslanForest: "Forêt de Moslan", Purificatoryforest: "Forêt de Purification",
    Sanctum_Watchpost: "Poste de Surveillance du Sanctuaire", Seggurheim: "Seggurheim", SilenceHill: "Colline Silencieuse",
    TraneinHillLand: "Collines de Tranein", Unnamed_Cemetery: "Cimetière sans Nom", WestGribadeCanyon: "Ouest des Collines de Gribade",
  };
  const areaName = (a) => {
    if (!a) return "";
    const water = /_UnderWater$/.test(a);
    const base = a.replace(/_UnderWater$/, "");
    const name = AREAS[base] || base.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
    return water ? `${name} (sous l'eau)` : name;
  };

  let sound = ["red", "all", "off"].includes(store.get(SOUND_KEY)) ? store.get(SOUND_KEY) : "red";
  let state = { map: null, spots: 0, cubes: [], now: Date.now() };
  const known = new Set();
  let firstPoll = true;
  let lastAlert = 0;

  const colour = (c) => (c.red ? "rouge" : "jaune");
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return "à l'instant";
    const m = Math.round(s / 60);
    return m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  };

  function header() {
    const name = MAPS[state.map];
    if (state.map == null) return `<li class="a2dEvNote">Change de zone (ou téléporte-toi) avec le meter ouvert : il saura sur quelle carte tu es.</li>`;
    if (!name) return `<li class="a2dEvNote">Pas de cubes cachés connus sur cette carte. Ils sont à Verteron, Eltnen, Altgard et Morheim.</li>`;
    return `<li class="a2dEvNote"><b>${esc(name)}</b> · ${state.spots.toLocaleString("fr-FR")} emplacements de cubes connus</li>`;
  }

  function soundRow() {
    const opt = (v, label) => `<button type="button" class="a2dCubeOpt${sound === v ? " isOn" : ""}" data-cube-sound="${v}">${label}</button>`;
    return `<li class="a2dCubeSound"><span>Alerte quand un cube apparaît</span><span class="a2dCubeOpts">${opt("red", "Rouges")}${opt("all", "Tous")}${opt("off", "Aucune")}</span></li>`;
  }

  function rows() {
    if (!state.cubes.length) return `<li class="a2dEvNote">Aucun cube caché à portée. Le jeu n'envoie que les cubes à environ 110 m de toi.</li>`;
    return state.cubes.map((c) => `<li class="a2dEvRow${c.red ? " isSoon" : ""}">
        <span class="a2dCubeDot ${c.red ? "isRed" : "isYellow"}" aria-hidden="true"></span>
        <span class="a2dEvWho"><b>Cube caché ${colour(c)}</b><small>${esc(areaName(c.area) || MAPS[state.map] || "")}</small></span>
        <span class="a2dEvWhen"><b>${ago(state.now - c.since)}</b><small>${c.water ? "sous l'eau" : ""}</small></span>
      </li>`).join("");
  }

  function render() {
    return `${header()}${soundRow()}<li class="a2dEvHead isLive">Autour de toi</li>${rows()}`;
  }

  function setSound(v) {
    if (!["red", "all", "off"].includes(v)) return;
    sound = v;
    store.set(SOUND_KEY, v);
  }

  function checkNew() {
    for (const c of state.cubes) {
      if (known.has(c.id)) continue;
      known.add(c.id);
      if (firstPoll || sound === "off" || (sound === "red" && !c.red)) continue;
      if (Date.now() - lastAlert < ALERT_GAP_MS) continue;
      lastAlert = Date.now();
      const where = areaName(c.area) || MAPS[state.map] || "";
      window.A2dEvents?.notify?.({
        title: `Cube caché ${colour(c)} à proximité`,
        detail: `${where ? `${where} · ` : ""}à moins de 110 m de toi`,
      });
    }
    // Les cubes partis peuvent revenir (nouvelle apparition) : on oublie leurs ids.
    const ids = new Set(state.cubes.map((c) => c.id));
    for (const id of known) if (!ids.has(id)) known.delete(id);
    firstPoll = false;
  }

  async function poll() {
    try {
      const s = await invoke("a2d_cubes_state");
      if (s && typeof s === "object") {
        state = { map: s.map ?? null, spots: s.spots || 0, cubes: Array.isArray(s.cubes) ? s.cubes : [], now: s.now || Date.now() };
        checkNew();
      }
    } catch {}
  }
  setInterval(poll, 2000);
  poll();

  window.A2dCubes = { render, setSound, poll, count: () => state.cubes.length };
})();
