//! All-defenses threat plans are untrusted move-ordering hints.
use crate::{
    rules::Position,
    threats::{candidates, cost_sets},
};
use std::collections::BTreeSet;

pub(crate) struct Proposal {
    pub(crate) plan: Option<Vec<usize>>,
    pub(crate) nodes: usize,
}

pub(crate) fn propose(board: &Position, limits: (u16, usize)) -> Proposal {
    let mut scout = Scout {
        limit: limits.1,
        nodes: 0,
        failed: BTreeSet::new(),
    };
    let plan = scout.search(board, limits.0);
    Proposal {
        plan,
        nodes: scout.nodes,
    }
}

struct Scout {
    limit: usize,
    nodes: usize,
    failed: BTreeSet<(Position, u16)>,
}

impl Scout {
    fn search(&mut self, board: &Position, depth: u16) -> Option<Vec<usize>> {
        if depth == 0 || !self.spend() {
            return None;
        }
        let key = (board.clone(), depth);
        if self.failed.contains(&key) {
            return None;
        }
        if let Some(&at) = board.winning_moves(board.turn()).first() {
            return Some(vec![at]);
        }
        for at in candidates(board, true) {
            if !self.spend() {
                break;
            }
            if let Some(plan) = self.attack(board, (at, depth)) {
                return Some(plan);
            }
        }
        if self.nodes < self.limit {
            self.failed.insert(key);
        }
        None
    }

    fn attack(&mut self, board: &Position, (at, depth): (usize, u16)) -> Option<Vec<usize>> {
        let next = board.place(at, board.turn());
        if next.winning_moves(board.turn()).len() >= 2 {
            return Some(vec![at]);
        }
        for costs in cost_sets(&next, at) {
            let mut defended = next.clone();
            for reply in costs {
                defended = defended.place(reply, next.turn());
            }
            if let Some(tail) = self.search(&defended, depth - 1) {
                let mut plan = vec![at];
                plan.extend(tail);
                return Some(plan);
            }
        }
        None
    }

    fn spend(&mut self) -> bool {
        if self.nodes >= self.limit {
            return false;
        }
        self.nodes += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::propose;
    use crate::rules::{game_from_moves, read_game};

    #[test]
    fn simultaneous_local_defenses_still_allow_a_crossing_threat_plan() {
        let game = game_from_moves(&[
            [5, 7],
            [0, 0],
            [6, 7],
            [0, 2],
            [7, 5],
            [14, 14],
            [7, 6],
            [14, 12],
        ])
        .unwrap();
        let board = read_game(&game).unwrap();
        let result = propose(&board, (3, 1000));
        let plan = result.plan.unwrap();
        assert_eq!(plan[0], 112);
        assert!(plan.len() >= 2);
        assert!(result.nodes <= 1000);
    }

    #[test]
    fn a_scout_never_reports_a_plan_after_its_budget_is_exhausted() {
        let game = game_from_moves(&[[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]]).unwrap();
        let board = read_game(&game).unwrap();
        for limits in [(0, 1000), (3, 0)] {
            assert!(propose(&board, limits).plan.is_none());
        }
        let empty = read_game(&game_from_moves(&[]).unwrap()).unwrap();
        assert!(propose(&empty, (12, 1000)).plan.is_none());
    }
}
