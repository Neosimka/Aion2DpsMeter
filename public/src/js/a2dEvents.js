// Aion2DpsMeter : panneau « Événements » de l'overlay.
//
// Le bouton calendrier de l'en-tête remplace la liste des joueurs par :
//  - Événements : Failles spatio-temporelles, Invasions dimensionnelles,
//    Festival des Shugos, Siège d'artefact, boss programmés, réinitialisations ;
//  - Boss de terrain : en vie (avec PV), réapparition imminente, à venir.
//
// Horaires : tables du jeu (a2dEventsData.js, repris d'Event Timers d'A2Tools,
// GPL-3.0), à l'heure du serveur (chaque région a son fuseau). Boss de terrain :
// le flux que les meters des joueurs publient sur a2tools.app.
(() => {
  const DATA = window.A2D_EVENTS_DATA;
  if (!DATA) return;

  // Fuseau de chaque région Global, par le 2e chiffre du numéro de serveur.
  const REGIONS = { 1: "America/New_York", 2: "America/Los_Angeles", 3: "Europe/Berlin", 4: "America/Sao_Paulo", 5: "Asia/Seoul" };
  const FEED_EVERY_MS = 60_000;
  const WINDOW_MS = 10 * 60_000; // boss « réapparition imminente » jusqu'à 10 min après l'heure prévue
  const SOON_MS = 15 * 60_000;
  const LAST_SERVER_KEY = "a2d.lastServer";
  const TAB_KEY = "a2d.eventsTab";
  const SHIFT_KEY = "a2d.bossShift"; // correction des timers de boss, en secondes
  // L'horloge du PC peut dériver : écart avec l'heure du serveur des timers.
  let skew = 0;
  const nowMs = () => Date.now() + skew;

  const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const text = (k) => DATA.text[k]?.fr ?? DATA.text[k]?.en ?? "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let serverId = Number(store.get(LAST_SERVER_KEY)) || 0;
  let feed = null; // { server, bosses, at, error }
  let feedTimer = null;
  let tickTimer = null;
  let open = false;
  let tab = ["bosses", "pets"].includes(store.get(TAB_KEY)) ? store.get(TAB_KEY) : "events";

  // ---------- alertes ----------
  // Une cloche par ligne : son + popup quelques minutes avant le début.
  const ALERTS_KEY = "a2d.alerts";
  const LEAD_KEY = "a2d.alertLead";
  const FIRED_KEY = "a2d.alertsFired";
  const LEADS = [1, 3, 5, 10, 15];
  const readJson = (k, d) => { try { return JSON.parse(store.get(k) || "") ?? d; } catch { return d; } };
  const alerts = new Set(readJson(ALERTS_KEY, []));
  let lead = LEADS.includes(Number(store.get(LEAD_KEY))) ? Number(store.get(LEAD_KEY)) : 10;
  const fired = new Set(readJson(FIRED_KEY, []).slice(-300));
  const saveAlerts = () => store.set(ALERTS_KEY, JSON.stringify([...alerts]));
  const hasBossAlerts = () => [...alerts].some((k) => k.startsWith("boss:"));
  const BELL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

  const region = () => (serverId >= 1000 ? Number(String(serverId)[1]) : 3); // Europe par défaut
  const side = () => (serverId >= 1000 ? (String(serverId)[0] === "1" ? "elyos" : String(serverId)[0] === "2" ? "asmodian" : null) : null);
  const timeZone = () => REGIONS[region()] || "Europe/Berlin";

  // ---------- heures (repris d'Event Timers) ----------
  const partsIn = (tz, ms) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", weekday: "short",
    }).formatToParts(new Date(ms));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
      y: Number(get("year")), m: Number(get("month")), d: Number(get("day")),
      h: Number(get("hour")), mi: Number(get("minute")), s: Number(get("second")),
      wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    };
  };
  const offsetAt = (tz, ms) => {
    const p = partsIn(tz, ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  };
  const wallToMs = (tz, y, m, d, minutes) => {
    const guess = Date.UTC(y, m - 1, d, 0, minutes);
    const first = guess - offsetAt(tz, guess);
    return guess - offsetAt(tz, first);
  };
  // Prochaine (ou actuelle) séance d'un événement : { start, end }.
  const nextOf = (ev, tz, now) => {
    const zone = ev.utc ? "UTC" : tz;
    const runMs = ev.enter ? ev.enter * 1000 : (ev.minutes || 0) * 60_000;
    let best = null;
    for (let back = -1; back <= 8; back++) {
      const p = partsIn(zone, now + back * 86_400_000);
      if (!ev.days.includes(p.wd)) continue;
      for (const start of ev.starts) {
        const at = wallToMs(zone, p.y, p.m, p.d, start);
        const end = at + runMs;
        if ((runMs ? end : at) <= now) continue;
        if (!best || at < best.start) best = { start: at, end };
      }
    }
    return best;
  };

  const span = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s >= 86_400) return `${Math.floor(s / 86_400)} j ${Math.floor((s % 86_400) / 3600)} h`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };
  const ago = (ms) => {
    const min = Math.max(0, Math.round(ms / 60_000));
    return min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`;
  };
  const clock = (ms, now) => {
    const d = new Date(ms);
    const sameDay = new Date(now).toDateString() === d.toDateString();
    return d.toLocaleString("fr-FR", sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
  };

  // ---------- rendu ----------
  const panel = () => document.querySelector(".a2dEvents");
  const meter = () => document.querySelector(".meter");
  const resize = () => requestAnimationFrame(() => window.javaBridge?.updateOverlaySize?.());

  const row = ({ name, where, countdown, at, cls = "", hp = null, alert = "" }) =>
    `<li class="a2dEvRow ${cls}"${hp != null ? ` style="--hp:${Math.max(0, Math.min(100, hp))}%"` : ""}>
      ${alert ? `<button type="button" class="a2dEvBell${alerts.has(alert) ? " isOn" : ""}" data-alert="${esc(alert)}" title="${alerts.has(alert) ? "Alerte activée : clique pour l'enlever" : `M'alerter ${lead} min avant`}">${BELL}</button>` : ""}
      <span class="a2dEvWho"><b>${esc(name)}</b>${where ? `<small>${esc(where)}</small>` : ""}</span>
      <span class="a2dEvWhen"><b>${esc(countdown)}</b><small>${esc(at)}</small></span>
    </li>`;

  function renderEvents(now) {
    const tz = timeZone();
    const s = side();
    const list = DATA.events
      .filter((ev) => !ev.side || !s || ev.side === s)
      .map((ev) => ({ ev, next: nextOf(ev, tz, now) }))
      .filter((x) => x.next)
      .sort((a, b) => a.next.start - b.next.start);
    // Sans faction connue, les deux versions d'un même événement : une seule ligne.
    const seen = new Set();
    const rows = [];
    for (const { ev, next } of list) {
      const key = ev.id.replace(/-(elyos|asmodian)$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      const running = next.start <= now;
      const where = (ev.where || []).map(text).filter(Boolean).join(", ");
      rows.push(row({
        name: text(ev.name) || ev.id,
        where,
        countdown: running ? `en cours · ${span(next.end - now)}` : `dans ${span(next.start - now)}`,
        at: running ? "maintenant" : clock(next.start, now),
        cls: running ? "isLive" : next.start - now <= SOON_MS ? "isSoon" : "",
        alert: `ev:${key}`,
      }));
    }
    return rows.join("");
  }

  // Le flux annonce les boss 30 s trop tard (constaté en jeu le 2026-10-24) : −30 s par défaut.
  const DEFAULT_SHIFT = -30;
  let shift = (() => { const raw = store.get(SHIFT_KEY); const v = Number(raw); return raw != null && raw !== "" && Number.isFinite(v) && Math.abs(v) <= 120 ? v : DEFAULT_SHIFT; })();
  function setShift(v) {
    shift = Math.max(-120, Math.min(120, Math.round(v)));
    store.set(SHIFT_KEY, String(shift));
  }
  function shiftRow() {
    const sign = shift > 0 ? `+${shift}` : `${shift}`;
    return `<li class="a2dBossShift"><span>Correction des timers${Math.abs(skew) >= 2000 ? `<small>horloge du PC corrigée de ${Math.round(skew / 1000)} s</small>` : ""}</span>
      <span class="a2dCubeOpts"><button type="button" class="a2dCubeOpt" data-boss-shift="-30">−30</button><button type="button" class="a2dCubeOpt" data-boss-shift="-5">−5</button><b>${shift ? `${sign} s` : "0 s"}</b><button type="button" class="a2dCubeOpt" data-boss-shift="5">+5</button><button type="button" class="a2dCubeOpt" data-boss-shift="30">+30</button></span></li>`;
  }

  function renderBosses(now) {
    if (!serverId) return `<p class="a2dEvNote">Connecte-toi en jeu une fois : le meter saura ton serveur et affichera ses boss.</p>`;
    const s = side();
    const bosses = Object.entries(DATA.fieldBosses)
      .filter(([, b]) => !b.side || !s || b.side === s)
      .map(([id, b]) => {
        const t = feed && feed.server === serverId ? feed.bosses?.[id] || null : null;
        const next = t?.state === "dead" && t.nextSpawn ? t.nextSpawn * 1000 + shift * 1000 : null;
        const group = t?.state === "up" ? "up" : !next ? "unknown" : next <= now ? (now - next <= WINDOW_MS ? "window" : "unknown") : "upcoming";
        return { id, b, t, next, group };
      });
    const order = { up: 0, window: 1, upcoming: 2, unknown: 3 };
    bosses.sort((x, y) => order[x.group] - order[y.group]
      || (x.group === "up" ? (x.t.hp ?? 101) - (y.t.hp ?? 101) : 0)
      || (x.next || 0) - (y.next || 0));
    const heads = { up: "En vie", window: "Réapparition imminente", upcoming: "À venir" };
    let html = "";
    let last = "";
    let unknown = 0;
    for (const { id, b, t, next, group } of bosses) {
      if (group === "unknown") { unknown++; continue; }
      if (group !== last) { last = group; html += `<li class="a2dEvHead ${group}">${heads[group]}</li>`; }
      const name = `${text(b.name) || "Boss"}${b.level ? ` · niv. ${b.level}` : ""}`;
      const where = text(b.where);
      if (group === "up") {
        const hp = t.hp != null && t.hpAt ? t.hp : null;
        html += row({
          name, where,
          countdown: hp != null ? `${Math.round(hp)} % PV` : "en vie",
          at: t.upSince ? `depuis ${ago(now - t.upSince * 1000)}` : t.reportedAt ? `vu il y a ${ago(now - t.reportedAt * 1000)}` : "",
          cls: "isLive", hp, alert: `boss:${id}`,
        });
      } else if (group === "window") {
        html += row({ name, where, countdown: `prévu il y a ${ago(now - next)}`, at: clock(next, now), cls: "isSoon", alert: `boss:${id}` });
      } else {
        html += row({ name, where, countdown: `dans ${span(next - now)}`, at: clock(next, now), cls: next - now <= SOON_MS ? "isSoon" : "", alert: `boss:${id}` });
      }
    }
    let note = "";
    if (feed?.error) note = "Impossible de lire les timers pour le moment.";
    else if (!feed) note = "Lecture des timers…";
    else if (!html) note = "Aucun timer connu pour ce serveur en ce moment.";
    if (unknown) note += `${note ? " " : ""}${unknown} boss sans information récente.`;
    return `${shiftRow()}${html}${note ? `<li class="a2dEvNote">${esc(note)}</li>` : ""}`;
  }

  function render() {
    const el = panel();
    if (!el || !open) return;
    const now = nowMs();
    const serverName = serverId ? DATA.servers[String(serverId)] || `serveur ${serverId}` : "";
    const serverClock = new Date(now).toLocaleTimeString("fr-FR", { timeZone: timeZone(), hour: "2-digit", minute: "2-digit" });
    el.querySelector(".a2dEvServer").textContent = `${serverName ? `${serverName} · ` : ""}heure serveur ${serverClock}`;
    el.querySelectorAll(".a2dEvTab").forEach((b) => b.classList.toggle("isActive", b.dataset.tab === tab));
    el.classList.toggle("isPets", tab === "pets");
    el.querySelector(".a2dEvList").innerHTML = tab === "bosses" ? renderBosses(now)
      : tab === "pets" ? (window.A2dPets?.render?.() ?? "") : renderEvents(now);
    const foot = el.querySelector(".a2dEvFoot");
    if (foot && !foot.dataset.ready) {
      foot.dataset.ready = "1";
      foot.innerHTML = `<label>${BELL}<span>Alerte</span>
          <select class="a2dEvLead">${LEADS.map((m) => `<option value="${m}">${m} min avant</option>`).join("")}</select></label>
        <span class="a2dEvCount"></span>
        <button type="button" class="a2dEvTest">Tester</button>`;
      foot.querySelector(".a2dEvLead").value = String(lead);
      foot.querySelector(".a2dEvLead").addEventListener("change", (e) => {
        lead = Number(e.target.value) || 10;
        store.set(LEAD_KEY, String(lead));
        unlockAudio();
        render();
      });
      foot.querySelector(".a2dEvTest").addEventListener("click", () => {
        unlockAudio();
        notify({ title: "Faille spatio-temporelle", detail: `commence dans ${lead} min · exemple d'alerte` });
      });
    }
    if (foot) foot.querySelector(".a2dEvCount").textContent = alerts.size ? `${alerts.size} alerte${alerts.size > 1 ? "s" : ""} active${alerts.size > 1 ? "s" : ""}` : "Clique sur une cloche";
  }

  // ---------- son ----------
  let audio = null;
  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch {}
  }
  // Petit carillon de trois notes, fabriqué sur place (aucun fichier son).
  function chime() {
    unlockAudio();
    if (!audio) return;
    const t0 = audio.currentTime + 0.02;
    [[880, 0], [1174.66, 0.16], [1567.98, 0.32]].forEach(([f, d]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.9);
      o.connect(g).connect(audio.destination);
      o.start(t0 + d);
      o.stop(t0 + d + 1);
    });
  }

  // ---------- popup ----------
  function notify({ title, detail }) {
    chime();
    const m = meter();
    if (!m) return;
    const toast = document.createElement("div");
    toast.className = "a2dToast";
    toast.innerHTML = `<span class="a2dToastIcon">${BELL}</span>
      <span class="a2dToastText"><b>${esc(title)}</b><small>${esc(detail)}</small></span>
      <button type="button" class="a2dToastClose" aria-label="Fermer">×</button>`;
    const header = m.querySelector(".header");
    header ? header.after(toast) : m.prepend(toast);
    const close = () => { toast.remove(); resize(); };
    toast.querySelector(".a2dToastClose").addEventListener("click", close);
    setTimeout(close, 30_000);
    // Sans quoi la fenêtre reste à sa taille et coupe le popup.
    resize();
  }

  // ---------- vérification des alertes (toutes les 5 s, panneau ouvert ou non) ----------
  function checkAlerts() {
    if (!alerts.size) return;
    const now = nowMs();
    const leadMs = lead * 60_000;
    const due = [];
    const tz = timeZone();
    const s = side();
    for (const ev of DATA.events) {
      if (ev.side && s && ev.side !== s) continue;
      const key = `ev:${ev.id.replace(/-(elyos|asmodian)$/, "")}`;
      if (!alerts.has(key)) continue;
      const next = nextOf(ev, tz, now);
      if (next) due.push({ key, start: next.start, verb: "commence", title: text(ev.name) || ev.id, where: (ev.where || []).map(text).filter(Boolean)[0] || "" });
    }
    if (feed && feed.server === serverId) {
      for (const [id, b] of Object.entries(DATA.fieldBosses)) {
        const key = `boss:${id}`;
        const t = feed.bosses?.[id];
        if (!alerts.has(key) || t?.state !== "dead" || !t.nextSpawn) continue;
        due.push({ key, start: t.nextSpawn * 1000 + shift * 1000, verb: "apparaît", title: text(b.name) || "Boss de terrain", where: text(b.where) });
      }
    }
    for (const d of due) {
      const left = d.start - now;
      const firedKey = `${d.key}@${d.start}`;
      if (left > leadMs || left < -60_000 || fired.has(firedKey)) continue;
      fired.add(firedKey);
      store.set(FIRED_KEY, JSON.stringify([...fired].slice(-300)));
      const when = left > 30_000 ? `${d.verb} dans ${Math.round(left / 60_000)} min` : `${d.verb} maintenant`;
      notify({ title: d.title, detail: `${when} · ${clock(d.start, now)}${d.where ? ` · ${d.where}` : ""}` });
    }
  }

  async function readCharacter() {
    try {
      const c = await invoke("a2d_character");
      const id = Number(c?.serverId);
      if (id >= 1000 && id !== serverId) {
        serverId = id;
        store.set(LAST_SERVER_KEY, String(id));
        feed = null;
      }
    } catch {}
  }

  async function readFeed() {
    clearTimeout(feedTimer);
    feedTimer = setTimeout(readFeed, FEED_EVERY_MS);
    if ((!open && !hasBossAlerts()) || !serverId) return;
    try {
      const data = await invoke("a2d_boss_timers", { server: serverId });
      feed = { server: serverId, bosses: data?.bosses || {}, at: Date.now(), error: false };
    } catch {
      feed = { server: serverId, bosses: feed?.server === serverId ? feed.bosses : {}, at: Date.now(), error: true };
    }
    if (open) {
      render();
      resize();
    }
  }

  async function setOpen(next) {
    open = next;
    meter()?.classList.toggle("a2dEventsOpen", open);
    document.querySelector(".a2dEventsBtn")?.classList.toggle("isActive", open);
    clearInterval(tickTimer);
    clearTimeout(feedTimer);
    if (open) {
      render();
      resize();
      tickTimer = setInterval(render, 1000);
      await readCharacter();
      render();
      resize();
      readFeed();
    } else {
      resize();
      if (hasBossAlerts()) readFeed();
    }
  }

  function init() {
    const btn = document.querySelector(".a2dEventsBtn");
    const el = panel();
    if (!btn || !el) return;
    btn.setAttribute("data-no-drag", "true");
    btn.addEventListener("click", () => {
      if (window._dpsApp?.isWindowDragging) return;
      setOpen(!open);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); }
    });
    el.querySelector(".a2dEvList").addEventListener("click", (e) => {
      const bs = e.target.closest("[data-boss-shift]");
      if (bs) { setShift(shift + Number(bs.dataset.bossShift)); render(); return; }
      if (e.target.closest("[data-pet-detach]")) { invoke("a2d_toggle_pets_window").catch(() => {}); return; }
      const pv = e.target.closest("[data-pet-view]");
      if (pv) { window.A2dPets?.setView?.(pv.dataset.petView); render(); return; }
      const pc = e.target.closest("[data-pet-capture]");
      if (pc) { window.A2dPets?.captureAction?.(pc.dataset.petCapture).then(() => window.A2dPets?.poll?.()).then(render); return; }
      const bell = e.target.closest(".a2dEvBell");
      if (!bell) return;
      if (bell.dataset.pet) {
        unlockAudio();
        window.A2dPets?.toggle?.(bell.dataset.pet);
        render();
        return;
      }
      unlockAudio();
      const key = bell.dataset.alert;
      if (alerts.has(key)) alerts.delete(key); else alerts.add(key);
      saveAlerts();
      if (key.startsWith("boss:") && hasBossAlerts()) readFeed();
      render();
    });
    setInterval(checkAlerts, 5000);
    const syncClock = async () => {
      try {
        const t = await invoke("a2d_server_clock");
        const d = Number(t) - Date.now();
        // Une heure plausible seulement (moins d'une heure d'écart).
        if (Number(t) > 1.6e12 && Math.abs(d) < 3_600_000) skew = d;
      } catch {}
    };
    syncClock();
    setInterval(syncClock, 10 * 60_000);
    // Windows ne laisse jouer un son qu'après une action dans la fenêtre : le
    // premier clic (ou touche) dans le meter débloque le son des alertes.
    const unlockOnce = () => unlockAudio();
    document.addEventListener("pointerdown", unlockOnce, { capture: true, passive: true });
    document.addEventListener("keydown", unlockOnce, { capture: true });
    // Le serveur (heure, faction, boss) même panneau fermé, pour les alertes.
    readCharacter().then(() => { if (hasBossAlerts()) readFeed(); });
    setInterval(readCharacter, 5 * 60_000);
    el.querySelectorAll(".a2dEvTab").forEach((b) => b.addEventListener("click", () => {
      tab = b.dataset.tab;
      store.set(TAB_KEY, tab);
      render();
      resize();
    }));
  }

  window.A2dEvents = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!open), nextOf, notify, checkAlerts };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
