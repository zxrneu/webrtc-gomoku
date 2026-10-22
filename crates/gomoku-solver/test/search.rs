use gomoku_solver::{
    ordering::ordered_moves,
    proof::verify,
    rules::{game_from_moves, read_game, Game},
    search::Search,
};

fn three() -> Game {
    game_from_moves(&[[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]]).unwrap()
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
fn finish(game: Game, attacks: u16, budget: usize) -> Search {
    let mut search = Search::new(game, attacks).unwrap();
    search.advance(budget);
    search
}

#[test]
fn ordering_keeps_every_empty_point_even_far_from_existing_stones() {
    for game in [
        game_from_moves(&[]).unwrap(),
        game_from_moves(&[[7, 7]]).unwrap(),
    ] {
        let board = read_game(&game).unwrap();
        let ordered = ordered_moves(&board, board.turn());
        let mut sorted = ordered.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, board.legal_moves());
        assert!(ordered.contains(&0));
        assert!(ordered.contains(&224));
    }
}

#[test]
fn local_wins_are_independently_certified_for_either_color() {
    for moves in [
        vec![[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]],
        vec![[0, 0], [4, 7], [0, 2], [5, 7], [14, 14], [6, 7], [14, 12]],
    ] {
        let search = finish(game_from_moves(&moves).unwrap(), 2, 1000);
        let certificate = search.certificate().unwrap().unwrap();
        assert_eq!(verify(&certificate), Ok(()));
        assert_eq!(search.stats().proof_number, 0);
        assert!(search.stats().finished);
    }
}

#[test]
fn non_forcing_attack_proof_covers_every_legal_defense() {
    let search = finish(double_three(), 3, 4000);
    let certificate = search.certificate().unwrap().unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    let gomoku_solver::certificate::ProofNode::Branch { replies, .. } =
        &certificate.nodes[certificate.root]
    else {
        panic!("non-forcing proof");
    };
    assert_eq!(replies.len(), 216);
    assert!(replies.iter().any(|r| r.at == 1));
}

#[test]
fn budgets_and_depth_limits_never_claim_a_win() {
    let search = finish(game_from_moves(&[]).unwrap(), 113, 1);
    assert_eq!(search.certificate().unwrap(), None);
    assert!(!search.stats().finished);
    assert_eq!(search.stats().expansions, 1);
    let search = finish(three(), 0, 1000);
    assert_eq!(search.certificate().unwrap(), None);
    assert!(search.stats().finished);
    assert!(Search::new(three(), 114).is_err());
}

#[test]
fn a_defender_five_threat_is_not_ignored() {
    let game = game_from_moves(&[
        [4, 7],
        [4, 9],
        [5, 7],
        [5, 9],
        [6, 7],
        [6, 9],
        [14, 14],
        [7, 9],
    ])
    .unwrap();
    assert_eq!(finish(game, 2, 2000).certificate().unwrap(), None);
}

#[test]
fn checkpoint_replay_resumes_exactly_and_shards_do_not_change_the_result() {
    let mut search = Search::new(double_three(), 3).unwrap();
    search.advance(40);
    assert!(!search.stats().finished);
    let json = search.checkpoint().unwrap();
    let mut resumed = Search::restore(&json).unwrap();
    assert_eq!(resumed.stats(), search.stats());
    while resumed.advance(7) {}
    let whole = finish(double_three(), 3, 4000);
    assert_eq!(resumed.certificate().unwrap(), whole.certificate().unwrap());
    assert_eq!(resumed.stats(), whole.stats());
}

#[test]
fn checkpoint_is_untrusted_work_log_not_a_win_certificate() {
    let mut search = Search::new(double_three(), 3).unwrap();
    search.advance(5);
    let json = search.checkpoint().unwrap();
    assert!(gomoku_solver::certificate::Certificate::from_json(&json).is_err());
    let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
    value["steps"][0]["at"] = serde_json::json!(225);
    assert!(Search::restore(&value.to_string()).is_err());
    assert!(Search::restore("{}").is_err());
}

#[test]
fn two_sessions_can_be_interleaved_without_global_board_state() {
    let mut first = Search::new(double_three(), 3).unwrap();
    let mut second = Search::new(three(), 2).unwrap();
    while first.advance(11) {
        second.advance(1);
    }
    while second.advance(1) {}
    assert_eq!(
        first.certificate().unwrap(),
        finish(double_three(), 3, 4000).certificate().unwrap()
    );
    assert_eq!(
        second.certificate().unwrap(),
        finish(three(), 2, 1000).certificate().unwrap()
    );
}

#[path = "support/endgame.rs"]
mod endgame;
use endgame::{brute_force, position as endgame};

#[test]
fn exhaustive_small_endgames_agree_with_an_independent_minimax_oracle() {
    for empty in 1..=6 {
        let game = endgame(empty);
        let board = read_game(&game).unwrap();
        let expected = brute_force(&board, board.turn());
        let search = finish(game, 113, 10000);
        assert!(search.stats().finished, "unfinished {empty}-point endgame");
        assert_eq!(
            search.certificate().unwrap().is_some(),
            expected,
            "{empty}-point endgame"
        );
    }
}

#[test]
fn equivalent_move_orders_reuse_exact_positions_without_hash_only_trust() {
    let search = finish(endgame(6), 113, 10000);
    assert!(search.stats().transpositions > 0);
    let restored = Search::restore(&search.checkpoint().unwrap()).unwrap();
    assert_eq!(restored.stats(), search.stats());
}

#[test]
fn attacker_symmetry_reduces_only_board_preserving_move_orbits() {
    use gomoku_solver::symmetry::attack_representatives;
    let board = read_game(&game_from_moves(&[]).unwrap()).unwrap();
    let choices = attack_representatives(&board);
    assert_eq!(choices.len(), 36);
    assert!(choices.contains(&112));
    assert!(choices.contains(&0));
    let asymmetric = read_game(&game_from_moves(&[[2, 3], [9, 11]]).unwrap()).unwrap();
    assert_eq!(
        attack_representatives(&asymmetric),
        ordered_moves(&asymmetric, asymmetric.turn())
    );
}

#[test]
fn tactical_leaf_proofs_accelerate_search_and_survive_checkpoint_replay() {
    use gomoku_solver::tactics::TacticalLimits;
    let limits = TacticalLimits {
        max_attacks: 8,
        max_nodes: 4000,
        threes: true,
    };
    let mut search = Search::with_tactics(double_three(), 3, limits).unwrap();
    search.advance(1);
    let certificate = search.certificate().unwrap().unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    assert!(certificate.nodes.len() < 10);
    assert_eq!(search.stats().expansions, 0);
    assert_eq!(search.stats().tactical_proofs, 1);
    assert!(search.stats().tactical_nodes > 200);
    let resumed = Search::restore(&search.checkpoint().unwrap()).unwrap();
    assert_eq!(resumed.stats(), search.stats());
    assert_eq!(resumed.certificate().unwrap(), Some(certificate));
}

#[test]
fn exhausted_tactical_search_leaves_the_complete_search_available() {
    use gomoku_solver::tactics::TacticalLimits;
    let limits = TacticalLimits {
        max_attacks: 8,
        max_nodes: 1,
        threes: true,
    };
    let mut search = Search::with_tactics(double_three(), 3, limits).unwrap();
    assert!(search.certificate().unwrap().is_none());
    search.advance(4000);
    assert_eq!(verify(&search.certificate().unwrap().unwrap()), Ok(()));
    let resumed = Search::restore(&search.checkpoint().unwrap()).unwrap();
    assert_eq!(resumed.stats(), search.stats());
    assert_eq!(
        resumed.certificate().unwrap(),
        search.certificate().unwrap()
    );
}
