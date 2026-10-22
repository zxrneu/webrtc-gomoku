//! Pure adapters between validated positions and portable coordinate records.
use crate::rules::{game_from_moves, Game, Position, CELLS, SIZE};

pub(crate) fn coordinate(name: &str) -> Result<usize, String> {
    let bytes = name.as_bytes();
    if !(2..=3).contains(&bytes.len()) || !(b'a'..=b'o').contains(&bytes[0]) {
        return Err("coordinate must be a1 through o15".into());
    }
    let y: usize = name[1..].parse().map_err(|_| "invalid coordinate")?;
    let x = (bytes[0] - b'a') as usize;
    if !(1..=SIZE).contains(&y) || format!("{}{y}", bytes[0] as char) != name {
        return Err("invalid coordinate".into());
    }
    Ok((y - 1) * SIZE + x)
}

pub(crate) fn game_for(board: &Position) -> Result<Game, String> {
    let stones = |color| {
        (0..CELLS)
            .filter(|&at| board.cells[at] == color)
            .collect::<Vec<_>>()
    };
    let black = stones(1);
    let white = stones(2);
    if black.len() != white.len() + usize::from(board.turn() == 2) {
        return Err("stone counts disagree with side to move".into());
    }
    let moves = black
        .iter()
        .enumerate()
        .flat_map(|(i, &at)| {
            [Some(at), white.get(i).copied()]
                .into_iter()
                .flatten()
                .map(|p| [p % SIZE, p / SIZE])
        })
        .collect::<Vec<_>>();
    game_from_moves(&moves)
}
