// Aion2DpsMeter : calculateur d'efficacité des stats.
//
// Tes stats d'attaque, lues dans les fiches que le jeu t'envoie (a2d_self_stats),
// plus ce que tu changerais (« +3 % Boost de DGT arme, −40 ATQ ») : le gain de
// dégâts en %. Formule reprise de RATmeter (Kuroukihime/AIon2-Dps-Meter,
// StatEfficiencyCalculator.cs, GPL v3) :
//   ATQ effective = ((ATQ équip. × (1 + DGT arme) + ATQ de base + moy. min/max avec
//                   coups parfaits × (1 + DGT arme)) × (1 + hausse d'ATQ)) + ATQ JcE + ATQ boss
//   dégâts = ATQ effective × (1 + boosts de DGT) × critiques × coups puissants × face/dos
(() => {
  if (window.A2_VIEW && window.A2_VIEW !== "main") return;
  const invoke = (...a) => window.__TAURI__?.core?.invoke?.(...a);
  const KEY = "a2d.calc";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; } };
  const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

  // id : identifiant de la stat dans la fiche du jeu ; pct : en centièmes de %.
  const STATS = [
    { k: "gear", id: 317, label: "ATQ de l'équipement" },
    { k: "base", id: 19, label: "ATQ de base" },
    { k: "min", id: 33, label: "ATQ min" },
    { k: "max", id: 31, label: "ATQ max" },
    { k: "pve", id: 56, label: "ATQ JcE" },
    { k: "boss", id: 50, label: "ATQ contre les boss" },
    { k: "atkUp", id: 425, pct: 1, label: "Hausse d'ATQ" },
    { k: "dmg", id: 28, pct: 1, label: "Boost de DGT" },
    { k: "wdb", id: 32, pct: 1, label: "Boost de DGT arme" },
    { k: "pveDmg", id: 379, pct: 1, label: "Boost de DGT JcE" },
    { k: "bossDmg", id: 520, pct: 1, label: "Boost de DGT contre les boss" },
    { k: "critDmg", id: 44, pct: 1, label: "Boost de DGT critiques" },
    { k: "perfect", id: 442, pct: 1, label: "Coup parfait" },
    { k: "smite", id: 443, pct: 1, label: "Coup puissant" },
    { k: "front", id: 589, pct: 1, label: "Boost de DGT de face" },
    { k: "back", id: 102, pct: 1, label: "Boost de DGT de dos" },
  ];
  const ENV = [
    { k: "crit", label: "Chance de critique", def: 50, pct: 1 },
    { k: "dir", label: "Position", def: "back", choices: [["none", "Peu importe"], ["back", "Dans le dos"], ["front", "De face"]] },
    { k: "dirRate", label: "Part des coups dans cette position", def: 80, pct: 1 },
    { k: "partyDmg", label: "Boost de DGT du groupe (buffs)", def: 0, pct: 1, more: 1 },
    { k: "bossTol", label: "Résistance aux DGT du boss", def: 0, pct: 1, more: 1 },
  ];

  const rate = (p) => (Number(p) || 0) / 100;
  const clamp = (p) => Math.max(0, Math.min(100, Number(p) || 0));
  function effectiveAttack(s) {
    const w = rate(s.wdb);
    const avg = (s.max + s.min) / 2;
    const perfect = rate(clamp(s.perfect));
    const minMax = perfect * s.max + (1 - perfect) * avg;
    const raw = s.gear * (1 + w) + s.base + minMax * (1 + w);
    return raw * (1 + rate(s.atkUp)) + s.pve + s.boss;
  }
  function totalDamage(s, e) {
    const critMult = (150 + s.critDmg) / 100;
    const mCrit = 1 + rate(clamp(e.crit)) * (critMult - 1);
    const mSmite = 1 + rate(clamp(s.smite));
    const mDir = e.dir === "back" ? 1 + rate(clamp(e.dirRate)) * rate(s.back) : e.dir === "front" ? 1 + rate(clamp(e.dirRate)) * rate(s.front) : 1;
    const amp = s.dmg + s.pveDmg + s.bossDmg + e.partyDmg - e.bossTol;
    return effectiveAttack(s) * (1 + rate(amp)) * mCrit * mSmite * mDir;
  }

  let open = false, read = null, readAt = 0;
  const state = load(); // { cur: {k: v}, delta: {k: v}, env: {k: v}, more }
  state.cur ||= {}; state.delta ||= {}; state.env ||= {};
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".").replace(/\s/g, "")); return Number.isFinite(n) ? n : 0; };
  const fromGame = (st) => {
    const v = read?.values?.[String(st.id)];
    return v == null ? null : st.pct ? v / 100 : v;
  };
  const cur = (st) => (state.cur[st.k] != null && state.cur[st.k] !== "" ? num(state.cur[st.k]) : fromGame(st) ?? 0);
  const env = () => Object.fromEntries(ENV.map((x) => [x.k, x.choices ? (state.env[x.k] || x.def) : state.env[x.k] != null && state.env[x.k] !== "" ? num(state.env[x.k]) : x.def]));
  const stats = (withDelta) => Object.fromEntries(STATS.map((st) => [st.k, cur(st) + (withDelta ? num(state.delta[st.k]) : 0)]));
  const fmt = (n, d = 0) => (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const panel = () => document.querySelector(".a2dCalc");
  const resize = () => requestAnimationFrame(() => window.javaBridge?.updateOverlaySize?.());

  // Ce que rapporte un petit plus sur chaque stat, pour les classer.
  const STEP = { gear: 100, base: 100, min: 100, max: 100, pve: 100, boss: 100 };
  function ranking(e) {
    const s0 = stats(false), d0 = totalDamage(s0, e);
    if (!(d0 > 0)) return [];
    return STATS.filter((st) => !(st.k === "front" && e.dir !== "front") && !(st.k === "back" && e.dir !== "back"))
      .map((st) => {
        const step = STEP[st.k] || 1;
        const s1 = { ...s0, [st.k]: s0[st.k] + step };
        return { st, step, gain: (totalDamage(s1, e) / d0 - 1) * 100 };
      }).sort((a, b) => b.gain - a.gain);
  }

  function results() {
    const e = env();
    const d0 = totalDamage(stats(false), e), d1 = totalDamage(stats(true), e);
    const gain = d0 > 0 ? (d1 / d0 - 1) * 100 : 0;
    const el = panel();
    if (!el) return;
    const g = el.querySelector(".a2dCalcGain");
    g.textContent = `${gain >= 0 ? "+" : ""}${fmt(gain, 2)} %`;
    g.className = `a2dCalcGain ${gain > 0.005 ? "isUp" : gain < -0.005 ? "isDown" : ""}`;
    el.querySelector(".a2dCalcAtk").textContent = `ATQ effective ${fmt(effectiveAttack(stats(false)))} → ${fmt(effectiveAttack(stats(true)))}`;
    const rk = ranking(e);
    const line = (r) => `<li><span>${esc(r.st.label)} <small>+${r.step}${r.st.pct ? " %" : ""}</small></span><b>+${fmt(r.gain, 2)} %</b></li>`;
    el.querySelector(".a2dCalcRank").innerHTML = rk.filter((r) => r.st.pct).slice(0, 6).map(line).join("")
      + rk.filter((r) => r.st.k === "gear").map((r) => line(r).replace("<li>", '<li class="isAtk">')).join("");
  }

  function render() {
    const el = panel();
    if (!el || !open) return;
    const known = STATS.filter((st) => fromGame(st) != null).length;
    const ago = readAt && read?.at ? Math.max(0, Math.round((Date.now() - read.at) / 60000)) : null;
    const missing = STATS.filter((st) => fromGame(st) == null && (state.cur[st.k] == null || state.cur[st.k] === "")).map((st) => st.label);
    el.innerHTML = `
      <div class="a2dCalcTop"><b>Calculateur de stats</b><span class="a2dCalcSrc">${read?.name ? esc(read.name) + " · " : ""}${known}/${STATS.length} stats lues dans le jeu${ago != null ? ` · il y a ${ago} min` : ""}</span></div>
      <div class="a2dCalcRes"><span class="a2dCalcGain">+0,00 %</span><span class="a2dCalcSub">de dégâts avec les changements<br><span class="a2dCalcAtk"></span></span></div>
      <div class="a2dCalcRankBox"><b>Ce qui te rapporte le plus</b> <small>(gain de dégâts pour +1 %, et pour +100 ATQ)</small><ul class="a2dCalcRank"></ul></div>
      <table class="a2dCalcTab"><thead><tr><th>Stat</th><th>Actuel</th><th>Changement</th></tr></thead><tbody>
      ${STATS.map((st) => {
        const g = fromGame(st);
        const v = state.cur[st.k] ?? "";
        return `<tr><td>${esc(st.label)}${st.pct ? " <small>%</small>" : ""}</td>
          <td><input data-cur="${st.k}" inputmode="decimal" value="${esc(v)}" placeholder="${g != null ? fmt(g, st.pct ? 2 : 0) : "?"}" class="${g != null ? "isGame" : ""}"></td>
          <td><input data-delta="${st.k}" inputmode="decimal" value="${esc(state.delta[st.k] ?? "")}" placeholder="0"></td></tr>`;
      }).join("")}
      </tbody></table>
      ${missing.length ? `<p class="a2dCalcNote">Pas encore reçu du jeu : ${esc(missing.join(", "))}. Tape-les depuis ta fenêtre de personnage, ou change de zone pour que le jeu les renvoie.</p>` : ""}
      <div class="a2dCalcEnv">${ENV.filter((x) => !x.more || state.more).map((x) => x.choices
        ? `<label>${esc(x.label)} <select data-env="${x.k}">${x.choices.map(([v, n]) => `<option value="${v}"${(state.env[x.k] || x.def) === v ? " selected" : ""}>${n}</option>`).join("")}</select></label>`
        : `<label>${esc(x.label)} <input data-env="${x.k}" inputmode="decimal" value="${esc(state.env[x.k] ?? "")}" placeholder="${x.def}"> %</label>`).join("")}
        <button type="button" class="a2dCalcMore">${state.more ? "Moins d'options" : "Plus d'options"}</button>
        <button type="button" class="a2dCalcClear">Effacer les changements</button></div>
      <p class="a2dCalcNote">Gris : valeur lue dans le jeu, tape par-dessus pour la corriger. Formule de RATmeter ; buffs et débuffs du moment compris.</p>`;
    results();
    resize();
  }

  async function refresh() {
    try { read = await invoke("a2d_self_stats"); readAt = Date.now(); } catch {}
  }

  async function setOpen(next) {
    open = next;
    document.querySelector(".meter")?.classList.toggle("a2dCalcOpen", open);
    document.querySelector(".a2dCalcBtn")?.classList.toggle("isActive", open);
    if (open) { await refresh(); render(); } else resize();
  }

  function init() {
    const btn = document.querySelector(".a2dCalcBtn");
    const el = panel();
    if (!btn || !el) return;
    btn.setAttribute("data-no-drag", "true");
    btn.addEventListener("click", () => { if (!window._dpsApp?.isWindowDragging) setOpen(!open); });
    btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } });
    el.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.cur) state.cur[t.dataset.cur] = t.value;
      else if (t.dataset.delta) state.delta[t.dataset.delta] = t.value;
      else if (t.dataset.env) state.env[t.dataset.env] = t.value;
      else return;
      save(state);
      results();
    });
    el.addEventListener("change", (e) => {
      if (e.target.tagName === "SELECT" && e.target.dataset.env) { state.env[e.target.dataset.env] = e.target.value; save(state); results(); }
    });
    el.addEventListener("click", (e) => {
      if (e.target.closest(".a2dCalcMore")) { state.more = !state.more; save(state); render(); }
      if (e.target.closest(".a2dCalcClear")) { state.delta = {}; save(state); render(); }
    });
    // Le jeu renvoie des stats au fil des buffs : on relit, sans toucher à la saisie.
    setInterval(async () => {
      if (!open) return;
      const before = JSON.stringify(read?.values || {});
      await refresh();
      if (JSON.stringify(read?.values || {}) === before) return;
      const focused = document.activeElement?.closest?.(".a2dCalc");
      if (focused) { results(); return; }
      render();
    }, 5000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.A2dCalc = { effectiveAttack, totalDamage, setOpen };
})();
