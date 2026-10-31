// Aion2DpsMeter : ton record sur le boss que tu tapes, sous sa barre de PV.
//
// « Record 109k/s · −38 % » : ton meilleur DPS sur ce boss (ce personnage, ce
// donjon) et où tu en es par rapport à lui ; « meilleur kill 2:41 » : le kill le
// plus rapide de ton groupe. Les records sont ceux de l'historique (onglet
// Records, personal_bests.json) : boss de donjon seulement.
(() => {
  let encounters = [];
  let loadedAt = 0;
  let loading = false;
  let lastCode = 0;
  let el = null;
  let lastArgs = null;

  const fmtTime = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  const fmtDps = (v) => {
    const app = window.dpsApp;
    const text = app?.formatDpsThousands ? app.formatDpsThousands(v) : `${Math.round(v / 1000)}k`;
    return `${text}/s`;
  };

  async function load(force = false) {
    if (loading || (!force && Date.now() - loadedAt < 60_000)) return;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    loading = true;
    try {
      const list = await invoke("get_personal_bests");
      if (Array.isArray(list)) encounters = list;
      loadedAt = Date.now();
      // Le meter ne redessine que quand les chiffres changent : on réaffiche.
      if (lastArgs) setTimeout(() => update(lastArgs, true), 0);
    } catch {
      loadedAt = Date.now();
    } finally {
      loading = false;
    }
  }

  function node() {
    if (el?.isConnected) return el;
    const bar = document.querySelector(".bossHpBar");
    if (!bar) return null;
    el = document.createElement("div");
    el.className = "a2dRecord";
    el.hidden = true;
    bar.insertAdjacentElement("afterend", el);
    return el;
  }

  // Le record de `me` sur ce boss : celui du donjon actuel, sinon le meilleur.
  function find(code, dungeonId, me) {
    const name = String(me || "").trim().toLowerCase();
    const mine = encounters.filter((e) => Number(e.mobCode) === code && (!name || String(e.character || "").toLowerCase() === name));
    if (!mine.length) return null;
    const here = mine.filter((e) => Number(e.dungeonId) === Number(dungeonId));
    const pool = here.length ? here : mine;
    return pool.reduce((best, e) => ((e.myDps?.value || 0) > (best.myDps?.value || 0) ? e : best), pool[0]);
  }

  // code : le boss ciblé ; dungeonId ; dps : ton DPS dans ce combat ; me : ton pseudo.
  function update(args, fromLoad = false) {
    const { dungeonId, dps, me, isBoss } = args || {};
    let { code } = args || {};
    lastArgs = args;
    const e = node();
    if (!e) return;
    code = Number(code) || 0;
    if (fromLoad) {
      // rien à recharger
    } else if (code !== lastCode) {
      lastCode = code;
      if (code) load(true);
    } else {
      load();
    }
    const rec = code && isBoss && Number(dungeonId) > 0 ? find(code, dungeonId, me) : null;
    const best = rec?.myDps?.value || 0;
    const fastest = rec?.fastest?.value || 0;
    if (!best && !fastest) {
      e.hidden = true;
      return;
    }
    const now = Number(dps) || 0;
    let html = "";
    if (best) {
      const diff = now > 0 ? Math.round((now / best - 1) * 100) : null;
      const cls = diff == null ? "" : diff >= 0 ? " isUp" : " isDown";
      html += `<span class="a2dRecBest">🏆 Record <b>${fmtDps(best)}</b>${diff != null ? ` <i class="a2dRecDiff${cls}">${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff)} %</i>` : ""}</span>`;
    }
    if (fastest) html += `<span class="a2dRecFast">⏱ meilleur kill <b>${fmtTime(fastest)}</b></span>`;
    e.innerHTML = html;
    e.hidden = false;
    const kills = rec.archived?.kills || 0;
    e.title = `Ton record sur ${rec.bossName || "ce boss"}${rec.myDps?.job ? ` (${rec.myDps.job})` : ""}` +
      (rec.partyDps?.value ? `\nMeilleur DPS du groupe : ${fmtDps(rec.partyDps.value)}` : "") +
      (fastest ? `\nKill le plus rapide : ${fmtTime(fastest)}` : "") +
      "\nTous tes records : Historique › Records personnels";
  }

  window.A2dRecord = { update, reload: () => load(true) };
})();
