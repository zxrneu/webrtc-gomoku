use gomoku_solver::rules::{game_from_moves, Game};

pub fn position(empty: usize) -> Game {
    let mut black = Vec::new();
    let mut white = Vec::new();
    for y in 0..15 {
        for x in 0..15 {
            if (x + 2 * y) % 4 < 2 {
                black.push([x, y]);
            } else {
                white.push([x, y]);
            }
        }
    }
    let mut moves = Vec::new();
    for index in 0..225 - empty {
        moves.push(if index % 2 == 0 {
            black[index / 2]
        } else {
            white[index / 2]
        });
    }
    game_from_moves(&moves).unwrap()
}

pub fn brute_force(board: &gomoku_solver::rules::Position, attacker: u8) -> bool {
    let choices: Vec<_> = board
        .legal_moves()
        .into_iter()
        .map(|at| {
            let next = board.play(at).unwrap();
            if next.wins_at(at, board.turn()) {
                board.turn() == attacker
            } else if next.legal_moves().is_empty() {
                false
            } else {
                brute_force(&next, attacker)
            }
        })
        .collect();
    if board.turn() == attacker {
        choices.into_iter().any(|won| won)
    } else {
        !choices.is_empty() && choices.into_iter().all(|won| won)
    }
}
