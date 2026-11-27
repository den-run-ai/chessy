//! Exact specialized evaluation for the current-production integration pipeline.
//!
//! Derived from tools/sparse_eval_v2/core.rs at PR #200 commit
//! 5d61f07739de1f89bf3c20b78f0d6650dc5661a9. Historical sources stay unchanged.
//! The HCE-only and full-model paths are separate compile-time instantiations.
//! No evaluator dispatch, optional whole-board cache, allocation, or packed-i4
//! reconstruction is needed at inference. Both historical rounding steps remain.
//! A separately fitted no-pawn/no-ray model may remove exactly that learned
//! family at compile time. HCE pawn terms and sliding geometry remain intact.

#[cfg(all(eval_pipeline_no_pawn, eval_pipeline_no_ray))]
compile_error!("the registered refits remove exactly one family");

use crate::engine::Position;
use crate::simd::Geometry;
#[path = "hce_constants.rs"]
mod hce;

pub const BASE: usize = 8640;
pub const TOTAL: usize = 17280;
pub const COEFFICIENT_BYTES: usize = 12_288
    + if cfg!(eval_pipeline_no_pawn) { 0 } else { 3_072 }
    + if cfg!(eval_pipeline_no_ray) { 0 } else { 1_352 };

pub struct Model {
    fused: [[i8; 2]; 3072],
    enemy: [[i8; 2]; 3072],
    #[cfg(not(eval_pipeline_no_pawn))]
    pawn: [[i8; 2]; 1536],
    #[cfg(not(eval_pipeline_no_ray))]
    pairs: [[i8; 2]; 676],
}

const _: [(); COEFFICIENT_BYTES] = [(); core::mem::size_of::<Model>()];

impl Model {
    pub const ZERO: Self = Self {
        fused: [[0; 2]; 3072], enemy: [[0; 2]; 3072],
        #[cfg(not(eval_pipeline_no_pawn))]
        pawn: [[0; 2]; 1536],
        #[cfg(not(eval_pipeline_no_ray))]
        pairs: [[0; 2]; 676],
    };

    /// Construct immutable tables generated from authenticated model weights.
    /// The typed arrays forbid out-of-range coefficients. The preparation tool
    /// independently compares this representation with strict load_dense.
    pub const fn from_tables(fused: [[i8; 2]; 3072], enemy: [[i8; 2]; 3072],
                             pawn: [[i8; 2]; 1536], pairs: [[i8; 2]; 676]) -> Self {
        // Reject a mismatched model in const evaluation rather than silently
        // ignoring trained coefficients when selecting a specialized build.
        #[cfg(eval_pipeline_no_pawn)]
        {
            let mut index = 0;
            while index < pawn.len() {
                assert!(pawn[index][0] == 0 && pawn[index][1] == 0, "removed pawn table must be zero");
                index += 1;
            }
        }
        #[cfg(eval_pipeline_no_ray)]
        {
            let mut index = 0;
            while index < pairs.len() {
                assert!(pairs[index][0] == 0 && pairs[index][1] == 0, "removed ray table must be zero");
                index += 1;
            }
        }
        Self { fused, enemy,
            #[cfg(not(eval_pipeline_no_pawn))]
            pawn,
            #[cfg(not(eval_pipeline_no_ray))]
            pairs,
        }
    }

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
        #[cfg(eval_pipeline_no_pawn)]
        if weights[6528..8064].iter().chain(&weights[BASE + 6528..BASE + 8064]).any(|&value| value != 0) {
            return Err("no-pawn specialization requires zero pawn-context coefficients");
        }
        #[cfg(eval_pipeline_no_ray)]
        if weights[8064..BASE].iter().chain(&weights[BASE + 8064..TOTAL]).any(|&value| value != 0) {
            return Err("no-ray specialization requires zero ray coefficients");
        }
        let mut next = Self::ZERO;
        for index in 0..3072 {
            for stage in 0..2 {
                let offset = stage * BASE;
                let fused = weights[offset + index % 384] + weights[offset + 384 + index];
                if !(-128..=127).contains(&fused) { return Err("fused PST/own-king sum does not fit lossless i8"); }
                next.fused[index][stage] = fused as i8;
                next.enemy[index][stage] = weights[offset + 3456 + index] as i8;
            }
        }
        #[cfg(not(eval_pipeline_no_pawn))]
        for index in 0..1536 {
            next.pawn[index] = [weights[6528 + index] as i8, weights[BASE + 6528 + index] as i8];
        }
        #[cfg(not(eval_pipeline_no_ray))]
        {
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
                }
            }
        }
        }
        *self = next;
        Ok(())
    }

    #[inline]
    pub fn evaluate(&self, position: &Position) -> i32 {
        let (baseline, residual) = evaluate_parts::<true>(position, Some(self));
        baseline + residual
    }

    /// Expose the two separately rounded terms to parity diagnostics.
    #[inline]
    pub fn parts(&self, position: &Position) -> (i32, i32) {
        evaluate_parts::<true>(position, Some(self))
    }

    #[inline(always)]
    fn add_piece(&self, offsets: &Offsets, _attacks: &[u64; 2], square: usize,
                 code: usize, residual: &mut [i32; 2]) {
        let color = usize::from(code >= 7);
        let kind = (code - 1) % 6;
        let sign = if color == 0 { 1 } else { -1 };
        let ps = kind * 64 + (square ^ (color * 56));
        let own = self.fused[offsets.own[color] + ps];
        let enemy = self.enemy[offsets.enemy[color] + ps];
        #[cfg(not(eval_pipeline_no_pawn))]
        let pawn = {
            let state = (((_attacks[color] >> square) & 1)
                | (((_attacks[1 - color] >> square) & 1) << 1)) as usize;
            self.pawn[state * 384 + ps]
        };
        #[cfg(eval_pipeline_no_pawn)]
        let pawn = [0_i8; 2];
        residual[0] += sign * (own[0] as i32 + enemy[0] as i32 + pawn[0] as i32);
        residual[1] += sign * (own[1] as i32 + enemy[1] as i32 + pawn[1] as i32);
    }
}

/// Existing HCE score with shared geometry; compile out every learned term.
#[inline]
pub fn evaluate_hce(position: &Position) -> i32 {
    evaluate_parts::<false>(position, None).0
}

/// HCE and residual share board analysis and nearest occupied geometry.
/// Sliding mobility starts with unobstructed edge distance and subtracts
/// each blocker's occluded tail. Both directed tails are handled once per
/// adjacent occupied pair, independently of residual ray coefficients.
#[inline(always)]
fn evaluate_parts<const WITH_RESIDUAL: bool>(position: &Position, model: Option<&Model>) -> (i32, i32) {
    let geometry = crate::simd::geometry(&position.board);
    let offsets = if WITH_RESIDUAL { Offsets::new(position) } else { Offsets::ZERO };
    #[cfg(not(eval_pipeline_no_pawn))]
    let pawn_attacks = if WITH_RESIDUAL { attacks(geometry.pawns) } else { [0; 2] };
    #[cfg(eval_pipeline_no_pawn)]
    let pawn_attacks = [0; 2];
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
        if WITH_RESIDUAL {
            model.expect("residual model").add_piece(&offsets, &pawn_attacks, square, code, &mut residual);
        }
        let predecessors = lines.previous(square, code);
        for (axis, previous) in predecessors.into_iter().enumerate() {
            let previous_code = previous as usize & 15;
            if previous_code == 0 { continue; }
            let previous_square = previous as usize >> 4;
            let same = i32::from((previous_code >= 7) == (code >= 7));
            mobility_adjustment -= SLOPE[previous_code][axis] as i32 * (POSITIVE_EDGE[square][axis] as i32 + same)
                + SLOPE[code][axis] as i32 * (NEGATIVE_EDGE[previous_square][axis] as i32 + same);
            #[cfg(not(eval_pipeline_no_ray))]
            if WITH_RESIDUAL {
                let value = model.expect("residual model").pairs[(previous_code * 13 + code) * 4 + axis];
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
    (baseline, if WITH_RESIDUAL { round_residual(residual, phase) } else { 0 })
}

struct Offsets { own: [usize; 2], enemy: [usize; 2] }
impl Offsets {
    const ZERO: Self = Self { own: [0; 2], enemy: [0; 2] };
    #[inline]
    fn new(position: &Position) -> Self {
        let white = position.king_sq[0] as usize ^ 56;
        let black = position.king_sq[1] as usize ^ 56;
        Self { own: [bucket(white) * 384, bucket(black ^ 56) * 384],
            enemy: [bucket(black) * 384, bucket(white ^ 56) * 384] }
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
#[cfg(not(eval_pipeline_no_pawn))]
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
