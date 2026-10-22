use gomoku_solver::{
    certificate::Certificate,
    rules::{game_from_moves, read_game},
    strategy::Strategy,
};

#[test]
fn checked_strategy_handles_every_legal_defense_including_remote_moves() {
    let certificate = Certificate::from_json(include_str!(
        "../../../docs/m5-ai/examples/double-three.proof.json"
    ))
    .unwrap();
    let mut moves: Vec<_> = certificate.game.moves.iter().map(|m| [m.x, m.y]).collect();
    let strategy = Strategy::load(certificate.clone()).unwrap();
    let first = strategy.move_for(&certificate.game).unwrap().unwrap();
    moves.push([first % 15, first / 15]);
    let game = game_from_moves(&moves).unwrap();
    for at in read_game(&game).unwrap().legal_moves() {
        let mut continuation = moves.clone();
        continuation.push([at % 15, at / 15]);
        let after = game_from_moves(&continuation).unwrap();
        assert!(
            strategy.move_for(&after).unwrap().is_some(),
            "missing defense {at}"
        );
    }
}

#[test]
fn fork_continues_by_winning_even_when_the_opponent_ignores_it() {
    let json = r#"{"format":"gomoku-proof-v1","rules":"freestyle-15","game":null,"attacker":1,"proof":{"kind":"fork","at":112}}"#;
    let game = game_from_moves(&[[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]]).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
    value["game"] = serde_json::to_value(&game).unwrap();
    let strategy = Strategy::load(Certificate::from_json(&value.to_string()).unwrap()).unwrap();
    let after = game_from_moves(&[
        [4, 7],
        [0, 0],
        [5, 7],
        [0, 2],
        [6, 7],
        [14, 14],
        [7, 7],
        [14, 12],
    ])
    .unwrap();
    let win = strategy.move_for(&after).unwrap().unwrap();
    assert!(read_game(&after)
        .unwrap()
        .play(win)
        .unwrap()
        .wins_at(win, 1));
    assert_eq!(
        strategy.move_for(&game_from_moves(&[]).unwrap()).unwrap(),
        None
    );
    let mut invalid = after;
    invalid.board[0][0] = 1;
    assert!(strategy.move_for(&invalid).is_err());
}

#[test]
fn forced_chain_handles_both_the_forced_reply_and_every_ignored_threat() {
    use gomoku_solver::certificate::ProofNode;
    let mut moves = vec![
        [3, 6],
        [2, 6],
        [4, 6],
        [0, 0],
        [5, 6],
        [0, 2],
        [6, 7],
        [14, 14],
        [6, 8],
        [14, 0],
    ];
    let certificate = Certificate {
        format: "gomoku-proof-dag-v1".into(),
        rules: "freestyle-15".into(),
        attacker: 1,
        root: 0,
        game: game_from_moves(&moves).unwrap(),
        nodes: vec![
            ProofNode::Force {
                at: 96,
                reply: 97,
                next: 1,
            },
            ProofNode::Fork { at: 141 },
        ],
    };
    let strategy = Strategy::load(certificate).unwrap();
    moves.push([6, 6]);
    let position = read_game(&game_from_moves(&moves).unwrap()).unwrap();
    for at in position.legal_moves() {
        let mut continuation = moves.clone();
        continuation.push([at % 15, at / 15]);
        let game = game_from_moves(&continuation).unwrap();
        let next = strategy.move_for(&game).unwrap().unwrap();
        if at == 97 {
            assert_eq!(next, 141);
        } else {
            assert!(read_game(&game)
                .unwrap()
                .play(next)
                .unwrap()
                .wins_at(next, 1));
        }
    }
}
