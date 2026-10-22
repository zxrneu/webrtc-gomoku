use gomoku_solver::{
    certificate::{Certificate, ProofNode},
    proof::{verify, verify_with_limit},
    rules::game_from_moves,
};

fn fork() -> Certificate {
    Certificate {
        format: "gomoku-proof-dag-v1".into(),
        rules: "freestyle-15".into(),
        attacker: 1,
        root: 0,
        game: game_from_moves(&[[4, 7], [0, 0], [5, 7], [0, 2], [6, 7], [14, 14]]).unwrap(),
        nodes: vec![ProofNode::Fork { at: 112 }],
    }
}

#[test]
fn fork_is_checked_by_rules_without_pattern_scores() {
    let certificate = fork();
    assert_eq!(verify(&certificate), Ok(()));
    assert_eq!(certificate.nodes[0].at(), 112);
    assert!(verify_with_limit(&certificate, 0).is_err());
}

#[test]
fn legacy_typescript_certificate_imports_and_round_trips_through_dag() {
    let json = include_str!("../../../docs/m5-ai/examples/double-three.proof.json");
    let certificate = Certificate::from_json(json).unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    assert_eq!(
        Certificate::from_json(&certificate.to_json().unwrap()).unwrap(),
        certificate
    );
    let tree = Certificate::from_json(&certificate.to_tree_json().unwrap()).unwrap();
    assert_eq!(verify(&tree), Ok(()));
}

#[test]
fn missing_duplicate_and_out_of_range_defenses_are_rejected() {
    let source = include_str!("../../../docs/m5-ai/examples/double-three.proof.json");
    let certificate = Certificate::from_json(source).unwrap();
    for tamper in 0..3 {
        let mut bad = certificate.clone();
        let ProofNode::Branch { replies, .. } = &mut bad.nodes[bad.root] else {
            panic!("branch fixture");
        };
        match tamper {
            0 => {
                replies.pop();
            }
            1 => {
                replies[1] = replies[0].clone();
            }
            _ => replies[0].proof = usize::MAX,
        }
        assert!(verify(&bad).is_err());
    }
}

#[test]
fn forged_wins_wrong_rules_wrong_turn_and_cycles_are_rejected() {
    let mut bad = fork();
    bad.nodes[0] = ProofNode::Five { at: 112 };
    assert!(verify(&bad).is_err());
    bad = fork();
    bad.nodes[0] = ProofNode::Fork { at: 225 };
    assert!(verify(&bad).is_err());
    bad = fork();
    bad.attacker = 2;
    assert!(verify(&bad).is_err());
    bad = fork();
    bad.rules = "renju".into();
    assert!(verify(&bad).is_err());
    bad = fork();
    bad.format = "gomoku-search-checkpoint-v1".into();
    assert!(verify(&bad).is_err());
    bad = fork();
    bad.nodes[0] = ProofNode::Force {
        at: 112,
        reply: 113,
        next: 0,
    };
    assert!(verify(&bad).is_err());
    assert!(Certificate::from_json("{\"format\":\"unknown\"}").is_err());
}

#[test]
fn a_defender_immediate_win_refutes_a_fork() {
    let mut bad = fork();
    bad.game = game_from_moves(&[
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
    assert!(verify(&bad).is_err());
}

#[test]
fn direct_five_wins_even_if_the_defender_threatens_five() {
    let mut certificate = fork();
    certificate.game = game_from_moves(&[
        [3, 7],
        [4, 9],
        [4, 7],
        [5, 9],
        [5, 7],
        [6, 9],
        [6, 7],
        [7, 9],
    ])
    .unwrap();
    certificate.nodes[0] = ProofNode::Five { at: 112 };
    assert_eq!(verify(&certificate), Ok(()));
}

#[test]
fn unique_forced_reply_is_verified_and_a_cyclic_continuation_is_rejected() {
    let certificate = Certificate {
        format: "gomoku-proof-dag-v1".into(),
        rules: "freestyle-15".into(),
        attacker: 1,
        root: 0,
        game: game_from_moves(&[
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
        ])
        .unwrap(),
        nodes: vec![
            ProofNode::Force {
                at: 96,
                reply: 97,
                next: 1,
            },
            ProofNode::Fork { at: 141 },
        ],
    };
    assert_eq!(verify(&certificate), Ok(()));
    let mut wrong_reply = certificate.clone();
    wrong_reply.nodes[0] = ProofNode::Force {
        at: 96,
        reply: 98,
        next: 1,
    };
    assert!(verify(&wrong_reply).is_err());
    let mut cyclic = certificate;
    cyclic.nodes[0] = ProofNode::Force {
        at: 96,
        reply: 97,
        next: 0,
    };
    assert!(verify(&cyclic).is_err());
}
