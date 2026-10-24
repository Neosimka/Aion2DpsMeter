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

  // code : le code du boss ciblé ; elapsedMs : la durée du combat ; hp : ses PV restants (si connus).
  function update(code, elapsedMs, hp) {
    const e = node();
    if (!e) return;
    const sec = TABLE[String(Number(code) || 0)];
    if (!sec || (hp != null && Number.isFinite(Number(hp)) && Number(hp) <= 0)) {
      e.hidden = true;
      return;
    }
    const elapsed = Number.isFinite(Number(elapsedMs)) && Number(elapsedMs) > 0 ? Number(elapsedMs) : 0;
    const left = sec * 1000 - elapsed;
    e.hidden = false;
    e.classList.toggle("isSoon", left > 0 && left <= 60_000);
    e.classList.toggle("isOn", left <= 0);
    e.textContent = left > 0 ? `⏱ ${fmt(left)}` : `ENRAGÉ +${fmt(-left)}`;
    e.title = left > 0
      ? `Enrage dans ${fmt(left)} (${fmt(sec * 1000)} après le début du combat)`
      : `Le boss est en enrage depuis ${fmt(-left)}`;
  }

  window.A2dEnrage = { update, seconds: (code) => TABLE[String(Number(code) || 0)] || 0 };
})();
