use gomoku_solver::{
    book::OpeningBook,
    rules::{game_from_moves, read_game},
};
use gomoku_solver::{
    certificate::ProofNode,
    proof::verify,
    tactics::{solve_guided, GuidedRequest, TacticalLimits},
};

#[test]
fn opening_data_provides_moves_without_trusting_numeric_leaf_claims() {
    let book = OpeningBook::from_json(r#"{"h8":{"i10":{"g7":17}}}"#).unwrap();
    let empty = read_game(&game_from_moves(&[]).unwrap()).unwrap();
    assert_eq!(book.moves_for(&empty), vec![112]);
    let leaf = read_game(&game_from_moves(&[[7, 7], [8, 9], [6, 6], [0, 0]]).unwrap()).unwrap();
    assert!(book.moves_for(&leaf).is_empty());
}

fn transform([mut x, mut y]: [usize; 2], symmetry: usize) -> [usize; 2] {
    if symmetry >= 4 {
        x = 14 - x;
    }
    for _ in 0..symmetry % 4 {
        (x, y) = (14 - y, x);
    }
    [x, y]
}

#[test]
fn book_moves_are_mapped_through_all_eight_board_symmetries() {
    let book = OpeningBook::from_json(r#"{"h8":{"i10":{"g7":17}}}"#).unwrap();
    for symmetry in 0..8 {
        let moves: Vec<_> = [[7, 7], [8, 9]]
            .into_iter()
            .map(|m| transform(m, symmetry))
            .collect();
        let board = read_game(&game_from_moves(&moves).unwrap()).unwrap();
        let [x, y] = transform([6, 6], symmetry);
        assert_eq!(book.moves_for(&board), vec![y * 15 + x]);
    }
}

#[test]
fn malformed_coordinates_occupied_points_and_terminal_continuations_are_rejected() {
    for json in [
        r#"{"p1":1}"#,
        r#"{"a0":1}"#,
        r#"{"a01":1}"#,
        r#"{"h8":{"h8":1}}"#,
        r#"{"h8":true}"#,
        "[]",
        "null",
    ] {
        assert!(OpeningBook::from_json(json).is_err(), "accepted {json}");
    }
    let terminal = r#"{"a1":{"a2":{"b1":{"c2":{"c1":{"e2":{"d1":{"g2":{"e1":{"o15":1}}}}}}}}}}"#;
    assert!(OpeningBook::from_json(terminal).is_err());
}

#[test]
fn a_quiet_book_move_is_proved_against_every_actual_defense() {
    let game = game_from_moves(&[
        [5, 5],
        [0, 0],
        [6, 5],
        [0, 2],
        [7, 5],
        [0, 4],
        [5, 9],
        [14, 10],
        [6, 9],
        [14, 12],
        [7, 9],
        [14, 14],
    ])
    .unwrap();
    let mut value = serde_json::json!({"h8":999});
    for m in game.moves.iter().rev() {
        let name = format!("{}{}", (b'a' + m.x as u8) as char, m.y + 1);
        value = serde_json::json!({name:value});
    }
    let book = OpeningBook::from_json(&value.to_string()).unwrap();
    let result = solve_guided(
        GuidedRequest {
            game: &game,
            book: &book,
        },
        TacticalLimits {
            // Both distant white groups can force several successive blocks.
            max_attacks: 8,
            max_nodes: 40000,
            threes: true,
        },
        || false,
    )
    .unwrap();
    let certificate = result.certificate.unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    let ProofNode::Branch { at, replies } = &certificate.nodes[certificate.root] else {
        panic!(
            "quiet book move must cover all defenses: {:?}; book hits {}",
            certificate.nodes[certificate.root], result.stats.book_hits
        );
    };
    assert_eq!(*at, 112);
    assert_eq!(replies.len(), 212);
    assert!(result.stats.book_hits > 0);
}

#[test]
fn numeric_wins_and_incomplete_opening_data_cannot_create_a_certificate() {
    let book = OpeningBook::from_json(r#"{"h8":999}"#).unwrap();
    let game = game_from_moves(&[]).unwrap();
    let result = solve_guided(
        GuidedRequest {
            game: &game,
            book: &book,
        },
        TacticalLimits {
            max_attacks: 3,
            max_nodes: 100,
            threes: true,
        },
        || false,
    )
    .unwrap();
    assert!(result.certificate.is_none());
}

#[test]
fn caller_supplied_cancellation_stops_guided_search_without_a_win_claim() {
    let book = OpeningBook::from_json(r#"{"h8":999}"#).unwrap();
    let game = game_from_moves(&[]).unwrap();
    let result = solve_guided(
        GuidedRequest {
            game: &game,
            book: &book,
        },
        TacticalLimits {
            max_attacks: 113,
            max_nodes: 100000,
            threes: true,
        },
        || true,
    )
    .unwrap();
    assert!(result.certificate.is_none());
    assert!(result.stats.interrupted);
    assert_eq!(result.stats.nodes, 0);
}

#[test]
fn short_tactical_proofs_are_found_before_deep_unpromising_threats() {
    let game = game_from_moves(&[[7, 7], [7, 9], [6, 6], [1, 9], [6, 7], [0, 0]]).unwrap();
    let book = OpeningBook::from_json(r#"{"h8":999}"#).unwrap();
    let result = solve_guided(
        GuidedRequest {
            game: &game,
            book: &book,
        },
        TacticalLimits {
            max_attacks: 113,
            max_nodes: 25000,
            threes: true,
        },
        || false,
    )
    .unwrap();
    let certificate = result.certificate.unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    assert!(result.stats.nodes <= 25000);
}

#[test]
fn all_defenses_scout_plans_are_expanded_into_checked_actual_branches() {
    let game = game_from_moves(&[
        [5, 7],
        [0, 0],
        [6, 7],
        [0, 2],
        [7, 5],
        [14, 14],
        [7, 6],
        [14, 12],
    ])
    .unwrap();
    let book = OpeningBook::from_json(r#"{"h8":999}"#).unwrap();
    let result = solve_guided(
        GuidedRequest {
            game: &game,
            book: &book,
        },
        TacticalLimits {
            max_attacks: 3,
            max_nodes: 4000,
            threes: true,
        },
        || false,
    )
    .unwrap();
    let certificate = result.certificate.unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    assert!(result.stats.scout_hits > 0);
    let ProofNode::Branch { replies, .. } = &certificate.nodes[certificate.root] else {
        panic!("actual defenses");
    };
    assert_eq!(replies.len(), 216);
}

#[test]
fn budget_exhaustion_identifies_a_real_unfinished_frontier_game() {
    let game = game_from_moves(&[[7, 7], [7, 9], [6, 6], [1, 9], [6, 7], [0, 0]]).unwrap();
    let book = OpeningBook::from_json(r#"{"h8":999}"#).unwrap();
    let result = solve_guided(
        GuidedRequest {
            game: &game,
            book: &book,
        },
        TacticalLimits {
            max_attacks: 113,
            max_nodes: 100,
            threes: true,
        },
        || false,
    )
    .unwrap();
    assert!(result.certificate.is_none());
    let frontier = result.frontier.unwrap();
    assert!(frontier.moves.starts_with(&game.moves));
    assert!(frontier.moves.len() > game.moves.len());
    assert!(read_game(&frontier).is_ok());
    assert_eq!(frontier.moves.len() % 2, game.moves.len() % 2);
}

#[test]
fn normalized_position_hints_round_trip_without_inventing_a_win_claim() {
    let json = r#"{"format":"gomoku-opening-hints-v1","rules":"freestyle-15","entries":[{"moves":[[7,7],[0,0]],"at":[8,8]}]}"#;
    let book = OpeningBook::from_json(json).unwrap();
    let board = read_game(&game_from_moves(&[[7, 7], [0, 0]]).unwrap()).unwrap();
    let choices = book.moves_for(&board);
    assert!(choices.contains(&(8 * 15 + 8)));
    assert!(choices.iter().all(|&at| board.cell(at) == Some(0)));
}

#[test]
fn normalized_hint_documents_validate_rules_moves_and_metadata() {
    for json in [
        r#"{"format":"gomoku-opening-hints-v1","rules":"renju","entries":[]}"#,
        r#"{"format":"gomoku-opening-hints-v1","rules":"freestyle-15","entries":[{"moves":[[7,7],[0,0]],"at":[7,7]}]}"#,
        r#"{"format":"gomoku-opening-hints-v1","rules":"freestyle-15","verified":true,"entries":[]}"#,
    ] {
        assert!(OpeningBook::from_json(json).is_err(), "accepted {json}");
    }
}
