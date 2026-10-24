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

/// L'heure exacte (ms), d'après le serveur qui publie les timers (en-tête
/// `Date` de sa réponse) : l'horloge du PC peut dériver de plusieurs dizaines
/// de secondes, et les timers des boss sont des heures absolues.
#[cfg(feature = "online")]
#[tauri::command]
pub async fn a2d_server_clock(app: tauri::AppHandle) -> Result<i64, String> {
    use tauri::Manager;
    let state = app.try_state::<crate::app::AppState>().ok_or("no app state")?;
    let sent = chrono::Utc::now().timestamp_millis();
    let res = state
        .http
        .head("https://cdn.a2tools.app/feeds/boss-timers/1103.json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let back = chrono::Utc::now().timestamp_millis();
    let date = res
        .headers()
        .get(reqwest::header::DATE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| chrono::DateTime::parse_from_rfc2822(v).ok())
        .ok_or("no Date header")?;
    // L'en-tête est à la seconde près : +500 ms pour viser le milieu, et
    // l'aller-retour partagé en deux.
    let server = date.timestamp_millis() + 500;
    Ok(server + (back - sent) / 2 - back + chrono::Utc::now().timestamp_millis())
}

#[cfg(not(feature = "online"))]
#[tauri::command]
pub async fn a2d_server_clock() -> Result<i64, String> {
    Err("this meter is built without network features".into())
}
