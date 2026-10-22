use gomoku_solver::rules::{game_from_moves, read_game, CELLS};

#[test]
fn empty_board_enumerates_all_225_points_including_corners() {
    let game = game_from_moves(&[]).unwrap();
    let position = read_game(&game).unwrap();
    assert_eq!(position.turn(), 1);
    assert_eq!(position.legal_moves(), (0..CELLS).collect::<Vec<_>>());
    assert_eq!(position.cell(CELLS), None);
}

#[test]
fn play_is_immutable_and_rejects_occupied_or_out_of_board() {
    let position = read_game(&game_from_moves(&[]).unwrap()).unwrap();
    let next = position.play(112).unwrap();
    assert_eq!(position.cell(112), Some(0));
    assert_eq!(next.cell(112), Some(1));
    assert_eq!(next.turn(), 2);
    assert!(next.play(112).is_err());
    assert!(next.play(CELLS).is_err());
    assert_eq!(next.legal_moves().len(), 224);
    assert!(next.legal_moves().contains(&0));
}

#[test]
fn all_four_directions_and_overlines_are_wins() {
    for (dx, dy) in [(1, 0), (0, 1), (1, 1), (1, -1)] {
        let mut position = read_game(&game_from_moves(&[]).unwrap()).unwrap();
        for step in 0..4 {
            let at = (7 + dy * step) * 15 + (3 + dx * step);
            position = position
                .play(at as usize)
                .unwrap()
                .play((step * 2) as usize)
                .unwrap();
        }
        let at = ((7 + dy * 4) * 15 + (3 + dx * 4)) as usize;
        assert!(position.winning_moves(1).contains(&at));
        let won = position.play(at).unwrap();
        assert!(won.wins_at(at, 1));
        assert!(!won.wins_at(at, 2));
        assert!(!won.wins_at(CELLS, 1));
        assert!(!won.wins_at(at, 0));
        assert!(won.play(224).is_err());
        assert!(won.legal_moves().is_empty());
    }
    let game = game_from_moves(&[
        [3, 7],
        [0, 0],
        [4, 7],
        [2, 0],
        [5, 7],
        [4, 0],
        [7, 7],
        [6, 0],
        [8, 7],
        [8, 0],
    ])
    .unwrap();
    let position = read_game(&game).unwrap().play(7 * 15 + 6).unwrap();
    assert!(position.wins_at(7 * 15 + 6, 1));
}

#[test]
fn input_must_be_legal_alternating_and_nonterminal() {
    assert!(game_from_moves(&[[15, 0]]).is_err());
    assert!(game_from_moves(&[[0, 0], [0, 0]]).is_err());
    assert!(game_from_moves(&[
        [0, 0],
        [0, 2],
        [1, 0],
        [2, 2],
        [2, 0],
        [4, 2],
        [3, 0],
        [6, 2],
        [4, 0],
    ])
    .is_err());
    let valid = game_from_moves(&[[7, 7]]).unwrap();
    let mut bad = valid.clone();
    bad.moves[0].c = 2;
    assert!(read_game(&bad).is_err());
    bad = valid.clone();
    bad.board[0][0] = 1;
    assert!(read_game(&bad).is_err());
    bad = valid.clone();
    bad.board.pop();
    assert!(read_game(&bad).is_err());
    bad = valid.clone();
    bad.size = 19;
    assert!(read_game(&bad).is_err());
    bad = valid.clone();
    bad.over = true;
    assert!(read_game(&bad).is_err());
    bad = valid.clone();
    bad.win_line = Some(vec![[0, 0]]);
    assert!(read_game(&bad).is_err());
    assert_eq!(
        serde_json::from_str::<gomoku_solver::rules::Game>(&serde_json::to_string(&valid).unwrap())
            .unwrap(),
        valid
    );
}

#[test]
fn a_full_board_without_five_is_a_draw_not_a_win() {
    let mut black = Vec::new();
    let mut white = Vec::new();
    for y in 0..15 {
        for x in 0..15 {
            if (x + 2 * y) % 4 < 2 {
                black.push([x, y]);
            } else {
                white.push([x, y]);
            }
        }
    }
    let mut moves = Vec::new();
    for index in 0..112 {
        moves.push(black[index]);
        moves.push(white[index]);
    }
    let board = read_game(&game_from_moves(&moves).unwrap()).unwrap();
    let at = black[112][1] * 15 + black[112][0];
    let draw = board.play(at).unwrap();
    assert!(draw.legal_moves().is_empty());
    assert!(!draw.wins_at(at, 1));
    moves.push(black[112]);
    assert!(game_from_moves(&moves).is_err());
}
