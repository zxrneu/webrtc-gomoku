//! Execute an independently checked strategy against arbitrary legal replies.
use crate::{
    certificate::{Certificate, ProofNode},
    rules::{read_game, Game},
};

pub struct Strategy {
    certificate: Certificate,
}
impl Strategy {
    pub fn load(certificate: Certificate) -> Result<Self, String> {
        crate::proof::verify(&certificate)?;
        Ok(Self { certificate })
    }
    pub fn move_for(&self, game: &Game) -> Result<Option<usize>, String> {
        let position = read_game(game)?;
        let prefix = &self.certificate.game.moves;
        if position.turn() != self.certificate.attacker || !game.moves.starts_with(prefix) {
            return Ok(None);
        }
        let mut id = self.certificate.root;
        let continuation = &game.moves[prefix.len()..];
        for (index, pair) in continuation.chunks_exact(2).enumerate() {
            let node = &self.certificate.nodes[id];
            if pair[0].y * 15 + pair[0].x != node.at() {
                return Ok(None);
            }
            let at = pair[1].y * 15 + pair[1].x;
            match node {
                ProofNode::Branch { replies, .. } => {
                    let Some(reply) = replies.iter().find(|r| r.at == at) else {
                        return Ok(None);
                    };
                    id = reply.proof;
                }
                ProofNode::Force { reply, next, .. } if *reply == at => id = *next,
                ProofNode::Force { .. } | ProofNode::Fork { .. }
                    if index * 2 + 2 == continuation.len() =>
                {
                    return Ok(position
                        .winning_moves(self.certificate.attacker)
                        .first()
                        .copied());
                }
                _ => return Ok(None),
            }
        }
        Ok(Some(self.certificate.nodes[id].at()))
    }
}
