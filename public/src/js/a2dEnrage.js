// Aion2DpsMeter : minuteur d'enrage, à côté du nom du boss que tu tapes.
//
// Le temps avant l'enrage part du début du combat (données RiftConsole, MIT).
// Rien n'est affiché pour un boss sans enrage connu.
(() => {
  const TABLE = window.A2D_BERSERK || {};
  const fmt = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  let el = null;
  function node() {
    if (el?.isConnected) return el;
    const name = document.querySelector(".bossNames .bossName");
    if (!name) return null;
    el = document.createElement("span");
    el.className = "a2dEnrage";
    el.hidden = true;
    name.insertAdjacentElement("afterend", el);
    return el;
  }

  // code : le code du boss ciblé ; elapsedMs : la durée du combat ; hp : ses
  // PV restants (si connus) ; ttkTotal : la durée totale prévue du combat (ms).
  function update(code, elapsedMs, hp, ttkTotal) {
    const e = node();
    if (!e) return;
    const sec = TABLE[String(Number(code) || 0)];
    const dead = hp != null && Number.isFinite(Number(hp)) && Number(hp) <= 0;
    const elapsed = Number.isFinite(Number(elapsedMs)) && Number(elapsedMs) > 0 ? Number(elapsedMs) : 0;
    // Mort prévue du boss dans… (estimation du meter, d'après les PV qu'il perd).
    const killIn = Number.isFinite(Number(ttkTotal)) && Number(ttkTotal) > 0 ? Number(ttkTotal) - elapsed : null;
    if (dead || (!sec && killIn == null)) {
      e.hidden = true;
      return;
    }
    const left = sec ? sec * 1000 - elapsed : null;
    const late = left != null && killIn != null && killIn > left;
    e.hidden = false;
    e.classList.toggle("isSoon", left != null && left > 0 && left <= 60_000);
    e.classList.toggle("isOn", left != null && left <= 0);
    const enrage = left == null ? "" : left > 0 ? `⏱ ${fmt(left)}` : `ENRAGÉ +${fmt(-left)}`;
    const kill = killIn != null && killIn > 0 ? `<i class="a2dKill${late ? " isLate" : left != null ? " isOk" : ""}">☠ ${fmt(killIn)}</i>` : "";
    e.innerHTML = `${enrage ? `<span>${enrage}</span>` : ""}${kill}`;
    const parts = [];
    if (left != null) parts.push(left > 0 ? `Enrage dans ${fmt(left)} (${fmt(sec * 1000)} après le début du combat)` : `En enrage depuis ${fmt(-left)}`);
    if (kill) parts.push(`Mort du boss estimée dans ${fmt(killIn)}${late ? ", après l'enrage : il faut accélérer" : left != null ? ", avant l'enrage" : ""}`);
    e.title = parts.join("\n");
  }

  window.A2dEnrage = { update, seconds: (code) => TABLE[String(Number(code) || 0)] || 0 };
})();
