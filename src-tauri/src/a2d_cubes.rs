//! Aion2DpsMeter : détection des cubes cachés.
//!
//! Lu sur le réseau seulement (aucune lecture de la mémoire du jeu). Le serveur
//! envoie au jeu chaque cube caché à environ 110 m du joueur, comme un objet
//! qui apparaît, avec son code. Deux chemins :
//! - **l'apparition** (`41 36`), déjà lue par le meter (`append_mob`) : le cube
//!   a un numéro d'entité, et disparaît du radar quand le jeu le retire ;
//! - **la trame brute** : toute trame qui contient le code d'un cube, quel que
//!   soit son type. Elle sert de repli si le jeu envoie les cubes autrement, et
//!   on y cherche la position du cube parmi les emplacements connus de la carte.
//!   Les premières trames de ce genre sont écrites dans le journal (préfixe
//!   `a2d-cube`), pour vérifier le format sur une vraie capture.
//!
//! Codes et emplacements : RiftConsole (`data/env_objects.tsv`,
//! `data/cube_spots.tsv`, licence MIT).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

/// (code, rouge, sous l'eau).
const CUBES: [(u32, bool, bool); 19] = [
    (1200036, false, false),
    (1200037, false, false),
    (1200039, true, false),
    (1200040, true, false),
    (1200041, true, true),
    (1200667, false, true),
    (1201502, false, false),
    (1201503, true, false),
    (1201504, true, true),
    (1201505, false, true),
    (1300081, false, false),
    (1300082, false, false),
    (1300754, false, true),
    (1301199, true, false),
    (1301200, true, true),
    (1301242, false, false),
    (1301243, false, true),
    (1301244, true, false),
    (1301245, true, true),
];

const SPOTS_TSV: &str = include_str!("a2d_cube_spots.tsv");
/// Une position lue à moins de 3 m d'un emplacement connu est cet emplacement.
const SPOT_RADIUS: f32 = 300.0;
/// Un cube vu seulement dans une trame brute (sans entité) est oublié après 3 min.
const RAW_TTL_MS: i64 = 180_000;
/// Une trame brute et l'apparition d'un même cube arrivent ensemble.
const LINK_MS: i64 = 2_000;
const MAX_LOGGED: u32 = 25;
/// Un cube que le jeu n'a jamais retiré est oublié après 15 min.
const KEEP_MS: i64 = 15 * 60_000;
/// Les emplacements montrés sur la carte du radar, autour de toi.
const SPOTS_AROUND_CM: f32 = 25_000.0;

fn cube(code: u32) -> Option<(bool, bool)> {
    CUBES.iter().find(|c| c.0 == code).map(|c| (c.1, c.2))
}

struct Spot {
    map: i32,
    area: &'static str,
    /// Rouge, ou « l'un ou l'autre » (`either`) : compté comme rouge possible.
    red: bool,
    x: f32,
    y: f32,
    z: f32,
}

fn spots() -> &'static Vec<Spot> {
    static SPOTS: OnceLock<Vec<Spot>> = OnceLock::new();
    SPOTS.get_or_init(|| {
        SPOTS_TSV
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                if f.len() < 6 {
                    return None;
                }
                Some(Spot {
                    map: f[0].parse().ok()?,
                    area: f[2],
                    red: f[1] != "yellow",
                    x: f[3].parse().ok()?,
                    y: f[4].parse().ok()?,
                    z: f[5].parse().ok()?,
                })
            })
            .collect()
    })
}

/// L'emplacement connu le plus proche d'une position, sur la carte `map`.
fn spot_at(map: Option<i32>, x: f32, y: f32, z: f32) -> Option<usize> {
    let mut best: Option<(usize, f32)> = None;
    for (i, s) in spots().iter().enumerate() {
        if map.is_some_and(|m| m != s.map) {
            continue;
        }
        let d = ((s.x - x).powi(2) + (s.y - y).powi(2) + (s.z - z).powi(2)).sqrt();
        if d <= SPOT_RADIUS && best.is_none_or(|(_, b)| d < b) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

/// Cherche, dans une trame, trois f32 qui tombent sur un emplacement connu.
fn find_spot(frame: &[u8], map: Option<i32>) -> Option<usize> {
    let f = |i: usize| f32::from_le_bytes([frame[i], frame[i + 1], frame[i + 2], frame[i + 3]]);
    let mut i = 0;
    while i + 12 <= frame.len() {
        let (x, y, z) = (f(i), f(i + 4), f(i + 8));
        let plausible = |v: f32| v.is_finite() && v.abs() > 100.0 && v.abs() < 1_000_000.0;
        if plausible(x) && plausible(y) && (z.is_finite() && z.abs() < 1_000_000.0) {
            if let Some(s) = spot_at(map, x, y, z) {
                return Some(s);
            }
        }
        i += 1;
    }
    None
}

/// Les codes de cube présents dans une trame (sur 3 octets, petit-boutiste),
/// et s'ils sont suivis du motif d'une apparition (`00 40 02` / `00 00 02`).
fn codes_in(frame: &[u8]) -> Vec<(u32, bool)> {
    let mut out = Vec::new();
    if frame.len() < 3 {
        return out;
    }
    for i in 0..frame.len() - 2 {
        // Tous les codes s'écrivent 0x12xxxx ou 0x13xxxx.
        if !matches!(frame[i + 2], 0x12 | 0x13) {
            continue;
        }
        let code = frame[i] as u32 | (frame[i + 1] as u32) << 8 | (frame[i + 2] as u32) << 16;
        if cube(code).is_some() && !out.iter().any(|o: &(u32, bool)| o.0 == code) {
            let spawn_like = frame.get(i + 3..i + 6).is_some_and(|t| t[0] == 0 && matches!(t[1], 0x00 | 0x40) && t[2] == 0x02);
            out.push((code, spawn_like));
        }
    }
    out
}

#[derive(Debug, Clone)]
struct Seen {
    code: u32,
    at: i64,
    last: i64,
    spot: Option<usize>,
    /// Position exacte, si le jeu l'a envoyée (`34 36`).
    pos: Option<(f32, f32, f32)>,
    /// Vu seulement dans une trame brute : pas d'entité, pas de disparition.
    raw: bool,
}

#[derive(Default)]
struct Cubes {
    map: Option<i32>,
    /// Par entité (apparition), ou par clé négative (trame brute).
    seen: HashMap<i64, Seen>,
    /// Trames brutes récentes, pas encore liées à une apparition : (code, quand, emplacement).
    pending: Vec<(u32, i64, Option<usize>)>,
    logged: u32,
}

static CUBES_STATE: OnceLock<Mutex<Cubes>> = OnceLock::new();

fn state() -> &'static Mutex<Cubes> {
    CUBES_STATE.get_or_init(|| Mutex::new(Cubes::default()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn raw_key(code: u32, spot: Option<usize>) -> i64 {
    -((code as i64) * 10_000 + spot.map_or(9_999, |s| s as i64))
}

/// Chaque trame lue par le meter.
pub fn frame(packet: &[u8]) {
    // L'apparition d'un objet (`34 36`) : entité, code et position exacts.
    if let Some((entity, (x, y, z), Some(code))) = crate::a2d_pos::parse(packet) {
        if cube(code).is_some() {
            let Ok(mut c) = state().lock() else { return };
            let at = now_ms();
            let spot = spot_at(c.map, x, y, z).or_else(|| spot_at(None, x, y, z));
            if c.logged < MAX_LOGGED {
                c.logged += 1;
                tracing::info!("a2d-cube: objet {entity} code {code} à ({x:.0}, {y:.0}, {z:.0}) emplacement {spot:?}");
            }
            let prev = c.seen.get(&(entity as i64)).map(|p| p.at);
            c.seen.insert(entity as i64, Seen { code, at: prev.unwrap_or(at), last: at, spot, pos: Some((x, y, z)), raw: false });
        }
        return;
    }
    let codes = codes_in(packet);
    if codes.is_empty() {
        return;
    }
    let Ok(mut c) = state().lock() else { return };
    let at = now_ms();
    let spot = find_spot(packet, c.map);
    // Un code seul peut tomber là par hasard : on ne garde que les trames qui
    // tombent sur un emplacement connu ou qui ont la forme d'une apparition.
    if spot.is_none() && !codes.iter().any(|c| c.1) {
        return;
    }
    if c.logged < MAX_LOGGED {
        c.logged += 1;
        let hex: String = packet.iter().take(160).map(|b| format!("{b:02x}")).collect();
        tracing::info!("a2d-cube: codes {codes:?} carte {:?} emplacement {spot:?} trame {hex}", c.map);
    }
    for (code, _) in codes {
        // Déjà là par son apparition : on garde l'emplacement trouvé.
        if let Some(s) = c.seen.values_mut().find(|s| !s.raw && s.code == code && at - s.at < LINK_MS) {
            s.spot = s.spot.or(spot);
            s.last = at;
            continue;
        }
        c.pending.push((code, at, spot));
    }
}

/// Un objet vient d'apparaître (appelé pour chaque apparition, `append_mob`).
pub fn note_spawn(entity: i32, code: i32) {
    if code <= 0 || cube(code as u32).is_none() {
        return;
    }
    let code = code as u32;
    let Ok(mut c) = state().lock() else { return };
    let at = now_ms();
    let spot = c
        .pending
        .iter()
        .position(|p| p.0 == code && at - p.1 < LINK_MS)
        .map(|i| c.pending.remove(i).2)
        .flatten();
    let prev = c.seen.get(&(entity as i64)).cloned();
    c.seen.insert(
        entity as i64,
        Seen {
            code,
            at: prev.as_ref().map_or(at, |p| p.at),
            last: at,
            spot: spot.or(prev.as_ref().and_then(|p| p.spot)),
            pos: prev.and_then(|p| p.pos),
            raw: false,
        },
    );
}

/// Mort, disparu, ramassé.
pub fn note_gone(entity: i32) {
    if let Ok(mut c) = state().lock() {
        c.seen.remove(&(entity as i64));
    }
}

/// Nouvelle carte (`21 36`).
pub fn note_map(map_id: i32) {
    if let Ok(mut c) = state().lock() {
        if c.map != Some(map_id) {
            c.seen.clear();
            c.pending.clear();
        }
        c.map = Some(map_id);
    }
}

/// Téléportation : le jeu renverra ce qui est autour.
pub fn note_zone_change() {
    if let Ok(mut c) = state().lock() {
        c.seen.clear();
        c.pending.clear();
    }
}

/// Les trames brutes restées sans apparition deviennent des cubes « vus ».
fn settle(c: &mut Cubes, now: i64) {
    let (old, keep): (Vec<_>, Vec<_>) = c.pending.drain(..).partition(|p| now - p.1 >= LINK_MS);
    c.pending = keep;
    for (code, at, spot) in old {
        let key = raw_key(code, spot);
        let e = c.seen.entry(key).or_insert(Seen { code, at, last: at, spot, pos: None, raw: true });
        e.last = e.last.max(at);
    }
    c.seen.retain(|_, s| now - s.last < if s.raw { RAW_TTL_MS } else { KEEP_MS });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CubeOut {
    id: i64,
    code: u32,
    red: bool,
    water: bool,
    since: i64,
    last_seen: i64,
    area: Option<&'static str>,
    x: Option<f32>,
    y: Option<f32>,
    z: Option<f32>,
}

/// Pour l'onglet Cubes : les cubes autour de toi et la carte.
#[tauri::command]
pub fn a2d_cubes_state() -> Value {
    let Ok(mut c) = state().lock() else { return Value::Null };
    let now = now_ms();
    settle(&mut c, now);
    let mut list: Vec<CubeOut> = c
        .seen
        .iter()
        .map(|(&id, s)| {
            let (red, water) = cube(s.code).unwrap_or((false, false));
            let sp = s.spot.and_then(|i| spots().get(i));
            let p = s.pos.or(sp.map(|p| (p.x, p.y, p.z)));
            CubeOut {
                id,
                code: s.code,
                red,
                water,
                since: s.at,
                last_seen: s.last,
                area: sp.map(|p| p.area),
                x: p.map(|p| p.0),
                y: p.map(|p| p.1),
                z: p.map(|p| p.2),
            }
        })
        .collect();
    list.sort_by_key(|o| (!o.red, -o.since));
    let map = c.map;
    let known = map.map_or(0, |m| spots().iter().filter(|s| s.map == m).count());
    // Les emplacements connus autour de toi (carrés creux sur la carte).
    let me = crate::a2d_pos::me();
    let around: Vec<Value> = me
        .map(|m| {
            spots()
                .iter()
                .filter(|s| map.is_none_or(|mm| mm == s.map))
                .filter(|s| ((s.x - m.x).powi(2) + (s.y - m.y).powi(2)).sqrt() <= SPOTS_AROUND_CM)
                .take(400)
                .map(|s| serde_json::json!({ "x": s.x, "y": s.y, "z": s.z, "red": s.red }))
                .collect()
        })
        .unwrap_or_default();
    serde_json::json!({ "map": map, "spots": known, "cubes": list, "around": around, "me": me, "now": now })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_table_loads() {
        assert!(spots().len() > 3000);
        assert!(spots().iter().any(|s| s.map == 1010));
    }

    #[test]
    fn finds_codes_and_spots_in_a_frame() {
        let s = &spots()[0];
        let mut f = vec![0x20, 0x41, 0x36, 0x99, 0x01];
        f.extend_from_slice(&1200039u32.to_le_bytes()[..3]);
        f.extend_from_slice(&[0x00, 0x40, 0x02]);
        for v in [s.x + 10.0, s.y - 20.0, s.z] {
            f.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(codes_in(&f), vec![(1200039, true)]);
        assert_eq!(find_spot(&f, Some(s.map)), Some(0));
        assert!(codes_in(&[0x00, 0x40, 0x02, 0x11, 0x22]).is_empty());
    }

    #[test]
    fn spawn_links_raw_frame_and_goes_away() {
        note_map(1010);
        let s = &spots()[0];
        let mut f = vec![0x20, 0x41, 0x36];
        f.extend_from_slice(&1200039u32.to_le_bytes()[..3]);
        for v in [s.x, s.y, s.z] {
            f.extend_from_slice(&v.to_le_bytes());
        }
        frame(&f);
        note_spawn(77, 1200039);
        note_spawn(78, 2100075); // un monstre, pas un cube
        let st = a2d_cubes_state();
        let list = st["cubes"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["red"], true);
        assert!(list[0]["area"].is_string());
        note_gone(77);
        assert!(a2d_cubes_state()["cubes"].as_array().unwrap().is_empty());
        note_zone_change();
    }
}
