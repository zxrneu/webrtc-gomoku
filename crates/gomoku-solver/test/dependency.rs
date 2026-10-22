use super::{combine, materialize, propose, Plan};
use crate::{
    rules::{game_from_moves, read_game},
    threats::candidates,
};

fn position() -> crate::rules::Position {
    read_game(
        &game_from_moves(&[
            [5, 5],
            [0, 0],
            [5, 6],
            [14, 14],
            [7, 4],
            [0, 2],
            [7, 6],
            [14, 12],
        ])
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn compatible_threat_sequences_create_a_new_attack_unavailable_to_either_alone() {
    let board = position();
    let left = Plan {
        gains: vec![7 * 15 + 5],
        costs: vec![4 * 15 + 5, 8 * 15 + 5, 9 * 15 + 5],
    };
    let right = Plan {
        gains: vec![7 * 15 + 7],
        costs: vec![3 * 15 + 7, 5 * 15 + 7, 8 * 15 + 7],
    };
    let middle = 7 * 15 + 6;
    assert!(!candidates(&materialize(&board, &left), true).contains(&middle));
    assert!(!candidates(&materialize(&board, &right), true).contains(&middle));
    let merged = combine(&board, &left, &right).unwrap();
    assert!(candidates(&materialize(&board, &merged), true).contains(&middle));
    assert_eq!(merged.gains.len(), 2);
}

#[test]
fn a_defense_square_cannot_also_be_a_gain_in_a_combined_sequence() {
    let board = position();
    let left = Plan {
        gains: vec![7 * 15 + 5],
        costs: vec![7 * 15 + 7],
    };
    let right = Plan {
        gains: vec![7 * 15 + 7],
        costs: vec![3 * 15 + 7],
    };
    assert!(combine(&board, &left, &right).is_none());
    assert!(combine(&board, &right, &left).is_none());
}

#[test]
fn dependency_planning_finds_a_bounded_double_three_plan_without_claiming_a_proof() {
    let board = read_game(
        &game_from_moves(&[
            [5, 7],
            [0, 0],
            [6, 7],
            [0, 2],
            [7, 5],
            [14, 14],
            [7, 6],
            [14, 12],
        ])
        .unwrap(),
    )
    .unwrap();
    let result = propose(&board, (3, 256));
    let plan = result.plan.unwrap();
    assert_eq!(plan[0], 112);
    assert!(plan.len() <= 3);
    assert!(result.nodes <= 256);
    assert!(result.dependencies > 0);
}

#[test]
fn zero_depth_or_budget_never_produces_a_dependency_plan() {
    for limits in [(0, 256), (3, 0)] {
        let result = propose(&position(), limits);
        assert!(result.plan.is_none());
        assert_eq!(result.nodes, 0);
    }
}
