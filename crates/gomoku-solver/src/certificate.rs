//! Flat proof DAG format, with adapters for the existing TypeScript tree format.
use crate::rules::Game;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ProofNode {
    Five {
        at: usize,
    },
    Fork {
        at: usize,
    },
    Force {
        at: usize,
        reply: usize,
        next: usize,
    },
    Branch {
        at: usize,
        replies: Vec<Reply>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub at: usize,
    pub proof: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Certificate {
    pub format: String,
    pub rules: String,
    pub game: Game,
    pub attacker: u8,
    pub root: usize,
    pub nodes: Vec<ProofNode>,
}

impl Certificate {
    pub fn from_json(json: &str) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        match value.get("format").and_then(|v| v.as_str()) {
            Some("gomoku-proof-dag-v1") => serde_json::from_value(value).map_err(|e| e.to_string()),
            Some("gomoku-proof-v1") => {
                let tree: TreeCertificate =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                let mut nodes = Vec::new();
                let root = flatten(tree.proof, &mut nodes);
                Ok(Self {
                    format: "gomoku-proof-dag-v1".into(),
                    rules: tree.rules,
                    game: tree.game,
                    attacker: tree.attacker,
                    root,
                    nodes,
                })
            }
            _ => Err("unsupported certificate format".into()),
        }
    }
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }
    pub fn to_tree_json(&self) -> Result<String, String> {
        crate::proof::verify(self)?;
        let proof = expand(self, self.root, &mut 200_000)?;
        serde_json::to_string(&TreeCertificate {
            format: "gomoku-proof-v1".into(),
            rules: self.rules.clone(),
            game: self.game.clone(),
            attacker: self.attacker,
            proof,
        })
        .map_err(|e| e.to_string())
    }
}

impl ProofNode {
    pub fn at(&self) -> usize {
        match self {
            Self::Five { at }
            | Self::Fork { at }
            | Self::Force { at, .. }
            | Self::Branch { at, .. } => *at,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TreeCertificate {
    format: String,
    rules: String,
    game: Game,
    attacker: u8,
    proof: TreeProof,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum TreeProof {
    Five {
        at: usize,
    },
    Fork {
        at: usize,
    },
    Force {
        at: usize,
        reply: usize,
        next: Box<TreeProof>,
    },
    Branch {
        at: usize,
        replies: Vec<TreeReply>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TreeReply {
    at: usize,
    proof: TreeProof,
}

fn flatten(proof: TreeProof, nodes: &mut Vec<ProofNode>) -> usize {
    let node = match proof {
        TreeProof::Five { at } => ProofNode::Five { at },
        TreeProof::Fork { at } => ProofNode::Fork { at },
        TreeProof::Force { at, reply, next } => ProofNode::Force {
            at,
            reply,
            next: flatten(*next, nodes),
        },
        TreeProof::Branch { at, replies } => ProofNode::Branch {
            at,
            replies: replies
                .into_iter()
                .map(|r| Reply {
                    at: r.at,
                    proof: flatten(r.proof, nodes),
                })
                .collect(),
        },
    };
    let id = nodes.len();
    nodes.push(node);
    id
}

fn expand(
    certificate: &Certificate,
    id: usize,
    remaining: &mut usize,
) -> Result<TreeProof, String> {
    if *remaining == 0 {
        return Err("tree export exceeds 200000 nodes; retain DAG format".into());
    }
    *remaining -= 1;
    Ok(match &certificate.nodes[id] {
        ProofNode::Five { at } => TreeProof::Five { at: *at },
        ProofNode::Fork { at } => TreeProof::Fork { at: *at },
        ProofNode::Force { at, reply, next } => TreeProof::Force {
            at: *at,
            reply: *reply,
            next: Box::new(expand(certificate, *next, remaining)?),
        },
        ProofNode::Branch { at, replies } => TreeProof::Branch {
            at: *at,
            replies: replies
                .iter()
                .map(|r| {
                    Ok(TreeReply {
                        at: r.at,
                        proof: expand(certificate, r.proof, remaining)?,
                    })
                })
                .collect::<Result<_, String>>()?,
        },
    })
}
