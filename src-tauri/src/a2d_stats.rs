//! Aion2DpsMeter : tes stats, lues dans les fiches que le jeu t'envoie
//! (`<len> 4A 36 <toi varint> <nombre varint> [<id u16> <valeur i32>]…`), pour
//! le calculateur d'efficacité des stats. Le jeu n'envoie que ce qui change
//! (un buff, une pièce) : les valeurs s'accumulent. Identifiants des stats
//! repris de RATmeter (Kuroukihime/AIon2-Dps-Meter, GPL v3), vérifiés sur
//! des captures de la légion (22/11/2026).

use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Default)]
struct State {
    values: BTreeMap<u16, i32>,
    at: i64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// Les paires (id, valeur) d'une fiche de stats, ou rien si ce n'en est pas une.
pub fn parse(packet: &[u8]) -> Option<Vec<(u16, i32)>> {
    use crate::capture::stream_processor::read_varint;
    let len = read_varint(packet, 0);
    if len.length <= 0 {
        return None;
    }
    let o = len.length as usize;
    if packet.get(o..o + 2)? != [0x4A, 0x36] {
        return None;
    }
    let ent = read_varint(packet, o + 2);
    if ent.length <= 0 {
        return None;
    }
    let mut p = o + 2 + ent.length as usize;
    let count = read_varint(packet, p);
    if count.length <= 0 || !(1..=400).contains(&count.value) {
        return None;
    }
    p += count.length as usize;
    let mut out = Vec::with_capacity(count.value as usize);
    for _ in 0..count.value {
        let b = packet.get(p..p + 6)?;
        out.push((u16::from_le_bytes([b[0], b[1]]), i32::from_le_bytes([b[2], b[3], b[4], b[5]])));
        p += 6;
    }
    Some(out)
}

pub fn note(values: &[(u16, i32)], at: i64) {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let s = g.get_or_insert_with(State::default);
    for &(id, v) in values {
        s.values.insert(id, v);
    }
    s.at = at;
}

/// Changement de personnage : on repart de zéro.
pub fn clear() {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn a2d_self_stats(state: tauri::State<'_, crate::app::AppState>) -> serde_json::Value {
    let g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let (values, at) = g.as_ref().map(|s| (s.values.clone(), s.at)).unwrap_or_default();
    serde_json::json!({
        "name": state.data_storage.local_character_name(),
        "at": at,
        "values": values.into_iter().map(|(k, v)| (k.to_string(), serde_json::json!(v))).collect::<serde_json::Map<String, serde_json::Value>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_stats_record() {
        // 1d 4a36 | d302 (toi) | 02 | 4100 e9070000 (65 = 2025) | 7b01 540b0000 (379 = 2900) | …
        let hex = "1d4a36d302024100e90700007b01540b00000000000000000000";
        let p: Vec<u8> = (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect();
        assert_eq!(parse(&p), Some(vec![(65, 2025), (379, 2900)]));
        assert_eq!(parse(&[0x05, 0x49, 0x36, 0x01, 0x00]), None);
    }
}
