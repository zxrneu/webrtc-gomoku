//! Incremental AND/OR proof-number search with exact-position transpositions.
use crate::{
    certificate::{Certificate, ProofNode, Reply},
    ordering::ordered_moves,
    rules::{read_game, Game, Position},
    tactics::{TacticalLimits, TacticalSearch},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

const INF: u64 = u64::MAX / 4;

#[path = "dfpn.rs"]
pub mod dfpn;

#[derive(Clone)]
enum Kind {
    Or,
    And { at: usize, forced: Option<usize> },
}

struct Node {
    board: Position,
    attacks: u16,
    kind: Kind,
    pn: u64,
    dn: u64,
    pending: Vec<usize>,
    edges: Vec<(usize, usize)>,
    parents: Vec<usize>,
    terminal: Option<ProofNode>,
    witness: Option<(usize, Vec<ProofNode>)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Expansion {
    node: usize,
    at: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Checkpoint {
    format: String,
    rules: String,
    game: Game,
    max_attacks: u16,
    steps: Vec<Expansion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tactics: Option<TacticalLimits>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStats {
    pub nodes: usize,
    pub expansions: usize,
    pub transpositions: usize,
    pub proof_number: u64,
    pub disproof_number: u64,
    pub finished: bool,
    pub tactical_nodes: usize,
    pub tactical_proofs: usize,
}

pub struct Search {
    game: Game,
    max_attacks: u16,
    attacker: u8,
    arena: Vec<Node>,
    positions: BTreeMap<(Position, u16), usize>,
    steps: Vec<Expansion>,
    transpositions: usize,
    tactics: Option<TacticalLimits>,
    tactical_nodes: usize,
    tactical_proofs: usize,
}
impl Search {
    pub fn with_tactics(
        game: Game,
        max_attacks: u16,
        limits: TacticalLimits,
    ) -> Result<Self, String> {
        if limits.max_attacks > 113 {
            return Err("tactical maxAttacks must be at most 113".into());
        }
        let mut search = Self::new(game, max_attacks)?;
        search.tactics = Some(limits);
        let mut root = search.arena.pop().expect("root exists");
        search.probe(&mut root);
        search.arena.push(root);
        Ok(search)
    }
    pub fn new(game: Game, max_attacks: u16) -> Result<Self, String> {
        if max_attacks > 113 {
            return Err("maxAttacks must be at most 113".into());
        }
        let board = read_game(&game)?;
        let attacker = board.turn();
        let root = Node::attack(board.clone(), max_attacks);
        Ok(Self {
            game,
            max_attacks,
            attacker,
            arena: vec![root],
            positions: BTreeMap::from([((board, max_attacks), 0)]),
            steps: Vec::new(),
            transpositions: 0,
            tactics: None,
            tactical_nodes: 0,
            tactical_proofs: 0,
        })
    }
    pub fn advance(&mut self, expansions: usize) -> bool {
        for _ in 0..expansions {
            let Some(step) = self.next_expansion() else {
                break;
            };
            self.expand(&step);
            self.steps.push(step);
        }
        !self.finished()
    }
    pub fn stats(&self) -> SearchStats {
        SearchStats {
            nodes: self.arena.len(),
            expansions: self.steps.len(),
            transpositions: self.transpositions,
            proof_number: self.arena[0].pn,
            disproof_number: self.arena[0].dn,
            finished: self.finished(),
            tactical_nodes: self.tactical_nodes,
            tactical_proofs: self.tactical_proofs,
        }
    }
    pub fn certificate(&self) -> Result<Option<Certificate>, String> {
        if self.arena[0].pn != 0 {
            return Ok(None);
        }
        let mut nodes = Vec::new();
        let root = self.emit(0, &mut nodes, &mut BTreeMap::new());
        let certificate = Certificate {
            format: "gomoku-proof-dag-v1".into(),
            rules: "freestyle-15".into(),
            game: self.game.clone(),
            attacker: self.attacker,
            root,
            nodes,
        };
        crate::proof::verify(&certificate)?;
        Ok(Some(certificate))
    }
    pub fn checkpoint(&self) -> Result<String, String> {
        serde_json::to_string(&Checkpoint {
            format: "gomoku-search-checkpoint-v1".into(),
            rules: "freestyle-15".into(),
            game: self.game.clone(),
            max_attacks: self.max_attacks,
            steps: self.steps.clone(),
            tactics: self.tactics,
        })
        .map_err(|e| e.to_string())
    }
    pub fn restore(json: &str) -> Result<Self, String> {
        let checkpoint: Checkpoint = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if checkpoint.format != "gomoku-search-checkpoint-v1" || checkpoint.rules != "freestyle-15"
        {
            return Err("unsupported checkpoint rules or format".into());
        }
        let mut search = match checkpoint.tactics {
            Some(limits) => Self::with_tactics(checkpoint.game, checkpoint.max_attacks, limits)?,
            None => Self::new(checkpoint.game, checkpoint.max_attacks)?,
        };
        for step in checkpoint.steps {
            if search.next_expansion().as_ref() != Some(&step) {
                return Err("invalid expansion log".into());
            }
            search.expand(&step);
            search.steps.push(step);
        }
        Ok(search)
    }

    fn finished(&self) -> bool {
        self.arena[0].pn == 0 || self.arena[0].dn == 0
    }

    fn next_expansion(&self) -> Option<Expansion> {
        if self.finished() {
            return None;
        }
        let mut id = 0;
        loop {
            let node = &self.arena[id];
            let metric = |child: usize| match node.kind {
                Kind::Or => self.arena[child].pn,
                _ => self.arena[child].dn,
            };
            let best = node
                .edges
                .iter()
                .map(|&(_, child)| child)
                .filter(|&child| metric(child) > 0)
                .min_by_key(|&child| metric(child));
            if !node.pending.is_empty() && best.is_none_or(|child| metric(child) > 1) {
                return Some(Expansion {
                    node: id,
                    at: *node.pending.last()?,
                });
            }
            id = best?;
        }
    }

    fn expand(&mut self, step: &Expansion) {
        let parent = &self.arena[step.node];
        let board = parent.board.place(step.at, parent.board.turn());
        let child = match parent.kind {
            Kind::Or => self.push(Node::defense(board, parent.attacks, step.at)),
            Kind::And { .. } => self.attack_node(board, parent.attacks - 1),
        };
        self.arena[step.node].pending.pop();
        self.arena[step.node].edges.push((step.at, child));
        self.arena[child].parents.push(step.node);
        self.propagate(step.node);
    }

    fn attack_node(&mut self, board: Position, attacks: u16) -> usize {
        let key = (board.clone(), attacks);
        if let Some(&id) = self.positions.get(&key) {
            self.transpositions += 1;
            return id;
        }
        let mut node = Node::attack(board, attacks);
        self.probe(&mut node);
        let id = self.push(node);
        self.positions.insert(key, id);
        id
    }

    fn probe(&mut self, node: &mut Node) {
        let Some(limits) = self.tactics else {
            return;
        };
        if node.pn == 0 || node.dn == 0 {
            return;
        }
        let mut tactical = TacticalSearch::new(limits.max_nodes);
        let root = tactical.search(
            &node.board,
            node.attacks.min(limits.max_attacks),
            limits.threes,
        );
        self.tactical_nodes += tactical.stats.nodes;
        if let Some(root) = root {
            self.tactical_proofs += 1;
            node.witness = Some(crate::proof_graph::compact(root, &tactical.nodes));
            node.pn = 0;
            node.dn = INF;
            node.pending.clear();
        }
    }

    fn push(&mut self, node: Node) -> usize {
        let id = self.arena.len();
        self.arena.push(node);
        id
    }

    fn propagate(&mut self, start: usize) {
        let mut queue = VecDeque::from([start]);
        while let Some(id) = queue.pop_front() {
            let (pn, dn) = self.numbers(id);
            let node = &mut self.arena[id];
            if node.pn == pn && node.dn == dn {
                continue;
            }
            node.pn = pn;
            node.dn = dn;
            queue.extend(node.parents.iter().copied());
        }
    }

    fn numbers(&self, id: usize) -> (u64, u64) {
        let node = &self.arena[id];
        if node.terminal.is_some() || node.witness.is_some() {
            return (0, INF);
        }
        let mut sum = node.pending.len() as u64;
        let mut min = if node.pending.is_empty() { INF } else { 1 };
        for &(_, child) in &node.edges {
            let next = &self.arena[child];
            match node.kind {
                Kind::Or => {
                    min = min.min(next.pn);
                    sum = (sum + next.dn).min(INF);
                }
                Kind::And { .. } => {
                    min = min.min(next.dn);
                    sum = (sum + next.pn).min(INF);
                }
            }
        }
        match node.kind {
            Kind::Or => (min, sum),
            _ => (sum, min),
        }
    }

    fn emit(
        &self,
        id: usize,
        nodes: &mut Vec<ProofNode>,
        memo: &mut BTreeMap<usize, usize>,
    ) -> usize {
        if let Some(&proof) = memo.get(&id) {
            return proof;
        }
        let node = &self.arena[id];
        if let Some((root, source)) = &node.witness {
            let proof = crate::proof_graph::append(*root, source, nodes);
            memo.insert(id, proof);
            return proof;
        }
        if matches!(node.kind, Kind::Or) && node.terminal.is_none() {
            let child = node
                .edges
                .iter()
                .find(|&&(_, child)| self.arena[child].pn == 0)
                .expect("proved OR child")
                .1;
            let proof = self.emit(child, nodes, memo);
            memo.insert(id, proof);
            return proof;
        }
        let proof = node
            .terminal
            .clone()
            .unwrap_or_else(|| self.emit_defense(node, nodes, memo));
        let proof_id = nodes.len();
        nodes.push(proof);
        memo.insert(id, proof_id);
        proof_id
    }

    fn emit_defense(
        &self,
        node: &Node,
        nodes: &mut Vec<ProofNode>,
        memo: &mut BTreeMap<usize, usize>,
    ) -> ProofNode {
        let Kind::And { at, forced } = node.kind else {
            unreachable!()
        };
        if let Some(reply) = forced {
            return ProofNode::Force {
                at,
                reply,
                next: self.emit(node.edges[0].1, nodes, memo),
            };
        }
        let mut replies: Vec<_> = node
            .edges
            .iter()
            .map(|&(at, child)| Reply {
                at,
                proof: self.emit(child, nodes, memo),
            })
            .collect();
        replies.sort_unstable_by_key(|r| r.at);
        ProofNode::Branch { at, replies }
    }
}

impl Node {
    fn base(board: Position, attacks: u16, kind: Kind) -> Self {
        Self {
            board,
            attacks,
            kind,
            pn: INF,
            dn: 0,
            pending: Vec::new(),
            edges: Vec::new(),
            parents: Vec::new(),
            terminal: None,
            witness: None,
        }
    }
    fn attack(board: Position, attacks: u16) -> Self {
        let mut node = Self::base(board, attacks, Kind::Or);
        if attacks == 0 {
            return node;
        }
        if let Some(&at) = node.board.winning_moves(node.board.turn()).first() {
            node.prove(ProofNode::Five { at });
            return node;
        }
        let pending = crate::symmetry::attack_representatives(&node.board);
        node.prepare(pending);
        node
    }
    fn defense(board: Position, attacks: u16, at: usize) -> Self {
        let attacker = 3 - board.turn();
        let mut node = Self::base(board, attacks, Kind::And { at, forced: None });
        if node.board.wins_at(at, attacker) {
            node.prove(ProofNode::Five { at });
            return node;
        }
        if !node.board.winning_moves(3 - attacker).is_empty() {
            return node;
        }
        let wins = node.board.winning_moves(attacker);
        if wins.len() >= 2 {
            node.prove(ProofNode::Fork { at });
            return node;
        }
        if attacks <= 1 {
            return node;
        }
        node.kind = Kind::And {
            at,
            forced: wins.first().copied(),
        };
        let pending = if wins.is_empty() {
            ordered_moves(&node.board, 3 - attacker)
        } else {
            wins
        };
        node.prepare(pending);
        node
    }
    fn prove(&mut self, proof: ProofNode) {
        self.pn = 0;
        self.dn = INF;
        self.terminal = Some(proof);
    }
    fn prepare(&mut self, mut pending: Vec<usize>) {
        if pending.is_empty() {
            return;
        }
        let count = pending.len() as u64;
        (self.pn, self.dn) = match self.kind {
            Kind::Or => (1, count),
            _ => (count, 1),
        };
        pending.reverse();
        self.pending = pending;
    }
}
