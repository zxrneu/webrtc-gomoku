use super::{GuidancePolicy, TacticalSearch};
use crate::rules::{game_from_moves, read_game};

#[test]
fn maximum_quiet_width_includes_every_empty_point_without_neighbor_pruning() {
    let board = read_game(&game_from_moves(&[[7, 7], [7, 6]]).unwrap()).unwrap();
    let mut search = TacticalSearch::new(1000);
    search.policy = GuidancePolicy { quiet_moves: 225 };
    search.quiet_left = 1;
    let choices = search.choices(&board, true);
    let mut points = choices.iter().map(|choice| choice.at).collect::<Vec<_>>();
    points.sort_unstable();
    assert_eq!(points, board.legal_moves());
    assert!(choices.iter().any(|choice| choice.at == 0 && choice.quiet));
}

#[test]
fn four_only_search_and_an_exhausted_preparation_allowance_do_not_add_quiet_moves() {
    let board = read_game(&game_from_moves(&[]).unwrap()).unwrap();
    let mut search = TacticalSearch::new(1000);
    search.policy = GuidancePolicy { quiet_moves: 3 };
    search.quiet_left = 1;
    assert!(search.choices(&board, false).is_empty());
    assert_eq!(search.choices(&board, true).len(), 3);
    search.quiet_left = 0;
    assert!(search.choices(&board, true).is_empty());
}
