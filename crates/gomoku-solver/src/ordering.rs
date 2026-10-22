//! Ordering changes exploration order, never removes a legal move.
use crate::rules::{Position, SIZE};

#[derive(Clone, Copy)]
struct Target {
    at: usize,
    color: u8,
}
pub fn ordered_moves(board: &Position, color: u8) -> Vec<usize> {
    if !(1..=2).contains(&color) {
        return Vec::new();
    }
    order_subset(board, color, board.empty_cells())
}

pub(crate) fn order_subset(board: &Position, color: u8, points: Vec<usize>) -> Vec<usize> {
    let mut moves: Vec<_> = points
        .into_iter()
        .map(|at| {
            let distance = (at % SIZE).abs_diff(7) + (at / SIZE).abs_diff(7);
            let score = potential(board, at, color) * 10 + potential(board, at, 3 - color) * 9;
            (at, score, distance)
        })
        .collect();
    moves.sort_unstable_by_key(|&(at, score, distance)| (std::cmp::Reverse(score), distance, at));
    moves.into_iter().map(|(at, _, _)| at).collect()
}

fn potential(board: &Position, at: usize, color: u8) -> u64 {
    let mut score = 0;
    for (dx, dy) in [(1, 0), (0, 1), (1, 1), (1, -1)] {
        for offset in -4..=0 {
            score += window(board, Target { at, color }, (dx, dy, offset));
        }
    }
    score
}

fn window(board: &Position, target: Target, line: (isize, isize, isize)) -> u64 {
    let Target { at, color } = target;
    let (dx, dy, offset) = line;
    let mut stones = 0;
    for step in offset..offset + 5 {
        let x = (at % SIZE) as isize + step * dx;
        let y = (at / SIZE) as isize + step * dy;
        if !(0..SIZE as isize).contains(&x) || !(0..SIZE as isize).contains(&y) {
            return 0;
        }
        let cell = board.cells[y as usize * SIZE + x as usize];
        if cell == 3 - color {
            return 0;
        }
        if step == 0 || cell == color {
            stones += 1;
        }
    }
    [0, 0, 2, 20, 500, 100_000][stones]
}
