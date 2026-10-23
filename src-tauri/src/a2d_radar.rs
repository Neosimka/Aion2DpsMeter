//! Aion2DpsMeter : radar à familiers.
//!
//! Deux choses, lues sur le réseau seulement (aucune lecture de la mémoire du
//! jeu) :
//! - **tes familiers** : leur niveau et leurs âmes à la connexion (`00 90`),
//!   chaque âme ramassée (`0D 90`) et chaque montée de niveau (`14 90`). Les
//!   décodeurs sont ceux du plugin Pet Soul Tracker d'A2Tools (GPL-3.0), passés
//!   par le moteur de décodage des plugins du meter. Gardé dans
//!   `a2d_pets.json`, pour un meter lancé après la connexion ;
//! - **les monstres autour de toi** : chaque apparition de monstre (son code de
//!   PNJ) jusqu'à sa mort, sa disparition ou un changement de zone.
//!
//! Quel monstre donne l'âme de quel familier : public/src/js/a2dPetsData.js.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::plugins::decoder::{Decoder, DecoderSpec};

/// Âmes pour passer du niveau 0 à 1, de 1 à 2, de 2 à 3.
const NEEDED: [u32; 3] = [5, 25, 75];
/// Au-delà, les plus anciens monstres vus sont oubliés.
const MAX_NEARBY: usize = 3000;
const FILE: &str = "a2d_pets.json";

const DECODERS: &str = r#"[
  { "name": "pet-list", "opcode": "00 90", "fields": [
    { "type": "skip:4" },
    { "name": "levels", "type": "list", "count": "varint", "fields": [
      { "name": "pet", "type": "u32" }, { "type": "skip:4" }, { "name": "level", "type": "u32" } ] },
    { "name": "points", "type": "list", "count": "varint", "fields": [
      { "name": "pet", "type": "u32" }, { "name": "points", "type": "u32" } ] } ] },
  { "name": "soul-gained", "opcode": "0D 90", "immediate": true, "fields": [
    { "name": "souls", "type": "list", "count": "u8", "fields": [
      { "name": "pet", "type": "u32" }, { "name": "amount", "type": "u32" } ] } ] },
  { "name": "level-up", "opcode": "14 90", "immediate": true, "fields": [
    { "type": "skip:2" }, { "name": "pet", "type": "u32" }, { "name": "level", "type": "u32" } ] }
]"#;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pets {
    pub levels: HashMap<u32, u32>,
    pub points: HashMap<u32, u32>,
    /// Dernière liste complète reçue du jeu (à la connexion), en ms.
    #[serde(default)]
    pub synced_at: i64,
    /// Le dernier familier pour lequel une âme a été ramassée, et quand.
    #[serde(default)]
    pub last_gain: Option<(u32, i64)>,
}

impl Pets {
    fn gain(&mut self, pet: u32, amount: u32, at: i64) {
        let p = self.points.entry(pet).or_insert(0);
        *p = p.saturating_add(amount);
        self.last_gain = Some((pet, at));
        let level = self.levels.get(&pet).copied().unwrap_or(0);
        if let Some(&need) = NEEDED.get(level as usize) {
            if self.points.get(&pet).copied().unwrap_or(0) >= need {
                self.levels.insert(pet, level + 1);
                self.points.insert(pet, 0);
            }
        }
    }

    fn level_up(&mut self, pet: u32, level: u32) {
        if self.levels.get(&pet).copied().unwrap_or(0) >= level {
            return;
        }
        self.levels.insert(pet, level);
        self.points.insert(pet, 0);
    }

    /// Applique un enregistrement décodé ; vrai s'il a changé quelque chose.
    fn apply(&mut self, decoder: &str, data: &Value, at: i64) -> bool {
        let before = self.clone();
        let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).map(|n| n as u32);
        match decoder {
            "pet-list" => {
                self.levels.clear();
                self.points.clear();
                for e in data.get("levels").and_then(Value::as_array).into_iter().flatten() {
                    if let (Some(pet), Some(level)) = (num(e, "pet"), num(e, "level")) {
                        self.levels.insert(pet, level);
                    }
                }
                for e in data.get("points").and_then(Value::as_array).into_iter().flatten() {
                    if let (Some(pet), Some(points)) = (num(e, "pet"), num(e, "points")) {
                        self.points.insert(pet, points);
                    }
                }
                self.synced_at = at;
            }
            "soul-gained" => {
                for e in data.get("souls").and_then(Value::as_array).into_iter().flatten() {
                    if let (Some(pet), Some(amount)) = (num(e, "pet"), num(e, "amount")) {
                        self.gain(pet, amount, at);
                    }
                }
            }
            "level-up" => {
                if let (Some(pet), Some(level)) = (num(data, "pet"), num(data, "level")) {
                    self.level_up(pet, level);
                }
            }
            _ => {}
        }
        *self != before
    }
}

#[derive(Debug, Clone, Copy)]
struct Seen {
    code: i32,
    at: i64,
}

struct Radar {
    decoders: Vec<Decoder>,
    pets: Option<Pets>,
    nearby: HashMap<i32, Seen>,
    file: Option<PathBuf>,
}

static RADAR: OnceLock<Mutex<Radar>> = OnceLock::new();

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn radar() -> &'static Mutex<Radar> {
    RADAR.get_or_init(|| {
        let specs: Vec<DecoderSpec> = serde_json::from_str(DECODERS).unwrap_or_default();
        let decoders = specs.iter().filter_map(|s| Decoder::compile(s).ok()).collect();
        Mutex::new(Radar { decoders, pets: None, nearby: HashMap::new(), file: None })
    })
}

/// Au démarrage : où garder les familiers, et ceux de la dernière fois.
pub fn init(app_data_dir: &std::path::Path) {
    let file = app_data_dir.join(FILE);
    let saved = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Pets>(&t).ok());
    if let Ok(mut r) = radar().lock() {
        r.file = Some(file);
        if r.pets.is_none() {
            r.pets = saved;
        }
    }
}

/// Chaque trame lue par le meter (appel bon marché : deux octets comparés).
pub fn frame(packet: &[u8]) {
    let len = crate::capture::stream_processor::read_varint(packet, 0).length;
    if len <= 0 {
        return;
    }
    let at = len as usize;
    let Some(op) = packet.get(at..at + 2) else { return };
    if op[1] != 0x90 || !matches!(op[0], 0x00 | 0x0D | 0x14) {
        return;
    }
    let body = &packet[at + 2..];
    let Ok(mut r) = radar().lock() else { return };
    let Some(decoder) = r.decoders.iter().find(|d| d.opcode == op).cloned() else { return };
    let Some(data) = decoder.decode(body) else { return };
    let pets = r.pets.get_or_insert_with(Pets::default);
    if pets.apply(&decoder.name, &data, now_ms()) {
        let saved = serde_json::to_string(&*pets).ok();
        if let (Some(file), Some(text)) = (r.file.clone(), saved) {
            let _ = std::fs::write(file, text);
        }
    }
}

/// Un monstre vient d'apparaître (ou d'être revu).
pub fn note_spawn(entity: i32, code: i32) {
    if code <= 0 {
        return;
    }
    let Ok(mut r) = radar().lock() else { return };
    r.nearby.insert(entity, Seen { code, at: now_ms() });
    if r.nearby.len() > MAX_NEARBY {
        let mut all: Vec<(i32, i64)> = r.nearby.iter().map(|(&e, s)| (e, s.at)).collect();
        all.sort_by_key(|&(_, at)| at);
        for (e, _) in all.into_iter().take(MAX_NEARBY / 4) {
            r.nearby.remove(&e);
        }
    }
}

/// Mort ou disparu.
pub fn note_gone(entity: i32) {
    crate::a2d_pos::forget(entity);
    if let Ok(mut r) = radar().lock() {
        r.nearby.remove(&entity);
    }
}

/// Téléportation ou changement de zone : le jeu renverra ce qui est autour.
pub fn note_zone_change() {
    crate::a2d_pos::note_zone_change();
    if let Ok(mut r) = radar().lock() {
        r.nearby.clear();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NearbyCode {
    code: i32,
    count: usize,
    last_seen: i64,
}

/// Pour l'onglet Familiers : tes familiers et les monstres présents, par code.
#[tauri::command]
pub fn a2d_radar_state() -> Value {
    let Ok(r) = radar().lock() else { return Value::Null };
    let mut by_code: HashMap<i32, NearbyCode> = HashMap::new();
    for s in r.nearby.values() {
        let e = by_code.entry(s.code).or_insert(NearbyCode { code: s.code, count: 0, last_seen: 0 });
        e.count += 1;
        e.last_seen = e.last_seen.max(s.at);
    }
    // Chaque monstre avec sa position, pour la carte du radar.
    let points: Vec<Value> = r
        .nearby
        .iter()
        .filter_map(|(&e, s)| {
            let p = crate::a2d_pos::of(e)?;
            Some(serde_json::json!({ "code": s.code, "x": p.x, "y": p.y, "z": p.z }))
        })
        .take(600)
        .collect();
    serde_json::json!({
        "pets": r.pets,
        "nearby": by_code.into_values().collect::<Vec<_>>(),
        "points": points,
        "me": crate::a2d_pos::me(),
        "now": now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_of(op: [u8; 2], body: &[u8]) -> Vec<u8> {
        // Longueur (varint) puis type puis corps, comme les trames du meter.
        let total = 1 + 2 + body.len();
        let mut f = vec![total as u8];
        f.extend_from_slice(&op);
        f.extend_from_slice(body);
        f
    }

    #[test]
    fn souls_and_levels() {
        let specs: Vec<DecoderSpec> = serde_json::from_str(DECODERS).unwrap();
        assert_eq!(specs.len(), 3);
        for s in &specs {
            Decoder::compile(s).unwrap();
        }
        let mut p = Pets::default();
        // Niveau 0 : 5 âmes pour le niveau 1, le compteur repart de 0.
        p.gain(1002, 3, 1);
        p.gain(1002, 2, 2);
        assert_eq!((p.levels.get(&1002), p.points.get(&1002)), (Some(&1), Some(&0)));
        p.gain(1002, 10, 3);
        assert_eq!(p.points.get(&1002), Some(&10));
        p.level_up(1002, 2);
        assert_eq!((p.levels.get(&1002), p.points.get(&1002)), (Some(&2), Some(&0)));
    }

    #[test]
    fn decodes_a_soul_pickup_frame() {
        // 0D 90 : 1 entrée, familier 1002 (u32 LE), 1 âme.
        let body = [1u8, 0xEA, 0x03, 0, 0, 1, 0, 0, 0];
        let f = frame_of([0x0D, 0x90], &body);
        let specs: Vec<DecoderSpec> = serde_json::from_str(DECODERS).unwrap();
        let d = Decoder::compile(&specs[1]).unwrap();
        let len = crate::capture::stream_processor::read_varint(&f, 0).length as usize;
        let data = d.decode(&f[len + 2..]).unwrap();
        let mut p = Pets::default();
        assert!(p.apply("soul-gained", &data, 5));
        assert_eq!(p.points.get(&1002), Some(&1));
        assert_eq!(p.last_gain, Some((1002, 5)));
    }

    #[test]
    fn nearby_tracks_spawns_and_deaths() {
        note_zone_change();
        note_spawn(10, 2100075);
        note_spawn(11, 2100075);
        note_spawn(12, 2100480);
        note_gone(11);
        let st = a2d_radar_state();
        let list = st["nearby"].as_array().unwrap();
        let count = |code: i64| list.iter().find(|e| e["code"] == code).map(|e| e["count"].as_u64().unwrap());
        assert_eq!(count(2100075), Some(1));
        assert_eq!(count(2100480), Some(1));
        note_zone_change();
        assert!(a2d_radar_state()["nearby"].as_array().unwrap().is_empty());
    }
}
