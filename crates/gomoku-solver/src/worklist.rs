//! Conditional proof tasks from candidate strategies; unfinished tasks are not counterexamples.
use crate::{
    rules::{read_game, Game, Position},
    symmetry::canonical,
    tactics::{GuidancePolicy, TacticalLimits, TacticalResult},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SolverEngine {
    #[default]
    Guided,
    Dfpn,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Worklist {
    pub format: String,
    pub rules: String,
    pub conditional: bool,
    pub root: Game,
    pub limits: TacticalLimits,
    pub jobs: Vec<Game>,
    pub truncated: bool,
    #[serde(default)]
    pub policy: GuidancePolicy,
    #[serde(default)]
    pub engine: SolverEngine,
    #[serde(default, rename = "nextJob")]
    pub next_job: usize,
}

impl Worklist {
    pub fn from_json(text: &str) -> Result<Self, String> {
        let work: Self = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if work.format != "gomoku-worklist-v1" || work.rules != "freestyle-15" || !work.conditional
        {
            return Err("unsupported worklist format, rules or scope".into());
        }
        read_game(&work.root)?;
        if work.limits.max_attacks > 113 || work.jobs.len() > 1001 || work.policy.quiet_moves > 225
        {
            return Err("worklist exceeds depth or task limit".into());
        }
        for job in &work.jobs {
            work.validate_job(job)?;
        }
        Ok(work)
    }

    pub fn from_search(
        root: &Game,
        limits: TacticalLimits,
        result: &TacticalResult,
    ) -> Result<Self, String> {
        let mut work = Self {
            format: "gomoku-worklist-v1".into(),
            rules: "freestyle-15".into(),
            conditional: true,
            root: root.clone(),
            limits,
            jobs: Vec::new(),
            truncated: result.frontiers_truncated,
            policy: GuidancePolicy::default(),
            engine: SolverEngine::default(),
            next_job: 0,
        };
        if result.certificate.is_none() {
            let games = std::iter::once(root.clone())
                .chain(result.frontiers.clone())
                .collect();
            work.replace_jobs(games)?;
        }
        Ok(work)
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    pub fn replace_jobs(&mut self, games: Vec<Game>) -> Result<(), String> {
        let mut keys = BTreeSet::new();
        let mut jobs = Vec::new();
        for game in games {
            let key = canonical(&self.validate_job(&game)?).0;
            if !keys.insert(key) {
                continue;
            }
            if jobs.len() >= 1001 {
                self.truncated = true;
                break;
            }
            jobs.push(game);
        }
        jobs.sort_by_key(|g| {
            (
                std::cmp::Reverse(g.moves.len()),
                g.moves.iter().map(|m| [m.x, m.y]).collect::<Vec<_>>(),
            )
        });
        self.jobs = jobs;
        Ok(())
    }

    fn validate_job(&self, job: &Game) -> Result<Position, String> {
        if !job.moves.starts_with(&self.root.moves)
            || !(job.moves.len() - self.root.moves.len()).is_multiple_of(2)
        {
            return Err("task must extend root history with the same side to move".into());
        }
        read_game(job)
    }
}
