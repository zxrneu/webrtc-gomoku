//! External board-to-action records are move hints, never winning certificates.
use crate::{
    book::{HintDocument, HintEntry, OpeningBook},
    position_codec::{coordinate, game_for},
    rules::{game_from_moves, read_game, Position, CELLS, SIZE},
};

pub fn import_fucusy(text: &str) -> Result<OpeningBook, String> {
    let mut entries = Vec::new();
    for (line, record) in text.lines().enumerate() {
        let record = record.trim();
        if record.is_empty() || record.starts_with('#') {
            continue;
        }
        if entries.len() >= 200_000 {
            return Err("import exceeds 200000 records; split the input".into());
        }
        entries.push(parse_record(record).map_err(|e| format!("line {}: {e}", line + 1))?);
    }
    let document = HintDocument {
        format: "gomoku-opening-hints-v1".into(),
        rules: "freestyle-15".into(),
        entries,
    };
    OpeningBook::from_json(&serde_json::to_string(&document).map_err(|e| e.to_string())?)
}

fn parse_record(record: &str) -> Result<HintEntry, String> {
    let (position, action) = record.split_once(':').ok_or("expected position:action")?;
    let at = coordinate(action)?;
    let moves = if position.contains(',') {
        let game = game_for(&packed_board(position)?)?;
        game.moves.iter().map(|m| [m.x, m.y]).collect()
    } else if position.is_empty() {
        Vec::new()
    } else {
        position
            .split('_')
            .map(|name| coordinate(name).map(|p| [p % SIZE, p / SIZE]))
            .collect::<Result<Vec<_>, _>>()?
    };
    let board = read_game(&game_from_moves(&moves)?)?;
    if board.turn() != 1 {
        return Err("fucusy records must have black to move".into());
    }
    board.play(at)?;
    Ok(HintEntry {
        moves,
        at: [at % SIZE, at / SIZE],
    })
}

fn packed_board(text: &str) -> Result<Position, String> {
    let rows = text
        .split(',')
        .map(|value| value.parse::<u32>().map_err(|_| "invalid packed row"))
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() != SIZE || rows.iter().any(|&value| value > 0x3fff_ffff) {
        return Err("expected fifteen 30-bit packed rows".into());
    }
    let mut board = Position {
        cells: [0; CELLS],
        turn: 1,
    };
    for (y, row) in rows.into_iter().enumerate() {
        for x in 0..SIZE {
            board.cells[y * SIZE + x] = match (row >> (2 * x)) & 3 {
                1 => 1,
                2 => 2,
                3 => 0,
                _ => return Err("invalid 00 packed cell".into()),
            };
        }
    }
    Ok(board)
}
