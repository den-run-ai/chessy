//! Exact, allocation-free sparse evaluator variants for research only.
//!
//! All variants consume the same 17,280 coefficients and retain two distinct
//! rounding operations: historical HCE floor(x+.5), then residual ties-away.
//! Narrow tables are a lossless representation, never clipping or quantizing.

use crate::engine::{Piece, Position};
#[path = "hce_constants.rs"]
mod hce;

pub const BASE: usize = 8640;
pub const TOTAL: usize = 17280;
pub const CACHE_SLOTS: usize = 1024;
#[cfg(v2_wide_fused)] type FusedValue = i16;
#[cfg(not(v2_wide_fused))] type FusedValue = i8;
pub const COEFFICIENT_BYTES: usize = 3072 * 2 * core::mem::size_of::<FusedValue>() + 6144 + 3072 + 1352;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant { Compact = 1, Fused = 2 }

pub struct Model {
    fused: [[FusedValue; 2]; 3072],
    enemy: [[i8; 2]; 3072],
    pawn: [[i8; 2]; 1536],
    pairs: [[i8; 2]; 676],
    active: [bool; 4],
}

impl Model {
    pub const ZERO: Self = Self {
        fused: [[0; 2]; 3072], enemy: [[0; 2]; 3072],
        pawn: [[0; 2]; 1536], pairs: [[0; 2]; 676], active: [false; 4],
    };

    /// Also accepts strict SPV1 sparse input. A failed load leaves self intact.
    /// Every original coefficient and every paired ray sum must fit i8.
    pub fn load_dense(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        let mut weights = [0_i16; TOTAL];
        if bytes.starts_with(b"SPV1") {
            if bytes.len() < 8 { return Err("truncated SPV1 header"); }
            let count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
            if count > TOTAL || bytes.len() != 8 + count * 4 { return Err("SPV1 count/length mismatch"); }
            let mut previous = None;
            for record in bytes[8..].chunks_exact(4) {
                let id = u16::from_le_bytes([record[0], record[1]]) as usize;
                let value = i16::from_le_bytes([record[2], record[3]]);
                if id >= TOTAL || previous.is_some_and(|old| id <= old) || value == 0 {
                    return Err("invalid SPV1 index/order/zero record");
                }
                weights[id] = value;
                previous = Some(id);
            }
        } else {
            if bytes.len() != TOTAL * 2 { return Err("expected dense i16 or SPV1 weights"); }
            for (index, pair) in bytes.chunks_exact(2).enumerate() {
                weights[index] = i16::from_le_bytes([pair[0], pair[1]]);
            }
        }
        if weights.iter().any(|&value| !(-128..=127).contains(&value)) {
            return Err("lossless narrow representation requires every coefficient in [-128,127]");
        }
        let mut next = Self::ZERO;
        for index in 0..3072 {
            for stage in 0..2 {
                let offset = stage * BASE;
                let fused = weights[offset + index % 384] + weights[offset + 384 + index];
                #[cfg(not(v2_wide_fused))]
                if !(-128..=127).contains(&fused) { return Err("fused PST/own-king sum does not fit lossless i8; rebuild with v2_wide_fused"); }
                next.fused[index][stage] = fused as FusedValue;
                next.enemy[index][stage] = weights[offset + 3456 + index] as i8;
            }
            next.active[0] |= next.fused[index] != [0, 0];
            next.active[1] |= next.enemy[index] != [0, 0];
        }
        for index in 0..1536 {
            next.pawn[index] = [weights[6528 + index] as i8, weights[BASE + 6528 + index] as i8];
            next.active[2] |= next.pawn[index] != [0, 0];
        }
        const GLOBAL: [usize; 4] = [2, 0, 1, 7]; // E,N,NE,NW
        const BLACK: [usize; 8] = [4, 3, 2, 1, 0, 7, 6, 5];
        for source in 1..13 {
            let sc = (source - 1) / 6;
            let sk = (source - 1) % 6;
            let ss = if sc == 0 { 1 } else { -1 };
            for target in 1..13 {
                let tc = (target - 1) / 6;
                let tk = (target - 1) % 6;
                let ts = if tc == 0 { 1 } else { -1 };
                let enemy = usize::from(sc != tc);
                for (axis, global) in GLOBAL.into_iter().enumerate() {
                    let reverse = (global + 4) % 8;
                    let sd = if sc == 0 { global } else { BLACK[global] };
                    let td = if tc == 0 { reverse } else { BLACK[reverse] };
                    let a = 8064 + (((sk * 6 + tk) * 2 + enemy) * 8 + sd);
                    let b = 8064 + (((tk * 6 + sk) * 2 + enemy) * 8 + td);
                    let id = (source * 13 + target) * 4 + axis;
                    for stage in 0..2 {
                        let value = ss * weights[a + stage * BASE] + ts * weights[b + stage * BASE];
                        if !(-128..=127).contains(&value) { return Err("paired ray sum does not fit lossless i8"); }
                        next.pairs[id][stage] = value as i8;
                    }
                    next.active[3] |= next.pairs[id] != [0, 0];
                }
            }
        }
        *self = next;
        Ok(())
    }

    #[inline]
    pub fn evaluate(&self, position: &Position, variant: Variant) -> i32 {
        match variant {
            Variant::Compact => crate::baseline::evaluate(position) + self.correction(position),
            Variant::Fused => { let (base, residual) = self.fused_parts(position); base + residual },
        }
    }

    /// The v1 pair sweep with smaller interleaved MG/EG coefficient tables.
    pub fn correction(&self, position: &Position) -> i32 {
        if !self.active.iter().any(|&value| value) { return 0; }
        let geometry = Geometry::new(position);
        let offsets = Offsets::new(position);
        let attacks = attacks(geometry.pawns);
        let mut lines = Lines::ZERO;
        let mut residual = [0_i32; 2];
        let mut phase = 0;
        let mut occupied = geometry.occupied;
        while occupied != 0 {
            let square = occupied.trailing_zeros() as usize;
            occupied &= occupied - 1;
            let code = position.board[square ^ 56] as usize;
            let kind = (code - 1) % 6;
            phase += hce::PHASE[kind];
            self.add_piece(&offsets, &attacks, square, code, &mut residual);
            if self.active[3] {
                let predecessors = lines.previous(square, code);
                for (axis, previous) in predecessors.into_iter().enumerate() {
                    let value = self.pairs[(((previous as usize & 15) * 13) + code) * 4 + axis];
                    residual[0] += value[0] as i32;
                    residual[1] += value[1] as i32;
                }
            }
        }
        round_residual(residual, phase.min(24))
    }

    #[inline(always)]
    fn add_piece(&self, offsets: &Offsets, attacks: &[u64; 2], square: usize,
                 code: usize, residual: &mut [i32; 2]) {
        let color = usize::from(code >= 7);
        let kind = (code - 1) % 6;
        let sign = if color == 0 { 1 } else { -1 };
        let ps = kind * 64 + (square ^ (color * 56));
        let mut value = [0_i32; 2];
        if self.active[0] {
            let pair = self.fused[offsets.own[color] + ps];
            value[0] += pair[0] as i32; value[1] += pair[1] as i32;
        }
        if self.active[1] {
            let pair = self.enemy[offsets.enemy[color] + ps];
            value[0] += pair[0] as i32; value[1] += pair[1] as i32;
        }
        if self.active[2] {
            let state = (((attacks[color] >> square) & 1)
                | (((attacks[1 - color] >> square) & 1) << 1)) as usize;
            let pair = self.pawn[state * 384 + ps];
            value[0] += pair[0] as i32; value[1] += pair[1] as i32;
        }
        residual[0] += sign * value[0]; residual[1] += sign * value[1];
    }

    /// HCE and residual share board analysis and nearest occupied geometry.
    /// Sliding mobility starts with unobstructed edge distance and subtracts
    /// each blocker's occluded tail. Both directed tails are handled once per
    /// adjacent occupied pair, independently of residual ray coefficients.
    pub fn fused_parts(&self, position: &Position) -> (i32, i32) {
        let geometry = Geometry::new(position);
        let offsets = Offsets::new(position);
        let pawn_attacks = attacks(geometry.pawns);
        let mut lines = Lines::ZERO;
        let mut base = [0_i32; 2];
        let mut residual = [0_i32; 2];
        let mut phase = 0;
        let mut force = [0_u32; 2];
        let mut nonpawn = [0_u32; 2];
        let mut mobility_adjustment = 0;
        let mut occupied = geometry.occupied;
        while occupied != 0 {
            let square = occupied.trailing_zeros() as usize;
            occupied &= occupied - 1;
            let code = position.board[square ^ 56] as usize;
            let color = usize::from(code >= 7);
            let kind = (code - 1) % 6;
            phase += hce::PHASE[kind];
            force[color] += u32::from(kind != 5);
            nonpawn[color] += u32::from(kind != 0 && kind != 5);
            let piece_base = BASE_PST[code * 64 + square];
            base[0] += piece_base[0] as i32; base[1] += piece_base[1] as i32;
            if kind == 1 {
                let blocked = (KNIGHTS[square] & geometry.colors[color]).count_ones() as i32;
                mobility_adjustment -= if color == 0 { blocked * 3 } else { -blocked * 3 };
            }
            self.add_piece(&offsets, &pawn_attacks, square, code, &mut residual);
            let predecessors = lines.previous(square, code);
            for (axis, previous) in predecessors.into_iter().enumerate() {
                let previous_code = previous as usize & 15;
                if previous_code == 0 { continue; }
                let previous_square = previous as usize >> 4;
                let same = i32::from((previous_code >= 7) == (code >= 7));
                mobility_adjustment -= SLOPE[previous_code][axis] as i32 * (POSITIVE_EDGE[square][axis] as i32 + same)
                    + SLOPE[code][axis] as i32 * (NEGATIVE_EDGE[previous_square][axis] as i32 + same);
                if self.active[3] {
                    let value = self.pairs[(previous_code * 13 + code) * 4 + axis];
                    residual[0] += value[0] as i32; residual[1] += value[1] as i32;
                }
            }
        }
        base[0] += mobility_adjustment; base[1] += mobility_adjustment;
        pawn_terms(position, &geometry, &mut base);
        let phase = phase.min(24);
        let mut baseline = round_baseline(base, phase);
        if nonpawn[0] != 0 && force[1] == 0 {
            baseline += mop_up(position.king_sq[1] as usize, position.king_sq[0] as usize);
        } else if nonpawn[1] != 0 && force[0] == 0 {
            baseline -= mop_up(position.king_sq[0] as usize, position.king_sq[1] as usize);
        }
        (baseline, round_residual(residual, phase))
    }
}

struct Offsets { own: [usize; 2], enemy: [usize; 2] }
impl Offsets {
    #[inline]
    fn new(position: &Position) -> Self {
        let white = position.king_sq[0] as usize ^ 56;
        let black = position.king_sq[1] as usize ^ 56;
        Self { own: [bucket(white) * 384, bucket(black ^ 56) * 384],
            enemy: [bucket(black) * 384, bucket(white ^ 56) * 384] }
    }
}

struct Geometry { occupied: u64, colors: [u64; 2], pawns: [u64; 2] }
impl Geometry {
    #[inline]
    fn new(position: &Position) -> Self {
        let occupied = occupied_a1_mask(&position.board);
        let mut colors = [0_u64; 2];
        let mut pawns = [0_u64; 2];
        let mut remaining = occupied;
        while remaining != 0 {
            let square = remaining.trailing_zeros() as usize;
            let bit = remaining & remaining.wrapping_neg();
            remaining &= remaining - 1;
            let code = position.board[square ^ 56] as usize;
            let color = usize::from(code >= 7);
            colors[color] |= bit;
            if code == 1 || code == 7 { pawns[color] |= bit; }
        }
        Self { occupied, colors, pawns }
    }
}

#[inline]
fn occupied_a1_mask(board: &[Piece; 64]) -> u64 {
    #[cfg(v2_simd)]
    { crate::simd::occupied_a1_mask(board) }
    #[cfg(not(v2_simd))]
    {
        let mut mask = 0_u64;
        for (internal, &piece) in board.iter().enumerate() {
            mask |= u64::from(piece != Piece::Empty) << (internal ^ 56);
        }
        mask
    }
}

struct Lines { rank: usize, last_rank: u16, files: [u16; 8], diagonal: [u16; 15], antidiagonal: [u16; 15] }
impl Lines {
    const ZERO: Self = Self { rank: 0, last_rank: 0, files: [0; 8], diagonal: [0; 15], antidiagonal: [0; 15] };
    #[inline(always)]
    fn previous(&mut self, square: usize, code: usize) -> [u16; 4] {
        let rank = square / 8;
        let file = square % 8;
        if self.rank != rank { self.last_rank = 0; self.rank = rank; }
        let diagonal = rank + 7 - file;
        let antidiagonal = rank + file;
        let result = [self.last_rank, self.files[file], self.diagonal[diagonal], self.antidiagonal[antidiagonal]];
        let entry = ((square << 4) | code) as u16;
        self.last_rank = entry; self.files[file] = entry;
        self.diagonal[diagonal] = entry; self.antidiagonal[antidiagonal] = entry;
        result
    }
}

#[inline]
fn bucket(square: usize) -> usize { (square / 32) * 4 + square % 8 / 2 }

#[inline]
fn attacks(pawns: [u64; 2]) -> [u64; 2] {
    [((pawns[0] & 0xfefefefefefefefe) << 7) | ((pawns[0] & 0x7f7f7f7f7f7f7f7f) << 9),
     ((pawns[1] & 0xfefefefefefefefe) >> 9) | ((pawns[1] & 0x7f7f7f7f7f7f7f7f) >> 7)]
}

#[inline]
fn round_baseline(value: [i32; 2], phase: i32) -> i32 {
    (value[0] * phase + value[1] * (24 - phase) + 12).div_euclid(24)
}

#[inline]
fn round_residual(value: [i32; 2], phase: i32) -> i32 {
    let numerator = value[0] * phase + value[1] * (24 - phase);
    let rounded = (numerator.abs() + 12) / 24;
    if numerator < 0 { -rounded } else { rounded }
}

fn pawn_terms(position: &Position, geometry: &Geometry, base: &mut [i32; 2]) {
    for color in 0..2 {
        let sign = if color == 0 { 1 } else { -1 };
        let pawns = geometry.pawns[color];
        let enemy = geometry.pawns[1 - color];
        let mut files = 0_u8;
        for file in 0..8 {
            if pawns & (0x0101010101010101_u64 << file) != 0 { files |= 1 << file; }
        }
        let doubled = pawns.count_ones() as i32 - files.count_ones() as i32;
        base[0] -= sign * hce::DOUBLED * doubled;
        base[1] -= sign * hce::DOUBLED * doubled;
        let mut remaining = pawns;
        while remaining != 0 {
            let square = remaining.trailing_zeros() as usize;
            remaining &= remaining - 1;
            let file = square % 8;
            let neighbors = ((1_u16 << file) >> 1) | ((1_u16 << file) << 1);
            if files as u16 & neighbors == 0 {
                base[0] -= sign * hce::ISOLATED; base[1] -= sign * hce::ISOLATED;
            }
            if enemy & PASSED_MASKS[color][square] == 0 {
                let rank = square / 8;
                let relative = if color == 0 { rank as i32 - 1 } else { 6 - rank as i32 };
                let relative = relative.clamp(0, 6) as usize;
                base[0] += sign * hce::PASSED_MG[relative];
                base[1] += sign * hce::PASSED_EG[relative];
            }
        }
        let king = position.king_sq[color] as usize ^ 56;
        base[0] += sign * hce::SHIELD * (pawns & SHIELD_MASKS[color][king]).count_ones() as i32;
    }
}

fn mop_up(loser: usize, winner: usize) -> i32 {
    let (lr, lf) = ((loser / 8) as i32, (loser % 8) as i32);
    let (wr, wf) = ((winner / 8) as i32, (winner % 8) as i32);
    8 * (core::cmp::max(3 - lf, lf - 4) + core::cmp::max(3 - lr, lr - 4))
        + 2 * (14 - (lr - wr).abs() - (lf - wf).abs())
}

const fn min(a: usize, b: usize) -> usize { if a < b { a } else { b } }
const fn edges(positive: bool) -> [[u8; 4]; 64] {
    let mut result = [[0; 4]; 64];
    let mut square = 0;
    while square < 64 {
        let rank = square / 8;
        let file = square % 8;
        result[square] = if positive {
            [(7 - file) as u8, (7 - rank) as u8, min(7 - rank, 7 - file) as u8, min(7 - rank, file) as u8]
        } else {
            [file as u8, rank as u8, min(rank, file) as u8, min(rank, 7 - file) as u8]
        };
        square += 1;
    }
    result
}
const POSITIVE_EDGE: [[u8; 4]; 64] = edges(true);
const NEGATIVE_EDGE: [[u8; 4]; 64] = edges(false);

const fn slopes() -> [[i8; 4]; 13] {
    let mut result = [[0; 4]; 13];
    let mut code = 1;
    while code < 13 {
        let kind = (code - 1) % 6;
        let sign = if code < 7 { 1 } else { -1 };
        result[code] = match kind { 2 => [0, 0, 3 * sign, 3 * sign],
            3 => [2 * sign, 2 * sign, 0, 0], 4 => [sign; 4], _ => [0; 4] };
        code += 1;
    }
    result
}
const SLOPE: [[i8; 4]; 13] = slopes();

const fn knights() -> [u64; 64] {
    let mut result = [0_u64; 64];
    let mut square = 0;
    while square < 64 {
        let mut target = 0;
        while target < 64 {
            let dr = (square / 8) as i32 - (target / 8) as i32;
            let df = (square % 8) as i32 - (target % 8) as i32;
            if dr * dr + df * df == 5 { result[square] |= 1_u64 << target; }
            target += 1;
        }
        square += 1;
    }
    result
}
const KNIGHTS: [u64; 64] = knights();

const fn base_pst() -> [[i16; 2]; 13 * 64] {
    let mut result = [[0; 2]; 13 * 64];
    let mut code = 1;
    while code < 13 {
        let kind = (code - 1) % 6;
        let sign = if code < 7 { 1 } else { -1 };
        let mut square = 0;
        while square < 64 {
            let table = square ^ if code < 7 { 56 } else { 0 };
            let mut mobility = 0;
            let mut axis = 0;
            while axis < 4 {
                mobility += SLOPE[code][axis] as i32 * (POSITIVE_EDGE[square][axis] + NEGATIVE_EDGE[square][axis]) as i32;
                axis += 1;
            }
            if kind == 1 { mobility = sign * 3 * KNIGHTS[square].count_ones() as i32; }
            result[code * 64 + square] = [
                (sign * (hce::VALUES_MG[kind] + hce::PST_MG[kind][table] as i32) + mobility) as i16,
                (sign * (hce::VALUES_EG[kind] + hce::PST_EG[kind][table] as i32) + mobility) as i16];
            square += 1;
        }
        code += 1;
    }
    result
}
const BASE_PST: [[i16; 2]; 13 * 64] = base_pst();

const fn pawn_masks(shield: bool) -> [[u64; 64]; 2] {
    let mut result = [[0_u64; 64]; 2];
    let mut color = 0;
    while color < 2 {
        let mut square = 0;
        while square < 64 {
            let mut target = 0;
            while target < 64 {
                let rank_distance = (target / 8) as i32 - (square / 8) as i32;
                let file_distance = (target % 8) as i32 - (square % 8) as i32;
                let forward = if color == 0 { rank_distance } else { -rank_distance };
                if file_distance >= -1 && file_distance <= 1 &&
                    (if shield { forward == 1 } else { forward > 0 }) {
                    result[color][square] |= 1_u64 << target;
                }
                target += 1;
            }
            square += 1;
        }
        color += 1;
    }
    result
}
const PASSED_MASKS: [[u64; 64]; 2] = pawn_masks(false);
const SHIELD_MASKS: [[u64; 64]; 2] = pawn_masks(true);

#[derive(Clone, Copy)]
struct CacheEntry { board: [Piece; 64], kings: [u8; 2], score: i32, generation: u16 }
impl CacheEntry {
    const ZERO: Self = Self { board: [Piece::Empty; 64], kings: [0; 2], score: 0, generation: 0 };
}

/// Direct mapped, exact-key cache. Hash collisions only replace an entry.
/// Score reuse requires all64 board bytes AND king squares to compare equal.
/// No turn/castling/EP/clock dependence exists in this static evaluator; game
/// adjudication remains in pinned search before static evaluation. Clear on
/// each search/model/mode change. Generation wrap clears every entry.
pub struct EvalCache { entries: [CacheEntry; CACHE_SLOTS], generation: u16, hits: u64, misses: u64 }
impl EvalCache {
    pub const ZERO: Self = Self { entries: [CacheEntry::ZERO; CACHE_SLOTS], generation: 1, hits: 0, misses: 0 };
    pub fn clear(&mut self) {
        self.hits = 0; self.misses = 0;
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            for entry in &mut self.entries { entry.generation = 0; }
            self.generation = 1;
        }
    }
    pub fn evaluate(&mut self, model: &Model, position: &Position) -> i32 {
        let slot = cache_slot(&position.board);
        let entry = &mut self.entries[slot];
        if entry.generation == self.generation && entry.kings == position.king_sq && entry.board == position.board {
            self.hits += 1;
            return entry.score;
        }
        self.misses += 1;
        let score = model.evaluate(position, Variant::Fused);
        *entry = CacheEntry { board: position.board, kings: position.king_sq, score, generation: self.generation };
        score
    }
    pub fn stats(&self) -> (u64, u64) { (self.hits, self.misses) }
}

#[inline]
fn cache_slot(board: &[Piece; 64]) -> usize {
    let mut hash = 0x9e3779b97f4a7c15_u64;
    for chunk in board.chunks_exact(8) {
        let mut word = 0_u64;
        for (index, &piece) in chunk.iter().enumerate() { word |= (piece as u64) << (index * 8); }
        hash = (hash ^ word).rotate_left(13).wrapping_mul(0xbf58476d1ce4e5b9);
    }
    hash as usize & (CACHE_SLOTS - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(weights: &[i16; TOTAL]) -> std::vec::Vec<u8> {
        weights.iter().flat_map(|weight| weight.to_le_bytes()).collect()
    }

    #[test]
    fn narrow_load_rejects_instead_of_clipping_and_keeps_previous_model() {
        let mut model = Model::ZERO;
        let mut weights = [0_i16; TOTAL];
        weights[0] = 127;
        model.load_dense(&bytes(&weights)).unwrap();
        assert_eq!(model.fused[0][0], 127);
        weights[0] = 128;
        assert!(model.load_dense(&bytes(&weights)).is_err());
        assert_eq!(model.fused[0][0], 127);
        #[cfg(not(v2_wide_fused))]
        {
            weights[0] = 127; weights[384] = 1;
            assert!(model.load_dense(&bytes(&weights)).is_err());
            assert_eq!(model.fused[0][0], 127);
        }
        weights.fill(0); weights[8074] = 127; weights[8078] = -127;
        assert!(model.load_dense(&bytes(&weights)).is_err());
        assert_eq!(model.fused[0][0], 127);
    }

    #[test]
    fn cache_collision_requires_board_and_king_witness() {
        let model = Model::ZERO;
        let position = crate::engine::parse_fen(b"8/8/8/8/8/8/3k4/R3K3 w - - 0 1").unwrap();
        let expected = model.evaluate(&position, Variant::Fused);
        let mut cache = EvalCache::ZERO;
        let slot = cache_slot(&position.board);
        let mut other = position;
        other.board[0] = Piece::BlackQueen;
        cache.entries[slot] = CacheEntry { board: other.board, kings: position.king_sq,
            score: 1000000, generation: cache.generation };
        assert_eq!(cache.evaluate(&model, &position), expected);
        assert_eq!(cache.stats(), (0, 1));
        assert_eq!(cache.evaluate(&model, &position), expected);
        assert_eq!(cache.stats(), (1, 1));
        cache.entries[slot].kings = [0, 1];
        cache.entries[slot].score = 2000000;
        assert_eq!(cache.evaluate(&model, &position), expected);
        assert_eq!(cache.stats(), (1, 2));
    }

    #[test]
    fn cache_clear_and_generation_wrap_prevent_stale_model_reuse() {
        let mut model = Model::ZERO;
        let position = crate::engine::parse_fen(b"8/8/8/8/8/8/3k4/R3K3 w - - 0 1").unwrap();
        let mut cache = EvalCache::ZERO;
        let original = cache.evaluate(&model, &position);
        let mut weights = [0_i16; TOTAL];
        weights[BASE + 3 * 64] = 100;
        model.load_dense(&bytes(&weights)).unwrap();
        cache.clear();
        assert_eq!(cache.stats(), (0, 0));
        assert_ne!(cache.evaluate(&model, &position), original);
        let slot = cache_slot(&position.board);
        cache.entries[slot].generation = 1;
        cache.entries[slot].score = 3000000;
        cache.generation = u16::MAX;
        cache.clear();
        assert_eq!(cache.generation, 1);
        assert_eq!(cache.evaluate(&model, &position), model.evaluate(&position, Variant::Fused));
        assert_eq!(cache.stats(), (0, 1));
    }

    #[test]
    fn cache_ignores_only_static_eval_irrelevant_rule_fields() {
        let model = Model::ZERO;
        let mut position = crate::engine::parse_fen(b"8/8/8/8/8/8/3k4/R3K3 w - - 0 1").unwrap();
        let mut cache = EvalCache::ZERO;
        let expected = cache.evaluate(&model, &position);
        position.turn = crate::engine::Color::Black;
        position.castling = 15; position.ep = 20; position.halfmove = 100; position.fullmove = 200;
        assert_eq!(cache.evaluate(&model, &position), expected);
        assert_eq!(cache.stats(), (1, 1));
        // Search, rather than this pure static cache, handles terminal draws.
    }
}
