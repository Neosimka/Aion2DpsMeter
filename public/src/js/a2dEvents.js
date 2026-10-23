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
  let tab = store.get(TAB_KEY) === "bosses" ? "bosses" : "events";

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

  const row = ({ name, where, countdown, at, cls = "", hp = null }) =>
    `<li class="a2dEvRow ${cls}"${hp != null ? ` style="--hp:${Math.max(0, Math.min(100, hp))}%"` : ""}>
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
      }));
    }
    return rows.join("");
  }

  function renderBosses(now) {
    if (!serverId) return `<p class="a2dEvNote">Connecte-toi en jeu une fois : le meter saura ton serveur et affichera ses boss.</p>`;
    const s = side();
    const bosses = Object.entries(DATA.fieldBosses)
      .filter(([, b]) => !b.side || !s || b.side === s)
      .map(([id, b]) => {
        const t = feed && feed.server === serverId ? feed.bosses?.[id] || null : null;
        const next = t?.state === "dead" && t.nextSpawn ? t.nextSpawn * 1000 : null;
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
    for (const { b, t, next, group } of bosses) {
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
          cls: "isLive", hp,
        });
      } else if (group === "window") {
        html += row({ name, where, countdown: `prévu il y a ${ago(now - next)}`, at: clock(next, now), cls: "isSoon" });
      } else {
        html += row({ name, where, countdown: `dans ${span(next - now)}`, at: clock(next, now), cls: next - now <= SOON_MS ? "isSoon" : "" });
      }
    }
    let note = "";
    if (feed?.error) note = "Impossible de lire les timers pour le moment.";
    else if (!feed) note = "Lecture des timers…";
    else if (!html) note = "Aucun timer connu pour ce serveur en ce moment.";
    if (unknown) note += `${note ? " " : ""}${unknown} boss sans information récente.`;
    return `${html}${note ? `<li class="a2dEvNote">${esc(note)}</li>` : ""}`;
  }

  function render() {
    const el = panel();
    if (!el || !open) return;
    const now = Date.now();
    const serverName = serverId ? DATA.servers[String(serverId)] || `serveur ${serverId}` : "";
    const serverClock = new Date(now).toLocaleTimeString("fr-FR", { timeZone: timeZone(), hour: "2-digit", minute: "2-digit" });
    el.querySelector(".a2dEvServer").textContent = `${serverName ? `${serverName} · ` : ""}heure serveur ${serverClock}`;
    el.querySelectorAll(".a2dEvTab").forEach((b) => b.classList.toggle("isActive", b.dataset.tab === tab));
    el.querySelector(".a2dEvList").innerHTML = tab === "bosses" ? renderBosses(now) : renderEvents(now);
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
    if (!open || !serverId) return;
    try {
      const data = await invoke("a2d_boss_timers", { server: serverId });
      feed = { server: serverId, bosses: data?.bosses || {}, at: Date.now(), error: false };
    } catch {
      feed = { server: serverId, bosses: feed?.server === serverId ? feed.bosses : {}, at: Date.now(), error: true };
    }
    render();
    resize();
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
    el.querySelectorAll(".a2dEvTab").forEach((b) => b.addEventListener("click", () => {
      tab = b.dataset.tab;
      store.set(TAB_KEY, tab);
      render();
      resize();
    }));
  }

  window.A2dEvents = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!open), nextOf };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
