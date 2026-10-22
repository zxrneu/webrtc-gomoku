//! Exact freestyle rules; no evaluation, IO or global mutable board.
use serde::{Deserialize, Serialize};

pub const SIZE: usize = 15;
pub const CELLS: usize = SIZE * SIZE;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Move {
    pub x: usize,
    pub y: usize,
    pub c: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Game {
    pub size: usize,
    pub board: Vec<Vec<u8>>,
    pub moves: Vec<Move>,
    pub over: bool,
    pub win_line: Option<Vec<[usize; 2]>>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Position {
    pub(crate) cells: [u8; CELLS],
    pub(crate) turn: u8,
}

pub fn game_from_moves(moves: &[[usize; 2]]) -> Result<Game, String> {
    let mut position = Position {
        cells: [0; CELLS],
        turn: 1,
    };
    let mut records = Vec::with_capacity(moves.len());
    for &[x, y] in moves {
        if x >= SIZE || y >= SIZE {
            return Err("coordinate out of board".into());
        }
        records.push(Move {
            x,
            y,
            c: position.turn,
        });
        position = position.play(y * SIZE + x)?;
        if position.wins_at(y * SIZE + x, 3 - position.turn) {
            return Err("input game must not be over".into());
        }
    }
    if moves.len() >= CELLS {
        return Err("input game must not be full".into());
    }
    Ok(Game {
        size: SIZE,
        board: position.cells.chunks(SIZE).map(<[u8]>::to_vec).collect(),
        moves: records,
        over: false,
        win_line: None,
    })
}

pub fn read_game(game: &Game) -> Result<Position, String> {
    if game.size != SIZE || game.over || game.win_line.is_some() {
        return Err("expected unfinished freestyle-15 game".into());
    }
    let points: Vec<_> = game.moves.iter().map(|m| [m.x, m.y]).collect();
    let replayed = game_from_moves(&points)?;
    if &replayed != game {
        return Err("board or colors disagree with move history".into());
    }
    let mut cells = [0; CELLS];
    for (at, value) in replayed.board.iter().flatten().enumerate() {
        cells[at] = *value;
    }
    Ok(Position {
        cells,
        turn: if game.moves.len().is_multiple_of(2) {
            1
        } else {
            2
        },
    })
}

impl Position {
    pub fn turn(&self) -> u8 {
        self.turn
    }
    pub fn cell(&self, at: usize) -> Option<u8> {
        self.cells.get(at).copied()
    }
    pub fn legal_moves(&self) -> Vec<usize> {
        if self.has_winner() {
            Vec::new()
        } else {
            self.empty_cells()
        }
    }
    pub fn play(&self, at: usize) -> Result<Self, String> {
        if self.cell(at) != Some(0) || self.has_winner() {
            return Err("illegal move".into());
        }
        Ok(self.place(at, self.turn))
    }
    pub fn wins_at(&self, at: usize, color: u8) -> bool {
        if !(1..=2).contains(&color) || self.cell(at) != Some(color) {
            return false;
        }
        [(1, 0), (0, 1), (1, 1), (1, -1)]
            .iter()
            .any(|&(dx, dy)| 1 + self.ray(at, color, dx, dy) + self.ray(at, color, -dx, -dy) >= 5)
    }
    pub fn winning_moves(&self, color: u8) -> Vec<usize> {
        if !(1..=2).contains(&color) {
            return Vec::new();
        }
        self.empty_cells()
            .into_iter()
            .filter(|&at| self.place(at, color).wins_at(at, color))
            .collect()
    }
    pub(crate) fn empty_cells(&self) -> Vec<usize> {
        (0..CELLS).filter(|&at| self.cells[at] == 0).collect()
    }
    pub(crate) fn place(&self, at: usize, color: u8) -> Self {
        let mut next = self.clone();
        next.cells[at] = color;
        next.turn = 3 - color;
        next
    }
    fn has_winner(&self) -> bool {
        (0..CELLS).any(|at| self.cells[at] != 0 && self.wins_at(at, self.cells[at]))
    }
    fn ray(&self, at: usize, color: u8, dx: isize, dy: isize) -> usize {
        let (mut x, mut y) = ((at % SIZE) as isize + dx, (at / SIZE) as isize + dy);
        let mut count = 0;
        while (0..SIZE as isize).contains(&x) && (0..SIZE as isize).contains(&y) {
            if self.cells[y as usize * SIZE + x as usize] != color {
                break;
            }
            count += 1;
            x += dx;
            y += dy;
        }
        count
    }
}
