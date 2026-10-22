use gomoku_solver::{dfpn::Dfpn, proof::verify, rules::game_from_moves};

fn root() -> gomoku_solver::rules::Game {
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
fn depth_first_thresholds_prove_every_actual_defense_and_allow_budgeted_slices() {
    let mut whole = Dfpn::new(root(), 3, None).unwrap();
    whole.advance(4000);
    let certificate = whole.certificate().unwrap().unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    let gomoku_solver::certificate::ProofNode::Branch { replies, .. } =
        &certificate.nodes[certificate.root]
    else {
        panic!("branch proof");
    };
    assert_eq!(replies.len(), 216);
    let mut sliced = Dfpn::new(root(), 3, None).unwrap();
    for _ in 0..1000 {
        if !sliced.advance(7) {
            break;
        }
    }
    assert_eq!(verify(&sliced.certificate().unwrap().unwrap()), Ok(()));
    assert!(sliced.stats().search.finished);
    assert!(whole.stats().visits > 0);
}

#[test]
fn cancellation_depth_limits_and_empty_budgets_do_not_manufacture_wins() {
    let mut search = Dfpn::new(game_from_moves(&[]).unwrap(), 113, None).unwrap();
    search.advance_with_stop(1000, || true);
    assert_eq!(search.stats().search.expansions, 0);
    search.advance(0);
    assert!(search.certificate().unwrap().is_none());
    let mut shallow = Dfpn::new(root(), 0, None).unwrap();
    shallow.advance(1000);
    assert!(shallow.certificate().unwrap().is_none());
    assert!(Dfpn::new(root(), 114, None).is_err());
}

#[test]
fn completed_depth_first_subproofs_can_be_saved_in_the_verified_cache() {
    let mut search = Dfpn::new(root(), 3, None).unwrap();
    search.advance(4000);
    let mut cache = gomoku_solver::cache::ProofCache::default();
    assert!(search.save_proofs(&mut cache) > 0);
    assert_eq!(verify(&cache.get(&root()).unwrap().unwrap()), Ok(()));
}

#[test]
fn verified_cache_proofs_close_an_already_expanded_root_without_more_edges() {
    use gomoku_solver::dfpn::DfpnRun;
    let mut solved = Dfpn::new(root(), 3, None).unwrap();
    solved.advance(4000);
    let mut cache = gomoku_solver::cache::ProofCache::default();
    solved.save_proofs(&mut cache);
    let mut resumed = Dfpn::new(root(), 3, None).unwrap();
    resumed.advance(3);
    let before = resumed.stats().search.expansions;
    resumed.advance_cached(
        DfpnRun {
            edges: 0,
            cache: &cache,
        },
        || false,
    );
    assert_eq!(resumed.stats().search.expansions, before);
    assert_eq!(resumed.stats().persistent_hits, 1);
    assert_eq!(verify(&resumed.certificate().unwrap().unwrap()), Ok(()));
}

#[path = "support/endgame.rs"]
mod endgame;

#[test]
fn dfpn_agrees_with_exhaustive_minimax_on_small_endgames() {
    use gomoku_solver::rules::read_game;
    for empty in 1..=6 {
        let game = endgame::position(empty);
        let board = read_game(&game).unwrap();
        let expected = endgame::brute_force(&board, board.turn());
        let mut search = Dfpn::new(game, 113, None).unwrap();
        search.advance(10000);
        assert!(search.stats().search.finished);
        assert_eq!(
            search.certificate().unwrap().is_some(),
            expected,
            "{empty} empty points"
        );
    }
}
