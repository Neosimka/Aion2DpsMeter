//! Aion2DpsMeter : les joueurs que tu as tués (ou aidé à tuer) et les Points
//! Abyssaux gagnés sur chacun, pour la vue PvP du meter.
//!
//! Les morts viennent du K/D/A d'A2Tools (`note_player_killed`), les points du
//! total que le jeu envoie (`ab ff`). Un gain de points va au dernier joueur tué
//! qui n'a pas encore les siens, s'il est mort juste avant (ou juste après :
//! le jeu peut envoyer les points avant le record de la mort).

use std::collections::VecDeque;
use std::sync::Mutex;

/// Un gain de points va à une mort de moins de 20 s avant lui…
const BEFORE_MS: i64 = 20_000;
/// … ou de moins de 3 s après lui.
const AFTER_MS: i64 = 3_000;
/// Le plus de points qu'une mise à jour peut compter comme gagnés (au-delà,
/// c'est le total d'un autre personnage à la connexion).
const MAX_GAIN: u64 = 20_000;
const MAX_KILLS: usize = 300;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Kill {
    pub at: i64,
    pub name: String,
    pub assist: bool,
    pub ap: u64,
}

#[derive(Default)]
struct State {
    kills: VecDeque<Kill>,
    last_total: Option<u64>,
    /// Points gagnés pas encore donnés à une mort : (quand, combien).
    pending: Option<(i64, u64)>,
    /// Points gagnés sans mort à côté (quêtes, monstres, artefacts…).
    other_ap: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(State::default))
}

fn settle(s: &mut State, now: i64) {
    if let Some((at, ap)) = s.pending {
        if now - at > AFTER_MS {
            s.other_ap += ap;
            s.pending = None;
        }
    }
}

/// Un joueur est mort de ta main (`assist` : tu l'as touché juste avant).
pub fn kill(name: String, assist: bool, at: i64) {
    with(|s| {
        let mut k = Kill { at, name, assist, ap: 0 };
        if let Some((pat, ap)) = s.pending {
            if pat <= at && at - pat <= AFTER_MS {
                k.ap = ap;
                s.pending = None;
            }
        }
        settle(s, at);
        s.kills.push_back(k);
        while s.kills.len() > MAX_KILLS {
            s.kills.pop_front();
        }
    });
}

/// Le total de Points Abyssaux de la semaine que le jeu vient d'envoyer.
pub fn abyss_total(total: u64, at: i64) {
    with(|s| {
        settle(s, at);
        let before = s.last_total.replace(total);
        let Some(gain) = before.filter(|b| total > *b && total - b <= MAX_GAIN).map(|b| total - b) else { return };
        if let Some(k) = s.kills.iter_mut().rev().find(|k| k.ap == 0 && at >= k.at && at - k.at <= BEFORE_MS) {
            k.ap = gain;
        } else if let Some(k) = s.kills.iter_mut().rev().find(|k| k.at >= at - BEFORE_MS && at >= k.at) {
            // plusieurs mises à jour pour la même mort
            k.ap += gain;
        } else {
            match s.pending.as_mut() {
                Some((_, ap)) => *ap += gain,
                None => s.pending = Some((at, gain)),
            }
        }
    });
}

pub fn reset() {
    with(|s| {
        s.kills.clear();
        s.pending = None;
        s.other_ap = 0;
    });
}

/// Les morts (par joueur) et les totaux de la session.
pub fn snapshot(now: i64) -> serde_json::Value {
    with(|s| {
        settle(s, now);
        let mut by: Vec<(String, u64, u32, u32, i64)> = Vec::new();
        for k in &s.kills {
            match by.iter_mut().find(|e| e.0 == k.name) {
                Some(e) => {
                    e.1 += k.ap;
                    if k.assist { e.3 += 1 } else { e.2 += 1 }
                    e.4 = e.4.max(k.at);
                }
                None => by.push((k.name.clone(), k.ap, u32::from(!k.assist), u32::from(k.assist), k.at)),
            }
        }
        by.sort_by(|a, b| b.1.cmp(&a.1).then(b.4.cmp(&a.4)));
        let players: Vec<_> = by
            .iter()
            .map(|(name, ap, kills, assists, last)| serde_json::json!({ "name": name, "ap": ap, "kills": kills, "assists": assists, "last": last }))
            .collect();
        let pvp_ap: u64 = s.kills.iter().map(|k| k.ap).sum();
        serde_json::json!({
            "players": players,
            "kills": s.kills.iter().filter(|k| !k.assist).count(),
            "assists": s.kills.iter().filter(|k| k.assist).count(),
            "pvpAp": pvp_ap,
            "otherAp": s.other_ap,
        })
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn a2d_pvp_state() -> serde_json::Value {
    snapshot(crate::clock::now_ms())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn a2d_pvp_reset() {
    reset();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_go_to_the_player_killed() {
        reset();
        with(|s| s.last_total = None);
        abyss_total(100_000, 0);
        kill("Lyrael".into(), false, 10_000);
        abyss_total(101_240, 11_000);
        kill("Kael".into(), true, 30_000);
        // points avant la mort (2 s)
        abyss_total(101_740, 60_000);
        kill("Morw".into(), false, 62_000);
        // points sans mort
        abyss_total(102_000, 120_000);
        let v = snapshot(200_000);
        let p = v["players"].as_array().unwrap();
        assert_eq!(p[0]["name"], "Lyrael");
        assert_eq!(p[0]["ap"], 1240);
        assert_eq!(p[1]["name"], "Morw");
        assert_eq!(p[1]["ap"], 500);
        assert_eq!(v["kills"], 2);
        assert_eq!(v["assists"], 1);
        assert_eq!(v["pvpAp"], 1740);
        assert_eq!(v["otherAp"], 260);
    }
}
