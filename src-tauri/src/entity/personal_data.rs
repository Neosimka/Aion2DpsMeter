use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::analyzed_skill::AnalyzedSkill;
use super::damage_packet::ParsedDamagePacket;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalData {
    pub job: String,
    pub dps: f64,
    pub amount: f64,
    pub damage_contribution: f64,
    #[serde(skip)]
    pub analyzed_data: HashMap<i32, AnalyzedSkill>,
    pub nickname: String,
    /// Combat power from the party roster packet, or 0 when this player isn't in
    /// your party (the roster is the only source, so non-party players have none).
    pub combat_power: i64,
    /// Gear score from the same roster packet; 0 when unknown, as above.
    #[serde(default)]
    pub gear_score: i32,
    /// Renders this player's name gold. Resolved locally against a roster the
    /// meter downloads — see `crate::supporters`; nothing about your party is
    /// ever sent anywhere to work this out.
    ///
    /// Cosmetic and nothing else. It must never affect ordering, bar colour, or
    /// any number, because a meter that flatters the people who paid is not a
    /// meter anybody should trust.
    #[serde(default)]
    pub is_supporter: bool,
    /// A party member who runs A2Tools too (`party_presence.rs`): a small
    /// mark beside the name.
    #[serde(default)]
    pub uses_a2tools: bool,
    /// The Others row on an open-world boss: everyone not in your party,
    /// from the HP the boss lost (`DpsCalculator::world_boss_rows`).
    #[serde(default)]
    pub is_others: bool,
    #[serde(default)]
    pub hps: f64,
    #[serde(default)]
    pub heal_amount: f64,
    /// Aion2DpsMeter : taux de coups critiques (en %, coups directs hors DoT).
    #[serde(default)]
    pub crit_rate: f64,
    /// Aion2DpsMeter : dégâts reçus des cibles du combat.
    #[serde(default)]
    pub damage_received: f64,
    /// Aion2DpsMeter : morts, depuis l'entrée dans le donjon (ou pendant le
    /// combat hors donjon).
    #[serde(default)]
    pub deaths: i32,
    /// Aion2DpsMeter : `deaths` compte le donjon entier (affiché à côté du nom).
    #[serde(default)]
    pub deaths_in_dungeon: bool,
    #[serde(skip)]
    pub crit_hits: i64,
    #[serde(skip)]
    pub direct_hits: i64,
}

impl PersonalData {
    pub fn new(nickname: String) -> Self {
        Self {
            job: String::new(),
            dps: 0.0,
            amount: 0.0,
            damage_contribution: 0.0,
            analyzed_data: HashMap::new(),
            nickname,
            combat_power: 0,
            gear_score: 0,
            is_supporter: false,
            uses_a2tools: false,
            is_others: false,
            hps: 0.0,
            heal_amount: 0.0,
            crit_rate: 0.0,
            damage_received: 0.0,
            deaths: 0,
            deaths_in_dungeon: false,
            crit_hits: 0,
            direct_hits: 0,
        }
    }

    pub fn with_job(nickname: String, job: String) -> Self {
        Self {
            job,
            dps: 0.0,
            amount: 0.0,
            damage_contribution: 0.0,
            analyzed_data: HashMap::new(),
            nickname,
            combat_power: 0,
            gear_score: 0,
            is_supporter: false,
            uses_a2tools: false,
            is_others: false,
            hps: 0.0,
            heal_amount: 0.0,
            crit_rate: 0.0,
            damage_received: 0.0,
            deaths: 0,
            deaths_in_dungeon: false,
            crit_hits: 0,
            direct_hits: 0,
        }
    }

    pub fn process_pdp(&mut self, pdp: &ParsedDamagePacket, skill_name: &str) {
        self.amount += pdp.total_damage() as f64;
        let skill_code = pdp.skill_code();
        let skill = self.analyzed_data.entry(skill_code).or_insert_with(|| {
            AnalyzedSkill::new(skill_code, skill_name.to_string())
        });
        skill.process_pdp(pdp);
    }

    pub fn merge_from(&mut self, other: &PersonalData) {
        self.amount += other.amount;
        self.heal_amount += other.heal_amount;
        self.damage_received += other.damage_received;
        self.deaths += other.deaths;
        self.crit_hits += other.crit_hits;
        self.direct_hits += other.direct_hits;
        for (skill_code, other_skill) in &other.analyzed_data {
            let existing = self.analyzed_data.entry(*skill_code).or_insert_with(|| {
                AnalyzedSkill::new(*skill_code, other_skill.skill_name.clone())
            });
            existing.merge_from(other_skill);
        }
    }
}
