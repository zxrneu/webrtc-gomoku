//! Independent proof checker: only the game rules determine acceptance.
use crate::{
    certificate::{Certificate, ProofNode, Reply},
    rules::{read_game, Position, CELLS},
};
use std::collections::BTreeSet;

pub fn verify(certificate: &Certificate) -> Result<(), String> {
    verify_with_limit(certificate, 2_000_000)
}
pub fn verify_with_limit(certificate: &Certificate, visits: usize) -> Result<(), String> {
    if certificate.format != "gomoku-proof-dag-v1" || certificate.rules != "freestyle-15" {
        return Err("unsupported proof rules or format".into());
    }
    let position = read_game(&certificate.game)?;
    if certificate.attacker != position.turn() {
        return Err("attacker must be the player to move".into());
    }
    Checker {
        nodes: &certificate.nodes,
        attacker: certificate.attacker,
        remaining: visits,
        active: BTreeSet::new(),
        checked: BTreeSet::new(),
    }
    .check(certificate.root, &position)
}

pub(crate) fn verify_fragment(
    nodes: &[ProofNode],
    position: &Position,
    root: usize,
) -> Result<(), String> {
    Checker {
        nodes,
        attacker: position.turn(),
        remaining: 2_000_000,
        active: BTreeSet::new(),
        checked: BTreeSet::new(),
    }
    .check(root, position)
}

struct Checker<'a> {
    nodes: &'a [ProofNode],
    attacker: u8,
    remaining: usize,
    active: BTreeSet<usize>,
    checked: BTreeSet<(usize, Position)>,
}
impl Checker<'_> {
    fn check(&mut self, id: usize, position: &Position) -> Result<(), String> {
        if self.remaining == 0 {
            return Err("verification budget exhausted".into());
        }
        self.remaining -= 1;
        if self.checked.contains(&(id, position.clone())) {
            return Ok(());
        }
        let node = self.nodes.get(id).ok_or("missing proof node")?;
        if position.cell(node.at()) != Some(0) || !self.active.insert(id) {
            return Err("occupied attack or cyclic certificate".into());
        }
        let result = self.after_attack(node, position);
        self.active.remove(&id);
        if result.is_ok() {
            self.checked.insert((id, position.clone()));
        }
        result
    }

    fn after_attack(&mut self, node: &ProofNode, position: &Position) -> Result<(), String> {
        let attacker = self.attacker;
        let board = position.place(node.at(), attacker);
        let won = board.wins_at(node.at(), attacker);
        if matches!(node, ProofNode::Five { .. }) {
            return require(won, "attack does not make five");
        }
        require(!won, "terminal attack must use a five proof")?;
        require(
            board.winning_moves(3 - attacker).is_empty(),
            "defender can win immediately",
        )?;
        let wins = board.winning_moves(attacker);
        match node {
            ProofNode::Fork { .. } => require(wins.len() >= 2, "fork needs two winning points"),
            ProofNode::Force { reply, next, .. } => {
                require(
                    wins.len() == 1 && wins[0] == *reply,
                    "reply is not uniquely forced",
                )?;
                self.check(*next, &board.place(*reply, 3 - attacker))
            }
            ProofNode::Branch { replies, .. } => self.check_replies(replies, &board),
            ProofNode::Five { .. } => unreachable!(),
        }
    }

    fn check_replies(&mut self, replies: &[Reply], board: &Position) -> Result<(), String> {
        let legal = board.empty_cells();
        require(
            !legal.is_empty() && replies.len() == legal.len(),
            "missing defensive branches",
        )?;
        let mut seen = [false; CELLS];
        for reply in replies {
            require(board.cell(reply.at) == Some(0), "illegal defense")?;
            require(!seen[reply.at], "duplicate defense")?;
            seen[reply.at] = true;
            self.check(reply.proof, &board.place(reply.at, 3 - self.attacker))?;
        }
        Ok(())
    }
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
