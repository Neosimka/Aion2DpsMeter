//! Aion2DpsMeter : les attaques des boss du raid Ludra, pour le guide de boss
//! en direct. Chaque attaque d'un boss suivi (Réacteur, Rahu, Ketu, Ludra
//! éternel, en Normal et Difficile ; le Facile n'est pas encore dans la table du jeu) qui touche un joueur est notée une
//! fois par lancer (les coups d'une même attaque sur plusieurs joueurs ne
//! comptent qu'une fois), écrite dans les logs (« BossGuide: … ») et gardée
//! pour la fenêtre du meter. Ces relevés servent à caler l'ordre des attaques.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Les codes des boss suivis (table des PNJ du jeu).
pub const TRACKED: [i32; 8] = [
    2_301_006, 2_301_007, 2_301_008, 2_301_014, // Normal : Rahu, Ketu, Réacteur, Ludra
    2_300_282, 2_300_283, 2_300_284, 2_300_290, // Difficile
];
/// Deux coups de la même attaque à moins de ce délai : un seul lancer.
const SAME_CAST_MS: i64 = 2_500;
const KEEP: usize = 60;

#[derive(Clone, Debug, PartialEq)]
pub struct Cast {
    pub mob: i32,
    pub skill: i32,
    pub at: i64,
}

#[derive(Default)]
struct State {
    last: HashMap<(i32, i32), i64>,
    casts: VecDeque<Cast>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// Un boss vient de toucher un joueur avec une de ses compétences. Renvoie
/// vrai si c'est un nouveau lancer.
pub fn note(mob: i32, skill: i32, at: i64) -> bool {
    if !TRACKED.contains(&mob) {
        return false;
    }
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let s = g.get_or_insert_with(State::default);
    let prev = s.last.insert((mob, skill), at);
    if prev.is_some_and(|p| at >= p && at - p < SAME_CAST_MS) {
        return false;
    }
    s.casts.push_back(Cast { mob, skill, at });
    while s.casts.len() > KEEP {
        s.casts.pop_front();
    }
    tracing::info!("BossGuide: mob={mob} skill={skill} at={at}");
    true
}

/// Les derniers lancers, du plus ancien au plus récent.
#[allow(dead_code)]
pub fn recent() -> Vec<Cast> {
    let g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref().map(|s| s.casts.iter().cloned().collect()).unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn a2d_boss_casts(state: tauri::State<'_, crate::app::AppState>) -> Vec<serde_json::Value> {
    recent()
        .into_iter()
        .map(|c| {
            serde_json::json!({
                "mob": c.mob,
                "skill": c.skill,
                "at": c.at,
                "name": state.skill_lookup.lookup_skill_name(c.skill),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_cast_per_attack_and_only_tracked_bosses() {
        assert!(note(2_301_014, 1_803_010, 1_000));
        assert!(!note(2_301_014, 1_803_010, 1_400)); // même attaque, autre joueur touché
        assert!(note(2_301_014, 1_803_010, 9_000)); // nouveau lancer
        assert!(note(2_301_014, 1_803_030, 9_100));
        assert!(!note(2_980_000, 1_803_010, 9_200)); // pas un boss de Ludra
        let r: Vec<_> = recent().into_iter().filter(|c| c.mob == 2_301_014).collect();
        assert_eq!(r.len(), 3);
        assert_eq!(r[2].skill, 1_803_030);
    }
}
