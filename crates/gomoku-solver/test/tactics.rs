use gomoku_solver::{
    certificate::ProofNode,
    proof::verify,
    rules::{game_from_moves, Game},
    strategy::Strategy,
    tactics::{solve, TacticalLimits},
};

fn limits(threes: bool) -> TacticalLimits {
    TacticalLimits {
        max_attacks: 8,
        max_nodes: 4000,
        threes,
    }
}

fn chain() -> Game {
    game_from_moves(&[
        [5, 7],
        [4, 7],
        [6, 7],
        [0, 0],
        [8, 7],
        [14, 14],
        [7, 5],
        [0, 2],
        [7, 6],
        [14, 12],
    ])
    .unwrap()
}

fn double_three() -> Game {
    game_from_moves(&[
        [5, 7],
        [0, 0],
        [6, 7],
        [0, 2],
        [7, 5],
        [14, 14],
        [7, 6],
        [14, 12],
    ])
    .unwrap()
}

#[test]
fn continuous_fours_produce_a_checked_forced_reply_chain() {
    let result = solve(&chain(), limits(false)).unwrap();
    let certificate = result.certificate.unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    assert!(matches!(
        certificate.nodes[certificate.root],
        ProofNode::Force { .. }
    ));
    assert!(result.stats.nodes < 100);
}

#[test]
fn continuous_threats_share_proofs_but_cover_all_216_defenses() {
    let game = double_three();
    let result = solve(&game, limits(true)).unwrap();
    let certificate = result.certificate.unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    let ProofNode::Branch { at, replies } = &certificate.nodes[certificate.root] else {
        panic!("a double three requires defensive branches");
    };
    assert_eq!(replies.len(), 216);
    assert!(result.stats.proof_reuses > 200);
    assert!(certificate.nodes.len() < 10);
    let strategy = Strategy::load(certificate.clone()).unwrap();
    for reply in replies {
        let mut moves: Vec<_> = game.moves.iter().map(|m| [m.x, m.y]).collect();
        moves.extend([[at % 15, at / 15], [reply.at % 15, reply.at / 15]]);
        assert!(strategy
            .move_for(&game_from_moves(&moves).unwrap())
            .unwrap()
            .is_some());
    }
}

#[test]
fn four_only_search_does_not_claim_a_double_three() {
    assert!(solve(&double_three(), limits(false))
        .unwrap()
        .certificate
        .is_none());
}

#[test]
fn the_forced_reply_can_create_a_defender_counter_win() {
    let game = game_from_moves(&[
        [5, 7],
        [4, 7],
        [6, 7],
        [9, 4],
        [8, 7],
        [9, 5],
        [7, 5],
        [9, 6],
        [7, 6],
        [0, 0],
    ])
    .unwrap();
    assert!(solve(&game, limits(false)).unwrap().certificate.is_none());
}

#[test]
fn tactical_budgets_and_depth_are_not_disproofs_or_win_claims() {
    for budget in [0, 1] {
        let mut bounded = limits(true);
        bounded.max_nodes = budget;
        let result = solve(&double_three(), bounded).unwrap();
        assert!(result.certificate.is_none());
        assert!(result.stats.nodes <= budget);
        assert!(result.stats.budget_exhausted);
    }
    let mut bounded = limits(false);
    bounded.max_attacks = 1;
    assert!(solve(&chain(), bounded).unwrap().certificate.is_none());
    bounded.max_attacks = 114;
    assert!(solve(&chain(), bounded).is_err());
    assert!(solve(&game_from_moves(&[]).unwrap(), limits(true))
        .unwrap()
        .certificate
        .is_none());
}

#[test]
fn tactical_proofs_work_for_white_and_immediate_five_has_priority() {
    let white =
        game_from_moves(&[[0, 0], [4, 7], [0, 2], [5, 7], [14, 14], [6, 7], [14, 12]]).unwrap();
    let certificate = solve(&white, limits(false)).unwrap().certificate.unwrap();
    assert_eq!(certificate.attacker, 2);
    assert_eq!(verify(&certificate), Ok(()));
    let mutual = game_from_moves(&[
        [4, 7],
        [4, 9],
        [5, 7],
        [5, 9],
        [6, 7],
        [6, 9],
        [7, 7],
        [7, 9],
    ])
    .unwrap();
    let certificate = solve(&mutual, limits(false)).unwrap().certificate.unwrap();
    assert!(matches!(
        certificate.nodes[certificate.root],
        ProofNode::Five { .. }
    ));
    assert_eq!(verify(&certificate), Ok(()));
}
