//! Aion2DpsMeter : combien de joueurs autour de toi, alliés et ennemis.
//!
//! Le serveur envoie au meter chaque joueur qui entre dans ta zone de
//! visibilité (`44/45 36`, avec son serveur) et dit quand il en sort
//! (`note_despawn`) ; un chargement de carte redistribue les identifiants, donc
//! la liste repart de zéro. La faction se lit au serveur : 1xxx Élyséens,
//! 2xxx Asmodiens. Les joueurs morts ne comptent pas : mort quand le jeu
//! l'annonce, de nouveau en vie quand il réapparaît, que ses PV remontent ou
//! qu'il agit (frappe ou soigne). Rien n'est lu dans le jeu, seulement le réseau.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Au-delà, un oubli de sortie gonflerait le compte : on garde les plus récents.
const MAX_PLAYERS: usize = 2000;

#[derive(Clone, Copy)]
struct Seen {
    /// 0 quand le serveur n'est pas connu.
    server: u16,
    at: i64,
    dead: bool,
}

fn players() -> &'static Mutex<HashMap<i32, Seen>> {
    static P: OnceLock<Mutex<HashMap<i32, Seen>>> = OnceLock::new();
    P.get_or_init(Mutex::default)
}

/// 1 Élyséens, 2 Asmodiens, 0 inconnu.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
fn faction(server: u16) -> u8 {
    match server / 1000 {
        1 => 1,
        2 => 2,
        _ => 0,
    }
}

/// Un joueur est apparu autour de toi.
pub fn spawn(id: i32, server: Option<u16>) {
    let Ok(mut p) = players().lock() else { return };
    let server = server.unwrap_or(0);
    let entry = p.entry(id).or_insert(Seen { server, at: 0, dead: false });
    if server != 0 {
        entry.server = server;
    }
    // Une réapparition (après une mort, au point de résurrection) : en vie.
    entry.dead = false;
    entry.at = crate::clock::now_ms();
    if p.len() > MAX_PLAYERS {
        let mut all: Vec<(i32, i64)> = p.iter().map(|(&k, s)| (k, s.at)).collect();
        all.sort_by_key(|&(_, at)| at);
        for (k, _) in all.into_iter().take(p.len() - MAX_PLAYERS) {
            p.remove(&k);
        }
    }
}

/// Une entité est morte (joueur ou non : seuls les joueurs suivis comptent).
pub fn died(id: i32) {
    if let Ok(mut p) = players().lock() {
        if let Some(s) = p.get_mut(&id) {
            s.dead = true;
        }
    }
}

/// Un joueur est de nouveau en vie : ses PV remontent, ou il frappe ou soigne.
pub fn alive(id: i32) {
    if let Ok(mut p) = players().lock() {
        if let Some(s) = p.get_mut(&id).filter(|s| s.dead) {
            s.dead = false;
        }
    }
}

/// Une entité a quitté ta zone (joueur ou non).
pub fn gone(id: i32) {
    if let Ok(mut p) = players().lock() {
        p.remove(&id);
    }
}

/// Changement de carte : les identifiants changent, tout le monde sera renvoyé.
pub fn clear() {
    if let Ok(mut p) = players().lock() {
        p.clear();
    }
}

/// (alliés, ennemis, inconnus) autour de toi, toi exclu. Sans ta faction
/// connue, tout le monde compte comme inconnu.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub fn counts(me: Option<i32>, my_server: u16) -> (u32, u32, u32) {
    let Ok(p) = players().lock() else { return (0, 0, 0) };
    let mine = faction(my_server);
    let (mut allies, mut enemies, mut unknown) = (0, 0, 0);
    for (&id, s) in p.iter() {
        if Some(id) == me || s.dead {
            continue;
        }
        let f = faction(s.server);
        if mine == 0 || f == 0 {
            unknown += 1;
        } else if f == mine {
            allies += 1;
        } else {
            enemies += 1;
        }
    }
    (allies, enemies, unknown)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn a2d_nearby_players(app: tauri::AppHandle) -> serde_json::Value {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::app::AppState>() else {
        return serde_json::Value::Null;
    };
    let me = state.data_storage.local_player_id().and_then(|id| i32::try_from(id).ok());
    let server = state.data_storage.local_profile().server_id;
    let (allies, enemies, unknown) = counts(me, server);
    serde_json::json!({ "allies": allies, "enemies": enemies, "unknown": unknown, "factionKnown": faction(server) != 0 })
}

/// Les Points Abyssaux de la semaine et leur plafond, tels que le jeu les a
/// envoyés (le compteur de la session se fait côté page).
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn a2d_abyss_points(app: tauri::AppHandle) -> serde_json::Value {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::app::AppState>() else {
        return serde_json::Value::Null;
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    match state.data_storage.abyss_points_at(now) {
        Some((points, limit)) => serde_json::json!({ "points": points, "limit": limit }),
        None => serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allies_and_enemies_by_server() {
        clear();
        spawn(987610, Some(1303)); // moi
        spawn(987611, Some(1301));
        spawn(987612, Some(2105));
        spawn(987613, None);
        spawn(987614, Some(2105));
        assert_eq!(counts(Some(987610), 1303), (1, 2, 1));
        died(987611);
        died(987614);
        assert_eq!(counts(Some(987610), 1303), (0, 1, 1), "les morts ne comptent pas");
        alive(987611);
        spawn(987614, Some(2105)); // réapparu au point de résurrection
        assert_eq!(counts(Some(987610), 1303), (1, 2, 1));
        gone(987612);
        assert_eq!(counts(Some(987610), 1303), (1, 1, 1));
        assert_eq!(counts(Some(987610), 0), (0, 0, 3), "sans ta faction : inconnus");
        clear();
        assert_eq!(counts(None, 1303), (0, 0, 0));
    }
}
