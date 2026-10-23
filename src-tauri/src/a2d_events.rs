//! Aion2DpsMeter : panneau Événements de l'overlay (Failles, invasions,
//! festivals, sièges, boss programmés et boss de terrain).
//!
//! Les horaires viennent des tables du jeu (public/src/js/a2dEventsData.js,
//! repris d'Event Timers d'A2Tools) ; il ne faut ici que le serveur du
//! personnage, pour l'heure du serveur et la faction, et les timers des boss de
//! terrain que les meters des joueurs publient sur a2tools.app.

use serde_json::Value;

/// Le personnage connu du meter : nom, serveur, niveau, classe.
#[tauri::command]
pub fn a2d_character(app: tauri::AppHandle) -> Option<Value> {
    crate::plugins::character(&app)
}

/// Les timers des boss de terrain d'un serveur (flux d'a2tools.app), ou None
/// si ce serveur n'en a pas encore.
#[tauri::command]
pub async fn a2d_boss_timers(app: tauri::AppHandle, server: u32) -> Result<Option<Value>, String> {
    if !(1000..10000).contains(&server) {
        return Err("not a server id".into());
    }
    crate::plugins::boss_timers(&app, server).await
}
