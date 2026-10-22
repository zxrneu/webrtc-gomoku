//! Only attacker choices equivalent under symmetries preserving both colors may be merged.
use crate::{
    ordering::ordered_moves,
    rules::{Position, CELLS, SIZE},
};
pub fn attack_representatives(board: &Position) -> Vec<usize> {
    let symmetries: Vec<_> = (0..8)
        .filter(|&symmetry| {
            (0..CELLS).all(|at| board.cells[at] == board.cells[transform(at, symmetry)])
        })
        .collect();
    let mut seen = [false; CELLS];
    ordered_moves(board, board.turn())
        .into_iter()
        .filter(|&at| {
            if seen[at] {
                return false;
            }
            for &symmetry in &symmetries {
                seen[transform(at, symmetry)] = true;
            }
            true
        })
        .collect()
}

pub(crate) fn transform(at: usize, symmetry: usize) -> usize {
    let (mut x, mut y) = (at % SIZE, at / SIZE);
    if symmetry >= 4 {
        x = SIZE - 1 - x;
    }
    for _ in 0..symmetry % 4 {
        (x, y) = (SIZE - 1 - y, x);
    }
    y * SIZE + x
}

pub(crate) fn inverse(symmetry: usize) -> usize {
    if symmetry >= 4 {
        symmetry
    } else {
        (4 - symmetry) % 4
    }
}

pub(crate) fn canonical(board: &Position) -> (Position, usize) {
    (0..8)
        .map(|symmetry| {
            let mut mapped = board.clone();
            for at in 0..CELLS {
                mapped.cells[transform(at, symmetry)] = board.cells[at];
            }
            (mapped, symmetry)
        })
        .min()
        .expect("eight symmetries")
}
