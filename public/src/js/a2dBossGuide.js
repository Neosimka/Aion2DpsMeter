// Aion2DpsMeter : guide de boss en direct pour le raid Ludra.
//
// Sous la barre du boss : la prochaine mécanique et à combien de % de PV elle
// tombe (avec le temps estimé d'après la vitesse à laquelle le boss perd ses
// PV), en rouge si elle fait wiper, puis un bandeau quand elle arrive. Une voix
// (voix Windows) l'annonce quelques secondes avant, puis dit quoi faire.
// Seuils de Ludra éternel : 8 essais de la légion rejoués depuis les captures du meter ;
// Rahu : deux kills de la légion rejoués depuis les captures du meter. Ketu et le Réacteur n'ont pas de seuil
// connu : une ligne de rappel à la place.
(() => {
  const K = { on: "a2d.guide.on", voice: "a2d.guide.voice", wipeOnly: "a2d.guide.wipeOnly", vol: "a2d.guide.volume" };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const on = () => get(K.on, "1") !== "0";
  const voiceOn = () => get(K.voice, "1") !== "0";
  const wipeOnly = () => get(K.wipeOnly, "0") === "1";
  const volume = () => Math.max(0, Math.min(100, Number(get(K.vol, "80")) || 0));

  const BOSS = {
    ludra: {
      name: "Ludra éternel", enrage: 600,
      // Seuils relevés sur 8 essais de La Chevrerie, dont 2 kills (22/11/2026, Normal).
      steps: [
        { at: 92, name: "Orbes", warn: "Orbes", say: "Tours d'orbes. Bleues dedans, la rouge sous blocage." },
        { at: 85, name: "Arène qui rétrécit", warn: "L'arène rétrécit", say: "L'arène rétrécit. Restez loin du bord." },
        { at: 74, name: "Coup sur tout le raid", warn: "Gros coup", say: "Gros coup sur tout le raid. Défensifs et soins." },
        { at: 52, name: "Coup sur tout le raid", warn: "Gros coup", say: "Gros coup sur tout le raid, puis Bingo." },
        { at: 50, name: "Bingo", wipe: true, warn: "Bingo", say: "Bingo. Allez sur vos numéros, par deux depuis les coins." },
        { at: 43, name: "Lasers de Zikel", warn: "Zikel", say: "Lasers de Zikel. Sortez des lignes." },
        { at: 33, name: "Couleurs", wipe: true, warn: "Couleurs", say: "Couleurs. Bleu à gauche, rouge à droite." },
        { at: 23, name: "Bingo", wipe: true, warn: "Deuxième Bingo", say: "Deuxième Bingo. Sautez d'abord, puis vos numéros." },
        { at: 10, name: "Cercles de couleur", wipe: true, warn: "Cercles", say: "Cercles. Chacun dans sa couleur, à deux secondes de la fin." },
      ],
    },
    rahu: {
      name: "Rahu",
      // Seuils relevés sur deux kills de La Chevrerie (22/11/2026, Normal).
      steps: [
        { at: 85, name: "Salve de 20 s", warn: "Salve", say: "Salve de vingt secondes. Défensifs et soins prêts." },
        { at: 63, name: "Vague de monstres", warn: "Monstres", say: "Monstres. Les distances les prennent." },
        { at: 48, name: "Arène en quatre", warn: "Arène en quatre", say: "Arène en quatre. Tous du même côté, le tank au centre." },
        { at: 31, name: "Temps de prédation", wipe: true, warn: "Prédateurs", say: "Temps de prédation. Le rayon rouge sur les quatre prédateurs." },
      ],
    },
    ketu: { name: "Ketu", tip: "Main levée : côté du laser · œil rouge : face, bleu : dos · ta pierre juste avant le gros coup" },
    reac: { name: "Réacteur", tip: "Anneau : colle au cœur · croix : entre les branches · bouclier : casse les réacteurs auxiliaires" },
  };
  const CODES = {
    2301014: "ludra", 2300290: "ludra", 2301006: "rahu", 2300282: "rahu",
    2301007: "ketu", 2300283: "ketu", 2301008: "reac", 2300284: "reac",
  };
  const kindOf = (code, name, isBoss) => {
    if (CODES[code]) return CODES[code];
    if (!isBoss) return null;
    const n = String(name || "");
    if (/follower|disciple|auxiliai|auxiliary/i.test(n)) return null;
    if (/ludra/i.test(n)) return "ludra";
    if (/rahu/i.test(n)) return "rahu";
    if (/ketu/i.test(n)) return "ketu";
    if (/fusion|réacteur|reactor/i.test(n)) return "reac";
    return null;
  };

  // ---------- voix ----------
  let frVoice = null;
  const pickVoice = () => {
    const list = window.speechSynthesis?.getVoices?.() || [];
    frVoice = list.find((v) => /^fr(-|_|$)/i.test(v.lang)) || null;
  };
  try { pickVoice(); window.speechSynthesis?.addEventListener?.("voiceschanged", pickVoice); } catch {}
  function speak(text, force) {
    if ((!voiceOn() && !force) || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      if (frVoice) u.voice = frVoice;
      u.lang = frVoice?.lang || "fr-FR";
      u.volume = volume() / 100;
      u.rate = 1.1;
      window.speechSynthesis.speak(u);
    } catch {}
  }

  // ---------- affichage ----------
  let el = null;
  const node = () => {
    if (el?.isConnected) return el;
    const anchor = document.querySelector(".a2dBossRow") || document.querySelector(".bossHpBar") || document.querySelector(".meter > .header");
    if (!anchor) return null;
    el = document.createElement("div");
    el.className = "a2dGuide";
    el.hidden = true;
    el.innerHTML = '<div class="a2dGuideNext"></div><div class="a2dGuideLast"></div>';
    anchor.insertAdjacentElement("afterend", el);
    return el;
  };
  const resize = () => requestAnimationFrame(() => window.javaBridge?.updateOverlaySize?.());
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- suivi du combat ----------
  let cur = null; // { kind, code, done:Set, warned:Set, samples:[], banner:{text,wipe,until}, enrageWarned }
  const fresh = (kind, code) => ({ kind, code, done: new Set(), warned: new Set(), samples: [], banner: null, enrageWarned: false, lastPct: 100, lastElapsed: 0 });

  // % de PV perdus par seconde, sur les 12 dernières secondes.
  function rate(now) {
    const s = cur.samples.filter((x) => now - x.t <= 12_000);
    cur.samples = s;
    if (s.length < 2) return 0;
    const a = s[0], b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt >= 2 && a.pct > b.pct ? (a.pct - b.pct) / dt : 0;
  }
  const fmtS = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.max(1, Math.round(s))} s`);

  function update({ code, name, maxHp, hp, totalDamage, elapsed, isBoss }) {
    const e = node();
    if (!e) return;
    const kind = on() ? kindOf(Number(code) || 0, name, isBoss) : null;
    const max = Number(maxHp) || 0;
    if (!kind || max <= 0) {
      if (!e.hidden) { e.hidden = true; resize(); }
      return;
    }
    const live = Number(hp);
    const left = Number.isFinite(live) && live >= 0 ? Math.min(max, live) : Math.max(0, max - (Number(totalDamage) || 0));
    const pct = (left / max) * 100;
    const ms = Number(elapsed) || 0;
    // Nouveau combat : autre boss, minuteur reparti de zéro, ou PV remontés (wipe).
    if (!cur || cur.code !== code || cur.kind !== kind || ms + 5000 < cur.lastElapsed || pct > cur.lastPct + 10) {
      cur = fresh(kind, code);
      // Meter ouvert en plein combat : les mécaniques déjà passées ne sont pas rejouées.
      for (const st of BOSS[kind].steps || []) if (pct <= st.at) { cur.done.add(st.at); cur.warned.add(st.at); }
      if (BOSS[kind].enrage && ms >= (BOSS[kind].enrage - 60) * 1000) cur.enrageWarned = true;
    }
    cur.lastPct = pct;
    cur.lastElapsed = ms;
    const now = Date.now();
    cur.samples.push({ t: now, pct });
    const b = BOSS[kind];
    const r = rate(now);

    // Mécaniques : passées, imminentes, prochaine.
    let next = null;
    for (const st of b.steps || []) {
      if (cur.done.has(st.at)) continue;
      if (pct <= st.at) {
        cur.done.add(st.at);
        cur.banner = { text: st.name, say: st.say, wipe: !!st.wipe, until: now + 8000 };
        if (!wipeOnly() || st.wipe) speak(st.say);
        continue;
      }
      if (!next) next = st;
    }
    let eta = null;
    if (next) {
      eta = r > 0 ? (pct - next.at) / r : null;
      const soon = eta != null ? eta <= 5 : pct - next.at <= 1.5;
      if (soon && !cur.warned.has(next.at)) {
        cur.warned.add(next.at);
        if (!wipeOnly() || next.wipe) speak(eta != null ? `${next.warn} dans ${Math.max(1, Math.round(eta))}` : `${next.warn} bientôt`);
      }
    }
    if (b.enrage && !cur.enrageWarned && ms >= (b.enrage - 60) * 1000 && pct > 0) {
      cur.enrageWarned = true;
      speak("Enrage dans une minute.");
    }

    // Ligne affichée.
    const top = e.querySelector(".a2dGuideNext");
    let html;
    if (cur.banner && now < cur.banner.until) {
      html = `<span class="a2dGuideBanner${cur.banner.wipe ? " isWipe" : ""}">${cur.banner.wipe ? "☠ " : "◆ "}${esc(cur.banner.text.toUpperCase())}</span><span class="a2dGuideSay">${esc(cur.banner.say)}</span>`;
    } else if (next) {
      const gap = Math.max(0, pct - next.at);
      const when = eta != null ? `~${fmtS(eta)}` : `${gap.toFixed(1)} %`;
      html = `<span class="a2dGuideTag${next.wipe ? " isWipe" : ""}">${next.wipe ? "☠" : "◆"} ${esc(next.name)}</span><span class="a2dGuideAt">à ${next.at} %</span><span class="a2dGuideEta${eta != null && eta <= 10 ? " isSoon" : ""}">${when}</span>`;
    } else if (b.tip) {
      html = `<span class="a2dGuideTip">${esc(b.tip)}</span>`;
    } else {
      html = `<span class="a2dGuideTip">Plus de mécanique annoncée : finissez-le</span>`;
    }
    if (top.innerHTML !== html) top.innerHTML = html;
    top.title = (b.steps || []).map((s) => `${s.at} % : ${s.name}${s.wipe ? " (wipe)" : ""}`).join("\n") || b.tip || "";
    if (e.hidden) { e.hidden = false; resize(); }
    pollCasts();
  }

  // ---------- dernière attaque du boss (relevé du meter) ----------
  let lastPoll = 0, lastCastAt = null, lastCast = null;
  async function pollCasts() {
    const now = Date.now();
    if (now - lastPoll < 1000) return;
    lastPoll = now;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke || !cur) return;
    try {
      const list = await invoke("a2d_boss_casts");
      const mine = (list || []).filter((c) => kindOf(c.mob, "", false) === cur?.kind);
      const c = mine[mine.length - 1];
      if (c && c.at !== lastCastAt) { lastCastAt = c.at; lastCast = { name: c.name || `#${c.skill}`, seen: now }; }
    } catch {}
    const line = el?.querySelector(".a2dGuideLast");
    if (!line) return;
    const txt = lastCast && now - lastCast.seen < 30_000 && !/^(Attack|Attaque)$/i.test(lastCast.name) ? `Dernière attaque : ${lastCast.name}` : "";
    if (line.textContent !== txt) { line.textContent = txt; line.hidden = !txt; resize(); }
  }

  // ---------- réglages ----------
  function bind() {
    const box = (cls, key, def, after) => {
      const cb = document.querySelector(cls);
      if (!cb) return;
      cb.checked = get(key, def) === "1";
      cb.addEventListener("change", () => { set(key, cb.checked ? "1" : "0"); after?.(cb.checked); });
    };
    box(".a2dGuideCheckbox", K.on, "1", (v) => { if (!v && el) { el.hidden = true; resize(); } });
    box(".a2dGuideVoiceCheckbox", K.voice, "1", (v) => { if (v) speak("Bingo dans 5.", true); });
    box(".a2dGuideWipeCheckbox", K.wipeOnly, "0");
    const range = document.querySelector(".a2dGuideVolumeInput");
    const val = document.querySelector(".a2dGuideVolumeValue");
    if (range) {
      range.value = String(volume());
      if (val) val.textContent = `${volume()}%`;
      range.addEventListener("input", () => { set(K.vol, range.value); if (val) val.textContent = `${range.value}%`; });
      range.addEventListener("change", () => speak("Couleurs. Bleu à gauche, rouge à droite.", true));
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();

  window.A2dBossGuide = { update, speak, kindOf, BOSS };
})();
