use gomoku_solver::{
    cache::ProofCache,
    proof::verify,
    rules::{game_from_moves, Game},
    tactics::{solve, TacticalLimits},
};

fn game() -> Game {
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
fn only_independently_verified_certificates_enter_a_round_trippable_cache() {
    let game = game();
    let certificate = solve(
        &game,
        TacticalLimits {
            max_attacks: 3,
            max_nodes: 4000,
            threes: true,
        },
    )
    .unwrap()
    .certificate
    .unwrap();
    let mut cache = ProofCache::default();
    assert!(cache.is_empty());
    assert!(cache.insert(&certificate).unwrap());
    assert!(!cache.insert(&certificate).unwrap());
    assert_eq!(cache.len(), 1);
    let restored = ProofCache::from_json(&cache.to_json().unwrap()).unwrap();
    assert_eq!(verify(&restored.get(&game).unwrap().unwrap()), Ok(()));
    let empty = game_from_moves(&[]).unwrap();
    assert!(restored.get(&empty).unwrap().is_none());
    let mut tampered = certificate.clone();
    tampered.root = usize::MAX;
    assert!(cache.insert(&tampered).is_err());
    assert_eq!(cache.len(), 1);
}

#[test]
fn cache_reuse_respects_both_colors_and_maps_proofs_through_all_symmetries() {
    let original = game();
    let certificate = solve(
        &original,
        TacticalLimits {
            max_attacks: 3,
            max_nodes: 4000,
            threes: true,
        },
    )
    .unwrap()
    .certificate
    .unwrap();
    let mut cache = ProofCache::default();
    cache.insert(&certificate).unwrap();
    for symmetry in 0..8 {
        let moves: Vec<_> = original
            .moves
            .iter()
            .map(|m| {
                let (mut x, mut y) = (m.x, m.y);
                if symmetry >= 4 {
                    x = 14 - x;
                }
                for _ in 0..symmetry % 4 {
                    (x, y) = (14 - y, x);
                }
                [x, y]
            })
            .collect();
        let mapped = game_from_moves(&moves).unwrap();
        let reused = cache.get(&mapped).unwrap().unwrap();
        assert_eq!(reused.game, mapped);
        assert_eq!(verify(&reused), Ok(()));
    }
    let different_white = game_from_moves(&[
        [5, 7],
        [0, 1],
        [6, 7],
        [0, 2],
        [7, 5],
        [14, 14],
        [7, 6],
        [14, 12],
    ])
    .unwrap();
    assert!(cache.get(&different_white).unwrap().is_none());
}

#[test]
fn cache_loading_rejects_tampering_unknown_fields_and_wrong_rules() {
    let certificate = solve(
        &game(),
        TacticalLimits {
            max_attacks: 3,
            max_nodes: 4000,
            threes: true,
        },
    )
    .unwrap()
    .certificate
    .unwrap();
    let mut document = serde_json::json!({"format":"gomoku-proof-cache-v1","rules":"freestyle-15","entries":[certificate]});
    let root = document["entries"][0]["root"].as_u64().unwrap() as usize;
    document["entries"][0]["nodes"][root]["at"] = serde_json::json!(5 + 7 * 15);
    assert!(ProofCache::from_json(&document.to_string()).is_err());
    assert!(ProofCache::from_json(
        r#"{"format":"gomoku-proof-cache-v1","rules":"renju","entries":[]}"#
    )
    .is_err());
    assert!(ProofCache::from_json(
        r#"{"format":"gomoku-proof-cache-v1","rules":"freestyle-15","verified":true,"entries":[]}"#
    )
    .is_err());
}
