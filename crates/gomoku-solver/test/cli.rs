use gomoku_solver::{certificate::Certificate, proof::verify, search::Search};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static COUNTER: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "gomoku-solver-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn write(&self, name: &str, json: &str) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, json).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn run(args: &[&Path]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_gomoku-solver"))
        .args(args)
        .output()
        .unwrap()
}
fn word(value: &str) -> &Path {
    Path::new(value)
}

#[test]
fn solve_verify_export_and_execute_checked_strategy() {
    let f = Fixture::new();
    let input = f.write("input.json", r#"{"moves":[[4,7],[0,0],[5,7],[0,2],[6,7],[14,14]],"options":{"maxAttacks":2,"maxNodes":1000}}"#);
    let output = f.path("proof.json");
    let checkpoint = f.path("checkpoint.json");
    let result = run(&[
        word("solve"),
        &input,
        &output,
        word("--checkpoint"),
        &checkpoint,
    ]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let certificate = Certificate::from_json(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(verify(&certificate), Ok(()));
    assert!(Search::restore(&fs::read_to_string(&checkpoint).unwrap()).is_ok());
    assert!(run(&[word("verify"), &output]).status.success());
    let tree = f.path("tree.json");
    assert!(run(&[word("export"), &output, &tree]).status.success());
    assert!(run(&[word("verify"), &tree]).status.success());
    let result = run(&[word("move"), &output, &input]);
    assert!(result.status.success());
    let reply: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(reply["move"].is_array());
}

#[test]
fn configured_tactical_oracle_emits_a_compact_verified_certificate() {
    let f = Fixture::new();
    let input = f.write("tactical.json", r#"{"moves":[[5,7],[0,0],[6,7],[0,2],[7,5],[14,14],[7,6],[14,12]],"options":{"maxAttacks":3,"maxNodes":0,"tactics":{"maxAttacks":3,"maxNodes":4000,"threes":true}}}"#);
    let output = f.path("proof.json");
    let result = run(&[word("solve"), &input, &output]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let certificate = Certificate::from_json(&fs::read_to_string(&output).unwrap()).unwrap();
    assert!(certificate.nodes.len() < 10);
    assert_eq!(verify(&certificate), Ok(()));
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["stats"]["tacticalProofs"], 1);
    assert_eq!(report["guaranteedFirstPlayerWin"], false);
}

#[test]
fn book_compilation_proves_tactics_and_rejects_unverified_opening_claims() {
    let f = Fixture::new();
    let book = f.write("book.json", r#"{"h8":999}"#);
    let input = f.write("local.json", r#"{"moves":[[5,7],[0,0],[6,7],[0,2],[7,5],[14,14],[7,6],[14,12]],"options":{"maxAttacks":3,"maxNodes":4000}}"#);
    let output = f.path("proof.json");
    let result = run(&[word("compile"), &book, &input, &output]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(run(&[word("verify"), &output]).status.success());
    let empty = f.write("empty.json", r#"{"moves":[],"options":{"timeBudgetMs":0}}"#);
    let unknown = f.path("unknown.json");
    let result = run(&[word("compile"), &book, &empty, &unknown]);
    assert_eq!(result.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["verified"], false);
    assert_eq!(report["reason"], "time");
    assert!(!run(&[word("verify"), &unknown]).status.success());
}

#[test]
fn empty_board_budget_exhaustion_stays_unknown_and_can_resume() {
    let f = Fixture::new();
    let input = f.write("input.json", r#"{"moves":[],"options":{"maxNodes":1}}"#);
    let output = f.path("unknown.json");
    let checkpoint = f.path("checkpoint.json");
    let result = run(&[
        word("solve"),
        &input,
        &output,
        word("--checkpoint"),
        &checkpoint,
    ]);
    assert_eq!(result.status.code(), Some(2));
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(value["status"], "unknown");
    assert_eq!(value["guaranteedFirstPlayerWin"], false);
    assert!(!run(&[word("verify"), &output]).status.success());
    let next = f.path("next.json");
    let result = run(&[
        word("resume"),
        &checkpoint,
        &next,
        word("--max-nodes"),
        word("2"),
    ]);
    assert_eq!(result.status.code(), Some(2));
    let resumed = Search::restore(&fs::read_to_string(&checkpoint).unwrap()).unwrap();
    assert_eq!(resumed.stats().expansions, 3);
}

#[test]
fn invalid_inputs_and_existing_outputs_are_never_overwritten() {
    let f = Fixture::new();
    let input = f.write("bad.json", r#"{"moves":[[15,0]]}"#);
    let output = f.path("proof.json");
    assert_eq!(
        run(&[word("solve"), &input, &output]).status.code(),
        Some(1)
    );
    assert!(!output.exists());
    let input = f.write("good.json", r#"{"moves":[],"options":{"maxNodes":0}}"#);
    fs::write(&output, "keep me").unwrap();
    assert_eq!(
        run(&[word("solve"), &input, &output]).status.code(),
        Some(1)
    );
    assert_eq!(fs::read_to_string(&output).unwrap(), "keep me");
    assert_eq!(
        run(&[
            word("solve"),
            &input,
            &f.path("next.json"),
            word("--checkpoint"),
            &input
        ])
        .status
        .code(),
        Some(1)
    );
    assert_eq!(
        fs::read_to_string(&input).unwrap(),
        r#"{"moves":[],"options":{"maxNodes":0}}"#
    );
}

#[test]
fn zero_time_budget_is_unknown_and_unknown_flags_are_rejected() {
    let f = Fixture::new();
    let input = f.write("input.json", r#"{"moves":[],"options":{"timeBudgetMs":0}}"#);
    let output = f.path("unknown.json");
    assert_eq!(
        run(&[word("solve"), &input, &output]).status.code(),
        Some(2)
    );
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(value["reason"], "time");
    assert_eq!(
        run(&[
            word("solve"),
            &input,
            &f.path("next.json"),
            word("--typo"),
            word("1")
        ])
        .status
        .code(),
        Some(1)
    );
}

#[test]
fn import_fucusy_accepts_step_and_packed_board_records_as_untrusted_hints() {
    let f = Fixture::new();
    let mut rows = [0x3fff_ffff_u32; 15];
    rows[7] &= !(2 << 14); // Black h8: 01; empty points are 11.
    rows[0] &= !1; // White a1: 10.
    let packed = rows
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let input = f.write("external.txt", &format!("h8_a1:i9\n{packed}:j10\n"));
    let output = f.path("hints.json");
    let result = run(&[word("import-fucusy"), &input, &output]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let json = fs::read_to_string(&output).unwrap();
    let book = gomoku_solver::book::OpeningBook::from_json(&json).unwrap();
    let game = gomoku_solver::rules::game_from_moves(&[[7, 7], [0, 0]]).unwrap();
    let board = gomoku_solver::rules::read_game(&game).unwrap();
    let choices = book.moves_for(&board);
    assert!(choices.contains(&(8 * 15 + 8)));
    assert!(choices.contains(&(9 * 15 + 9)));
    assert!(!run(&[word("verify"), &output]).status.success());
    assert!(!run(&[word("import-fucusy"), &input, &output])
        .status
        .success());
    assert_eq!(fs::read_to_string(&output).unwrap(), json);
}

#[test]
fn import_fucusy_reads_selected_directory_files_and_rejects_invalid_records() {
    let f = Fixture::new();
    let directory = f.path("external");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("leaf.txt.board2action.txt"), "h8_a1:i9\n").unwrap();
    fs::write(directory.join("manually_added_step_str2move.txt"), ":h8\n").unwrap();
    fs::write(directory.join("leaf.txt"), "this is not a move table").unwrap();
    let output = f.path("hints.json");
    let result = run(&[word("import-fucusy"), &directory, &output]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    for text in [
        "h8_a1:h8",
        "h8:p1",
        "h8_a1:i09",
        "1073741824:h8",
        "h8_a1:i9:extra",
    ] {
        let bad = f.write("bad.txt", text);
        let next = f.path("bad-output.json");
        assert_eq!(
            run(&[word("import-fucusy"), &bad, &next]).status.code(),
            Some(1)
        );
        assert!(!next.exists());
    }
}

#[test]
fn compile_persists_verified_proofs_and_reuses_them_with_zero_search_budget() {
    let f = Fixture::new();
    let book = f.write("book.json", "{}");
    let input = f.write("input.json", r#"{"moves":[[5,7],[0,0],[6,7],[0,2],[7,5],[14,14],[7,6],[14,12]],"options":{"maxAttacks":3,"maxNodes":4000}}"#);
    let cache = f.path("cache.json");
    let first = f.path("first.json");
    let result = run(&[
        word("compile"),
        &book,
        &input,
        &first,
        word("--cache"),
        &cache,
    ]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cache).unwrap()).unwrap();
    assert_eq!(saved["format"], "gomoku-proof-cache-v1");
    assert!(!saved["entries"].as_array().unwrap().is_empty());
    let second = f.path("second.json");
    let result = run(&[
        word("compile"),
        &book,
        &input,
        &second,
        word("--cache"),
        &cache,
        word("--max-nodes"),
        word("0"),
    ]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["stats"]["nodes"], 0);
    assert_eq!(report["stats"]["persistentHits"], 1);
    assert!(run(&[word("verify"), &second]).status.success());
    assert_eq!(report["guaranteedFirstPlayerWin"], false);
}

#[test]
fn an_interrupted_compile_keeps_subproofs_and_exports_resumable_conditional_jobs() {
    let f = Fixture::new();
    let book = f.write("book.json", "{}");
    let input = f.write("input.json", r#"{"moves":[[5,7],[0,0],[6,7],[0,2],[7,5],[14,14],[7,6],[14,12]],"options":{"maxAttacks":3,"maxNodes":30}}"#);
    let cache = f.path("cache.json");
    let jobs = f.path("jobs.json");
    let unknown = f.path("unknown.json");
    let result = run(&[
        word("compile"),
        &book,
        &input,
        &unknown,
        word("--cache"),
        &cache,
        word("--worklist"),
        &jobs,
    ]);
    assert_eq!(
        result.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cache).unwrap()).unwrap();
    assert!(!saved["entries"].as_array().unwrap().is_empty());
    let pending: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&jobs).unwrap()).unwrap();
    assert_eq!(pending["format"], "gomoku-worklist-v1");
    assert_eq!(pending["conditional"], true);
    assert!(!pending["jobs"].as_array().unwrap().is_empty());
    let proof = f.path("proof.json");
    let result = run(&[
        word("work"),
        &book,
        &jobs,
        &proof,
        word("--cache"),
        &cache,
        word("--max-nodes"),
        word("4000"),
        word("--max-jobs"),
        word("8"),
    ]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(run(&[word("verify"), &proof]).status.success());
}

#[test]
fn corrupt_caches_and_input_output_aliases_are_rejected_before_writing() {
    let f = Fixture::new();
    let book = f.write("book.json", "{}");
    let input = f.write("input.json", r#"{"moves":[],"options":{"maxNodes":0}}"#);
    let cache = f.write(
        "cache.json",
        r#"{"format":"gomoku-proof-cache-v1","rules":"renju","entries":[]}"#,
    );
    let output = f.path("output.json");
    assert_eq!(
        run(&[
            word("compile"),
            &book,
            &input,
            &output,
            word("--cache"),
            &cache
        ])
        .status
        .code(),
        Some(1)
    );
    assert!(!output.exists());
    assert!(fs::read_to_string(&cache).unwrap().contains("renju"));
    assert_eq!(
        run(&[
            word("compile"),
            &book,
            &input,
            &output,
            word("--cache"),
            &input
        ])
        .status
        .code(),
        Some(1)
    );
    assert_eq!(
        run(&[
            word("compile"),
            &book,
            &input,
            &output,
            word("--worklist"),
            &output
        ])
        .status
        .code(),
        Some(1)
    );
    assert!(!output.exists());
}

#[test]
fn zero_budget_work_preserves_unknown_jobs_and_can_be_resumed_again() {
    let f = Fixture::new();
    let book = f.write("book.json", r#"{"h8":999}"#);
    let input = f.write("input.json", r#"{"moves":[],"options":{"maxNodes":0}}"#);
    let cache = f.path("cache.json");
    let jobs = f.path("jobs.json");
    let result = run(&[
        word("compile"),
        &book,
        &input,
        &f.path("unknown.json"),
        word("--cache"),
        &cache,
        word("--worklist"),
        &jobs,
    ]);
    assert_eq!(result.status.code(), Some(2));
    let next = f.path("next.json");
    let result = run(&[
        word("work"),
        &book,
        &jobs,
        &next,
        word("--cache"),
        &cache,
        word("--max-nodes"),
        word("0"),
    ]);
    assert_eq!(result.status.code(), Some(2));
    let restored =
        gomoku_solver::worklist::Worklist::from_json(&fs::read_to_string(&next).unwrap()).unwrap();
    assert!(!restored.jobs.is_empty());
    assert!(restored.jobs.iter().any(|game| game.moves.is_empty()));
    assert!(!run(&[word("verify"), &next]).status.success());
    assert_eq!(
        run(&[
            word("work"),
            &book,
            &next,
            &f.path("later.json"),
            word("--cache"),
            &cache,
            word("--max-jobs"),
            word("0")
        ])
        .status
        .code(),
        Some(2)
    );
}

#[test]
fn guided_compilation_uses_dependency_plans_and_still_emits_a_checked_proof() {
    let f = Fixture::new();
    let book = f.write("book.json", "{}");
    let input = f.write("input.json", r#"{"moves":[[5,7],[0,0],[6,7],[0,2],[7,5],[14,14],[7,6],[14,12]],"options":{"maxAttacks":3,"maxNodes":4000}}"#);
    let output = f.path("proof.json");
    let result = run(&[word("compile"), &book, &input, &output]);
    assert!(result.status.success());
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(report["stats"]["dependencyNodes"].as_u64().unwrap_or(0) > 0);
    assert!(run(&[word("verify"), &output]).status.success());
}

#[test]
fn quiet_preparations_are_budgeted_and_preserved_in_resumable_worklists() {
    let f = Fixture::new();
    let book = f.write("book.json", "{}");
    let input = f.write(
        "input.json",
        r#"{"moves":[],"options":{"maxAttacks":2,"maxNodes":30}}"#,
    );
    let jobs = f.path("jobs.json");
    let cache = f.path("cache.json");
    let result = run(&[
        word("compile"),
        &book,
        &input,
        &f.path("unknown.json"),
        word("--cache"),
        &cache,
        word("--worklist"),
        &jobs,
        word("--quiet-moves"),
        word("1"),
    ]);
    assert_eq!(
        result.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(report["stats"]["quietNodes"].as_u64().unwrap_or(0) > 0);
    assert!(report["stats"]["nodes"].as_u64().unwrap() <= 30);
    let document: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&jobs).unwrap()).unwrap();
    assert_eq!(document["policy"]["quietMoves"], 1);
    let next = f.path("next.json");
    assert_eq!(
        run(&[
            word("work"),
            &book,
            &jobs,
            &next,
            word("--cache"),
            &cache,
            word("--max-nodes"),
            word("0")
        ])
        .status
        .code(),
        Some(2)
    );
    let document: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(next).unwrap()).unwrap();
    assert_eq!(document["policy"]["quietMoves"], 1);
    assert_eq!(
        run(&[
            word("compile"),
            &book,
            &input,
            &f.path("invalid.json"),
            word("--quiet-moves"),
            word("226")
        ])
        .status
        .code(),
        Some(1)
    );
}

#[test]
fn depth_first_proof_number_search_emits_verified_proofs_and_stays_unknown_on_empty_budget() {
    let f = Fixture::new();
    let input = f.write("input.json", r#"{"moves":[[5,7],[0,0],[6,7],[0,2],[7,5],[14,14],[7,6],[14,12]],"options":{"maxAttacks":3,"maxNodes":4000}}"#);
    let output = f.path("proof.json");
    let result = run(&[word("dfpn"), &input, &output]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(run(&[word("verify"), &output]).status.success());
    let empty = f.write("empty.json", r#"{"moves":[],"options":{"maxNodes":0}}"#);
    let result = run(&[word("dfpn"), &empty, &f.path("unknown.json")]);
    assert_eq!(result.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["guaranteedFirstPlayerWin"], false);
    assert_eq!(report["stats"]["expansions"], 0);
}

#[test]
fn pending_jobs_can_switch_to_complete_dfpn_and_merge_their_verified_subproofs() {
    let f = Fixture::new();
    let book = f.write("book.json", "{}");
    let input = f.write("input.json", r#"{"moves":[[5,7],[0,0],[6,7],[0,2],[7,5],[14,14],[7,6],[14,12]],"options":{"maxAttacks":3,"maxNodes":30}}"#);
    let cache = f.path("cache.json");
    let jobs = f.path("jobs.json");
    assert_eq!(
        run(&[
            word("compile"),
            &book,
            &input,
            &f.path("unknown.json"),
            word("--cache"),
            &cache,
            word("--worklist"),
            &jobs
        ])
        .status
        .code(),
        Some(2)
    );
    let output = f.path("proof.json");
    let result = run(&[
        word("work"),
        &book,
        &jobs,
        &output,
        word("--cache"),
        &cache,
        word("--max-nodes"),
        word("4000"),
        word("--engine"),
        word("dfpn"),
    ]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(run(&[word("verify"), &output]).status.success());
}

#[test]
fn zero_remaining_depth_does_not_starve_other_pending_jobs() {
    let f = Fixture::new();
    let root = gomoku_solver::rules::game_from_moves(&[]).unwrap();
    let leaf = gomoku_solver::rules::game_from_moves(&[[7, 7], [0, 0]]).unwrap();
    let jobs = f.write("jobs.json", &serde_json::json!({"format":"gomoku-worklist-v1","rules":"freestyle-15","conditional":true,"root":root,"limits":{"maxAttacks":1,"maxNodes":100,"threes":true},"jobs":[leaf,root],"truncated":false}).to_string());
    let book = f.write("book.json", r#"{"h8":999}"#);
    let result = run(&[
        word("work"),
        &book,
        &jobs,
        &f.path("next.json"),
        word("--cache"),
        &f.path("cache.json"),
        word("--max-jobs"),
        word("1"),
    ]);
    assert_eq!(result.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(report["nodes"].as_u64().unwrap() > 0);
}

#[test]
fn repeated_work_rounds_rotate_unfinished_jobs_and_allow_a_larger_depth() {
    let f = Fixture::new();
    let root = gomoku_solver::rules::game_from_moves(&[]).unwrap();
    let first = gomoku_solver::rules::game_from_moves(&[[7, 7], [0, 0]]).unwrap();
    let second = gomoku_solver::rules::game_from_moves(&[[7, 7], [0, 1]]).unwrap();
    let jobs = f.write("jobs.json", &serde_json::json!({"format":"gomoku-worklist-v1","rules":"freestyle-15","conditional":true,"root":root,"limits":{"maxAttacks":3,"maxNodes":1,"threes":true},"jobs":[first,second,root],"truncated":false}).to_string());
    let book = f.write("book.json", "{}");
    let cache = f.path("cache.json");
    let next = f.path("next.json");
    assert_eq!(
        run(&[
            word("work"),
            &book,
            &jobs,
            &next,
            word("--cache"),
            &cache,
            word("--max-jobs"),
            word("1")
        ])
        .status
        .code(),
        Some(2)
    );
    let before: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&next).unwrap()).unwrap();
    assert!(before["nextJob"].as_u64().unwrap_or(0) > 0);
    let later = f.path("later.json");
    assert_eq!(
        run(&[
            word("work"),
            &book,
            &next,
            &later,
            word("--cache"),
            &cache,
            word("--max-jobs"),
            word("1"),
            word("--max-attacks"),
            word("4")
        ])
        .status
        .code(),
        Some(2)
    );
    let after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(later).unwrap()).unwrap();
    assert_eq!(after["limits"]["maxAttacks"], 4);
    assert_ne!(before["nextJob"], after["nextJob"]);
}
