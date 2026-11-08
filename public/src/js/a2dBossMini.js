// Aion2DpsMeter : la vie du boss en petite barre rouge avec son pourcentage
// (comme les autres meters), sur une ligne sous l'en-tête, avec le record à côté.
// Elle recopie la grande barre, que core.js tient à jour ; la grande barre est
// masquée tant que l'option est cochée (Apparence, cochée par défaut).
(() => {
  const KEY = "a2d.bossbar.mini";
  const isOn = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };
  let row = null;

  const ensureRow = () => {
    if (row?.isConnected) return row;
    const header = document.querySelector(".meter > .header");
    if (!header) return null;
    row = document.createElement("div");
    row.className = "a2dBossRow";
    row.hidden = true;
    row.innerHTML = '<span class="a2dBossMini"><span class="a2dBossMiniFill"></span><span class="a2dBossMiniPct"></span></span>';
    header.insertAdjacentElement("afterend", row);
    return row;
  };

  const sync = () => {
    const on = isOn();
    document.documentElement.classList.toggle("a2dBossMiniOn", on);
    const r = ensureRow();
    if (!r) return;
    const bar = document.querySelector(".bossHpBar");
    const rec = document.querySelector(".a2dRecord");
    // Le record suit la barre affichée : dans la ligne, ou sous la grande barre.
    if (rec) {
      if (on && rec.parentElement !== r) r.appendChild(rec);
      else if (!on && bar && rec.previousElementSibling !== bar) bar.insertAdjacentElement("afterend", rec);
    }
    const mini = r.querySelector(".a2dBossMini");
    const boss = !!bar && bar.style.display !== "none";
    mini.hidden = !boss;
    r.hidden = !on || (!boss && (!rec || rec.hidden));
    if (!boss) return;
    const pct = Math.max(0, Math.min(100, parseFloat(bar.querySelector(".bossHpFill")?.style.width) || 0));
    mini.querySelector(".a2dBossMiniFill").style.width = `${pct}%`;
    mini.querySelector(".a2dBossMiniPct").textContent = `${pct.toFixed(1)}%`;
    mini.classList.toggle("isLow", pct <= 25);
  };

  const start = () => {
    const bar = document.querySelector(".bossHpBar");
    if (bar) new MutationObserver(sync).observe(bar, { attributes: true, subtree: true, attributeFilter: ["style", "class"] });
    const cb = document.querySelector(".a2dBossMiniCheckbox");
    if (cb) {
      cb.checked = isOn();
      cb.addEventListener("change", () => { try { localStorage.setItem(KEY, cb.checked ? "1" : "0"); } catch {} sync(); });
    }
    // Le réglage peut venir de la fenêtre des réglages.
    window.addEventListener("storage", (e) => { if (e.key === KEY) sync(); });
    sync();
    setInterval(sync, 500);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
