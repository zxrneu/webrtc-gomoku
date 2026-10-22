use crate::files;
use gomoku_solver::{
    book::OpeningBook,
    cache::ProofCache,
    certificate::Certificate,
    dfpn::{Dfpn, DfpnRun},
    proof::verify,
    rules::{game_from_moves, Game},
    search::Search,
    strategy::Strategy,
    tactics::{
        solve_guided, solve_guided_cached, CachedRequest, GuidancePolicy, GuidanceStats,
        GuidedRequest, TacticalLimits, TacticalResult, TacticalStats,
    },
    worklist::{SolverEngine, Worklist},
};
use serde::Deserialize;
use serde_json::json;
use std::time::Instant;

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Options {
    max_attacks: Option<u16>,
    max_nodes: Option<usize>,
    time_budget_ms: Option<u64>,
    tactics: Option<TacticalLimits>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    moves: Vec<[usize; 2]>,
    #[serde(default)]
    options: Options,
}
#[derive(Default)]
struct Flags {
    checkpoint: Option<String>,
    nodes: Option<usize>,
    time: Option<u64>,
    cache: Option<String>,
    worklist: Option<String>,
    jobs: Option<usize>,
    quiet: Option<usize>,
    engine: Option<SolverEngine>,
    attacks: Option<u16>,
}

struct Budget {
    nodes: usize,
    time_ms: u64,
}
struct Save<'a> {
    path: &'a str,
    reason: &'a str,
}

pub fn run(args: Vec<String>) -> Result<i32, String> {
    match args.first().map(String::as_str) {
        Some("solve" | "resume") if args.len() >= 3 => solve(&args),
        Some("compile") if args.len() >= 4 => compile(&args),
        Some("dfpn") if args.len() >= 3 => dfpn(&args),
        Some("work") if args.len() >= 4 => work(&args),
        Some("import-fucusy") if args.len() == 3 => import_opening(&args[1], &args[2]),
        Some("verify") if args.len() == 2 => {
            let certificate = Certificate::from_json(&files::read(&args[1])?)?;
            verify(&certificate)?;
            println!("{}",json!({"verified":true,"guaranteedFirstPlayerWin":certificate.game.moves.is_empty() && certificate.attacker == 1}));
            Ok(0)
        }
        Some("export") if args.len() == 3 => {
            files::ensure_new(&args[2])?;
            let certificate = Certificate::from_json(&files::read(&args[1])?)?;
            files::write_new(&args[2],&certificate.to_tree_json()?)?;
            println!("{}",json!({"verified":true,"format":"gomoku-proof-v1"})); Ok(0)
        }
        Some("move") if args.len() == 3 => execute(&args[1],&args[2]),
        _ => Err("usage: gomoku-solver solve INPUT OUTPUT [--checkpoint PATH] [--max-nodes N] [--time-ms N] | resume CHECKPOINT OUTPUT [same flags] | compile BOOK INPUT OUTPUT [--cache PATH] [--worklist PATH] [--quiet-moves N] [--max-nodes N] [--time-ms N] | work BOOK WORKLIST OUTPUT --cache PATH [--max-nodes N] [--time-ms N] [--max-jobs N] [--quiet-moves N] [--engine guided|dfpn] | dfpn INPUT OUTPUT [--cache PATH] [--max-nodes N] [--time-ms N] | import-fucusy FILE_OR_DIRECTORY OUTPUT | verify CERTIFICATE | export CERTIFICATE TREE_OUTPUT | move CERTIFICATE INPUT".into()),
    }
}

fn dfpn(args: &[String]) -> Result<i32, String> {
    files::ensure_new(&args[2])?;
    let flags = flags(&args[3..])?;
    if flags.checkpoint.is_some()
        || flags.worklist.is_some()
        || flags.jobs.is_some()
        || flags.quiet.is_some()
        || flags.engine.is_some()
    {
        return Err("dfpn only accepts --cache, --max-attacks, --max-nodes and --time-ms".into());
    }
    let mut paths = vec![args[1].as_str(), args[2].as_str()];
    if let Some(path) = flags.cache.as_deref() {
        paths.push(path);
    }
    files::distinct(&paths)?;
    let input: Input = serde_json::from_str(&files::read(&args[1])?).map_err(|e| e.to_string())?;
    let game = game_from_moves(&input.moves)?;
    let mut cache = load_cache(flags.cache.as_deref())?;
    let mut search = Dfpn::new(
        game.clone(),
        flags.attacks.or(input.options.max_attacks).unwrap_or(113),
        input.options.tactics,
    )?;
    let started = Instant::now();
    let time = flags
        .time
        .or(input.options.time_budget_ms)
        .unwrap_or(60_000);
    let cached = cache.get(&game)?;
    if cached.is_none() {
        search.advance_cached(
            DfpnRun {
                edges: flags.nodes.or(input.options.max_nodes).unwrap_or(100_000),
                cache: &cache,
            },
            || started.elapsed().as_millis() >= u128::from(time),
        );
        search.save_proofs(&mut cache);
    }
    let certificate = cached.or(search.certificate()?);
    save_cache(flags.cache.as_deref(), &cache)?;
    let won = certificate.is_some();
    let (document, report) = dfpn_document(&game, certificate, search.stats())?;
    files::write_new(&args[2], &document)?;
    println!("{report}");
    Ok(if won { 0 } else { 2 })
}

fn dfpn_document(
    game: &Game,
    certificate: Option<Certificate>,
    stats: gomoku_solver::dfpn::DfpnStats,
) -> Result<(String, serde_json::Value), String> {
    let won = certificate.is_some();
    let report = json!({"status":if won {"win"} else {"unknown"},"verified":won,
        "guaranteedFirstPlayerWin":won && game.moves.is_empty(),"stats":stats});
    let document = match certificate {
        Some(certificate) => certificate.to_json()?,
        None => json!({"format":"gomoku-dfpn-search-v1","rules":"freestyle-15","game":game,"result":report}).to_string(),
    };
    Ok((document, report))
}

fn import_opening(input: &str, output: &str) -> Result<i32, String> {
    files::ensure_new(output)?;
    files::distinct(&[input, output])?;
    let book = gomoku_solver::opening_import::import_fucusy(&files::opening_records(input)?)?;
    files::write_new(output, &book.to_json()?)?;
    println!(
        "{}",
        json!({"format":"gomoku-opening-hints-v1","verified":false})
    );
    Ok(0)
}

fn compile(args: &[String]) -> Result<i32, String> {
    files::ensure_new(&args[3])?;
    files::distinct(&[&args[1], &args[2], &args[3]])?;
    let flags = flags(&args[4..])?;
    if flags.checkpoint.is_some() || flags.jobs.is_some() || flags.engine.is_some() {
        return Err("compile does not accept --checkpoint, --max-jobs or --engine".into());
    }
    prepare_guided_paths(args, &flags)?;
    let mut cache = load_cache(flags.cache.as_deref())?;
    let input: Input = serde_json::from_str(&files::read(&args[2])?).map_err(|e| e.to_string())?;
    let book = OpeningBook::from_json(&files::read(&args[1])?)?;
    let game = game_from_moves(&input.moves)?;
    let (limits, time_ms) = guided_budget(&input.options, &flags);
    let started = Instant::now();
    let stop = || started.elapsed().as_millis() >= u128::from(time_ms);
    let policy = GuidancePolicy {
        quiet_moves: flags.quiet.unwrap_or(0),
    };
    let result = if flags.cache.is_some() || policy.quiet_moves > 0 {
        solve_guided_cached(
            CachedRequest {
                game: &game,
                book: &book,
                cache: &mut cache,
                policy,
            },
            limits,
            stop,
        )?
    } else {
        solve_guided(
            GuidedRequest {
                game: &game,
                book: &book,
            },
            limits,
            stop,
        )?
    };
    save_cache(flags.cache.as_deref(), &cache)?;
    if let Some(path) = flags.worklist.as_deref() {
        let mut work = Worklist::from_search(&game, limits, &result)?;
        work.policy = policy;
        files::write_new(path, &work.to_json()?)?;
    }
    output_guided(result, &game, &args[3])
}

fn guided_budget(options: &Options, flags: &Flags) -> (TacticalLimits, u64) {
    let defaults = TacticalLimits {
        max_attacks: 113,
        max_nodes: 1_000_000,
        threes: true,
    };
    let mut limits = options.tactics.unwrap_or(defaults);
    limits.max_attacks = flags
        .attacks
        .or(options.max_attacks)
        .unwrap_or(limits.max_attacks);
    limits.max_nodes = flags
        .nodes
        .or(options.max_nodes)
        .unwrap_or(limits.max_nodes);
    let time_ms = flags.time.or(options.time_budget_ms).unwrap_or(60_000);
    (limits, time_ms)
}

fn prepare_guided_paths(args: &[String], flags: &Flags) -> Result<(), String> {
    let mut paths = vec![args[1].as_str(), args[2].as_str(), args[3].as_str()];
    if let Some(path) = flags.cache.as_deref() {
        paths.push(path);
    }
    if let Some(path) = flags.worklist.as_deref() {
        files::ensure_new(path)?;
        paths.push(path);
    }
    files::distinct(&paths)
}

fn load_cache(path: Option<&str>) -> Result<ProofCache, String> {
    match path {
        Some(path)
            if std::path::Path::new(path)
                .try_exists()
                .map_err(|e| e.to_string())? =>
        {
            ProofCache::from_json(&files::read(path)?)
        }
        _ => Ok(ProofCache::default()),
    }
}

fn save_cache(path: Option<&str>, cache: &ProofCache) -> Result<(), String> {
    if let Some(path) = path {
        files::atomic_checkpoint(path, &cache.to_json()?)?;
    }
    Ok(())
}

struct BatchBudget {
    nodes: usize,
    time_ms: u64,
    jobs: usize,
}

struct Batch<'a> {
    work: &'a mut Worklist,
    cache: &'a mut ProofCache,
    book: &'a OpeningBook,
    started: Instant,
    budget: BatchBudget,
    cache_path: Option<&'a str>,
    nodes: usize,
    tried: usize,
    root_proof: Option<Certificate>,
}

fn work(args: &[String]) -> Result<i32, String> {
    files::ensure_new(&args[3])?;
    let flags = flags(&args[4..])?;
    if flags.checkpoint.is_some() || flags.worklist.is_some() || flags.cache.is_none() {
        return Err("work requires --cache and does not accept --checkpoint or --worklist".into());
    }
    prepare_guided_paths(args, &flags)?;
    let book = OpeningBook::from_json(&files::read(&args[1])?)?;
    let mut work = Worklist::from_json(&files::read(&args[2])?)?;
    configure_work(&mut work, &flags)?;
    let mut cache = load_cache(flags.cache.as_deref())?;
    let root_proof = cache.get(&work.root)?;
    let budget = BatchBudget {
        nodes: flags.nodes.unwrap_or(work.limits.max_nodes),
        time_ms: flags.time.unwrap_or(60_000),
        jobs: flags.jobs.unwrap_or(32),
    };
    let mut pending = std::mem::take(&mut work.jobs);
    if !pending.is_empty() {
        work.next_job %= pending.len();
        pending.rotate_left(work.next_job);
    }
    let mut batch = Batch {
        work: &mut work,
        cache: &mut cache,
        book: &book,
        started: Instant::now(),
        budget,
        cache_path: flags.cache.as_deref(),
        nodes: 0,
        tried: 0,
        root_proof,
    };
    batch.process(pending)?;
    batch.output(&args[3])
}

fn configure_work(work: &mut Worklist, flags: &Flags) -> Result<(), String> {
    if let Some(quiet) = flags.quiet {
        work.policy.quiet_moves = quiet;
    }
    if let Some(engine) = flags.engine {
        work.engine = engine;
    }
    if let Some(attacks) = flags.attacks {
        work.limits.max_attacks = attacks;
    }
    if work.limits.max_attacks > 113 {
        return Err("maxAttacks must be at most 113".into());
    }
    if work.policy.quiet_moves > 225 {
        return Err("quietMoves must be at most 225".into());
    }
    Ok(())
}

impl Batch<'_> {
    fn process(&mut self, pending: Vec<Game>) -> Result<(), String> {
        let mut next = vec![self.work.root.clone()];
        let (start, count) = (self.work.next_job, pending.len());
        for (index, game) in pending.into_iter().enumerate() {
            if self.root_proof.is_some() {
                break;
            }
            if self.cache.get(&game)?.is_some() {
                continue;
            }
            if !self.can_search() {
                next.push(game);
                continue;
            }
            self.work.next_job = (start + index + 1) % count;
            if (game.moves.len() - self.work.root.moves.len()) / 2
                >= usize::from(self.work.limits.max_attacks)
            {
                next.push(game);
                continue;
            }
            let result = self.solve_job(&game)?;
            self.nodes += result.stats.nodes;
            self.tried += 1;
            if game == self.work.root {
                self.root_proof = result.certificate.clone();
            }
            if result.certificate.is_none() {
                next.push(game);
            }
            next.extend(result.frontiers);
            self.work.truncated |= result.frontiers_truncated;
            save_cache(self.cache_path, self.cache)?;
        }
        self.work.replace_jobs(next)?;
        self.work.next_job %= self.work.jobs.len().max(1);
        save_cache(self.cache_path, self.cache)?;
        Ok(())
    }

    fn can_search(&self) -> bool {
        self.tried < self.budget.jobs
            && self.nodes < self.budget.nodes
            && self.started.elapsed().as_millis() < u128::from(self.budget.time_ms)
    }

    fn solve_job(&mut self, game: &Game) -> Result<TacticalResult, String> {
        let mut limits = self.work.limits;
        limits.max_nodes = self.budget.nodes - self.nodes;
        limits.max_attacks = limits
            .max_attacks
            .saturating_sub(((game.moves.len() - self.work.root.moves.len()) / 2) as u16);
        if matches!(self.work.engine, SolverEngine::Dfpn) {
            return self.solve_complete(game, limits);
        }
        solve_guided_cached(
            CachedRequest {
                game,
                book: self.book,
                cache: self.cache,
                policy: self.work.policy,
            },
            limits,
            || self.started.elapsed().as_millis() >= u128::from(self.budget.time_ms),
        )
    }

    fn solve_complete(
        &mut self,
        game: &Game,
        limits: TacticalLimits,
    ) -> Result<TacticalResult, String> {
        let mut search = Dfpn::new(game.clone(), limits.max_attacks, None)?;
        search.advance_cached(
            DfpnRun {
                edges: limits.max_nodes,
                cache: self.cache,
            },
            || self.started.elapsed().as_millis() >= u128::from(self.budget.time_ms),
        );
        let saved = search.save_proofs(self.cache);
        let stats = search.stats();
        Ok(TacticalResult {
            certificate: search.certificate()?,
            frontier: None,
            frontiers: Vec::new(),
            frontiers_truncated: false,
            stats: TacticalStats {
                nodes: stats.search.expansions,
                guidance: GuidanceStats {
                    cache_saved: saved,
                    persistent_hits: stats.persistent_hits,
                    ..GuidanceStats::default()
                },
                ..TacticalStats::default()
            },
        })
    }

    fn output(&self, path: &str) -> Result<i32, String> {
        let certificate = self.root_proof.clone().or(self.cache.get(&self.work.root)?);
        if let Some(certificate) = &certificate {
            verify(certificate)?;
        }
        let won = certificate.is_some();
        let text = match certificate {
            Some(c) => c.to_json()?,
            None => self.work.to_json()?,
        };
        files::write_new(path, &text)?;
        println!(
            "{}",
            json!({"status":if won {"win"} else {"unknown"},"verified":won,
            "guaranteedFirstPlayerWin":won && self.work.root.moves.is_empty(),"nodes":self.nodes,
            "tasksTried":self.tried,"pendingJobs":if won {0} else {self.work.jobs.len()},"cacheEntries":self.cache.len(),"engine":self.work.engine})
        );
        Ok(if won { 0 } else { 2 })
    }
}

fn output_guided(result: TacticalResult, game: &Game, path: &str) -> Result<i32, String> {
    let won = result.certificate.is_some();
    let reason = if won {
        "proved"
    } else if result.stats.interrupted {
        "time"
    } else if result.stats.budget_exhausted {
        "nodes"
    } else {
        "exhausted"
    };
    let report = json!({"status":if won {"win"} else {"unknown"},"verified":won,
        "guaranteedFirstPlayerWin":won && game.moves.is_empty(),"reason":reason,"stats":result.stats});
    let document = match result.certificate {
        Some(certificate) => certificate.to_json()?,
        None => json!({"format":"gomoku-guided-search-v1","rules":"freestyle-15",
            "game":game,"result":report,"frontier":result.frontier})
        .to_string(),
    };
    files::write_new(path, &document)?;
    println!("{report}");
    Ok(if won { 0 } else { 2 })
}

fn flags(args: &[String]) -> Result<Flags, String> {
    if !args.len().is_multiple_of(2) {
        return Err("every flag requires a value".into());
    }
    let mut result = Flags::default();
    for pair in args.chunks_exact(2) {
        match pair[0].as_str() {
            "--checkpoint" if result.checkpoint.is_none() => {
                result.checkpoint = Some(pair[1].clone())
            }
            "--max-nodes" if result.nodes.is_none() => {
                result.nodes = Some(pair[1].parse().map_err(|_| "invalid node budget")?)
            }
            "--time-ms" if result.time.is_none() => {
                result.time = Some(pair[1].parse().map_err(|_| "invalid time budget")?)
            }
            "--cache" if result.cache.is_none() => result.cache = Some(pair[1].clone()),
            "--worklist" if result.worklist.is_none() => result.worklist = Some(pair[1].clone()),
            "--max-jobs" if result.jobs.is_none() => {
                result.jobs = Some(pair[1].parse().map_err(|_| "invalid task budget")?)
            }
            "--quiet-moves" if result.quiet.is_none() => {
                result.quiet = Some(pair[1].parse().map_err(|_| "invalid quiet move width")?)
            }
            "--engine" if result.engine.is_none() => {
                result.engine = Some(match pair[1].as_str() {
                    "guided" => SolverEngine::Guided,
                    "dfpn" => SolverEngine::Dfpn,
                    _ => return Err("engine must be guided or dfpn".into()),
                })
            }
            "--max-attacks" if result.attacks.is_none() => {
                result.attacks = Some(pair[1].parse().map_err(|_| "invalid attack depth")?)
            }
            _ => return Err(format!("unknown or repeated flag: {}", pair[0])),
        }
    }
    Ok(result)
}

fn has_guided_flags(flags: &Flags) -> bool {
    flags.cache.is_some()
        || flags.worklist.is_some()
        || flags.jobs.is_some()
        || flags.quiet.is_some()
        || flags.engine.is_some()
        || flags.attacks.is_some()
}

fn solve(args: &[String]) -> Result<i32, String> {
    files::ensure_new(&args[2])?;
    let mut flags = flags(&args[3..])?;
    if has_guided_flags(&flags) {
        return Err("solve and resume do not accept guided search flags".into());
    }
    let (mut search, options, game) = if args[0] == "solve" {
        let input: Input =
            serde_json::from_str(&files::read(&args[1])?).map_err(|e| e.to_string())?;
        let game = game_from_moves(&input.moves)?;
        let depth = input.options.max_attacks.unwrap_or(113);
        let search = match input.options.tactics {
            Some(limits) => Search::with_tactics(game.clone(), depth, limits)?,
            None => Search::new(game.clone(), depth)?,
        };
        (search, input.options, game)
    } else {
        let text = files::read(&args[1])?;
        let search = Search::restore(&text)?;
        let game: Game = serde_json::from_value(
            serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())?["game"]
                .clone(),
        )
        .map_err(|e| e.to_string())?;
        flags.checkpoint.get_or_insert_with(|| args[1].clone());
        (search, Options::default(), game)
    };
    prepare_paths(args, &flags)?;
    let nodes = flags.nodes.or(options.max_nodes).unwrap_or(100_000);
    let time = flags.time.or(options.time_budget_ms).unwrap_or(60_000);
    let reason = compute(
        &mut search,
        flags.checkpoint.as_deref(),
        Budget {
            nodes,
            time_ms: time,
        },
    )?;
    if let Some(path) = &flags.checkpoint {
        files::atomic_checkpoint(path, &search.checkpoint()?)?;
    }
    output(
        &search,
        &game,
        Save {
            path: &args[2],
            reason,
        },
    )
}

fn prepare_paths(args: &[String], flags: &Flags) -> Result<(), String> {
    let Some(checkpoint) = &flags.checkpoint else {
        return files::distinct(&[&args[1], &args[2]]);
    };
    if args[0] == "solve" {
        files::ensure_new(checkpoint)?;
    }
    if args[0] == "resume" && checkpoint == &args[1] {
        return files::distinct(&[checkpoint, &args[2]]);
    }
    if args[0] == "resume" {
        files::ensure_new(checkpoint)?;
    }
    files::distinct(&[&args[1], &args[2], checkpoint])
}

fn compute(
    search: &mut Search,
    checkpoint: Option<&str>,
    budget: Budget,
) -> Result<&'static str, String> {
    let started = Instant::now();
    let initial = search.stats().expansions;
    let mut checkpointed = Instant::now();
    loop {
        if search.stats().finished {
            return Ok("exhausted");
        }
        if started.elapsed().as_millis() >= u128::from(budget.time_ms) {
            return Ok("time");
        }
        if search.stats().expansions - initial >= budget.nodes {
            return Ok("nodes");
        }
        search.advance(1);
        if checkpointed.elapsed().as_secs() < 5 {
            continue;
        }
        if let Some(path) = checkpoint {
            files::atomic_checkpoint(path, &search.checkpoint()?)?;
        }
        eprintln!("{}", json!({"status":"searching","stats":search.stats()}));
        checkpointed = Instant::now();
    }
}

fn output(search: &Search, game: &Game, save: Save<'_>) -> Result<i32, String> {
    let Save { path, reason } = save;
    let certificate = search.certificate()?;
    let won = certificate.is_some();
    let guaranteed = won && game.moves.is_empty();
    let status = if won { "win" } else { "unknown" };
    let document = match certificate {
        Some(certificate) => certificate.to_json()?,
        None => json!({"format":"gomoku-search-v1","rules":"freestyle-15","game":game,
            "status":status,"reason":reason,"stats":search.stats(),"guaranteedFirstPlayerWin":false}).to_string(),
    };
    files::write_new(path, &document)?;
    println!(
        "{}",
        json!({"status":status,"verified":won,"guaranteedFirstPlayerWin":guaranteed,
        "reason":if won {"proved"} else {reason},"stats":search.stats(),"output":path})
    );
    Ok(if won { 0 } else { 2 })
}

fn execute(certificate: &str, input: &str) -> Result<i32, String> {
    let strategy = Strategy::load(Certificate::from_json(&files::read(certificate)?)?)?;
    let input: Input = serde_json::from_str(&files::read(input)?).map_err(|e| e.to_string())?;
    let at = strategy.move_for(&game_from_moves(&input.moves)?)?;
    println!("{}", json!({"move":at.map(|at| [at % 15, at / 15])}));
    Ok(if at.is_some() { 0 } else { 2 })
}
