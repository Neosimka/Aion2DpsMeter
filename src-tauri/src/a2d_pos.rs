//! Aion2DpsMeter : positions (la tienne, celles des monstres et des objets).
//!
//! Lu sur le réseau seulement, dans ce que le serveur envoie au jeu (aucune
//! lecture de la mémoire du jeu). Formats relevés sur une capture du
//! 2026-10-23 (Col du Pèlerin, Verteron), coordonnées en centimètres :
//!
//! ```text
//! 1a 37  <entité varint> <2 octets>           <x f32> <y f32> <z f32> …
//! 1f 37, 2f 37, 24 37, 23 37
//!        <entité varint> <1 octet>            <x> <y> <z> …
//! 1b 37, 1c 37, 1e 37, 28 37, 29 37, 2b 37
//!        <entité varint> <drapeau> [+1 octet si drapeau & 1] <x> <y> <z> …
//! 41 36  (apparition d'un monstre) <entité varint> <9 octets> <x> <y> <z> …
//! 34 36  (apparition d'un objet)   <entité varint> <u16> <code u32> <x> <y> <z> …
//! 23 36  (téléportation, entité 0 = toi) <00> <5 octets> <x> <y> <z> …
//! 21 36  (chargement de carte) <u32> <u32 carte> <8 octets> <x> <y> <z> …
//! 2a 38, 2b 38 (une compétence) <entité varint> … <x> <y> <z> (fin de trame)
//! 3c 37  <entité varint> <1 octet> <x> <y> <z> …
//! ```
//!
//! Ta propre position n'arrive pas pendant que tu marches (le jeu ne la renvoie
//! pas, capture du 2026-10-23 17:44) : seulement quand tu utilises une
//! compétence, te téléportes ou changes de carte.
//!

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// Au-delà, les plus anciennes positions sont oubliées.
const MAX_TRACKED: usize = 4000;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Pos {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub at: i64,
    /// Direction de ton dernier déplacement (radians, atan2(dy, dx)), si connue.
    pub heading: Option<f32>,
}

#[derive(Default)]
struct Positions {
    by_entity: HashMap<i32, Pos>,
    me: Option<Me>,
    /// Le point d'où le cap a été calculé (on attend 1 m de déplacement).
    heading_from: Option<(f32, f32)>,
    /// Ton numéro d'entité, tel que le meter le connaît (pour les captures).
    local: Option<i64>,
    /// D'où vient ta dernière position : (entité, type de trame).
    me_from: Option<(i32, [u8; 2])>,
}

static POSITIONS: OnceLock<Mutex<Positions>> = OnceLock::new();

fn state() -> &'static Mutex<Positions> {
    POSITIONS.get_or_init(|| Mutex::new(Positions::default()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn xyz(b: &[u8], i: usize) -> Option<(f32, f32, f32)> {
    let f = |j: usize| -> Option<f32> { Some(f32::from_le_bytes(b.get(j..j + 4)?.try_into().ok()?)) };
    let (x, y, z) = (f(i)?, f(i + 4)?, f(i + 8)?);
    let ok = |v: f32| v.is_finite() && v.abs() < 600_000.0;
    (ok(x) && ok(y) && ok(z) && (x != 0.0 || y != 0.0)).then_some((x, y, z))
}

/// La position portée par une trame : (entité, x, y, z), et le code de l'objet
/// pour une apparition d'objet (`34 36`).
pub fn parse(packet: &[u8]) -> Option<(i32, (f32, f32, f32), Option<u32>)> {
    let len = crate::capture::stream_processor::read_varint(packet, 0).length;
    if len <= 0 {
        return None;
    }
    let at = len as usize;
    let op = packet.get(at..at + 2)?;
    let b = &packet[at + 2..];
    // 21 36 (chargement de carte) : <u32> <u32 carte> <8 octets> puis ta position.
    if op == [0x21, 0x36] {
        return Some((0, xyz(b, 16)?, None));
    }
    let ent = crate::capture::stream_processor::read_varint(b, 0);
    if ent.length <= 0 {
        return None;
    }
    let k = ent.length as usize;
    let (i, code) = match (op[0], op[1]) {
        (0x1A, 0x37) => (k + 2, None),
        (0x1F | 0x2F | 0x24 | 0x23, 0x37) => (k + 1, None),
        (0x1B | 0x1C | 0x1E | 0x28 | 0x29 | 0x2B, 0x37) => (k + 1 + (*b.get(k)? & 1) as usize, None),
        (0x41, 0x36) => (k + 9, None),
        (0x34, 0x36) => (k + 6, Some(u32::from_le_bytes(b.get(k + 2..k + 6)?.try_into().ok()?))),
        // 23 36 : <entité 0> <5 octets> puis ta position.
        (0x23, 0x36) if ent.value == 0 => (k + 5, None),
        // 3c 37 : <entité> <1 octet> <x> <y> <z>.
        (0x3C, 0x37) => (k + 1, None),
        // 2a 38, 2b 38 (une compétence) : celui qui agit, puis sa position en fin de trame.
        (0x2A | 0x2B, 0x38) if b.len() >= k + 12 => (b.len() - 12, None),
        _ => return None,
    };
    Some((ent.value, xyz(b, i)?, code))
}

/// Chaque trame lue par le meter. `local` : ton numéro d'entité, s'il est connu.
pub fn frame(packet: &[u8], local: Option<i64>) {
    let Ok(mut s) = state().lock() else { return };
    s.local = local;
    drop(s);
    let Some((entity, (x, y, z), _)) = parse(packet) else { return };
    let Ok(mut s) = state().lock() else { return };
    let at = now_ms();
    // Entité 0 : ta téléportation. Sinon, ta propre entité.
    let mine = entity == 0 || local.is_some_and(|l| l == entity as i64);
    if mine {
        let mut heading = s.me.and_then(|m| m.heading);
        match s.heading_from {
            Some((fx, fy)) if entity != 0 => {
                if ((x - fx).powi(2) + (y - fy).powi(2)).sqrt() >= 100.0 {
                    heading = Some((y - fy).atan2(x - fx));
                    s.heading_from = Some((x, y));
                }
            }
            _ => s.heading_from = Some((x, y)),
        }
        s.me = Some(Me { x, y, z, at, heading });
        let len = crate::capture::stream_processor::read_varint(packet, 0).length.max(0) as usize;
        let op = [packet.get(len).copied().unwrap_or(0), packet.get(len + 1).copied().unwrap_or(0)];
        if s.me_from != Some((entity, op)) {
            tracing::info!("a2d-pos: ta position vient de l'entité {entity} (trame {:02x} {:02x}), à ({x:.0}, {y:.0}, {z:.0})", op[0], op[1]);
            s.me_from = Some((entity, op));
        }
        if entity == 0 {
            return;
        }
    }
    s.by_entity.insert(entity, Pos { x, y, z, at });
    if s.by_entity.len() > MAX_TRACKED {
        let mut all: Vec<(i32, i64)> = s.by_entity.iter().map(|(&e, p)| (e, p.at)).collect();
        all.sort_by_key(|&(_, at)| at);
        for (e, _) in all.into_iter().take(MAX_TRACKED / 4) {
            s.by_entity.remove(&e);
        }
    }
}

pub fn of(entity: i32) -> Option<Pos> {
    state().lock().ok()?.by_entity.get(&entity).copied()
}

/// Ton numéro d'entité et ta position, pour les captures.
pub fn debug_line() -> String {
    let Ok(s) = state().lock() else { return String::new() };
    let me = s.me.map(|m| format!("{:.0} {:.0} {:.0} {}", m.x, m.y, m.z, m.at)).unwrap_or_default();
    format!("local={:?} me={me} from={:?}", s.local, s.me_from)
}

pub fn me() -> Option<Me> {
    state().lock().ok()?.me
}

pub fn forget(entity: i32) {
    if let Ok(mut s) = state().lock() {
        s.by_entity.remove(&entity);
    }
}

/// Changement de zone : les numéros d'entité repartent de zéro.
pub fn note_zone_change() {
    if let Ok(mut s) = state().lock() {
        s.by_entity.clear();
        s.heading_from = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Trames de la capture du 2026-10-23 (précédées de leur longueur).
    #[test]
    fn reads_real_frames() {
        // 29 37 : toi (6501), « 03 03 » puis x, y, z.
        let body = hex("e53203036d419e46f5c91447ba520d474c36d6c37b39");
        let mut f = vec![(body.len() + 4 + 1 - 1) as u8, 0x29, 0x37];
        f.extend(&body);
        let (e, (x, y, _), code) = parse(&f).unwrap();
        assert_eq!((e, code), (6501, None));
        assert!((x - 20256.7).abs() < 1.0 && (y - 38089.9).abs() < 1.0, "{x} {y}");
        // 34 36 : un objet (46917), code 1500020, à (18702, 48847, 26901).
        let body = hex("c5ee02040074e31600001c924600cf3e47002ad246000000000000000001");
        let mut f = vec![60, 0x34, 0x36];
        f.extend(&body);
        let (e, (x, y, z), code) = parse(&f).unwrap();
        assert_eq!((e, code), (46917, Some(1_500_020)));
        assert_eq!((x.round(), y.round(), z.round()), (18702.0, 48847.0, 26901.0));
    }

    /// Toi (848) sur la capture du 2026-10-23 17:44 : une compétence, le chargement de carte, la téléportation.
    #[test]
    fn reads_your_own_fixes() {
        let framed = |op: [u8; 2], body: &str| {
            let mut f = vec![0x40, op[0], op[1]];
            f.extend(hex(body));
            f
        };
        let (e, (x, y, z), _) = parse(&framed([0x2A, 0x38], "d0060111e41fc80000002c01000000000000cb407069a1010000d006010044ded7471d09c94600f0d846")).unwrap();
        assert_eq!((e, x.round(), y.round(), z.round()), (848, 110525.0, 25733.0, 27768.0));
        let (e, (x, y, _), _) = parse(&framed([0x21, 0x36], "12000000f2030000afbece000000000010f40f4779c0694700a0ec46f0ffb3c2")).unwrap();
        assert_eq!((e, x.round(), y.round()), (0, 36852.0, 59840.0));
        let (e, (x, y, _), _) = parse(&framed([0x23, 0x36], "00000000000010f40f4779c0694700a0ec4601000000a64b")).unwrap();
        assert_eq!((e, x.round(), y.round()), (0, 36852.0, 59840.0));
    }

    #[test]
    fn tracks_you_and_your_heading() {
        note_zone_change();
        let frame_at = |e: u8, x: f32, y: f32| {
            let mut f = vec![20, 0x24, 0x37, e, 0x01];
            for v in [x, y, 100.0f32] {
                f.extend(v.to_le_bytes());
            }
            f
        };
        frame(&frame_at(42, 1000.0, 1000.0), Some(42));
        frame(&frame_at(42, 1000.0, 1500.0), Some(42));
        let m = me().unwrap();
        assert_eq!((m.x, m.y), (1000.0, 1500.0));
        assert!((m.heading.unwrap() - std::f32::consts::FRAC_PI_2).abs() < 1e-3);
        frame(&frame_at(43, 5.0e3, 5.0e3), Some(42));
        assert_eq!(of(43).map(|p| p.x), Some(5000.0));
    }
}
