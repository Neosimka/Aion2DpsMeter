//! Aion2DpsMeter : les attaques des boss du raid Ludra, pour le guide de boss
//! en direct. Chaque attaque d'un boss suivi (Réacteur, Rahu, Ketu, Ludra
//! éternel, en Normal et Difficile ; le Facile n'est pas encore dans la table du jeu) qui touche un joueur est notée une
//! fois par lancer (les coups d'une même attaque sur plusieurs joueurs ne
//! comptent qu'une fois), écrite dans les logs (« BossGuide: … ») et gardée
//! pour la fenêtre du meter. Ces relevés servent à caler l'ordre des attaques.
//!
//! Depuis la 2.1.29, tout part aussi dans `bossguide.log` (dossier de données
//! du meter), même sans le journal de débogage : PV des boss de la Forge par
//! pas de 0,5 % et coups des boss et de leurs monstres sur les joueurs. Petit
//! fichier (2 Mo, puis `bossguide.old.log`), à envoyer après un raid.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Les codes des boss suivis (table des PNJ du jeu).
pub const TRACKED: [i32; 8] = [
    2_301_006, 2_301_007, 2_301_008, 2_301_014, // Normal : Rahu, Ketu, Réacteur, Ludra
    2_300_282, 2_300_283, 2_300_284, 2_300_290, // Difficile
];
/// Les PNJ de la Forge abyssale (boss, adeptes, réacteurs) et les monstres
/// sans nom qu'ils invoquent : ce que le relevé écrit dans le fichier.
pub fn forge_npc(mob: i32) -> bool {
    (2_300_270..2_300_300).contains(&mob) || (2_301_000..2_301_020).contains(&mob) || (2_920_700..2_920_800).contains(&mob)
}

// ---------- fichier bossguide.log ----------

static FILE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
const FILE_MAX: u64 = 2 * 1024 * 1024;
static HP_LAST: Mutex<Option<HashMap<i32, i64>>> = Mutex::new(None);

#[allow(dead_code)]
pub fn init(dir: &std::path::Path) {
    if let Ok(mut f) = FILE.lock() {
        *f = Some(dir.join("bossguide.log"));
    }
}

fn write_line(line: &str) {
    use std::io::Write;
    let Some(path) = FILE.lock().ok().and_then(|f| f.clone()) else { return };
    if std::fs::metadata(&path).map(|m| m.len() > FILE_MAX).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_file_name("bossguide.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// PV d'un PNJ de la Forge : une ligne à chaque demi-pour-cent.
pub fn note_hp(entity: i32, mob: i32, hp: i32, max: i32, at: i64) {
    if !forge_npc(mob) || max <= 0 || !TRACKED.contains(&mob) && !(2_301_009..2_301_014).contains(&mob) {
        return;
    }
    let step = (hp.max(0) as i64 * 200) / max as i64; // pas de 0,5 %
    let Ok(mut g) = HP_LAST.lock() else { return };
    let last = g.get_or_insert_with(HashMap::new);
    if last.get(&entity) == Some(&step) {
        return;
    }
    last.insert(entity, step);
    if last.len() > 200 {
        last.clear();
    }
    drop(g);
    write_line(&format!("{at} HP id={entity} mob={mob} {:.1}%", step as f64 / 2.0));
}

/// Un boss commence une attaque : `<len varint> 06 38 <entité varint>
/// <compétence u32> …`. Relevé le 24/11/2026 sur les captures du 22/11 :
/// Ludra éternel l'envoie toutes les ~5 s, dans un ordre fixe d'un essai à
/// l'autre (1803010 « Fulguration violette » ouvre le Bingo de 50 %,
/// 1803040 « Épreuve de Ludra » celui de ~23 %).
pub fn parse_cast(packet: &[u8]) -> Option<(i32, i32)> {
    let len = crate::capture::stream_processor::read_varint(packet, 0);
    if len.length <= 0 {
        return None;
    }
    let o = len.length as usize;
    if packet.get(o..o + 2)? != [0x06, 0x38] {
        return None;
    }
    let ent = crate::capture::stream_processor::read_varint(packet, o + 2);
    if ent.length <= 0 || ent.value <= 0 {
        return None;
    }
    let p = o + 2 + ent.length as usize;
    let skill = u32::from_le_bytes(packet.get(p..p + 4)?.try_into().ok()?);
    if !(1_000_000..100_000_000).contains(&skill) {
        return None;
    }
    Some((ent.value, skill as i32))
}

/// Une attaque commencée par un boss suivi.
pub fn note_start(mob: i32, skill: i32, at: i64) {
    // Les tics d'une même attaque (jusqu'à plusieurs par seconde) ne comptent
    // qu'une fois : `note` les regroupe et écrit la ligne du fichier.
    if TRACKED.contains(&mob) {
        note(mob, skill, at);
    }
}

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
#[cfg(test)]
static ALL: Mutex<Vec<Cast>> = Mutex::new(Vec::new());
/// Relevé de test : les paquets qui contiennent un code de compétence de la Forge.
#[cfg(test)]
pub static TAP: Mutex<Vec<(i64, Vec<u8>)>> = Mutex::new(Vec::new());
#[cfg(test)]
pub fn tap(packet: &[u8], at: i64) {
    if packet.len() < 4 {
        return;
    }
    if let Ok(op) = std::env::var("A2D_TAPOP") {
        let len = crate::capture::stream_processor::read_varint(packet, 0);
        let o = len.length.max(0) as usize;
        let hex: String = packet.get(o..o + 2).unwrap_or(&[]).iter().map(|b| format!("{b:02x}")).collect();
        if hex == op {
            TAP.lock().unwrap().push((at, packet.to_vec()));
        }
        return;
    }
    if std::env::var("A2D_TAP").is_err() {
        return;
    }
    let hit = packet.windows(4).any(|w| {
        let v = u32::from_le_bytes([w[0], w[1], w[2], w[3]]);
        (1_802_700..1_803_600).contains(&v)
    });
    if hit {
        TAP.lock().unwrap().push((at, packet.to_vec()));
    }
}

/// Un boss vient de toucher un joueur avec une de ses compétences. Renvoie
/// vrai si c'est un nouveau lancer.
pub fn note(mob: i32, skill: i32, at: i64) -> bool {
    #[cfg(test)]
    if let Ok(mut all) = ALL.lock() {
        all.push(Cast { mob, skill, at });
    }
    if forge_npc(mob) && !TRACKED.contains(&mob) {
        write_line(&format!("{at} HIT mob={mob} skill={skill}"));
    }
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
    write_line(&format!("{at} CAST mob={mob} skill={skill}"));
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
    fn reads_a_cast_start() {
        // 0f 06 38 | d9 9a 01 (19801) | 8a 84 1b 00 (1803402) | fd 00
        let p = [0x0f, 0x06, 0x38, 0xd9, 0x9a, 0x01, 0x8a, 0x84, 0x1b, 0x00, 0xfd, 0x00];
        assert_eq!(parse_cast(&p), Some((19_801, 1_803_402)));
        assert_eq!(parse_cast(&[0x0f, 0x02, 0x38, 0xd9, 0x9a, 0x01, 0x8a, 0x84, 0x1b, 0x00]), None);
    }

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

    /// Relevé d'une capture (`packets_*.txt`) : PV des boss de Ludra et
    /// attaques des PNJ sur les joueurs, pour caler le guide.
    /// `A2D_CAPTURE=chemin cargo test --features desktop,online --lib boss_timeline -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn boss_timeline() {
        use crate::capture::stream_processor::StreamProcessor;
        use crate::combat::data_storage::DataStorage;
        use crate::i18n::lookup::{NpcLookup, SkillLookup};
        use std::sync::Arc;
        let data = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/data/");
        let npcs = Arc::new(NpcLookup::new());
        npcs.load_from_json(&std::fs::read_to_string(format!("{data}i18n/npcs/fr.json")).unwrap());
        let skills = Arc::new(SkillLookup::new());
        skills.load_from_json(&std::fs::read_to_string(format!("{data}i18n/skills/fr.json")).unwrap());
        let storage = Arc::new(DataStorage::new());
        let mut p = StreamProcessor::new(storage.clone(), skills.clone(), npcs.clone());
        if let Ok(t) = std::fs::read_to_string(format!("{data}dot_skill_ids.json")) {
            if let Ok(ids) = serde_json::from_str::<Vec<i32>>(&t) {
                p.set_dot_skill_ids(ids.into_iter().collect());
            }
        }
        let mut hp_last: std::collections::HashMap<i32, i64> = Default::default();
        for path in std::env::var("A2D_CAPTURE").unwrap().split(',') {
            let text = std::fs::read_to_string(path).unwrap_or_default();
            for line in text.lines() {
                let parts: Vec<&str> = line.trim().splitn(3, '|').collect();
                if parts.len() != 3 || line.starts_with('#') {
                    continue;
                }
                let Ok(ts) = chrono::DateTime::parse_from_rfc3339(parts[0]) else { continue };
                let ms = ts.timestamp_millis();
                let Ok(bytes) = (0..parts[2].len() / 2)
                    .map(|i| u8::from_str_radix(&parts[2][2 * i..2 * i + 2], 16))
                    .collect::<Result<Vec<u8>, _>>()
                else {
                    continue;
                };
                p.set_override_timestamp(Some(ms));
                p.consume_stream(&bytes);

                for (id, code) in storage.get_mob_data() {
                    if !(2_300_000..2_302_000).contains(&code) && !npcs.is_boss(code) {
                        continue;
                    }
                    let (Some(cur), Some(max)) = (storage.get_mob_current_hp(id), storage.get_mob_hp(id)) else { continue };
                    if max <= 0 {
                        continue;
                    }
                    let pm = (cur as i64 * 1000) / max as i64; // pour mille
                    if hp_last.get(&id) != Some(&pm) {
                        hp_last.insert(id, pm);
                        println!("HP {ms} id={id} code={code} {} {}.{}%", npcs.get_npc_name(code), pm / 10, pm % 10);
                    }
                }
            }
        }
        if std::env::var("A2D_PVP").is_ok() {
            println!("PVP {}", serde_json::to_string(&crate::a2d_pvp::snapshot(i64::MAX / 2)).unwrap_or_default());
        }
        for (at, p) in TAP.lock().unwrap().iter() {
            println!("PKT {at} {}", p.iter().map(|b| format!("{b:02x}")).collect::<String>());
        }
        for c in ALL.lock().unwrap().iter() {
            println!("CAST {} mob={} {} skill={} {}", c.at, c.mob, npcs.get_npc_name(c.mob), c.skill, skills.lookup_skill_name(c.skill));
        }
    }
}
