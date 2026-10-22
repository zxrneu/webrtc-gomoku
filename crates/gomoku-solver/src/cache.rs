//! Persistent proofs keyed by the complete two-color position, checked before admission.
use crate::{
    certificate::{Certificate, ProofNode},
    position_codec::game_for,
    proof::verify,
    proof_graph::compact,
    rules::{game_from_moves, read_game, Game, Position, SIZE},
    symmetry::{canonical, inverse, transform},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_ENTRIES: usize = 20_000;
const MAX_NODES: usize = 1_000_000;

#[derive(Default)]
pub struct ProofCache {
    entries: BTreeMap<Position, Certificate>,
    nodes: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    format: String,
    rules: String,
    entries: Vec<Certificate>,
}

impl ProofCache {
    pub fn from_json(text: &str) -> Result<Self, String> {
        let document: Document = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if document.format != "gomoku-proof-cache-v1" || document.rules != "freestyle-15" {
            return Err("unsupported proof cache format or rules".into());
        }
        if document.entries.len() > MAX_ENTRIES
            || document
                .entries
                .iter()
                .map(|c| c.nodes.len())
                .sum::<usize>()
                > MAX_NODES
        {
            return Err("proof cache exceeds entry or node limit".into());
        }
        let mut cache = Self::default();
        for certificate in document.entries {
            cache.insert(&certificate)?;
        }
        Ok(cache)
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(&Document {
            format: "gomoku-proof-cache-v1".into(),
            rules: "freestyle-15".into(),
            entries: self.entries.values().cloned().collect(),
        })
        .map_err(|e| e.to_string())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn insert(&mut self, certificate: &Certificate) -> Result<bool, String> {
        verify(certificate)?;
        let (key, symmetry) = canonical(&read_game(&certificate.game)?);
        let previous = self.entries.get(&key).map_or(0, |c| c.nodes.len());
        let mapped = mapped(certificate, symmetry)?;
        if previous > 0 && previous <= mapped.nodes.len() {
            return Ok(false);
        }
        let total = self.nodes - previous + mapped.nodes.len();
        if total > MAX_NODES || (previous == 0 && self.entries.len() >= MAX_ENTRIES) {
            return Ok(false);
        }
        self.nodes = total;
        self.entries.insert(key, mapped);
        Ok(true)
    }

    pub fn get(&self, game: &Game) -> Result<Option<Certificate>, String> {
        let mut certificate = self.lookup(&read_game(game)?);
        if let Some(certificate) = &mut certificate {
            certificate.game = game.clone();
        }
        Ok(certificate)
    }

    pub(crate) fn contains(&self, board: &Position) -> bool {
        self.entries.contains_key(&canonical(board).0)
    }

    pub(crate) fn lookup(&self, board: &Position) -> Option<Certificate> {
        let (key, symmetry) = canonical(board);
        mapped(self.entries.get(&key)?, inverse(symmetry)).ok()
    }

    pub(crate) fn remember(&mut self, board: &Position, proof: (&[ProofNode], usize)) -> bool {
        if self.contains(board) {
            return false;
        }
        let Ok(game) = game_for(board) else {
            return false;
        };
        let (root, nodes) = compact(proof.1, proof.0);
        let certificate = Certificate {
            format: "gomoku-proof-dag-v1".into(),
            rules: "freestyle-15".into(),
            game,
            attacker: board.turn(),
            root,
            nodes,
        };
        self.insert(&certificate).unwrap_or(false)
    }
}

fn mapped(certificate: &Certificate, symmetry: usize) -> Result<Certificate, String> {
    let (root, mut nodes) = compact(certificate.root, &certificate.nodes);
    for node in &mut nodes {
        match node {
            ProofNode::Five { at } | ProofNode::Fork { at } => *at = transform(*at, symmetry),
            ProofNode::Force { at, reply, .. } => {
                *at = transform(*at, symmetry);
                *reply = transform(*reply, symmetry);
            }
            ProofNode::Branch { at, replies } => {
                *at = transform(*at, symmetry);
                for reply in replies.iter_mut() {
                    reply.at = transform(reply.at, symmetry);
                }
                replies.sort_unstable_by_key(|r| r.at);
            }
        }
    }
    let moves = certificate
        .game
        .moves
        .iter()
        .map(|m| {
            let at = transform(m.y * SIZE + m.x, symmetry);
            [at % SIZE, at / SIZE]
        })
        .collect::<Vec<_>>();
    Ok(Certificate {
        game: game_from_moves(&moves)?,
        nodes,
        root,
        ..certificate.clone()
    })
}
