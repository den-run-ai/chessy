// Offline observer compiled beside the r85 engine sources. The search remains on HCE.
#![allow(dead_code, static_mut_refs)]
mod engine;
mod eval;
mod search;

use engine::{Color, Position};
use std::io::{self, BufRead};

#[no_mangle]
pub extern "C" fn now_ms() -> f64 { panic!("unexpected clock in fixed-node trace") }

#[derive(Clone, Copy)]
struct Event {
    position: Position,
    score: i32,
    bound: i32,
    qply: usize,
    ordinal: usize,
}

struct Sample {
    visits: usize,
    rng: u64,
    retained: Vec<Event>,
}

impl Sample {
    fn new(seed: u64) -> Self { Self { visits: 0, rng: seed, retained: Vec::new() } }

    fn observe(&mut self, event: Event) {
        self.visits += 1;
        self.rng = self.rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let slot = ((self.rng as u128 * self.visits as u128) >> 64) as usize;
        if self.visits <= 6 { self.retained.push(event); }
        else if slot < 6 { self.retained[slot] = event; }
    }
}

thread_local! {
    static SAMPLES: std::cell::RefCell<[Sample; 2]> = std::cell::RefCell::new([Sample::new(1), Sample::new(2)]);
}

fn observe(p: &Position, score: i32, alpha: i32, beta: i32, qply: usize) {
    let bound = if p.turn == Color::White { beta } else { alpha };
    SAMPLES.with_borrow_mut(|samples| {
        let event = Event { position: *p, score, bound, qply, ordinal: samples[0].visits };
        samples[0].observe(event);
        if (score - bound).abs() <= 50 { samples[1].observe(event); }
    });
}

fn fen(p: &Position) -> String {
    let mut board = String::new();
    for (i, rank) in p.board.chunks(8).enumerate() {
        if i > 0 { board.push('/'); }
        let mut empty = 0_u8;
        for &piece in rank {
            if piece == engine::Piece::Empty { empty += 1; continue; }
            if empty > 0 { board.push((b'0' + empty) as char); empty = 0; }
            board.push(b" PNBRQKpnbrqk"[piece as usize] as char);
        }
        if empty > 0 { board.push((b'0' + empty) as char); }
    }
    let mut rights: String = "KQkq".chars().enumerate().filter_map(|(i, c)|
        if (p.castling >> i) & 1 != 0 { Some(c) } else { None }).collect();
    if rights.is_empty() { rights.push('-'); }
    let ep = if p.ep == engine::NO_SQUARE { "-".to_string() }
        else { format!("{}{}", (b'a' + p.ep % 8) as char, (b'8' - p.ep / 8) as char) };
    format!("{} {} {} {} {} {}", board, if p.turn == Color::White { "w" } else { "b" },
            rights, ep, p.halfmove, p.fullmove)
}

fn main() {
    for (root, line) in io::stdin().lock().lines().enumerate() {
        let line = line.unwrap();
        let history: Vec<&str> = line.split('\t').collect();
        let mut p = engine::parse_fen(history.last().unwrap().as_bytes()).unwrap();
        let seed = 47981 + root as u64;
        SAMPLES.with_borrow_mut(|s| *s = [Sample::new(seed), Sample::new(!seed)]);
        let result = unsafe {
            assert!(search::load_game_history(history.join("\n").as_bytes()).is_ok());
            search::run_seeded(&mut p, 111, 10000, 0, true, 0xC0FFEE)
        };
        println!("R\t{root}\t{}\t{}\t{}\t{}\t{}", result.score, result.depth,
                 result.nodes, result.qnodes, result.mv.map(search::abi_move).unwrap_or(u32::MAX));
        SAMPLES.with_borrow(|samples| {
            for (s, sample) in samples.iter().enumerate() {
                for e in &sample.retained {
                    println!("E\t{root}\t{s}\t{}\t{}\t{}\t{}\t{}\t{}", sample.visits,
                             e.ordinal, e.qply, e.score, e.bound, fen(&e.position));
                }
            }
        });
    }
}
