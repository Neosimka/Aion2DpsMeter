//! Aion2DpsMeter : envoi automatique des combats au site de la légion
//! La Chevrerie (https://aion2-la-chevrerie.netlify.app).
//!
//! À la fin d'un combat de **boss de terrain**, de **donjon** ou de
//! **Cauchemar**, le meter envoie un résumé (boss, durée, dégâts, et une ligne
//! par membre de la légion) à la fonction Netlify du site. Les joueurs qui ne
//! sont pas dans la liste des membres du site ne sont pas envoyés du tout.
//!
//! - La catégorie vient de la table des PNJ du jeu (`npcs/en.json`) :
//!   « Nightmare » → Cauchemar, autre catégorie d'instance ou instance connue →
//!   Donjon, boss hors instance → Boss.
//! - Chaque combat est envoyé une seule fois. Un échec réseau est réessayé
//!   (1, 2, 5, 15, 30 puis 60 min), suivi dans `chevrerie_uploads.json`.
//! - La clé de légion est fournie à la compilation (secret GitHub
//!   `CHEVRERIE_KEY`). Sans clé, rien n'est envoyé.
//! - Désactivable dans l'onglet La Chevrerie (`dpsMeter.chevrerieUpload`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::app::AppState;
use crate::entity::fight_record::{obscure_nickname, FightRecord, APP_VERSION};

/// L'API du site (fonction Netlify `netlify/functions/meter.mjs`).
pub const SITE_API: &str = "https://aion2-la-chevrerie.netlify.app/api/meter";
/// "false" coupe l'envoi ; absent ou autre chose : activé.
pub const ENABLED_KEY: &str = "dpsMeter.chevrerieUpload";

/// Un combat est terminé quand rien ne s'y est passé depuis ce délai.
const ENDED_AFTER_MS: i64 = 10_000;
/// Les combats plus vieux que ça (historique d'avant la mise à jour) ne partent pas.
const MAX_AGE_MS: i64 = 3 * 24 * 60 * 60_000;
/// Délai avant chaque nouvel essai après un échec, en minutes.
const RETRY_MINUTES: [i64; 6] = [1, 2, 5, 15, 30, 60];
/// La liste des membres est redemandée au site au plus tous les…
const MEMBERS_TTL_MS: i64 = 10 * 60_000;
const REGISTRY_FILE: &str = "chevrerie_uploads.json";

fn legion_key() -> &'static str {
    option_env!("CHEVRERIE_KEY").unwrap_or("")
}

/// Le type de combat, tel que le site le range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Boss,
    Donjon,
    Cauchemar,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Boss => "boss",
            Category::Donjon => "donjon",
            Category::Cauchemar => "cauchemar",
        }
    }
}

/// Ce que la table des PNJ dit d'un code de monstre.
#[derive(Debug, Clone, Default)]
pub struct NpcEntry {
    pub category: Option<String>,
    pub is_boss: bool,
    pub is_dummy: bool,
}

pub type NpcTable = HashMap<i32, NpcEntry>;

/// L'instance Cauchemar, que la table des donjons ne nomme pas.
const NIGHTMARE_DUNGEON_ID: i32 = 200003;

pub fn parse_npc_table(json: &str) -> NpcTable {
    let mut table = NpcTable::new();
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(json) else {
        return table;
    };
    for (code, value) in map {
        let Ok(code) = code.parse::<i32>() else { continue };
        let entry = NpcEntry {
            category: value.get("category").and_then(|v| v.as_str()).map(str::to_string),
            is_boss: value.get("isBoss").and_then(|v| v.as_bool()).unwrap_or(false),
            is_dummy: value.get("isDummy").and_then(|v| v.as_bool()).unwrap_or(false),
        };
        table.insert(code, entry);
    }
    table
}

/// Boss, Donjon, Cauchemar, ou rien (mannequin, monstre ordinaire).
pub fn classify(table: &NpcTable, mob_code: i32, dungeon_id: i32) -> Option<Category> {
    let entry = table.get(&mob_code);
    if entry.is_some_and(|e| e.is_dummy) {
        return None;
    }
    match entry.and_then(|e| e.category.as_deref()) {
        Some("Nightmare") => return Some(Category::Cauchemar),
        Some(_) => return Some(Category::Donjon),
        None => {}
    }
    if dungeon_id == NIGHTMARE_DUNGEON_ID {
        return Some(Category::Cauchemar);
    }
    if dungeon_id > 0 {
        return Some(Category::Donjon);
    }
    if entry.is_some_and(|e| e.is_boss) {
        return Some(Category::Boss);
    }
    None
}

static NPCS: OnceLock<NpcTable> = OnceLock::new();

fn npc_table(data_dir: Option<&Path>) -> &'static NpcTable {
    NPCS.get_or_init(|| {
        data_dir
            .and_then(|dir| std::fs::read_to_string(dir.join("i18n").join("npcs").join("en.json")).ok())
            .map(|text| parse_npc_table(&text))
            .unwrap_or_default()
    })
}

/// Nom de classe en français, depuis le nom interne (coréen) du meter.
pub fn class_fr(job: &str) -> &'static str {
    match job {
        "검성" => "Gladiateur",
        "수호성" => "Templier",
        "궁성" => "Rôdeur",
        "살성" => "Assassin",
        "마도성" => "Sorcier",
        "치유성" => "Clerc",
        "정령성" => "Spiritualiste",
        "호법성" => "Aède",
        "권성" => "Pugiliste",
        _ => "",
    }
}

pub fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLine {
    pub name: String,
    pub classe: String,
    pub damage: i64,
    pub dps: i64,
    /// Part des dégâts du combat entier (en %, une décimale).
    pub share: f64,
    pub heal: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FightPayload {
    pub v: u8,
    pub meter: String,
    pub fight_id: String,
    pub category: String,
    pub boss_name: String,
    pub mob_code: i32,
    pub dungeon_id: i32,
    pub server_id: u16,
    pub start_time_ms: i64,
    pub duration_ms: i64,
    pub total_damage: i64,
    pub max_hp: i64,
    pub uploader: String,
    pub players: Vec<PlayerLine>,
}

/// Le résumé à envoyer, avec seulement les membres. `None` si aucun membre
/// n'a combattu.
pub fn build_payload(
    record: &FightRecord,
    category: Category,
    members: &HashSet<String>,
    uploader: &str,
    names: &HashMap<i32, String>,
) -> Option<FightPayload> {
    // Les combats enregistrés masquent le pseudo des autres joueurs
    // (« Pt**e ») : on prend le vrai nom retrouvé à la fin du combat.
    let real = |a: &crate::entity::details_context::DetailsActorSummary| -> String {
        names.get(&a.actor_id).cloned().unwrap_or_else(|| a.nickname.trim().to_string())
    };
    let mut damage: HashMap<i32, i64> = HashMap::new();
    for skill in &record.details.skills {
        *damage.entry(skill.actor_id).or_default() += skill.dmg as i64;
    }
    let mut heal: HashMap<i32, i64> = HashMap::new();
    for skill in &record.details.heal_skills {
        *heal.entry(skill.actor_id).or_default() += skill.dmg as i64;
    }
    let total = (record.total_damage as i64).max(damage.values().sum::<i64>()).max(1);
    let seconds = (record.duration_ms as f64 / 1000.0).max(1.0);

    let mut seen = HashSet::new();
    let mut players: Vec<PlayerLine> = record
        .actors
        .iter()
        .filter(|a| !real(a).is_empty())
        .filter(|a| members.contains(&normalize_name(&real(a))))
        .filter(|a| seen.insert(normalize_name(&real(a))))
        .map(|a| {
            let dmg = damage.get(&a.actor_id).copied().unwrap_or(0);
            PlayerLine {
                name: real(a),
                classe: class_fr(&a.job).to_string(),
                damage: dmg,
                dps: (dmg as f64 / seconds).round() as i64,
                share: ((dmg as f64 / total as f64) * 1000.0).round() / 10.0,
                heal: heal.get(&a.actor_id).copied().unwrap_or(0),
            }
        })
        .filter(|p| p.damage > 0 || p.heal > 0)
        .collect();
    if players.is_empty() {
        return None;
    }
    players.sort_by(|a, b| b.damage.cmp(&a.damage));

    Some(FightPayload {
        v: 1,
        meter: APP_VERSION.to_string(),
        fight_id: record.id.clone(),
        category: category.as_str().to_string(),
        boss_name: record.boss_name.clone(),
        mob_code: record.mob_code,
        dungeon_id: record.dungeon_id,
        server_id: record.server_id,
        start_time_ms: record.start_time_ms,
        duration_ms: record.duration_ms,
        total_damage: total,
        max_hp: record.details.max_hp as i64,
        uploader: uploader.to_string(),
        players,
    })
}

// ---------- Vrais pseudos ----------

/// Le vrai pseudo de chaque joueur d'un combat enregistré, retrouvé pendant
/// que le meter connaît encore le groupe : par l'identifiant du groupe (dbid),
/// puis par le nom de l'entité, puis par un pseudo du groupe qui donne le même
/// masque. Seulement quand la réponse est unique.
pub fn resolve_names(
    record: &FightRecord,
    party: &HashMap<String, crate::combat::data_storage::PartyMember>,
    nicknames: &HashMap<i32, String>,
) -> HashMap<i32, String> {
    let mut out = HashMap::new();
    for a in &record.actors {
        let shown = a.nickname.trim();
        if shown.is_empty() {
            continue;
        }
        if !shown.contains('*') {
            out.insert(a.actor_id, shown.to_string());
            continue;
        }
        if a.dbid != 0 {
            if let Some((name, _)) = party.iter().find(|(_, m)| m.dbid == a.dbid) {
                out.insert(a.actor_id, name.clone());
                continue;
            }
        }
        if let Some(name) = nicknames.get(&a.actor_id).filter(|n| obscure_nickname(n) == shown) {
            out.insert(a.actor_id, name.clone());
            continue;
        }
        let mut same: Vec<&String> = party.keys().filter(|n| obscure_nickname(n) == shown).collect();
        same.dedup();
        if same.len() == 1 {
            out.insert(a.actor_id, same[0].clone());
        }
    }
    out
}

/// Dernier recours, avec la liste des membres du site : le seul membre dont le
/// pseudo donne ce masque.
pub fn resolve_with_members(record: &FightRecord, names: &mut HashMap<i32, String>, members: &[String]) {
    for a in &record.actors {
        let shown = a.nickname.trim();
        if names.contains_key(&a.actor_id) || !shown.contains('*') {
            continue;
        }
        let same: Vec<&String> = members.iter().filter(|m| obscure_nickname(m) == shown).collect();
        if same.len() == 1 {
            names.insert(a.actor_id, same[0].clone());
        }
    }
}

// ---------- Suivi des envois (un fichier dans les données du meter) ----------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(default)]
    done: bool,
    #[serde(default)]
    attempts: u32,
    #[serde(default)]
    retry_at_ms: i64,
    #[serde(default)]
    end_ms: i64,
    /// Vrais pseudos retrouvés à la fin du combat (id d'acteur → pseudo).
    #[serde(default)]
    names: HashMap<i32, String>,
    /// Version de l'envoi : les combats envoyés avant la 2.0.80 (pseudos des
    /// autres joueurs masqués, donc lignes manquantes) sont renvoyés une fois.
    #[serde(default)]
    rev: u8,
}

/// Envois faits avec les vrais pseudos des membres du groupe.
const REV: u8 = 2;
static BACKFILL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn registry_path(dir: &Path) -> PathBuf {
    dir.join(REGISTRY_FILE)
}

fn read_registry(dir: &Path) -> HashMap<String, Entry> {
    std::fs::read_to_string(registry_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_registry(dir: &Path, reg: &HashMap<String, Entry>) {
    if let Ok(text) = serde_json::to_string(reg) {
        let _ = std::fs::write(registry_path(dir), text);
    }
}

fn update_entry(dir: &Path, id: &str, f: impl FnOnce(&mut Entry)) {
    let _guard = REGISTRY_LOCK.lock();
    let mut reg = read_registry(dir);
    f(reg.entry(id.to_string()).or_default());
    // On oublie les combats envoyés depuis plus de MAX_AGE_MS.
    let now = crate::clock::now_ms();
    reg.retain(|_, e| !(e.done && e.end_ms > 0 && now - e.end_ms > MAX_AGE_MS));
    write_registry(dir, &reg);
}

fn entry(dir: &Path, id: &str) -> Entry {
    let _guard = REGISTRY_LOCK.lock();
    read_registry(dir).get(id).cloned().unwrap_or_default()
}

struct InFlight(String);

impl InFlight {
    fn start(id: &str) -> Option<Self> {
        let set = IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()));
        set.lock().ok()?.insert(id.to_string()).then(|| InFlight(id.to_string()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Some(set) = IN_FLIGHT.get() {
            if let Ok(mut set) = set.lock() {
                set.remove(&self.0);
            }
        }
    }
}

fn enabled(state: &AppState) -> bool {
    !legion_key().is_empty() && state.settings.get(ENABLED_KEY).as_deref() != Some("false")
}

/// Le combat est fini, récent, et de la bonne catégorie.
fn eligible(state: &AppState, record: &FightRecord, now: i64) -> Option<Category> {
    if record.is_train {
        return None;
    }
    let end = record.start_time_ms + record.duration_ms;
    if now - end < ENDED_AFTER_MS || now - end > MAX_AGE_MS {
        return None;
    }
    classify(npc_table(state.i18n_data_dir.as_deref()), record.mob_code, record.dungeon_id)
}

/// Appelé à chaque enregistrement de combats (toutes les 30 s et avant une
/// remise à zéro) : envoie ceux qui viennent de se terminer.
pub fn on_fights_saved(app: &tauri::AppHandle, state: &AppState, records: &[FightRecord]) {
    if !enabled(state) {
        return;
    }
    let now = crate::clock::now_ms();
    for record in records {
        let Some(category) = eligible(state, record, now) else { continue };
        let e = entry(&state.app_data_dir, &record.id);
        if (e.done && e.rev >= REV) || (!e.done && e.attempts > 0) {
            continue; // déjà envoyé, ou entre les mains des réessais
        }
        let names = resolve_names(
            record,
            &state.data_storage.get_party_members(),
            &state.data_storage.get_nicknames(),
        );
        update_entry(&state.app_data_dir, &record.id, |e| {
            e.names = names;
            e.done = false;
            e.attempts = 0;
        });
        send(app.clone(), record.clone(), category);
    }
}

/// Une fois par lancement : les combats récents (3 jours) jamais envoyés ou
/// envoyés par une version qui perdait les autres membres du groupe.
fn backfill(app: &tauri::AppHandle, state: &AppState, now: i64) {
    if BACKFILL.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    for summary in state.fight_history.list_fights() {
        let end = summary.start_time_ms + summary.duration_ms;
        if summary.is_train || now - end > MAX_AGE_MS || now - end < ENDED_AFTER_MS {
            continue;
        }
        let e = entry(&state.app_data_dir, &summary.id);
        if (e.done && e.rev >= REV) || (!e.done && e.attempts > 0) {
            continue;
        }
        let Ok(record) = state.fight_history.load_fight(&summary.id) else { continue };
        if let Some(category) = eligible(state, &record, now) {
            update_entry(&state.app_data_dir, &record.id, |e| {
                e.done = false;
                e.attempts = 0;
            });
            send(app.clone(), record, category);
        }
    }
}

/// Les combats dont l'envoi a échoué et doit être retenté maintenant.
pub fn retry_due(app: &tauri::AppHandle, state: &AppState) {
    if !enabled(state) {
        return;
    }
    let now = crate::clock::now_ms();
    backfill(app, state, now);
    let due: Vec<String> = {
        let _guard = REGISTRY_LOCK.lock();
        read_registry(&state.app_data_dir)
            .into_iter()
            .filter(|(_, e)| !e.done && e.attempts > 0 && e.retry_at_ms <= now)
            .map(|(id, _)| id)
            .collect()
    };
    for id in due {
        let Ok(record) = state.fight_history.load_fight(&id) else {
            update_entry(&state.app_data_dir, &id, |e| e.done = true);
            continue;
        };
        match eligible(state, &record, now) {
            Some(category) => send(app.clone(), record, category),
            None => update_entry(&state.app_data_dir, &id, |e| e.done = true),
        }
    }
}

static MEMBERS: Mutex<Option<(i64, Vec<String>)>> = Mutex::new(None);

async fn members(http: &reqwest::Client) -> Result<Vec<String>, String> {
    let now = crate::clock::now_ms();
    if let Ok(cache) = MEMBERS.lock() {
        if let Some((at, set)) = cache.as_ref() {
            if now - at < MEMBERS_TTL_MS {
                return Ok(set.clone());
            }
        }
    }
    #[derive(Deserialize)]
    struct Members {
        members: Vec<String>,
    }
    let list: Members = http
        .get(format!("{SITE_API}/members"))
        .header("x-chevrerie-key", legion_key())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))?;
    let list: Vec<String> = list.members.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
    if let Ok(mut cache) = MEMBERS.lock() {
        *cache = Some((now, list.clone()));
    }
    Ok(list)
}

enum Outcome {
    Sent,
    /// Rien à envoyer, ou refusé pour de bon : on n'insiste pas.
    Drop(String),
    Retry(String),
}

async fn try_send(state: &AppState, record: &FightRecord, category: Category) -> Outcome {
    let member_list = match members(&state.http).await {
        Ok(m) => m,
        Err(e) => return Outcome::Retry(format!("liste des membres : {e}")),
    };
    let members: HashSet<String> = member_list.iter().map(|m| normalize_name(m)).collect();
    let mut names = entry(&state.app_data_dir, &record.id).names;
    resolve_with_members(record, &mut names, &member_list);
    let uploader = state.data_storage.local_character_name().unwrap_or_default();
    let Some(payload) = build_payload(record, category, &members, &uploader, &names) else {
        return Outcome::Drop("aucun membre de la légion dans ce combat".into());
    };
    let response = state
        .http
        .post(format!("{SITE_API}/fights"))
        .header("x-chevrerie-key", legion_key())
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&payload).unwrap_or_default())
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    match response {
        Ok(r) if r.status().is_success() => Outcome::Sent,
        // 401/403 : clé de légion pas encore (ou mal) réglée sur le site. On
        // garde le combat : il partira quand la clé sera corrigée.
        Ok(r) if matches!(r.status().as_u16(), 401 | 403 | 429) || r.status().is_server_error() => {
            Outcome::Retry(format!("le site a répondu {}", r.status()))
        }
        Ok(r) => Outcome::Drop(format!("le site a refusé : {}", r.status())),
        Err(e) => Outcome::Retry(e.to_string()),
    }
}

fn send(app: tauri::AppHandle, record: FightRecord, category: Category) {
    let Some(in_flight) = InFlight::start(&record.id) else { return };
    tauri::async_runtime::spawn(async move {
        let _in_flight = in_flight;
        let Some(state) = app.try_state::<AppState>() else { return };
        let end_ms = record.start_time_ms + record.duration_ms;
        let dir = state.app_data_dir.clone();
        match try_send(&state, &record, category).await {
            Outcome::Sent => {
                tracing::info!("La Chevrerie : combat {} ({}) envoyé", record.id, category.as_str());
                update_entry(&dir, &record.id, |e| {
                    e.done = true;
                    e.end_ms = end_ms;
                    e.rev = REV;
                });
            }
            Outcome::Drop(why) => {
                tracing::info!("La Chevrerie : combat {} non envoyé : {why}", record.id);
                update_entry(&dir, &record.id, |e| {
                    e.done = true;
                    e.end_ms = end_ms;
                    e.rev = REV;
                });
            }
            Outcome::Retry(why) => {
                let now = crate::clock::now_ms();
                update_entry(&dir, &record.id, |e| {
                    e.attempts += 1;
                    e.end_ms = end_ms;
                    e.rev = REV;
                    match RETRY_MINUTES.get(e.attempts as usize - 1) {
                        Some(m) => e.retry_at_ms = now + m * 60_000,
                        None => e.done = true,
                    }
                });
                tracing::info!("La Chevrerie : envoi de {} à refaire : {why}", record.id);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> NpcTable {
        parse_npc_table(
            r#"{
            "2000000": {"name": "Punching Bag", "isBoss": false, "isDummy": true},
            "2701155": {"name": "Zikel's Nightmare", "isBoss": true, "category": "Nightmare", "dungeonId": 200003},
            "2300000": {"name": "Submerged Emon", "isBoss": true, "category": "Transcendence", "dungeonId": 610011},
            "2400001": {"name": "Field Boss", "isBoss": true},
            "2400002": {"name": "Wolf", "isBoss": false}
        }"#,
        )
    }

    #[test]
    fn masked_party_members_are_found_again() {
        let record: FightRecord = serde_json::from_value(serde_json::json!({
            "id": "auto_9", "bossName": "Boss", "targetId": 1, "startTimeMs": 1_700_000_000_000i64,
            "durationMs": 100_000, "totalDamage": 1000, "jobs": [], "jobIds": [],
            "details": {"targetId": 1, "maxHp": 0, "totalTargetDamage": 1000, "battleTime": 100_000,
                        "startTime": 0, "pingHistory": [], "healSkills": [],
                        "skills": [
                          {"actorId": 1, "code": 1, "name": "a", "time": 1, "dmg": 500, "multiHitCount": 0, "multiHitDamage": 0, "crit": 0, "parry": 0, "back": 0, "perfect": 0, "double": 0, "regen": 0},
                          {"actorId": 2, "code": 1, "name": "a", "time": 1, "dmg": 300, "multiHitCount": 0, "multiHitDamage": 0, "crit": 0, "parry": 0, "back": 0, "perfect": 0, "double": 0, "regen": 0},
                          {"actorId": 3, "code": 1, "name": "a", "time": 1, "dmg": 200, "multiHitCount": 0, "multiHitDamage": 0, "crit": 0, "parry": 0, "back": 0, "perfect": 0, "double": 0, "regen": 0}
                        ]},
            "actors": [
                {"actorId": 1, "nickname": "NeoSimka", "job": "검성"},
                {"actorId": 2, "nickname": obscure_nickname("Ptose"), "job": "치유성"},
                {"actorId": 3, "nickname": obscure_nickname("Kyumy"), "job": "궁성"}
            ],
            "isTrain": false, "appVersion": "2.0.80", "mobCode": 1, "dungeonId": 600004, "serverId": 1303
        }))
        .unwrap();
        // Ptose retrouvé par le nom de son entité, Kyumy par la liste du site.
        let nicknames: HashMap<i32, String> = [(2, "Ptose".to_string())].into_iter().collect();
        let mut names = resolve_names(&record, &HashMap::new(), &nicknames);
        resolve_with_members(&record, &mut names, &["Ptose".into(), "Kyumy".into(), "NeoSimka".into(), "Pleasure".into()]);
        let members: HashSet<String> = ["neosimka", "ptose", "kyumy"].iter().map(|s| s.to_string()).collect();
        let p = build_payload(&record, Category::Donjon, &members, "NeoSimka", &names).unwrap();
        let got: Vec<&str> = p.players.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(got, ["NeoSimka", "Ptose", "Kyumy"]);
    }

    #[test]
    fn categories() {
        let t = table();
        assert_eq!(classify(&t, 2701155, 0), Some(Category::Cauchemar));
        assert_eq!(classify(&t, 2300000, 610011), Some(Category::Donjon));
        assert_eq!(classify(&t, 2400001, 0), Some(Category::Boss));
        assert_eq!(classify(&t, 2400001, 600004), Some(Category::Donjon));
        assert_eq!(classify(&t, 2400002, 0), None);
        assert_eq!(classify(&t, 2000000, 0), None);
        assert_eq!(classify(&t, 999, NIGHTMARE_DUNGEON_ID), Some(Category::Cauchemar));
    }

    #[test]
    fn only_members_are_sent() {
        let record: FightRecord = serde_json::from_value(serde_json::json!({
            "id": "auto_1_2", "bossName": "Boss", "targetId": 1, "startTimeMs": 1_700_000_000_000i64,
            "durationMs": 100_000, "totalDamage": 1000, "jobs": [], "jobIds": [],
            "details": {"targetId": 1, "maxHp": 5000, "totalTargetDamage": 1000, "battleTime": 100_000,
                        "startTime": 0, "pingHistory": [], "healSkills": [],
                        "skills": [
                          {"actorId": 1, "code": 1, "name": "a", "time": 1, "dmg": 600, "multiHitCount": 0, "multiHitDamage": 0, "crit": 0, "parry": 0, "back": 0, "perfect": 0, "double": 0, "regen": 0},
                          {"actorId": 2, "code": 1, "name": "a", "time": 1, "dmg": 400, "multiHitCount": 0, "multiHitDamage": 0, "crit": 0, "parry": 0, "back": 0, "perfect": 0, "double": 0, "regen": 0}
                        ]},
            "actors": [
                {"actorId": 1, "nickname": "NeoSimka", "job": "검성"},
                {"actorId": 2, "nickname": "Inconnu", "job": "궁성"}
            ],
            "isTrain": false, "appVersion": "2.0.76", "mobCode": 2400001, "dungeonId": 0, "serverId": 1001
        }))
        .unwrap();
        let members: HashSet<String> = ["neosimka".to_string()].into_iter().collect();
        let p = build_payload(&record, Category::Boss, &members, "NeoSimka", &HashMap::new()).unwrap();
        assert_eq!(p.players.len(), 1);
        assert_eq!(p.players[0].name, "NeoSimka");
        assert_eq!(p.players[0].classe, "Gladiateur");
        assert_eq!(p.players[0].damage, 600);
        assert_eq!(p.players[0].dps, 6);
        assert_eq!(p.players[0].share, 60.0);
        assert!(build_payload(&record, Category::Boss, &HashSet::new(), "x", &HashMap::new()).is_none());
        // Le format attendu par netlify/lib/fights.mjs (validateFight) du site.
        let json = serde_json::to_value(&p).unwrap();
        if let Ok(path) = std::env::var("CHEVRERIE_PAYLOAD_OUT") {
            std::fs::write(path, serde_json::to_string(&json).unwrap()).unwrap();
        }
        for key in ["v", "meter", "fightId", "category", "bossName", "mobCode", "dungeonId", "serverId",
                    "startTimeMs", "durationMs", "totalDamage", "maxHp", "uploader", "players"] {
            assert!(json.get(key).is_some(), "champ {key} manquant");
        }
        for key in ["name", "classe", "damage", "dps", "share", "heal"] {
            assert!(json["players"][0].get(key).is_some(), "champ joueur {key} manquant");
        }
    }
}
