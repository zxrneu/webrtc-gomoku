//! Benchmark-only native player. Unknown proof results require an explicit heuristic fallback.
use gomoku_solver::{
    book::OpeningBook,
    certificate::Certificate,
    dfpn::Dfpn,
    ordering::ordered_moves,
    rules::{game_from_moves, read_game, Game, Position},
    strategy::Strategy,
    tactics::{solve_guided, GuidedRequest, TacticalLimits},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    time::Instant,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    moves: Vec<[usize; 2]>,
    time_budget_ms: u64,
    max_nodes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    r#move: [usize; 2],
    source: &'static str,
    proof_status: &'static str,
    certificate: Option<Value>,
    tactical_nodes: usize,
    dfpn_expansions: usize,
}

struct Player {
    strategy: Option<Strategy>,
    certificate: Option<Value>,
}

impl Player {
    fn new() -> Self {
        Self {
            strategy: None,
            certificate: None,
        }
    }

    fn choose(
        &mut self,
        request: Request,
        mut stop: impl FnMut(f64) -> bool,
    ) -> Result<Reply, String> {
        let game = game_from_moves(&request.moves)?;
        let board = read_game(&game)?;
        if let Some(strategy) = &self.strategy {
            if let Some(at) = strategy.move_for(&game)? {
                return Ok(self.proven_reply(at, "cached-proof", (0, 0)));
            }
        }
        let (certificate, nodes) = if stop(1.0) {
            (None, (0, 0))
        } else {
            search_proof(&game, request.max_nodes, &mut stop)?
        };
        if let Some(certificate) = certificate {
            let document =
                serde_json::from_str(&certificate.to_tree_json()?).map_err(|e| e.to_string())?;
            let strategy = Strategy::load(certificate)?;
            let at = strategy.move_for(&game)?.ok_or("proof has no legal move")?;
            self.strategy = Some(strategy);
            self.certificate = Some(document);
            return Ok(self.proven_reply(at, "proof", nodes));
        }
        let (at, source) = fallback(&board)?;
        Ok(Reply {
            r#move: [at % 15, at / 15],
            source,
            proof_status: "unknown",
            certificate: None,
            tactical_nodes: nodes.0,
            dfpn_expansions: nodes.1,
        })
    }

    fn proven_reply(&self, at: usize, source: &'static str, nodes: (usize, usize)) -> Reply {
        Reply {
            r#move: [at % 15, at / 15],
            source,
            proof_status: "win",
            certificate: self.certificate.clone(),
            tactical_nodes: nodes.0,
            dfpn_expansions: nodes.1,
        }
    }
}

type ProofResult = (Option<Certificate>, (usize, usize));

fn search_proof(
    game: &Game,
    max_nodes: usize,
    stop: &mut impl FnMut(f64) -> bool,
) -> Result<ProofResult, String> {
    let book = OpeningBook::from_json("{}")?;
    let tactical = solve_guided(
        GuidedRequest { game, book: &book },
        TacticalLimits {
            max_attacks: 113,
            max_nodes,
            threes: true,
        },
        || stop(0.75),
    )?;
    if tactical.certificate.is_some() || stop(1.0) {
        return Ok((tactical.certificate, (tactical.stats.nodes, 0)));
    }
    let mut dfpn = Dfpn::new(game.clone(), 113, None)?;
    dfpn.advance_with_stop(max_nodes, || stop(1.0));
    Ok((
        dfpn.certificate()?,
        (tactical.stats.nodes, dfpn.stats().search.expansions),
    ))
}

fn fallback(board: &Position) -> Result<(usize, &'static str), String> {
    if let Some(&at) = board.winning_moves(board.turn()).first() {
        return Ok((at, "immediate-win"));
    }
    if let Some(&at) = board.winning_moves(3 - board.turn()).first() {
        return Ok((at, "block"));
    }
    ordered_moves(board, board.turn())
        .first()
        .copied()
        .map(|at| (at, "ordering"))
        .ok_or_else(|| "no legal move".into())
}

fn main() -> io::Result<()> {
    let mut player = Player::new();
    let mut output = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let line = line?;
        let result = serde_json::from_str::<Request>(&line)
            .map_err(|e| e.to_string())
            .and_then(|request| {
                let started = Instant::now();
                let budget = request.time_budget_ms as f64;
                player.choose(request, |fraction| {
                    started.elapsed().as_secs_f64() * 1000.0 >= budget * fraction
                })
            });
        let value = match result {
            Ok(reply) => json!({"ok": true, "result": reply}),
            Err(error) => json!({"ok": false, "error": error}),
        };
        writeln!(output, "{value}")?;
        output.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gomoku_solver::{
        certificate::Certificate,
        proof::verify,
        rules::{game_from_moves, read_game},
    };

    fn request(moves: Vec<[usize; 2]>) -> Request {
        Request {
            moves,
            time_budget_ms: 1000,
            max_nodes: 4000,
        }
    }

    #[test]
    fn expired_search_uses_native_ordering_without_claiming_a_proof() {
        let reply = Player::new().choose(request(vec![]), |_| true).unwrap();
        assert_eq!(reply.r#move, [7, 7]);
        assert_eq!(reply.source, "ordering");
        assert_eq!(reply.proof_status, "unknown");
        assert!(reply.certificate.is_none());
    }

    #[test]
    fn fallback_takes_an_immediate_win_before_blocking_the_opponent() {
        let moves = vec![
            [4, 7],
            [0, 0],
            [5, 7],
            [1, 0],
            [6, 7],
            [2, 0],
            [7, 7],
            [3, 0],
        ];
        let board = read_game(&game_from_moves(&moves).unwrap()).unwrap();
        let reply = Player::new().choose(request(moves), |_| true).unwrap();
        let at = reply.r#move[1] * 15 + reply.r#move[0];
        assert!(board.play(at).unwrap().wins_at(at, 1));
        assert_eq!(reply.source, "immediate-win");
    }

    #[test]
    fn fallback_blocks_the_only_immediate_opponent_win() {
        let moves = vec![[5, 7], [4, 7], [6, 7], [0, 0], [7, 7], [0, 2], [8, 7]];
        let reply = Player::new().choose(request(moves), |_| true).unwrap();
        assert_eq!(reply.r#move, [9, 7]);
        assert_eq!(reply.source, "block");
        assert_eq!(reply.proof_status, "unknown");
    }

    #[test]
    fn fallback_never_returns_an_occupied_center() {
        let reply = Player::new()
            .choose(request(vec![[7, 7]]), |_| true)
            .unwrap();
        assert_ne!(reply.r#move, [7, 7]);
    }

    #[test]
    fn invalid_game_history_is_rejected() {
        assert!(Player::new()
            .choose(request(vec![[15, 0]]), |_| true)
            .is_err());
        assert!(Player::new()
            .choose(request(vec![[7, 7], [7, 7]]), |_| true)
            .is_err());
    }

    #[test]
    fn tactical_moves_carry_an_independently_checkable_certificate() {
        let moves = vec![[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]];
        let reply = Player::new().choose(request(moves), |_| false).unwrap();
        assert_eq!(reply.source, "proof");
        assert_eq!(reply.proof_status, "win");
        let certificate = Certificate::from_json(&reply.certificate.unwrap().to_string()).unwrap();
        assert_eq!(verify(&certificate), Ok(()));
        assert_eq!(
            reply.r#move,
            [certificate.nodes[certificate.root].at() % 15, 7]
        );
    }

    #[test]
    fn checked_strategy_survives_an_arbitrary_legal_defense() {
        let mut player = Player::new();
        let mut moves = vec![[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]];
        let first = player.choose(request(moves.clone()), |_| false).unwrap();
        moves.extend([first.r#move, [1, 1]]);
        let next = player.choose(request(moves), |_| true).unwrap();
        assert_eq!(next.source, "cached-proof");
        assert_eq!(next.proof_status, "win");
        assert!(next.certificate.is_some());
    }

    #[test]
    fn wire_input_rejects_unknown_fields_and_negative_budgets() {
        assert!(
            serde_json::from_str::<Request>(r#"{"moves":[],"timeBudgetMs":-1,"maxNodes":1}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<Request>(
            r#"{"moves":[],"timeBudgetMs":1,"maxNodes":1,"untrusted":true}"#
        )
        .is_err());
    }
}
