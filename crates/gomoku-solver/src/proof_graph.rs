//! Copy reachable proof nodes while preserving DAG sharing.
use crate::certificate::{ProofNode, Reply};
use std::collections::BTreeMap;

pub(crate) fn compact(root: usize, source: &[ProofNode]) -> (usize, Vec<ProofNode>) {
    let mut nodes = Vec::new();
    let root = append(root, source, &mut nodes);
    (root, nodes)
}

pub(crate) fn append(root: usize, source: &[ProofNode], nodes: &mut Vec<ProofNode>) -> usize {
    Copier {
        source,
        memo: BTreeMap::new(),
    }
    .copy(root, nodes)
}

struct Copier<'a> {
    source: &'a [ProofNode],
    memo: BTreeMap<usize, usize>,
}

impl Copier<'_> {
    fn copy(&mut self, id: usize, nodes: &mut Vec<ProofNode>) -> usize {
        if let Some(&id) = self.memo.get(&id) {
            return id;
        }
        let proof = match self.source[id].clone() {
            ProofNode::Force { at, reply, next } => ProofNode::Force {
                at,
                reply,
                next: self.copy(next, nodes),
            },
            ProofNode::Branch { at, replies } => ProofNode::Branch {
                at,
                replies: replies
                    .into_iter()
                    .map(|r| Reply {
                        at: r.at,
                        proof: self.copy(r.proof, nodes),
                    })
                    .collect(),
            },
            terminal => terminal,
        };
        let next = nodes.len();
        nodes.push(proof);
        self.memo.insert(id, next);
        next
    }
}
