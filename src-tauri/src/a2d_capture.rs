//! Aion2DpsMeter : enregistrement d'une courte capture réseau du jeu.
//!
//! Pour décoder les positions (la tienne et celles des monstres), qu'il faut
//! au radar : quelques minutes du trafic du jeu, dans les deux sens, écrites
//! dans un fichier texte sur ton PC. Rien n'est envoyé nulle part ; c'est toi
//! qui envoies le fichier si tu veux.
//!
//! Format : celui que relit `capture::file_replay` (`temps|Client:<client>:<serveur>|hex`)
//! pour ce que le serveur envoie ; ce que ton PC envoie est sur des lignes
//! `#C|temps|Client:<client>:<serveur>|hex`, que la relecture ignore.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::capture::captured_payload::CapturedPayload;

/// Au plus 10 minutes, et au plus 200 Mo.
const MAX_SECONDS: u64 = 600;
const MAX_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Default)]
struct Rec {
    dir: Option<PathBuf>,
    file: Option<std::io::BufWriter<std::fs::File>>,
    path: Option<PathBuf>,
    until: i64,
    bytes: u64,
    lines: u64,
    last_path: Option<PathBuf>,
}

static REC: OnceLock<Mutex<Rec>> = OnceLock::new();

fn rec() -> &'static Mutex<Rec> {
    REC.get_or_init(|| Mutex::new(Rec::default()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Au démarrage : où écrire les captures.
pub fn init(app_data_dir: &std::path::Path) {
    if let Ok(mut r) = rec().lock() {
        r.dir = Some(app_data_dir.join("captures"));
    }
}

fn stop_locked(r: &mut Rec) {
    if let Some(mut f) = r.file.take() {
        let _ = f.flush();
    }
    if let Some(p) = r.path.take() {
        r.last_path = Some(p);
    }
    r.until = 0;
}

/// Chaque segment TCP du jeu, dans les deux sens (`port` : le port du serveur).
pub fn record(cap: &CapturedPayload, port: u16) {
    let Some(lock) = REC.get() else { return };
    let Ok(mut r) = lock.lock() else { return };
    if r.file.is_none() {
        return;
    }
    let now = now_ms();
    if now > r.until || r.bytes > MAX_BYTES {
        stop_locked(&mut r);
        return;
    }
    let from_server = cap.src_port == port;
    let client = if from_server { cap.dst_port } else { cap.src_port };
    let hex: String = cap.data.iter().map(|b| format!("{b:02x}")).collect();
    let line = if from_server {
        format!("{now}|Client:{client}:{port}|{hex}\n")
    } else {
        format!("#C|{now}|Client:{client}:{port}|{hex}\n")
    };
    r.bytes += line.len() as u64;
    r.lines += 1;
    if let Some(f) = r.file.as_mut() {
        if f.write_all(line.as_bytes()).is_err() {
            stop_locked(&mut r);
        }
    }
}

fn state_locked(r: &Rec) -> Value {
    serde_json::json!({
        "recording": r.file.is_some(),
        "until": r.until,
        "bytes": r.bytes,
        "lines": r.lines,
        "path": r.path.as_ref().or(r.last_path.as_ref()).map(|p| p.display().to_string()),
        "now": now_ms(),
    })
}

/// Démarre une capture de `seconds` secondes (2 min par défaut).
#[tauri::command]
pub fn a2d_capture_start(seconds: Option<u64>) -> Result<Value, String> {
    let mut r = rec().lock().map_err(|_| "occupé".to_string())?;
    stop_locked(&mut r);
    let dir = r.dir.clone().ok_or("dossier inconnu")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("a2d-capture-{stamp}.txt"));
    let mut f = std::io::BufWriter::new(std::fs::File::create(&path).map_err(|e| e.to_string())?);
    let _ = writeln!(
        f,
        "# Aion2DpsMeter {} : capture du jeu. Contient les noms des joueurs autour de toi et le chat.",
        env!("CARGO_PKG_VERSION")
    );
    r.file = Some(f);
    r.path = Some(path);
    r.bytes = 0;
    r.lines = 0;
    r.until = now_ms() + (seconds.unwrap_or(120).clamp(10, MAX_SECONDS) * 1000) as i64;
    Ok(state_locked(&r))
}

#[tauri::command]
pub fn a2d_capture_stop() -> Value {
    let Ok(mut r) = rec().lock() else { return Value::Null };
    stop_locked(&mut r);
    state_locked(&r)
}

#[tauri::command]
pub fn a2d_capture_state() -> Value {
    let Ok(mut r) = rec().lock() else { return Value::Null };
    if r.file.is_some() && now_ms() > r.until {
        stop_locked(&mut r);
    }
    state_locked(&r)
}

/// Montre la dernière capture dans l'explorateur.
#[tauri::command]
pub fn a2d_capture_reveal() -> Result<(), String> {
    let r = rec().lock().map_err(|_| "occupé".to_string())?;
    let p = r.path.clone().or(r.last_path.clone()).or(r.dir.clone()).ok_or("aucune capture")?;
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}
