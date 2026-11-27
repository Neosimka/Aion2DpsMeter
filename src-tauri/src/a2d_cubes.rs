//! Aion2DpsMeter : les cubes cachés près de toi, lus dans le réseau.
//!
//! Le jeu annonce chaque objet du décor qui apparaît autour de toi
//! (`EnvObjSpawn_NT`, octets 34 36) et qui disparaît (`EnvObjDespawn_NT`,
//! 35 36) ; ta position arrive avec tes déplacements (`CharMove*_NT`, 1A, 1B,
//! 1C 37) et tes téléportations (`CharWarp*_NT`, 3C, 3D 37). Disposition des
//! messages et codes des cubes relevés dans l'application Questlog (0.1.56),
//! vérifiés sur des captures de la légion du 22/11/2026 (5 cubes rouges vus
//! entre 09:58 et 09:59). Positions en centimètres.
#![cfg_attr(not(feature = "desktop"), allow(dead_code))]

use crate::capture::stream_processor::read_varint;
use std::collections::HashMap;
use std::sync::Mutex;

/// Codes des cubes cachés : rouge (à clé) ou doré.
const CUBES: [(i32, bool); 19] = [
    (1_200_036, false), (1_200_037, false), (1_200_039, true), (1_200_040, true), (1_200_041, true),
    (1_200_667, false), (1_201_502, false), (1_201_503, true), (1_201_504, true), (1_201_505, false),
    (1_300_081, false), (1_300_082, false), (1_300_754, false), (1_301_199, true), (1_301_200, true),
    (1_301_242, false), (1_301_243, false), (1_301_244, true), (1_301_245, true),
];
fn cube_kind(code: i32) -> Option<bool> {
    CUBES.iter().find(|&&(c, _)| c == code).map(|&(_, red)| red)
}
/// Un cube ouvert reste affiché quelques secondes, barré.
const TAKEN_SHOWN_MS: i64 = 8_000;
/// Après une téléportation, on oublie les cubes plus loin que ça (en cm).
const FORGET_CM: f32 = 40_000.0;
/// Une position plus vieille que ça ne sert plus aux distances.
const POS_FRESH_MS: i64 = 60_000;

#[derive(Clone, Debug)]
struct Cube {
    code: i32,
    red: bool,
    pos: [f32; 3],
    seen_at: i64,
    spawned: bool,
    taken_at: Option<i64>,
}

#[derive(Default)]
struct State {
    cubes: HashMap<i32, Cube>,
    me: Option<([f32; 3], i64)>,
}
static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(State::default))
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}
impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.p)?;
        self.p += 1;
        Some(v)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        (self.p + n <= self.b.len()).then(|| self.p += n)
    }
    fn vi32(&mut self) -> Option<i32> {
        let v = read_varint(self.b, self.p);
        if v.length <= 0 {
            return None;
        }
        self.p += v.length as usize;
        Some(v.value)
    }
    fn i32(&mut self) -> Option<i32> {
        let s = self.b.get(self.p..self.p + 4)?;
        self.p += 4;
        Some(i32::from_le_bytes(s.try_into().ok()?))
    }
    fn f32(&mut self) -> Option<f32> {
        Some(f32::from_bits(self.i32()? as u32))
    }
    fn pos(&mut self) -> Option<[f32; 3]> {
        let p = [self.f32()?, self.f32()?, self.f32()?];
        p.iter().all(|v| v.is_finite() && v.abs() < 1.0e8).then_some(p)
    }
}

/// Ce qu'un message apprend au relevé des cubes.
#[derive(Debug, PartialEq)]
pub enum Event {
    Spawn { key: i32, code: i32, pos: [f32; 3], spawned: bool },
    Despawn { key: i32, used: bool },
    Move { key: i32, pos: [f32; 3], warp: bool },
}

pub fn parse(packet: &[u8]) -> Option<Event> {
    let len = read_varint(packet, 0);
    if len.length <= 0 {
        return None;
    }
    let o = len.length as usize;
    let op = u16::from_le_bytes(packet.get(o..o + 2)?.try_into().ok()?);
    let mut r = Reader { b: packet, p: o + 2 };
    match op {
        13876 => {
            // EnvObjSpawn_NT : clé, drapeaux, descripteur (drapeaux, [nom], code, …), position, …
            let key = r.vi32()?;
            r.u8()?;
            let t = r.u8()?;
            if t & 1 != 0 {
                let n = r.vi32()?;
                r.skip(n.max(0) as usize)?;
            }
            let code = r.i32()?;
            cube_kind(code)?;
            for (bit, n) in [(2, 1), (4, 1), (8, 5), (16, 1)] {
                if t & bit != 0 {
                    r.skip(n)?;
                }
            }
            let pos = r.pos()?;
            // originSpawnKey i32, dir f32, state u8, puis des booléens en bits, puis reason u8.
            r.skip(4 + 4 + 1 + 1)?;
            let reason = r.u8()?;
            Some(Event::Spawn { key, code, pos, spawned: reason == 6 })
        }
        13877 => {
            // EnvObjDespawn_NT : clé, état, raison (3 : ouvert).
            let key = r.vi32()?;
            r.u8()?;
            let reason = r.u8()?;
            Some(Event::Despawn { key, used: reason == 3 })
        }
        14106 => {
            // CharMoveStop_NT : clé, drapeaux, moveState, [moveSubstate], position.
            let key = r.vi32()?;
            let n = r.u8()?;
            r.u8()?;
            if n & 1 != 0 {
                r.u8()?;
            }
            Some(Event::Move { key, pos: r.pos()?, warp: false })
        }
        14107 | 14108 => {
            // CharMoveStart_NT / CharMoveUpdateSnapshot_NT : clé, drapeaux, [isRunning], position.
            let key = r.vi32()?;
            let n = r.u8()?;
            if n & 1 != 0 {
                r.u8()?;
            }
            Some(Event::Move { key, pos: r.pos()?, warp: false })
        }
        14140 | 14141 => {
            let key = r.vi32()?;
            r.u8()?;
            Some(Event::Move { key, pos: r.pos()?, warp: op == 14141 })
        }
        _ => None,
    }
}

pub fn note(event: Event, me: Option<i64>, at: i64) {
    with(|s| match event {
        Event::Spawn { key, code, pos, spawned } => {
            let red = cube_kind(code).unwrap_or(false);
            let first = !s.cubes.contains_key(&key);
            let seen_at = s.cubes.get(&key).map(|c| c.seen_at).unwrap_or(at);
            s.cubes.insert(key, Cube { code, red, pos, seen_at, spawned, taken_at: None });
            if first {
                tracing::info!("Cube: {} {code} at {:.0},{:.0},{:.0}", if red { "red" } else { "gold" }, pos[0], pos[1], pos[2]);
            }
        }
        Event::Despawn { key, used } => {
            if let Some(c) = s.cubes.get_mut(&key) {
                if used {
                    c.taken_at = Some(at);
                } else {
                    s.cubes.remove(&key);
                }
            }
        }
        Event::Move { key, pos, warp } => {
            if me != Some(key as i64) {
                return;
            }
            s.me = Some((pos, at));
            if warp {
                s.cubes.retain(|_, c| dist(c.pos, pos) < FORGET_CM);
            }
        }
    });
}

fn dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// Les cubes connus, du plus proche au plus loin, pour la fenêtre du meter.
pub fn state(now: i64) -> Vec<serde_json::Value> {
    with(|s| {
        s.cubes.retain(|_, c| c.taken_at.is_none_or(|t| now - t <= TAKEN_SHOWN_MS));
        let me = s.me.filter(|&(_, at)| now - at < POS_FRESH_MS).map(|(p, _)| p);
        let mut out: Vec<(f32, serde_json::Value)> = s
            .cubes
            .iter()
            .map(|(&key, c)| {
                let d = me.map(|m| dist(c.pos, m));
                let angle = me.map(|m| (m[1] - c.pos[1]).atan2(c.pos[0] - m[0]).to_degrees().round());
                let rise = me.map(|m| ((c.pos[2] - m[2]) / 100.0).round());
                (
                    d.unwrap_or(f32::MAX),
                    serde_json::json!({
                        "key": key, "code": c.code, "red": c.red, "spawned": c.spawned,
                        "seenAt": c.seen_at, "takenAt": c.taken_at,
                        "distance": d.map(|d| (d / 100.0).round()), "angle": angle, "rise": rise,
                    }),
                )
            })
            .collect();
        out.sort_by(|a, b| a.0.total_cmp(&b.0));
        out.into_iter().map(|(_, v)| v).collect()
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn a2d_cubes() -> Vec<serde_json::Value> {
    state(crate::clock::now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn a_cube_appears_is_measured_and_opened() {
        // EnvObjSpawn_NT : len | 34 36 | clé 100 | drapeaux 0 | desc 0, code 1200039 | x y z | …, reason 6
        let mut p = vec![0x00, 0x34, 0x36, 100, 0x00, 0x00];
        p.extend(1_200_039i32.to_le_bytes());
        for v in [10_000.0f32, 0.0, 500.0] {
            p.extend(v.to_le_bytes());
        }
        p.extend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
        p[0] = p.len() as u8;
        let ev = parse(&p).unwrap();
        assert_eq!(ev, Event::Spawn { key: 100, code: 1_200_039, pos: [10_000.0, 0.0, 500.0], spawned: true });
        note(ev, Some(7), 1_000);
        // ta position : CharMoveStop_NT, clé 7, drapeaux 0, moveState 0, x y z
        let mut m = vec![0x00, 0x1a, 0x37, 7, 0, 0];
        for v in [7_000.0f32, 4_000.0, 0.0] {
            m.extend(v.to_le_bytes());
        }
        m[0] = m.len() as u8;
        note(parse(&m).unwrap(), Some(7), 2_000);
        let s = state(3_000);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0]["distance"], 50.0); // 30 m, 40 m : 50 m
        assert_eq!(s[0]["rise"], 5.0);
        assert_eq!(s[0]["red"], true);
        // ouvert (raison 3), puis oublié après quelques secondes
        note(parse(&hex("05353664000300")).unwrap_or(Event::Despawn { key: 100, used: true }), Some(7), 4_000);
        assert!(state(5_000)[0]["takenAt"].is_number());
        assert!(state(20_000).is_empty());
        // pas un cube
        let mut q = p.clone();
        q[6..10].copy_from_slice(&1_500_000i32.to_le_bytes());
        assert_eq!(parse(&q), None);
    }
}
