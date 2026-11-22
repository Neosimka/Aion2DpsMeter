//! Aion2DpsMeter : les joueurs que tu as tués (ou aidé à tuer) et les Points
//! Abyssaux gagnés sur chacun, pour la vue PvP du meter.
//!
//! Les morts viennent du K/D/A d'A2Tools (`note_player_killed`), les points du
//! total que le jeu envoie (`ab ff`). Le jeu peut envoyer les points avant ou
//! après le record de la mort : chaque gain va à la mort la plus proche dans
//! le temps qui n'a pas encore de points, jamais à une mort déjà payée.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Points arrivés juste après une mort : à elle tout de suite.
const AFTER_KILL_MS: i64 = 3_000;
/// Points arrivés sans mort juste avant : attendus jusqu'à 8 s une mort…
const WAIT_MS: i64 = 8_000;
/// … puis donnés à la dernière mort sans points de moins de 20 s, sinon hors PvP.
const BEFORE_MS: i64 = 20_000;
/// Le plus de points qu'une mise à jour peut compter comme gagnés (au-delà,
/// c'est le total d'un autre personnage à la connexion).
const MAX_GAIN: u64 = 20_000;
const MAX_KILLS: usize = 300;
/// Après ce délai, plus aucun gain ne peut aller à une mort : ses points sont
/// définitifs et elle peut partir au site de la légion.
#[allow(dead_code)]
const FINAL_MS: i64 = BEFORE_MS + WAIT_MS + 2_000;

/// Comment le joueur est mort pour toi.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum How {
    /// Le dernier coup est le tien.
    Kill,
    /// Tu l'as touché juste avant sa mort.
    Assist,
    /// Quelqu'un de ton groupe l'a tué, sans que tu le touches.
    Group,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Kill {
    pub at: i64,
    pub name: String,
    pub how: How,
    pub ap: u64,
    /// Déjà remise à l'envoi au site (`take_final`).
    pub taken: bool,
}

impl How {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            How::Kill => "kill",
            How::Assist => "assist",
            How::Group => "group",
        }
    }
}

#[derive(Default)]
struct State {
    kills: VecDeque<Kill>,
    last_total: Option<u64>,
    /// Gains pas encore donnés à une mort : (quand, combien).
    pending: VecDeque<(i64, u64)>,
    /// Points gagnés sans mort à côté (quêtes, monstres, artefacts…).
    other_ap: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(State::default))
}

/// Les gains qui ont assez attendu : à la dernière mort sans points d'avant eux,
/// sinon hors PvP.
fn settle(s: &mut State, now: i64) {
    while let Some(&(at, ap)) = s.pending.front() {
        if now - at <= WAIT_MS {
            break;
        }
        s.pending.pop_front();
        match s.kills.iter_mut().rev().find(|k| k.ap == 0 && k.at <= at && at - k.at <= BEFORE_MS) {
            Some(k) => k.ap = ap,
            None => s.other_ap += ap,
        }
    }
}

/// Un joueur est mort : de ta main, avec ton aide, ou de celle de ton groupe.
pub fn kill(name: String, how: How, at: i64) {
    with(|s| {
        settle(s, at);
        let mut k = Kill { at, name, how, ap: 0, taken: false };
        // des points arrivés juste avant ce record : les plus anciens d'abord
        if let Some(i) = s.pending.iter().position(|&(pat, _)| pat <= at && at - pat <= WAIT_MS) {
            k.ap = s.pending.remove(i).map(|(_, ap)| ap).unwrap_or(0);
        }
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
        tracing::info!("PvP: +{gain} Abyss Points at {at}");
        // juste après une mort qui n'a pas encore ses points : à elle
        if let Some(k) = s.kills.iter_mut().rev().find(|k| k.ap == 0 && k.at <= at && at - k.at <= AFTER_KILL_MS) {
            k.ap = gain;
        } else {
            s.pending.push_back((at, gain));
        }
    });
}

/// Les morts dont les points sont définitifs et pas encore remises à l'envoi :
/// chacune n'est rendue qu'une fois. Un kill du groupe sans points est ignoré.
#[allow(dead_code)]
pub fn take_final(now: i64) -> Vec<Kill> {
    with(|s| {
        settle(s, now);
        let mut out = Vec::new();
        for k in s.kills.iter_mut().filter(|k| !k.taken && now - k.at > FINAL_MS) {
            k.taken = true;
            if k.how != How::Group || k.ap > 0 {
                out.push(k.clone());
            }
        }
        out
    })
}

pub fn reset() {
    with(|s| {
        s.kills.clear();
        s.pending.clear();
        s.other_ap = 0;
    });
}

/// Les morts (par joueur) et les totaux de la session. Une mort du groupe sans
/// points n'est pas montrée : elle ne t'a rien rapporté.
pub fn snapshot(now: i64) -> serde_json::Value {
    with(|s| {
        settle(s, now);
        // nom, AP, kills, assists, groupe, dernière mort
        let mut by: Vec<(String, u64, u32, u32, u32, i64)> = Vec::new();
        for k in s.kills.iter().filter(|k| k.how != How::Group || k.ap > 0) {
            let e = match by.iter_mut().position(|e| e.0 == k.name) {
                Some(i) => &mut by[i],
                None => {
                    by.push((k.name.clone(), 0, 0, 0, 0, k.at));
                    by.last_mut().expect("just pushed")
                }
            };
            e.1 += k.ap;
            match k.how {
                How::Kill => e.2 += 1,
                How::Assist => e.3 += 1,
                How::Group => e.4 += 1,
            }
            e.5 = e.5.max(k.at);
        }
        by.sort_by(|a, b| b.1.cmp(&a.1).then(b.5.cmp(&a.5)));
        let players: Vec<_> = by
            .iter()
            .map(|(name, ap, kills, assists, group, last)| {
                serde_json::json!({ "name": name, "ap": ap, "kills": kills, "assists": assists, "group": group, "last": last })
            })
            .collect();
        let shown = |h: How| s.kills.iter().filter(|k| k.how == h && (h != How::Group || k.ap > 0)).count();
        serde_json::json!({
            "players": players,
            "kills": shown(How::Kill),
            "assists": shown(How::Assist),
            "group": shown(How::Group),
            "pvpAp": s.kills.iter().map(|k| k.ap).sum::<u64>(),
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

    fn fresh() {
        reset();
        with(|s| s.last_total = None);
    }

    #[test]
    fn points_after_each_kill() {
        fresh();
        abyss_total(100_000, 0);
        kill("Lyrael".into(), How::Kill, 10_000);
        abyss_total(101_240, 11_000);
        kill("Kael".into(), How::Assist, 30_000);
        kill("Morw".into(), How::Kill, 32_000);
        abyss_total(101_740, 33_000);
        abyss_total(102_000, 120_000); // hors PvP
        let v = snapshot(200_000);
        let p = v["players"].as_array().unwrap();
        assert_eq!((p[0]["name"].as_str(), p[0]["ap"].as_u64()), (Some("Lyrael"), Some(1240)));
        assert_eq!((p[1]["name"].as_str(), p[1]["ap"].as_u64()), (Some("Morw"), Some(500)));
        assert_eq!(v["otherAp"], 260);
    }

    #[test]
    fn points_before_each_kill_in_a_fast_fight() {
        // le jeu envoie les points avant le record de la mort, et les kills
        // s'enchaînent : chacun garde les siens, rien ne s'empile sur le premier
        fresh();
        abyss_total(100_000, 0);
        abyss_total(101_000, 1_000);
        kill("A".into(), How::Kill, 2_000);
        abyss_total(103_000, 6_000);
        kill("B".into(), How::Kill, 7_500);
        abyss_total(103_500, 9_000);
        kill("C".into(), How::Kill, 10_000);
        let v = snapshot(60_000);
        let ap = |n: &str| v["players"].as_array().unwrap().iter().find(|p| p["name"] == n).unwrap()["ap"].as_u64().unwrap();
        assert_eq!((ap("A"), ap("B"), ap("C")), (1000, 2000, 500));
        assert_eq!(v["otherAp"], 0);
    }

    #[test]
    fn group_kills_count_only_when_they_pay() {
        fresh();
        abyss_total(100_000, 0);
        // un allié de groupe tue sans que tu touches : points quand même
        kill("Groupé".into(), How::Group, 5_000);
        abyss_total(100_600, 5_500);
        // une mort du groupe sans points n'apparaît pas
        kill("Rien".into(), How::Group, 40_000);
        let v = snapshot(80_000);
        let p = v["players"].as_array().unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!((p[0]["name"].as_str(), p[0]["ap"].as_u64(), p[0]["group"].as_u64()), (Some("Groupé"), Some(600), Some(1)));
        assert_eq!((v["kills"].as_u64(), v["group"].as_u64(), v["pvpAp"].as_u64()), (Some(0), Some(1), Some(600)));
    }

    #[test]
    fn final_kills_are_taken_once() {
        fresh();
        abyss_total(100_000, 0);
        kill("A".into(), How::Kill, 1_000);
        abyss_total(100_900, 2_000);
        kill("G".into(), How::Group, 3_000); // sans points : jamais envoyé
        assert!(take_final(10_000).is_empty()); // trop tôt
        let got = take_final(60_000);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].name.as_str(), got[0].ap, got[0].how.as_str()), ("A", 900, "kill"));
        assert!(take_final(90_000).is_empty());
    }

    #[test]
    fn late_points_go_to_the_last_unpaid_kill() {
        fresh();
        abyss_total(100_000, 0);
        kill("A".into(), How::Kill, 1_000);
        abyss_total(100_800, 9_000); // 8 s après, pas d'autre mort
        let v = snapshot(30_000);
        assert_eq!(v["players"][0]["ap"], 800);
    }
}
