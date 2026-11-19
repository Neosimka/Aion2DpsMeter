// Aion2DpsMeter : onglet « Tâches » du panneau Événements, comme RiftConsole.
// Les compteurs viennent de ce que le jeu envoie sur ton personnage
// (a2d_character : entrées, énergie d'Odyle, Kinah du jour, Points Abyssaux,
// achats de la boutique, missions de vocation, passages d'Abysse). Ce que le
// jeu n'envoie pas (arènes, champ de bataille, raid) se coche à la main et se
// décoche tout seul à la remise à zéro.
(() => {
  if (window.A2_VIEW && window.A2_VIEW !== "main") return;
  const invoke = (...a) => window.__TAURI__?.core?.invoke?.(...a);
  const CHECK_KEY = "a2d.tasks.checks";
  let char = null;
  let readAt = 0;

  // Remises à zéro du jeu : chaque jour à 07:00 UTC, le mercredi pour la semaine.
  const DAY = 86_400_000;
  function lastDaily(now) {
    const d = new Date(now);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7);
    if (t > now) t -= DAY;
    return t;
  }
  function lastWeekly(now) {
    let t = lastDaily(now);
    while (new Date(t).getUTCDay() !== 3) t -= DAY; // mercredi
    return t;
  }
  const nextDaily = (now) => lastDaily(now) + DAY;
  const nextWeekly = (now) => lastWeekly(now) + 7 * DAY;

  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("fr-FR");
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",")}M` : fmt(n));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function left(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return d ? `${d} j ${h} h` : h ? `${h} h ${String(mm).padStart(2, "0")}` : `${mm} min`;
  }
  const when = (t) => new Date(t).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

  // Tâches cochées à la main : { id: moment coché }.
  function checks() { try { return JSON.parse(localStorage.getItem(CHECK_KEY) || "{}") || {}; } catch { return {}; } }
  function saveChecks(c) { try { localStorage.setItem(CHECK_KEY, JSON.stringify(c)); } catch {} }
  const MANUAL = {
    daily: [],
    weekly: [
      ["arena-solo", "⚔", "Arène de solitude"],
      ["arena-coop", "⚔", "Arène de coopération"],
      ["battlefield", "⚑", "Champ de bataille"],
      ["ludra", "☠", "Raid Ludra"],
    ],
  };
  function isChecked(id, scope, now) {
    const at = checks()[id];
    return !!at && at >= (scope === "daily" ? lastDaily(now) : lastWeekly(now));
  }

  async function read() {
    try { char = await invoke("a2d_character"); readAt = Date.now(); } catch {}
  }
  setInterval(read, 10_000);
  setTimeout(read, 1500);

  // Une ligne : icône, nom, valeur, et « fait » quand c'est terminé.
  const row = (icon, name, value, { done = false, tip = "", sub = "", check = null } = {}) =>
    `<li class="a2dTkRow${done ? " isDone" : ""}"${tip ? ` title="${esc(tip)}"` : ""}${check ? ` data-task="${check}"` : ""}>
      <span class="a2dTkIcon">${icon}</span><span class="a2dTkName">${esc(name)}${sub ? ` <small>${esc(sub)}</small>` : ""}</span>
      <span class="a2dTkVal">${value}</span></li>`;
  const pair = (v, cap) => {
    if (!v) return `<em>pas encore lu</em>`;
    const [a, b] = v;
    return `<b>${fmt(a)}</b>${b ? ` <span class="a2dTkPlus">(+${fmt(b)})</span>` : ""}${cap ? ` / ${fmt(cap)}` : ""}`;
  };
  const bar = (v, cap) => `<span class="a2dTkBar"><i style="width:${Math.min(100, (100 * (v || 0)) / cap)}%"></i></span>`;

  function render() {
    const now = Date.now();
    const c = char || {};
    const counts = c.contentCounts || {};
    const cnt = (id) => counts[id] || null;
    let h = "";
    if (!char?.name) {
      return `<li class="a2dEvNote">Connecte-toi sur un personnage (ou change de zone) : le jeu envoie tes compteurs à la connexion.</li>`;
    }
    // Énergie d'Odyle
    const od = c.odyleEnergy;
    h += `<li class="a2dEvHead">Énergie d'Odyle · ${esc(c.name)}</li>`;
    if (od) {
      h += row("⚡", "Basique", `<b>${fmt(od.basic)}</b> / 840`, { sub: "" }) + `<li class="a2dTkBarRow">${bar(od.basic, 840)}</li>`;
      h += row("⚡", "Rechargée", `<b>${fmt(od.charged)}</b> / 2 000`) + `<li class="a2dTkBarRow">${bar(od.charged, 2000)}</li>`;
    } else h += row("⚡", "Énergie", `<em>pas encore lue</em>`);

    // Défis (entrées)
    h += `<li class="a2dEvHead">Défis</li>`;
    const ch = [
      [4, "☠", "Cauchemar", 14],
      [80000001, "♛", "Épreuve d'Éveil", 3],
      [101, "◎", "Brèche inconnue", 14],
      [1, "🗝", "Clé du Festival des Shugos", 21],
      [8, "🗝", "Clé d'invasion", 7],
    ];
    for (const [id, icon, name, cap] of ch) {
      const v = cnt(id);
      h += row(icon, name, pair(v, cap), { done: v && v[0] + (v[1] || 0) === 0, tip: "Entrées restantes (bonus entre parenthèses)" });
    }

    // Aujourd'hui
    const nd = nextDaily(now);
    h += `<li class="a2dEvHead">Aujourd'hui <small>réinit. ${when(nd)} · ${left(nd - now)}</small></li>`;
    const duty = cnt(0);
    h += row("★", "Missions de vocation", duty ? `<b>${fmt(duty[1])}</b> / 5${duty[0] ? ` <small>${fmt(duty[0])} rendue${duty[0] > 1 ? "s" : ""}</small>` : ""}` : `<em>pas encore lu</em>`,
      { done: duty && duty[1] >= 5, tip: "Missions prises aujourd'hui sur ce serveur (5 au plus, tous persos)" });
    const kin = c.kinahToday;
    h += row("◉", "Kinah gagnés", kin == null ? `<em>pas encore lu</em>` : `<b>${short(kin)}</b> / 1M`, { done: kin >= 1e6 });
    const times = c.contentTimes || {};
    const passages = Object.entries(times).filter(([id]) => +id >= 10000001 && +id <= 10000003);
    h += row("◌", "Corridors d'Abysse", passages.length
      ? passages.map(([, [ms]]) => `<b>${left(ms)}</b>`).join(" · ")
      : `<em>aucun ouvert</em>`, { tip: "Temps d'utilisation restant de chaque passage d'Abysse ouvert" });
    for (const [id, icon, name] of MANUAL.daily) h += row(icon, name, isChecked(id, "daily", now) ? "✓ fait" : "à faire", { done: isChecked(id, "daily", now), check: id });

    // Cette semaine
    const nw = nextWeekly(now);
    h += `<li class="a2dEvHead">Cette semaine <small>réinit. ${when(nw)} · ${left(nw - now)}</small></li>`;
    const ap = c.abyssPoints;
    h += row("◆", "Points Abyssaux", ap ? `<b>${fmt(ap[0])}</b> / ${short(ap[1])}` : `<em>pas encore lu</em>`, { done: ap && ap[1] && ap[0] >= ap[1] });
    if (ap && ap[1]) h += `<li class="a2dTkBarRow">${bar(ap[0], ap[1])}</li>`;
    const bought = c.shopLimits?.["100134"];
    h += row("⚡", "Énergie Od achetée", bought ? `<b>${fmt(bought[0])}</b>` : `<em>ouvre la boutique</em>`, { tip: "Achats d'énergie d'Odyle cette semaine (lu quand la boutique s'ouvre)" });
    const craftS = c.crafts?.["32070001"], craftC = c.crafts?.["32070002"];
    h += row("⚗", "Énergie Od transmutée", craftS != null || craftC != null
      ? `<b>${fmt(craftS || 0)}</b> <small>serveur</small> · <b>${fmt(craftC || 0)}</b> <small>perso</small>` : `<em>ouvre l'artisanat</em>`,
      { tip: "Transmutations d'énergie d'Odyle (lu quand la fenêtre d'artisanat s'ouvre)" });
    for (const [id, icon, name] of MANUAL.weekly) {
      const done = isChecked(id, "weekly", now);
      h += row(icon, name, done ? "✓ fait" : `<span class="a2dTkTodo">à cocher</span>`, { done, check: id, tip: "Le jeu ne l'envoie pas : clique pour cocher, ça se décoche tout seul mercredi" });
    }
    if (readAt && now - readAt > 60_000) h += `<li class="a2dEvNote">Lu il y a ${left(now - readAt)}.</li>`;
    return h;
  }

  function toggle(id) {
    const c = checks();
    const now = Date.now();
    const scope = MANUAL.daily.some(([i]) => i === id) ? "daily" : "weekly";
    if (isChecked(id, scope, now)) delete c[id]; else c[id] = now;
    saveChecks(c);
  }

  window.A2dTasks = { render, toggle, read };
})();
