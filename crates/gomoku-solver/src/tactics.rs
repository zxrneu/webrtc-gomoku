//! Bounded tactical proof search. Failure to find a proof is always unknown.
use crate::{
    certificate::{Certificate, ProofNode, Reply},
    ordering::ordered_moves,
    proof::{verify, verify_fragment},
    proof_graph::{append, compact},
    rules::{game_from_moves, read_game, Game, Position},
    symmetry::{canonical, inverse, transform},
    threats::{candidates, fork_defenses},
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TacticalLimits {
    pub max_attacks: u16,
    pub max_nodes: usize,
    pub threes: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TacticalStats {
    pub nodes: usize,
    pub cache_hits: usize,
    pub proof_reuses: usize,
    pub budget_exhausted: bool,
    pub book_hits: usize,
    pub interrupted: bool,
    pub symmetry_hits: usize,
    pub scout_nodes: usize,
    pub scout_hits: usize,
    #[serde(flatten)]
    pub guidance: GuidanceStats,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidanceStats {
    pub persistent_hits: usize,
    pub cache_saved: usize,
    pub dependency_nodes: usize,
    pub dependency_combinations: usize,
    pub dependency_conflicts: usize,
    pub quiet_nodes: usize,
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct GuidancePolicy {
    pub quiet_moves: usize,
}

pub struct TacticalResult {
    pub certificate: Option<Certificate>,
    pub stats: TacticalStats,
    pub frontier: Option<Game>,
    pub frontiers: Vec<Game>,
    pub frontiers_truncated: bool,
}

pub struct GuidedRequest<'a> {
    pub game: &'a Game,
    pub book: &'a crate::book::OpeningBook,
}

pub struct CachedRequest<'a> {
    pub game: &'a Game,
    pub book: &'a crate::book::OpeningBook,
    pub cache: &'a mut crate::cache::ProofCache,
    pub policy: GuidancePolicy,
}

pub fn solve_guided_cached(
    request: CachedRequest<'_>,
    limits: TacticalLimits,
    mut stop: impl FnMut() -> bool,
) -> Result<TacticalResult, String> {
    let mut search = TacticalSearch::new(limits.max_nodes);
    search.book = Some(request.book);
    search.cache = Some(request.cache);
    search.policy = request.policy;
    search.quiet_left = u8::from(request.policy.quiet_moves > 0);
    search.stop = Some(&mut stop);
    finish(request.game, limits, search)
}

pub fn solve_guided(
    request: GuidedRequest<'_>,
    limits: TacticalLimits,
    mut stop: impl FnMut() -> bool,
) -> Result<TacticalResult, String> {
    let mut search = TacticalSearch::new(limits.max_nodes);
    search.book = Some(request.book);
    search.stop = Some(&mut stop);
    finish(request.game, limits, search)
}

pub fn solve(game: &Game, limits: TacticalLimits) -> Result<TacticalResult, String> {
    finish(game, limits, TacticalSearch::new(limits.max_nodes))
}

fn finish(
    game: &Game,
    limits: TacticalLimits,
    mut search: TacticalSearch<'_>,
) -> Result<TacticalResult, String> {
    let board = read_game(game)?;
    if limits.max_attacks > 113 || search.policy.quiet_moves > 225 {
        return Err("maxAttacks must be at most 113 and quietMoves at most 225".into());
    }
    let root = search.preferred(&board, limits.max_attacks, limits.threes);
    let certificate = finish_certificate(game, &mut search, root)?;
    let frontier = search
        .frontier
        .as_ref()
        .and_then(|path| game_at_path(game, &path[..path.len() / 2 * 2]).ok());
    let frontiers = unfinished_games(game, &search);
    Ok(TacticalResult {
        certificate,
        stats: search.stats,
        frontier,
        frontiers,
        frontiers_truncated: search.pending_truncated,
    })
}

fn finish_certificate(
    game: &Game,
    search: &mut TacticalSearch<'_>,
    root: Option<usize>,
) -> Result<Option<Certificate>, String> {
    let certificate = root.map(|root| {
        let (root, nodes) = compact(root, &search.nodes);
        Certificate {
            format: "gomoku-proof-dag-v1".into(),
            rules: "freestyle-15".into(),
            game: game.clone(),
            attacker: if game.moves.len().is_multiple_of(2) {
                1
            } else {
                2
            },
            root,
            nodes,
        }
    });
    if let Some(certificate) = &certificate {
        verify(certificate)?;
        if let Some(cache) = search.cache.as_deref_mut() {
            search.stats.guidance.cache_saved += usize::from(cache.insert(certificate)?);
        }
    }
    Ok(certificate)
}

fn unfinished_games(game: &Game, search: &TacticalSearch<'_>) -> Vec<Game> {
    search
        .pending
        .iter()
        .filter_map(|(board, path)| {
            if search
                .cache
                .as_deref()
                .is_some_and(|cache| cache.contains(board))
            {
                return None;
            }
            let pending = game_at_path(game, path).ok()?;
            (read_game(&pending).ok().as_ref() == Some(board)).then_some(pending)
        })
        .collect()
}

fn game_at_path(game: &Game, path: &[usize]) -> Result<Game, String> {
    let mut points: Vec<_> = game.moves.iter().map(|m| [m.x, m.y]).collect();
    points.extend(path.iter().map(|at| [at % 15, at / 15]));
    game_from_moves(&points)
}

pub(crate) struct TacticalSearch<'a> {
    limit: usize,
    pub(crate) nodes: Vec<ProofNode>,
    pub(crate) stats: TacticalStats,
    memo: BTreeMap<(Position, u16, bool, u8), Option<usize>>,
    book: Option<&'a crate::book::OpeningBook>,
    stop: Option<&'a mut dyn FnMut() -> bool>,
    local_horizon: bool,
    mapped: BTreeMap<(usize, usize), usize>,
    plan: Vec<usize>,
    path: Vec<usize>,
    frontier: Option<Vec<usize>>,
    speculative: usize,
    cache: Option<&'a mut crate::cache::ProofCache>,
    pending: BTreeMap<Position, Vec<usize>>,
    pending_truncated: bool,
    policy: GuidancePolicy,
    quiet_left: u8,
}

impl TacticalSearch<'_> {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            nodes: Vec::new(),
            stats: TacticalStats::default(),
            memo: BTreeMap::new(),
            book: None,
            stop: None,
            local_horizon: false,
            mapped: BTreeMap::new(),
            plan: Vec::new(),
            path: Vec::new(),
            frontier: None,
            speculative: 0,
            cache: None,
            pending: BTreeMap::new(),
            pending_truncated: false,
            policy: GuidancePolicy::default(),
            quiet_left: 0,
        }
    }

    pub(crate) fn search(&mut self, board: &Position, depth: u16, threes: bool) -> Option<usize> {
        if let Some(certificate) = self.cache.as_deref().and_then(|cache| cache.lookup(board)) {
            self.stats.guidance.persistent_hits += 1;
            return Some(append(
                certificate.root,
                &certificate.nodes,
                &mut self.nodes,
            ));
        }
        if depth == 0 || !self.spend() {
            self.record_unknown(board);
            return None;
        }
        let (position, symmetry) = if self.book.is_some() {
            canonical(board)
        } else {
            (board.clone(), 0)
        };
        let key = (position, depth, threes, self.quiet_left);
        if let Some(&result) = self.memo.get(&key) {
            self.stats.cache_hits += 1;
            self.stats.symmetry_hits += usize::from(symmetry != 0);
            return result.map(|proof| self.relocate(proof, inverse(symmetry)));
        }
        let result = self.find(board, depth, threes);
        match result {
            Some(root) => self.remember(board, root),
            None => self.record_unknown(board),
        }
        if !self.stats.budget_exhausted && !self.stats.interrupted {
            let mapped = result.map(|proof| self.relocate(proof, symmetry));
            self.memo.insert(key, mapped);
        }
        result
    }

    fn relocate(&mut self, id: usize, symmetry: usize) -> usize {
        if symmetry == 0 {
            return id;
        }
        if let Some(&mapped) = self.mapped.get(&(id, symmetry)) {
            return mapped;
        }
        let at = transform(self.nodes[id].at(), symmetry);
        let proof = match self.nodes[id].clone() {
            ProofNode::Five { .. } => ProofNode::Five { at },
            ProofNode::Fork { .. } => ProofNode::Fork { at },
            ProofNode::Force { reply, next, .. } => ProofNode::Force {
                at,
                reply: transform(reply, symmetry),
                next: self.relocate(next, symmetry),
            },
            ProofNode::Branch { replies, .. } => {
                let mut replies: Vec<_> = replies
                    .into_iter()
                    .map(|r| Reply {
                        at: transform(r.at, symmetry),
                        proof: self.relocate(r.proof, symmetry),
                    })
                    .collect();
                replies.sort_unstable_by_key(|r| r.at);
                ProofNode::Branch { at, replies }
            }
        };
        let mapped = self.push(proof);
        self.mapped.insert((id, symmetry), mapped);
        mapped
    }

    fn preferred(&mut self, board: &Position, depth: u16, threes: bool) -> Option<usize> {
        let Some(book) = self.book else {
            return self.search(board, depth, threes);
        };
        if !threes || self.local_horizon || !book.moves_for(board).is_empty() {
            return self.search(board, depth, threes);
        }
        if let Some(proof) = self.search(board, depth.min(12), false) {
            return Some(proof);
        }
        if self.stats.budget_exhausted || self.stats.interrupted {
            return None;
        }
        let previous_plan = std::mem::take(&mut self.plan);
        let scout_budget = (self.limit.saturating_sub(self.stats.nodes) / 8).min(256);
        self.plan = self.propose_plan(board, (depth.min(12), scout_budget));
        if !self.plan.is_empty() {
            let result = self.try_plan(board, depth.min(12));
            self.plan.clear();
            if result.is_some() || self.stats.interrupted {
                self.plan = previous_plan;
                return result;
            }
        }
        let mut bound = depth.min(12);
        loop {
            self.local_horizon = true;
            let result = self.search(board, bound, true);
            self.local_horizon = false;
            if result.is_some()
                || bound == depth
                || self.stats.budget_exhausted
                || self.stats.interrupted
            {
                self.plan = previous_plan;
                return result;
            }
            bound = (bound + 12).min(depth);
        }
    }

    fn propose_plan(&mut self, board: &Position, (depth, budget): (u16, usize)) -> Vec<usize> {
        let dependency = crate::dependency::propose(board, (depth, budget));
        self.stats.guidance.dependency_nodes += dependency.nodes;
        self.stats.guidance.dependency_combinations += dependency.combinations;
        self.stats.guidance.dependency_conflicts += dependency.conflicts;
        let fallback = if dependency.plan.is_none() {
            crate::scout::propose(board, (depth, budget.saturating_sub(dependency.nodes)))
        } else {
            crate::scout::Proposal {
                plan: None,
                nodes: 0,
            }
        };
        let nodes = dependency.nodes + fallback.nodes;
        let plan = dependency.plan.or(fallback.plan);
        self.stats.nodes += nodes;
        self.stats.scout_nodes += nodes;
        self.stats.scout_hits += usize::from(plan.is_some());
        plan.unwrap_or_default()
    }

    fn try_plan(&mut self, board: &Position, depth: u16) -> Option<usize> {
        let total_limit = self.limit;
        let allowance = (total_limit.saturating_sub(self.stats.nodes) / 8).min(1024);
        self.limit = self.stats.nodes + allowance;
        self.speculative += 1;
        self.local_horizon = true;
        let result = self.search(board, depth, true);
        self.local_horizon = false;
        self.limit = total_limit;
        self.speculative -= 1;
        // A speculative plan gets a small share of the budget; failure leaves the ordinary search available.
        self.stats.budget_exhausted = self.stats.nodes >= total_limit;
        result
    }

    fn find(&mut self, board: &Position, depth: u16, threes: bool) -> Option<usize> {
        if let Some(&at) = board.winning_moves(board.turn()).first() {
            return Some(self.push(ProofNode::Five { at }));
        }
        let counters = board.winning_moves(3 - board.turn());
        if counters.len() > 1 {
            return None;
        }
        let mut choices = self.choices(board, threes);
        if threes && counters.len() == 1 && !choices.iter().any(|choice| choice.at == counters[0]) {
            choices.insert(
                0,
                Choice {
                    at: counters[0],
                    quiet: false,
                },
            );
        }
        for Choice { at, quiet } in choices {
            if !counters.is_empty() && counters[0] != at {
                continue;
            }
            if !self.spend() {
                break;
            }
            let attack = Attack {
                at,
                board: board.place(at, board.turn()),
                depth,
                threes,
            };
            let traced = self.trace(at);
            self.quiet_left -= u8::from(quiet);
            self.stats.guidance.quiet_nodes += usize::from(quiet);
            let result = self.after_attack(attack);
            self.quiet_left += u8::from(quiet);
            self.untrace(traced);
            if let Some(proof) = result {
                return Some(proof);
            }
        }
        None
    }

    fn attack_choices(&mut self, board: &Position, threes: bool) -> (Vec<usize>, bool) {
        let mut choices = if threes {
            self.book
                .map(|book| book.moves_for(board))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        self.stats.book_hits += usize::from(!choices.is_empty());
        let defenses = if threes {
            fork_defenses(board)
        } else {
            Vec::new()
        };
        let attacks = candidates(board, threes && defenses.is_empty());
        if !defenses.is_empty() {
            // Off-square non-forcing moves allow an immediate enemy fork.
            choices.retain(|at| attacks.contains(at) || defenses.contains(at));
        }
        let allow_quiet = threes && defenses.is_empty() && self.quiet_left > 0;
        for at in attacks.into_iter().chain(defenses) {
            if !choices.contains(&at) {
                choices.push(at);
            }
        }
        if !self.plan.is_empty() {
            choices.sort_by_key(|at| {
                self.plan
                    .iter()
                    .position(|gain| gain == at)
                    .unwrap_or(self.plan.len())
            });
        }
        (choices, allow_quiet)
    }

    fn choices(&mut self, board: &Position, threes: bool) -> Vec<Choice> {
        let (choices, allow_quiet) = self.attack_choices(board, threes);
        let mut result: Vec<_> = choices
            .iter()
            .map(|&at| Choice { at, quiet: false })
            .collect();
        if allow_quiet {
            result.extend(
                ordered_moves(board, board.turn())
                    .into_iter()
                    .filter(|at| !choices.contains(at))
                    .take(self.policy.quiet_moves)
                    .map(|at| Choice { at, quiet: true }),
            );
        }
        result
    }

    fn after_attack(&mut self, attack: Attack) -> Option<usize> {
        let Attack {
            at,
            ref board,
            depth,
            threes,
        } = attack;
        let attacker = 3 - board.turn();
        if !board.winning_moves(board.turn()).is_empty() {
            return None;
        }
        let wins = board.winning_moves(attacker);
        if wins.len() >= 2 {
            return Some(self.push(ProofNode::Fork { at }));
        }
        if depth <= 1 {
            return None;
        }
        if let Some(&reply) = wins.first() {
            let traced = self.trace(reply);
            let result = self.search(&board.place(reply, board.turn()), depth - 1, threes);
            self.untrace(traced);
            let next = result?;
            return Some(self.push(ProofNode::Force { at, reply, next }));
        }
        if !threes {
            return None;
        }
        self.branch(attack)
    }

    fn branch(&mut self, attack: Attack) -> Option<usize> {
        let Attack {
            at,
            board,
            depth,
            threes,
        } = attack;
        let mut passed = board.clone();
        passed.turn = 3 - board.turn();
        // A null-move continuation is only a hint. Every real defense is checked below.
        self.speculative += 1;
        let mut hints: Vec<_> = self.search(&passed, depth - 1, false).into_iter().collect();
        self.speculative -= 1;
        let mut replies = Vec::new();
        for reply in ordered_moves(&board, board.turn()) {
            if !self.spend() {
                return None;
            }
            let next = board.place(reply, board.turn());
            let traced = self.trace(reply);
            let result = self.continuation(&next, (depth - 1, threes), &hints);
            self.untrace(traced);
            let proof = result?;
            if !hints.contains(&proof) {
                hints.push(proof);
            }
            replies.push(Reply { at: reply, proof });
        }
        if replies.is_empty() {
            return None;
        }
        replies.sort_unstable_by_key(|reply| reply.at);
        Some(self.push(ProofNode::Branch { at, replies }))
    }

    fn continuation(
        &mut self,
        board: &Position,
        limits: (u16, bool),
        hints: &[usize],
    ) -> Option<usize> {
        for &proof in hints {
            if verify_fragment(&self.nodes, board, proof).is_ok() {
                self.stats.proof_reuses += 1;
                self.remember(board, proof);
                return Some(proof);
            }
        }
        self.preferred(board, limits.0, limits.1)
    }

    fn remember(&mut self, board: &Position, root: usize) {
        if self.speculative != 0 {
            return;
        }
        if let Some(cache) = self.cache.as_deref_mut() {
            self.stats.guidance.cache_saved +=
                usize::from(cache.remember(board, (&self.nodes, root)));
        }
    }

    fn record_unknown(&mut self, board: &Position) {
        if self.speculative != 0 || self.book.is_none() {
            return;
        }
        if self.pending.len() >= 1000 {
            self.pending_truncated = true;
            return;
        }
        self.pending
            .entry(board.clone())
            .or_insert_with(|| self.path.clone());
    }

    fn spend(&mut self) -> bool {
        if self.stats.interrupted || self.stop.as_mut().is_some_and(|stop| stop()) {
            self.stats.interrupted = true;
            self.capture_frontier();
            return false;
        }
        if self.stats.nodes >= self.limit {
            self.stats.budget_exhausted = true;
            self.capture_frontier();
            return false;
        }
        self.stats.nodes += 1;
        true
    }

    fn push(&mut self, proof: ProofNode) -> usize {
        let id = self.nodes.len();
        self.nodes.push(proof);
        id
    }

    fn capture_frontier(&mut self) {
        if self.speculative == 0 && self.frontier.is_none() {
            self.frontier = Some(self.path.clone());
        }
    }

    fn trace(&mut self, at: usize) -> bool {
        let actual = self.speculative == 0;
        if actual {
            self.path.push(at);
        }
        actual
    }

    fn untrace(&mut self, traced: bool) {
        if traced {
            self.path.pop();
        }
    }
}

struct Attack {
    at: usize,
    board: Position,
    depth: u16,
    threes: bool,
}

struct Choice {
    at: usize,
    quiet: bool,
}

#[cfg(test)]
#[path = "../test/tactical_symmetry.rs"]
mod symmetry_tests;

#[cfg(test)]
#[path = "../test/preparations.rs"]
mod preparation_tests;
