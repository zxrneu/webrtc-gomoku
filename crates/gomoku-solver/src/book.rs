//! Opening data supplies candidate moves, never trusted winning claims.
use crate::{
    position_codec::{coordinate, game_for},
    rules::{game_from_moves, read_game, Position, SIZE},
    symmetry::{canonical, inverse, transform},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HintDocument {
    pub(crate) format: String,
    pub(crate) rules: String,
    pub(crate) entries: Vec<HintEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HintEntry {
    pub(crate) moves: Vec<[usize; 2]>,
    pub(crate) at: [usize; 2],
}

pub struct OpeningBook {
    hints: BTreeMap<Position, BTreeSet<usize>>,
}
impl OpeningBook {
    pub fn from_json(json: &str) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if !value.is_object() {
            return Err("book root must be a move object".into());
        }
        let mut book = Self {
            hints: BTreeMap::new(),
        };
        if value.get("format").is_some() {
            book.read_document(value)?;
            return Ok(book);
        }
        let board = read_game(&game_from_moves(&[])?)?;
        book.read(&value, &board, &mut 200_000)?;
        Ok(book)
    }

    pub fn to_json(&self) -> Result<String, String> {
        let mut entries = Vec::new();
        for (board, choices) in &self.hints {
            let moves: Vec<_> = game_for(board)?.moves.iter().map(|m| [m.x, m.y]).collect();
            for &at in choices {
                entries.push(HintEntry {
                    moves: moves.clone(),
                    at: [at % SIZE, at / SIZE],
                });
            }
        }
        serde_json::to_string(&HintDocument {
            format: "gomoku-opening-hints-v1".into(),
            rules: "freestyle-15".into(),
            entries,
        })
        .map_err(|e| e.to_string())
    }

    fn read_document(&mut self, value: serde_json::Value) -> Result<(), String> {
        let document: HintDocument = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if document.format != "gomoku-opening-hints-v1" || document.rules != "freestyle-15" {
            return Err("unsupported opening hint format or rules".into());
        }
        if document.entries.len() > 200_000 {
            return Err("book exceeds 200000 records".into());
        }
        for entry in document.entries {
            let board = read_game(&game_from_moves(&entry.moves)?)?;
            let [x, y] = entry.at;
            if x >= SIZE || y >= SIZE {
                return Err("hint coordinate out of board".into());
            }
            let at = y * SIZE + x;
            board.play(at)?;
            let (key, symmetry) = canonical(&board);
            self.hints
                .entry(key)
                .or_default()
                .insert(transform(at, symmetry));
        }
        Ok(())
    }

    pub fn moves_for(&self, board: &Position) -> Vec<usize> {
        let (key, symmetry) = canonical(board);
        self.hints
            .get(&key)
            .into_iter()
            .flatten()
            .map(|&at| transform(at, inverse(symmetry)))
            .collect()
    }

    fn read(
        &mut self,
        value: &serde_json::Value,
        board: &Position,
        remaining: &mut usize,
    ) -> Result<(), String> {
        if *remaining == 0 {
            return Err("book exceeds 200000 nodes".into());
        }
        *remaining -= 1;
        // Numeric annotations are ignored, including their claimed winner and distance.
        if value.is_number() {
            return Ok(());
        }
        let choices = value
            .as_object()
            .ok_or("expected move object or numeric annotation")?;
        let (key, symmetry) = canonical(board);
        for (name, child) in choices {
            let at = coordinate(name)?;
            let next = board.play(at)?;
            self.hints
                .entry(key.clone())
                .or_default()
                .insert(transform(at, symmetry));
            self.read(child, &next, remaining)?;
        }
        Ok(())
    }
}
