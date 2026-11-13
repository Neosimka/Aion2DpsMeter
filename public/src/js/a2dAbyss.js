// Aion2DpsMeter : Points Abyssaux gagnés pendant la session, en temps réel, en bas du meter.
// Le total de la semaine vient du réseau (data_storage, enregistrement « ab ») ;
// la session commence au premier total reçu après le lancement du meter.
// Un clic remet le compteur à zéro.
(() => {
  if (window.A2_VIEW && window.A2_VIEW !== "main") return;
  const ON_KEY = "a2d.abyss.on";
  let el = null;
  let base = null;      // total au début de la session
  let startAt = 0;      // heure du premier gain (pour le rythme par heure)
  let last = null;      // dernier total vu
  let flashUntil = 0;
  const fmt = (n) => Math.round(n).toLocaleString("fr-FR");
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : n >= 1e5 ? `${Math.round(n / 1e3)} k` : fmt(n));

  function node() {
    if (el?.isConnected) return el;
    const anchor = document.querySelector(".meterFooter .odyleDisplay");
    if (!anchor) return null;
    el = document.createElement("button");
    el.type = "button";
    el.className = "a2dAbyss";
    el.hidden = true;
    el.addEventListener("click", (e) => { e.stopPropagation(); base = last?.points ?? null; startAt = 0; render(); });
    anchor.insertAdjacentElement("afterend", el);
    return el;
  }

  function render(gain) {
    const e = node();
    if (!e || !last) return;
    const got = base == null ? 0 : Math.max(0, last.points - base);
    const hours = startAt ? (Date.now() - startAt) / 3.6e6 : 0;
    const rate = hours > 1 / 60 && got ? got / hours : 0;
    e.innerHTML = `<span class="a2dAbIcon">◆</span><b>+${short(got)}</b><small>AP</small>${gain ? `<em>+${fmt(gain)}</em>` : ""}`;
    e.classList.toggle("isFlash", Date.now() < flashUntil);
    const pct = last.limit ? Math.min(100, (last.points / last.limit) * 100) : 0;
    e.title = `Points Abyssaux gagnés depuis le lancement : ${fmt(got)}` +
      (rate ? `\nRythme : ${fmt(rate)} par heure` : "") +
      `\nSemaine : ${fmt(last.points)}${last.limit ? ` / ${fmt(last.limit)} (${pct.toFixed(0)} %)` : ""}` +
      `\nClic : remettre le compteur à zéro`;
    e.hidden = false;
  }

  async function tick() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke || !node()) return;
    try { if (localStorage.getItem(ON_KEY) === "0") { el.hidden = true; return; } } catch {}
    let r;
    try { r = await invoke("a2d_abyss_points"); } catch { return; }
    if (!r || typeof r.points !== "number") return;
    let gain = 0;
    if (base == null || (last && r.points < last.points)) base = r.points; // début, ou remise à zéro du mercredi
    else if (last && r.points > last.points) {
      gain = r.points - last.points;
      if (!startAt) startAt = Date.now();
      flashUntil = Date.now() + 1800;
    }
    last = r;
    render(gain);
  }
  setInterval(tick, 1000);
  setTimeout(tick, 1500);
})();
