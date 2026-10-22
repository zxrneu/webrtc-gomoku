use super::TacticalSearch;
use crate::{
    book::OpeningBook,
    certificate::Certificate,
    proof::verify,
    rules::{game_from_moves, read_game},
    symmetry::transform,
};

#[test]
fn reused_symmetric_proofs_relocate_attacks_forced_replies_and_all_branches() {
    let book = OpeningBook::from_json(r#"{"h8":999}"#).unwrap();
    let mut search = TacticalSearch::new(20_000);
    search.book = Some(&book);
    for points in [
        vec![
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
        ],
        vec![
            [5, 7],
            [0, 0],
            [6, 7],
            [0, 2],
            [7, 5],
            [14, 14],
            [7, 6],
            [14, 12],
        ],
    ] {
        for symmetry in 0..8 {
            let mapped: Vec<_> = points
                .iter()
                .map(|&[x, y]| {
                    let at = transform(y * 15 + x, symmetry);
                    [at % 15, at / 15]
                })
                .collect();
            let game = game_from_moves(&mapped).unwrap();
            let board = read_game(&game).unwrap();
            let root = search.search(&board, 3, true).unwrap();
            let (root, nodes) = super::compact(root, &search.nodes);
            let certificate = Certificate {
                format: "gomoku-proof-dag-v1".into(),
                rules: "freestyle-15".into(),
                attacker: 1,
                game,
                root,
                nodes,
            };
            assert_eq!(verify(&certificate), Ok(()));
        }
    }
    assert!(search.stats.symmetry_hits >= 7);
}
