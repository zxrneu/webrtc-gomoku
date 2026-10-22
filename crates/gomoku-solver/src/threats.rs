//! Exact local candidate generation for four and open-three threats.
use crate::{
    ordering::order_subset,
    rules::{Position, CELLS, SIZE},
};

pub(crate) fn candidates(board: &Position, threes: bool) -> Vec<usize> {
    let mut ranks = [0_u8; CELLS];
    for direction in [(1, 0), (0, 1), (1, 1), (1, -1)] {
        for start in 0..CELLS {
            mark(board, &mut ranks, (start, direction, 5));
            if threes {
                mark(board, &mut ranks, (start, direction, 6));
            }
        }
    }
    let points = (0..CELLS).filter(|&at| ranks[at] > 0).collect();
    let mut choices = order_subset(board, board.turn(), points);
    choices.sort_by_key(|&at| std::cmp::Reverse(ranks[at]));
    choices
}

fn mark(board: &Position, ranks: &mut [u8; CELLS], line: (usize, (isize, isize), usize)) {
    let (start, (dx, dy), length) = line;
    let Some(points) = points(start, (dx, dy), length) else {
        return;
    };
    let color = board.turn();
    if points[..length]
        .iter()
        .any(|&at| board.cells[at] == 3 - color)
    {
        return;
    }
    let stones = points[..length]
        .iter()
        .filter(|&&at| board.cells[at] == color)
        .count();
    let (range, rank) = match (length, stones) {
        (5, 3) => (0..5, 2),
        (6, 2) if board.cells[points[0]] == 0 && board.cells[points[5]] == 0 => (1..5, 1),
        _ => return,
    };
    for &at in &points[range] {
        if board.cells[at] == 0 {
            ranks[at] = ranks[at].max(rank);
        }
    }
}

fn points(start: usize, (dx, dy): (isize, isize), length: usize) -> Option<[usize; 6]> {
    let mut points = [0; 6];
    for (step, at) in points.iter_mut().enumerate().take(length) {
        let x = (start % SIZE) as isize + step as isize * dx;
        let y = (start / SIZE) as isize + step as isize * dy;
        if !(0..SIZE as isize).contains(&x) || !(0..SIZE as isize).contains(&y) {
            return None;
        }
        *at = y as usize * SIZE + x as usize;
    }
    Some(points)
}

pub(crate) fn cost_sets(board: &Position, gain: usize) -> Vec<Vec<usize>> {
    let wins = board.winning_moves(3 - board.turn());
    if !wins.is_empty() {
        return vec![wins];
    }
    let mut sets = Vec::new();
    for direction in [(1, 0), (0, 1), (1, 1), (1, -1)] {
        for start in 0..CELLS {
            if let Some(costs) = three_costs(board, gain, (start, direction)) {
                if !sets.contains(&costs) {
                    sets.push(costs);
                }
            }
        }
    }
    sets
}

fn three_costs(board: &Position, gain: usize, line: (usize, (isize, isize))) -> Option<Vec<usize>> {
    let points = points(line.0, line.1, 6)?;
    if !points[1..5].contains(&gain) || board.cells[points[0]] != 0 || board.cells[points[5]] != 0 {
        return None;
    }
    let attacker = 3 - board.turn();
    if points.iter().any(|&at| board.cells[at] == board.turn()) {
        return None;
    }
    if points[1..5]
        .iter()
        .filter(|&&at| board.cells[at] == attacker)
        .count()
        != 3
    {
        return None;
    }
    let mut costs: Vec<_> = points
        .into_iter()
        .filter(|&at| board.cells[at] == 0)
        .collect();
    costs.sort_unstable();
    Some(costs)
}

pub(crate) fn fork_defenses(board: &Position) -> Vec<usize> {
    let mut opponent = board.clone();
    opponent.turn = 3 - board.turn();
    let mut defenses = [false; CELLS];
    for gain in candidates(&opponent, false) {
        let next = opponent.place(gain, opponent.turn());
        let wins = next.winning_moves(opponent.turn());
        if wins.len() >= 2 {
            defenses[gain] = true;
            for at in wins {
                defenses[at] = true;
            }
        }
    }
    let points = (0..CELLS).filter(|&at| defenses[at]).collect();
    order_subset(board, board.turn(), points)
}

#[cfg(test)]
mod tests {
    use crate::rules::{game_from_moves, read_game};

    #[test]
    fn quiet_moves_that_prevent_an_opponent_open_four_remain_available() {
        let game = game_from_moves(&[
            [7, 7],
            [7, 6],
            [8, 6],
            [6, 8],
            [8, 5],
            [8, 7],
            [9, 5],
            [10, 4],
            [9, 6],
            [6, 5],
            [9, 8],
            [9, 7],
            [10, 7],
            [11, 8],
            [8, 4],
            [6, 6],
        ])
        .unwrap();
        let board = read_game(&game).unwrap();
        assert!(board.winning_moves(2).is_empty());
        let defenses = super::fork_defenses(&board);
        for at in [4 * 15 + 6, 7 * 15 + 6, 9 * 15 + 6] {
            assert!(defenses.contains(&at), "missing quiet defense {at}");
            let next = board.play(at).unwrap();
            let white_gain = 7 * 15 + 6;
            if next.cell(white_gain) == Some(0) {
                assert!(next.play(white_gain).unwrap().winning_moves(2).len() < 2);
            }
        }
    }
}
