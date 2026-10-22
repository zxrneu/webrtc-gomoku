use gomoku_solver::{rules::game_from_moves, worklist::Worklist};

#[test]
fn worklists_validate_conditional_jobs_and_preserve_the_root_history() {
    let root = game_from_moves(&[[7, 7], [0, 0]]).unwrap();
    let job = game_from_moves(&[[7, 7], [0, 0], [8, 8], [14, 14]]).unwrap();
    let document = serde_json::json!({"format":"gomoku-worklist-v1","rules":"freestyle-15","conditional":true,"root":root,"limits":{"maxAttacks":10,"maxNodes":1000,"threes":true},"jobs":[job],"truncated":false});
    let work = Worklist::from_json(&document.to_string()).unwrap();
    assert_eq!(work.jobs.len(), 1);
    assert!(Worklist::from_json(&work.to_json().unwrap()).is_ok());
    let mut bad = document.clone();
    bad["conditional"] = serde_json::json!(false);
    assert!(Worklist::from_json(&bad.to_string()).is_err());
    bad = document.clone();
    bad["jobs"][0] = serde_json::json!(game_from_moves(&[]).unwrap());
    assert!(Worklist::from_json(&bad.to_string()).is_err());
    bad = document;
    bad["jobs"][0] = serde_json::json!(game_from_moves(&[[7, 7], [0, 0], [8, 8]]).unwrap());
    assert!(Worklist::from_json(&bad.to_string()).is_err());
}

#[test]
fn a_completed_root_has_no_remaining_tasks_from_rejected_attack_candidates() {
    use gomoku_solver::{
        book::OpeningBook,
        tactics::{solve_guided, GuidedRequest, TacticalLimits},
    };
    let root = game_from_moves(&[
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
    let book = OpeningBook::from_json("{}").unwrap();
    let limits = TacticalLimits {
        max_attacks: 3,
        max_nodes: 4000,
        threes: true,
    };
    let result = solve_guided(
        GuidedRequest {
            game: &root,
            book: &book,
        },
        limits,
        || false,
    )
    .unwrap();
    assert!(result.certificate.is_some());
    assert!(Worklist::from_search(&root, limits, &result)
        .unwrap()
        .jobs
        .is_empty());
}
