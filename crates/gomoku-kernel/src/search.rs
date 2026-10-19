//! Bounded fixed-depth prototype. No JS callbacks, heap allocation or wall clock.
use super::{gomoku_score_candidates, point_score, BOARD_BUFFER, CELL_COUNT, S_FIVE};

pub struct Result {
    pub at: i32,
    pub score: f64,
}
pub struct Budget {
    pub nodes: u32,
    pub limit: u32,
    pub depth: i32,
    pub branches: usize,
}

pub unsafe fn evaluate(color: i32) -> f64 {
    let board = core::ptr::addr_of!(BOARD_BUFFER) as *const u8;
    let mut own = 0i64;
    let mut opponent = 0i64;
    for at in 0..CELL_COUNT {
        let owner = *board.add(at) as i32;
        if owner == 0 { continue; }
        let score = point_score(at as i32, owner) as i64;
        if owner == color { own += score; } else { opponent += score; }
    }
    // Pattern scores are multiples of 20, so the 1.1 defense weight is integral.
    (own * 10 - opponent * 11) as f64 / 10.0
}

unsafe fn winning_points(color: i32) -> (usize, i32) {
    let board = core::ptr::addr_of!(BOARD_BUFFER) as *const u8;
    let mut count = 0;
    let mut first = -1;
    for at in 0..CELL_COUNT {
        if *board.add(at) == 0 && point_score(at as i32, color) >= S_FIVE {
            if count == 0 { first = at as i32; }
            count += 1;
        }
    }
    (count, first)
}

pub unsafe fn negamax(color: i32, depth: i32, mut alpha: f64, beta: f64, budget: &mut Budget) -> Result {
    if budget.nodes >= budget.limit { return Result { at: -1, score: evaluate(color) }; }
    budget.nodes += 1;
    let opponent = 3 - color;
    let ply = budget.depth - depth;
    let (wins, win) = winning_points(color);
    if wins > 0 { return Result { at: win, score: (S_FIVE - ply) as f64 }; }
    let (blocks, block) = winning_points(opponent);
    if blocks >= 2 { return Result { at: block, score: (-S_FIVE + ply) as f64 }; }
    if depth == 0 { return Result { at: -1, score: evaluate(color) }; }
    let board = core::ptr::addr_of_mut!(BOARD_BUFFER) as *mut u8;
    if blocks == 1 {
        *board.add(block as usize) = color as u8;
        let child = negamax(opponent, depth - 1, -beta, -alpha, budget);
        *board.add(block as usize) = 0;
        return Result { at: block, score: -child.score };
    }

    // Stack-local buffers are independent at every ply.
    let mut moves = [0i16; CELL_COUNT];
    let mut scores = [0i32; CELL_COUNT];
    let count = gomoku_score_candidates(color, 90, moves.as_mut_ptr(), scores.as_mut_ptr()) as usize;
    if count == 0 { return Result { at: -1, score: evaluate(color) }; }
    for i in 1..count {
        let at = moves[i];
        let score = scores[i];
        let mut j = i;
        while j > 0 && (scores[j - 1] < score || (scores[j - 1] == score && moves[j - 1] > at)) {
            moves[j] = moves[j - 1];
            scores[j] = scores[j - 1];
            j -= 1;
        }
        moves[j] = at;
        scores[j] = score;
    }
    let mut result = Result { at: moves[0] as i32, score: f64::NEG_INFINITY };
    for &at in moves.iter().take(count.min(budget.branches)) {
        *board.add(at as usize) = color as u8;
        let child = negamax(opponent, depth - 1, -beta, -alpha, budget);
        *board.add(at as usize) = 0;
        let score = -child.score;
        if score > result.score { result = Result { at: at as i32, score }; }
        if score > alpha { alpha = score; }
        if alpha >= beta || budget.nodes >= budget.limit { break; }
    }
    result
}
