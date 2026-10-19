#![cfg_attr(all(target_arch = "wasm32", not(test)), no_std)]

#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

pub const BOARD_SIZE: usize = 15;

mod search;
static mut SEARCH_SCORE: f64 = 0.0;
static mut SEARCH_NODES: u32 = 0;

#[no_mangle]
pub unsafe extern "C" fn gomoku_evaluate_position(color: i32) -> f64 {
    init_window_scores();
    search::evaluate(color)
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_search(color: i32, depth: i32, branches: i32, max_nodes: i32) -> i32 {
    SEARCH_SCORE = 0.0;
    SEARCH_NODES = 0;
    if !(1..=2).contains(&color) || !(0..=32).contains(&depth)
        || !(1..=225).contains(&branches) || !(1..=1_000_000).contains(&max_nodes) { return -1; }
    init_window_scores();
    let mut budget = search::Budget { nodes: 0, limit: max_nodes as u32, depth, branches: branches as usize };
    let result = search::negamax(color, depth, f64::NEG_INFINITY, f64::INFINITY, &mut budget);
    SEARCH_SCORE = result.score;
    SEARCH_NODES = budget.nodes;
    result.at
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_search_score() -> f64 { SEARCH_SCORE }

#[no_mangle]
pub unsafe extern "C" fn gomoku_search_nodes() -> u32 { SEARCH_NODES }
pub const CELL_COUNT: usize = 225;
pub const DIR_COUNT: usize = 4;
pub const WINDOW_LEN: usize = 9;
pub const CENTER_SLOT: usize = 4;
pub const WINDOW_CODE_COUNT: usize = 19683; // 3^9

pub const S_FIVE: i32 = 10_000_000;
pub const S_OPEN_FOUR: i32 = 1_000_000;
pub const S_FOUR: i32 = 100_000;
pub const S_OPEN_THREE: i32 = 20_000;
pub const S_SLEEP_THREE: i32 = 5_000;
pub const S_OPEN_TWO: i32 = 800;
pub const S_SLEEP_TWO: i32 = 120;
pub const S_OPEN_ONE: i32 = 20;

pub const COMBO_DOUBLE_FOUR: i32 = 800_000;
pub const COMBO_FOUR_THREE: i32 = 400_000;
pub const COMBO_DOUBLE_THREE: i32 = 300_000;

struct PatternEntry {
    pattern: &'static [u8],
    score: i32,
}

const PATTERN_TABLE: [PatternEntry; 28] = [
    PatternEntry { pattern: b"11111", score: S_FIVE },
    PatternEntry { pattern: b"011110", score: S_OPEN_FOUR },
    PatternEntry { pattern: b"011112", score: S_FOUR },
    PatternEntry { pattern: b"211110", score: S_FOUR },
    PatternEntry { pattern: b"11011", score: S_FOUR },
    PatternEntry { pattern: b"10111", score: S_FOUR },
    PatternEntry { pattern: b"11101", score: S_FOUR },
    PatternEntry { pattern: b"011100", score: S_OPEN_THREE },
    PatternEntry { pattern: b"001110", score: S_OPEN_THREE },
    PatternEntry { pattern: b"010110", score: S_OPEN_THREE },
    PatternEntry { pattern: b"011010", score: S_OPEN_THREE },
    PatternEntry { pattern: b"001112", score: S_SLEEP_THREE },
    PatternEntry { pattern: b"211100", score: S_SLEEP_THREE },
    PatternEntry { pattern: b"010112", score: S_SLEEP_THREE },
    PatternEntry { pattern: b"211010", score: S_SLEEP_THREE },
    PatternEntry { pattern: b"10011", score: S_SLEEP_THREE },
    PatternEntry { pattern: b"10101", score: S_SLEEP_THREE },
    PatternEntry { pattern: b"001100", score: S_OPEN_TWO },
    PatternEntry { pattern: b"010100", score: S_OPEN_TWO },
    PatternEntry { pattern: b"001010", score: S_OPEN_TWO },
    PatternEntry { pattern: b"010010", score: S_OPEN_TWO },
    PatternEntry { pattern: b"000112", score: S_SLEEP_TWO },
    PatternEntry { pattern: b"211000", score: S_SLEEP_TWO },
    PatternEntry { pattern: b"001012", score: S_SLEEP_TWO },
    PatternEntry { pattern: b"10001", score: S_SLEEP_TWO },
    PatternEntry { pattern: b"00100", score: S_OPEN_ONE },
    PatternEntry { pattern: b"01000", score: S_OPEN_ONE },
    PatternEntry { pattern: b"00010", score: S_OPEN_ONE },
];

pub const THREE_POW: [i32; 9] = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];

pub const DIRS: [(i32, i32); 4] = [
    (1, 0),
    (0, 1),
    (1, 1),
    (1, -1),
];

// Linear memory layout
pub static mut BOARD_BUFFER: [u8; CELL_COUNT] = [0; CELL_COUNT];
pub static mut WINDOW_SCORES: [i32; WINDOW_CODE_COUNT] = [0; WINDOW_CODE_COUNT];
pub static mut CANDIDATES_MOVES_BUFFER: [i16; CELL_COUNT] = [0; CELL_COUNT];
pub static mut CANDIDATES_SCORES_BUFFER: [i32; CELL_COUNT] = [0; CELL_COUNT];
static mut INITIALIZED: bool = false;

pub unsafe fn init_window_scores() {
    if INITIALIZED {
        return;
    }
    let scores_ptr = core::ptr::addr_of_mut!(WINDOW_SCORES) as *mut i32;
    let mut pi = PATTERN_TABLE.len();
    while pi > 0 {
        pi -= 1;
        let entry = &PATTERN_TABLE[pi];
        let pat = entry.pattern;
        let len = pat.len();
        let score = entry.score;

        let max_start = 9 - len;
        for start in 0..=max_start {
            let center_offset = 4 as isize - start as isize;
            if center_offset < 0 || center_offset >= len as isize {
                continue;
            }
            if pat[center_offset as usize] != b'1' {
                continue;
            }

            let mut free_slots = [0usize; 9];
            let mut free_count = 0;
            for slot in 0..9 {
                if slot < start || slot >= start + len {
                    free_slots[free_count] = slot;
                    free_count += 1;
                }
            }

            let mut combos = 1;
            for _ in 0..free_count {
                combos *= 3;
            }

            for m in 0..combos {
                let mut code = 0;
                let mut rest = m;
                for k in 0..len {
                    code += ((pat[k] - b'0') as i32) * THREE_POW[start + k];
                }
                for i in 0..free_count {
                    let slot = free_slots[i];
                    let digit = rest % 3;
                    rest /= 3;
                    code += (digit as i32) * THREE_POW[slot];
                }
                *scores_ptr.add(code as usize) = score;
            }
        }
    }
    INITIALIZED = true;
}

#[inline]
pub unsafe fn window_code(idx: i32, dir: i32, color: i32) -> i32 {
    if idx < 0 || idx >= 225 || dir < 0 || dir >= 4 {
        return 0;
    }
    let x = (idx % 15) as i32;
    let y = (idx / 15) as i32;
    let (dx, dy) = DIRS[dir as usize];

    let mut code = 81; // 3^4 center slot is always 1 (current player stone)

    let board_ptr = core::ptr::addr_of!(BOARD_BUFFER) as *const u8;
    for slot in 0..9 {
        if slot == 4 {
            continue;
        }
        let k = (slot as i32) - 4;
        let nx = x + dx * k;
        let ny = y + dy * k;

        let digit = if nx < 0 || ny < 0 || nx >= 15 || ny >= 15 {
            2
        } else {
            let cell = *board_ptr.add((ny * 15 + nx) as usize);
            if cell == 0 {
                0
            } else if cell == color as u8 {
                1
            } else {
                2
            }
        };
        code += digit * THREE_POW[slot];
    }
    code
}

#[inline]
pub unsafe fn window_score(idx: i32, dir: i32, color: i32) -> i32 {
    let code = window_code(idx, dir, color);
    if (0..WINDOW_CODE_COUNT as i32).contains(&code) {
        let scores_ptr = core::ptr::addr_of!(WINDOW_SCORES) as *const i32;
        *scores_ptr.add(code as usize)
    } else {
        0
    }
}

#[inline]
pub fn combine_scores(d0: i32, d1: i32, d2: i32, d3: i32) -> i32 {
    let mut five = 0;
    let mut open_four = 0;
    let mut four = 0;
    let mut open_three = 0;
    let mut best = 0;

    let dirs = [d0, d1, d2, d3];
    for &s in &dirs {
        if s > best {
            best = s;
        }
        if s == S_FIVE {
            five += 1;
        } else if s == S_OPEN_FOUR {
            open_four += 1;
        } else if s == S_FOUR {
            four += 1;
        } else if s == S_OPEN_THREE {
            open_three += 1;
        }
    }

    if five > 0 {
        return S_FIVE;
    }
    if open_four > 0 {
        return S_OPEN_FOUR;
    }
    if four >= 2 {
        return COMBO_DOUBLE_FOUR;
    }
    if four >= 1 && open_three >= 1 {
        return COMBO_FOUR_THREE;
    }
    if open_three >= 2 {
        return COMBO_DOUBLE_THREE;
    }
    best
}

#[inline]
pub unsafe fn point_score(idx: i32, color: i32) -> i32 {
    let d0 = window_score(idx, 0, color);
    let d1 = window_score(idx, 1, color);
    let d2 = window_score(idx, 2, color);
    let d3 = window_score(idx, 3, color);
    combine_scores(d0, d1, d2, d3)
}

#[inline]
pub unsafe fn wins_at(idx: i32, color: i32) -> bool {
    if idx < 0 || idx >= 225 {
        return false;
    }
    let board_ptr = core::ptr::addr_of!(BOARD_BUFFER) as *const u8;
    if *board_ptr.add(idx as usize) != color as u8 {
        return false;
    }
    let x = (idx % 15) as i32;
    let y = (idx / 15) as i32;

    for &(dx, dy) in &DIRS {
        let mut count = 1;
        for &sign in &[-1, 1] {
            let mut nx = x + dx * sign;
            let mut ny = y + dy * sign;
            while nx >= 0 && ny >= 0 && nx < 15 && ny < 15 {
                let cell = *board_ptr.add((ny * 15 + nx) as usize);
                if cell == color as u8 {
                    count += 1;
                    nx += dx * sign;
                    ny += dy * sign;
                } else {
                    break;
                }
            }
        }
        if count >= 5 {
            return true;
        }
    }
    false
}

// ==========================================
// C-ABI Exports
// ==========================================

#[no_mangle]
pub unsafe extern "C" fn gomoku_init() {
    init_window_scores();
    let ptr = core::ptr::addr_of_mut!(BOARD_BUFFER) as *mut u8;
    core::ptr::write_bytes(ptr, 0, CELL_COUNT);
    let moves_ptr = core::ptr::addr_of_mut!(CANDIDATES_MOVES_BUFFER) as *mut u8;
    core::ptr::write_bytes(moves_ptr, 0, CELL_COUNT * 2);
    let scores_ptr = core::ptr::addr_of_mut!(CANDIDATES_SCORES_BUFFER) as *mut u8;
    core::ptr::write_bytes(scores_ptr, 0, CELL_COUNT * 4);
}

#[no_mangle]
pub unsafe extern "C" fn get_candidates_moves_ptr() -> *mut i16 {
    core::ptr::addr_of_mut!(CANDIDATES_MOVES_BUFFER) as *mut i16
}

#[no_mangle]
pub unsafe extern "C" fn get_candidates_scores_ptr() -> *mut i32 {
    core::ptr::addr_of_mut!(CANDIDATES_SCORES_BUFFER) as *mut i32
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_set_cell(idx: i32, color: i32) {
    if idx >= 0 && idx < 225 {
        let ptr = core::ptr::addr_of_mut!(BOARD_BUFFER) as *mut u8;
        *ptr.add(idx as usize) = color as u8;
    }
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_window_score(idx: i32, dir: i32, color: i32) -> i32 {
    if !INITIALIZED {
        init_window_scores();
    }
    window_score(idx, dir, color)
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_point_score(idx: i32, color: i32) -> i32 {
    if !INITIALIZED {
        init_window_scores();
    }
    point_score(idx, color)
}

#[no_mangle]
pub unsafe extern "C" fn get_board_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(BOARD_BUFFER) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_window_code(idx: i32, dir: i32, color: i32) -> i32 {
    window_code(idx, dir, color)
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_raw_window_score(code: i32) -> i32 {
    if !INITIALIZED {
        init_window_scores();
    }
    if (0..WINDOW_CODE_COUNT as i32).contains(&code) {
        let scores_ptr = core::ptr::addr_of!(WINDOW_SCORES) as *const i32;
        *scores_ptr.add(code as usize)
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn gomoku_combine_scores(d0: i32, d1: i32, d2: i32, d3: i32) -> i32 {
    combine_scores(d0, d1, d2, d3)
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_wins_at(idx: i32, color: i32) -> i32 {
    if wins_at(idx, color) {
        1
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_find_five(color: i32, out_buf: *mut i16, max_len: i32) -> i32 {
    if !INITIALIZED {
        init_window_scores();
    }
    if out_buf.is_null() || max_len <= 0 {
        return 0;
    }
    let board_ptr = core::ptr::addr_of!(BOARD_BUFFER) as *const u8;
    let mut count = 0;
    for idx in 0..225 {
        if *board_ptr.add(idx as usize) == 0 {
            if point_score(idx, color) >= S_FIVE {
                *out_buf.offset(count as isize) = idx as i16;
                count += 1;
                if count >= max_len {
                    break;
                }
            }
        }
    }
    count
}

#[no_mangle]
pub unsafe extern "C" fn gomoku_score_candidates(
    color: i32,
    defense_weight_pct: i32,
    out_moves: *mut i16,
    out_scores: *mut i32,
) -> i32 {
    if !INITIALIZED {
        init_window_scores();
    }
    if out_moves.is_null() || out_scores.is_null() {
        return 0;
    }
    let board_ptr = core::ptr::addr_of!(BOARD_BUFFER) as *const u8;
    let opp = if color == 1 { 2 } else { 1 };
    let mut count = 0;
    for idx in 0..225 {
        if *board_ptr.add(idx as usize) == 0 {
            let x = (idx % 15) as i32;
            let y = (idx / 15) as i32;
            let mut has_neighbor = false;
            'check_neighbor: for dy in -2..=2 {
                for dx in -2..=2 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx >= 0 && ny >= 0 && nx < 15 && ny < 15 {
                        if *board_ptr.add((ny * 15 + nx) as usize) != 0 {
                            has_neighbor = true;
                            break 'check_neighbor;
                        }
                    }
                }
            }
            if has_neighbor {
                let attack = point_score(idx, color);
                let defense = point_score(idx, opp);
                let score = attack + (((defense as i64) * (defense_weight_pct as i64)) / 100) as i32;
                *out_moves.offset(count as isize) = idx as i16;
                *out_scores.offset(count as isize) = score;
                count += 1;
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_table_init() {
        unsafe {
            gomoku_init();
            let five_code = THREE_POW[2] + THREE_POW[3] + THREE_POW[4] + THREE_POW[5] + THREE_POW[6];
            assert_eq!(WINDOW_SCORES[five_code as usize], S_FIVE);
        }
    }

    #[test]
    fn test_point_score_empty_board() {
        unsafe {
            gomoku_init();
            let score = gomoku_point_score(112, 1);
            assert_eq!(score, S_OPEN_ONE);
        }
    }
}
