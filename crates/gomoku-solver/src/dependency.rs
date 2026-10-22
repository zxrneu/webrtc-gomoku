//! Bounded threat dependency and combination planning. Plans remain untrusted hints.
use crate::{
    rules::Position,
    threats::{candidates, cost_sets},
};
use std::collections::BTreeSet;

#[derive(Clone, Default)]
struct Plan {
    gains: Vec<usize>,
    costs: Vec<usize>,
}

#[derive(Default)]
pub(crate) struct Proposal {
    pub(crate) plan: Option<Vec<usize>>,
    pub(crate) nodes: usize,
    pub(crate) dependencies: usize,
    pub(crate) combinations: usize,
    pub(crate) conflicts: usize,
}

pub(crate) fn propose(board: &Position, (depth, budget): (u16, usize)) -> Proposal {
    let mut graph = Graph {
        board,
        depth: usize::from(depth),
        budget,
        result: Proposal::default(),
        plans: vec![Plan::default()],
        seen: BTreeSet::from([board.clone()]),
        pairs: BTreeSet::new(),
    };
    let mut cursor = 0;
    while depth > 0 && graph.result.nodes < budget {
        if cursor < graph.plans.len() {
            let plan = graph.plans[cursor].clone();
            cursor += 1;
            if let Some(plan) = graph.expand(&plan) {
                graph.result.plan = Some(plan);
                break;
            }
        } else if !graph.combine_stage() {
            break;
        }
    }
    graph.result
}

struct Graph<'a> {
    board: &'a Position,
    depth: usize,
    budget: usize,
    result: Proposal,
    plans: Vec<Plan>,
    seen: BTreeSet<Position>,
    pairs: BTreeSet<(usize, usize)>,
}

impl Graph<'_> {
    fn expand(&mut self, plan: &Plan) -> Option<Vec<usize>> {
        if plan.gains.len() >= self.depth {
            return None;
        }
        let board = materialize(self.board, plan);
        for at in candidates(&board, true) {
            if !plan.gains.is_empty() && !plan.gains.iter().any(|&gain| aligned(at, gain)) {
                continue;
            }
            if !self.spend() {
                return None;
            }
            let next = board.place(at, board.turn());
            let mut gains = plan.gains.clone();
            gains.push(at);
            if next.wins_at(at, board.turn()) || next.winning_moves(board.turn()).len() >= 2 {
                return Some(gains);
            }
            for costs in cost_sets(&next, at) {
                let mut child = Plan {
                    gains: gains.clone(),
                    costs: plan.costs.clone(),
                };
                child.costs.extend(costs);
                child.costs.sort_unstable();
                child.costs.dedup();
                if self.insert(child) {
                    self.result.dependencies += 1;
                }
            }
        }
        None
    }

    fn combine_stage(&mut self) -> bool {
        let previous = self.plans.len();
        for right in 1..previous {
            for left in 1..right {
                if self.pairs.contains(&(left, right)) {
                    continue;
                }
                if !self.spend() {
                    return false;
                }
                self.pairs.insert((left, right));
                if self.plans[left].gains.len() + self.plans[right].gains.len() > self.depth {
                    continue;
                }
                match combine(self.board, &self.plans[left], &self.plans[right]) {
                    Some(plan) => {
                        if self.insert(plan) {
                            self.result.combinations += 1;
                        }
                    }
                    None => self.result.conflicts += 1,
                }
            }
        }
        self.plans.len() > previous
    }

    fn insert(&mut self, plan: Plan) -> bool {
        if plan.gains.len() > self.depth || plan.gains.iter().any(|gain| plan.costs.contains(gain))
        {
            return false;
        }
        if !self.seen.insert(materialize(self.board, &plan)) {
            return false;
        }
        self.plans.push(plan);
        true
    }

    fn spend(&mut self) -> bool {
        if self.result.nodes >= self.budget {
            return false;
        }
        self.result.nodes += 1;
        true
    }
}

fn combine(board: &Position, left: &Plan, right: &Plan) -> Option<Plan> {
    if left.gains.iter().any(|gain| right.costs.contains(gain))
        || right.gains.iter().any(|gain| left.costs.contains(gain))
    {
        return None;
    }
    if !left
        .gains
        .iter()
        .any(|&a| right.gains.iter().any(|&b| a != b && aligned(a, b)))
    {
        return None;
    }
    let mut merged = left.clone();
    for &at in &right.gains {
        if !merged.gains.contains(&at) {
            merged.gains.push(at);
        }
    }
    merged.costs.extend(&right.costs);
    merged.costs.sort_unstable();
    merged.costs.dedup();
    let mut previous = candidates(&materialize(board, left), true);
    previous.extend(candidates(&materialize(board, right), true));
    candidates(&materialize(board, &merged), true)
        .iter()
        .any(|at| !previous.contains(at))
        .then_some(merged)
}

fn aligned(a: usize, b: usize) -> bool {
    let dx = (a % 15).abs_diff(b % 15);
    let dy = (a / 15).abs_diff(b / 15);
    dx.max(dy) <= 5 && (dx == 0 || dy == 0 || dx == dy)
}

fn materialize(base: &Position, plan: &Plan) -> Position {
    let mut board = base.clone();
    for &at in &plan.costs {
        board.cells[at] = 3 - base.turn();
    }
    for &at in &plan.gains {
        board.cells[at] = base.turn();
    }
    board.turn = base.turn();
    board
}

#[cfg(test)]
#[path = "../test/dependency.rs"]
mod tests;
