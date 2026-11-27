//! One-pass exact board masks for the production integration experiment.
//!
//! Extends the occupancy-only kernel from sparse_eval_v2/simd.rs at commit
//! 5d61f07739de1f89bf3c20b78f0d6650dc5661a9. Piece is repr(u8), Empty=0,
//! White=1..=6, Black=7..=12. Every returned mask uses a1 as bit zero.
//! This is integer SIMD only; no relaxed SIMD or numerical approximation.

use crate::engine::Piece;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub occupied: u64,
    pub colors: [u64; 2],
    pub pawns: [u64; 2],
}

pub const HAS_EXPLICIT_SIMD: bool = cfg!(all(eval_pipeline_simd, any(
    all(target_arch = "wasm32", target_feature = "simd128"),
    target_arch = "x86_64",
)));

#[inline]
pub fn geometry(board: &[Piece; 64]) -> Geometry {
    #[cfg(all(eval_pipeline_simd, target_arch = "wasm32", target_feature = "simd128"))]
    unsafe {
        use core::arch::wasm32::{i8x16_bitmask, i8x16_eq, i8x16_gt, i8x16_splat, v128_load};
        let zero = i8x16_splat(0);
        let white_pawn = i8x16_splat(1);
        let white_king = i8x16_splat(6);
        let black_pawn = i8x16_splat(7);
        let mut masks = [0_u64; 4]; // occupied, black, white pawns, black pawns
        for block in 0..4 {
            let value = v128_load(board.as_ptr().cast::<u8>().add(block * 16).cast());
            let occupied = !i8x16_bitmask(i8x16_eq(value, zero)) as u16;
            let black = i8x16_bitmask(i8x16_gt(value, white_king)) as u16;
            let wp = i8x16_bitmask(i8x16_eq(value, white_pawn)) as u16;
            let bp = i8x16_bitmask(i8x16_eq(value, black_pawn)) as u16;
            let shift = block * 16;
            masks[0] |= (occupied as u64) << shift;
            masks[1] |= (black as u64) << shift;
            masks[2] |= (wp as u64) << shift;
            masks[3] |= (bp as u64) << shift;
        }
        return from_internal(masks);
    }
    #[cfg(all(eval_pipeline_simd, target_arch = "x86_64"))]
    unsafe {
        use core::arch::x86_64::{__m128i, _mm_cmpeq_epi8, _mm_cmpgt_epi8,
            _mm_loadu_si128, _mm_movemask_epi8, _mm_set1_epi8, _mm_setzero_si128};
        let zero = _mm_setzero_si128();
        let white_pawn = _mm_set1_epi8(1);
        let white_king = _mm_set1_epi8(6);
        let black_pawn = _mm_set1_epi8(7);
        let mut masks = [0_u64; 4];
        for block in 0..4 {
            let value = _mm_loadu_si128(board.as_ptr().cast::<u8>().add(block * 16).cast::<__m128i>());
            let occupied = !_mm_movemask_epi8(_mm_cmpeq_epi8(value, zero)) as u16;
            let black = _mm_movemask_epi8(_mm_cmpgt_epi8(value, white_king)) as u16;
            let wp = _mm_movemask_epi8(_mm_cmpeq_epi8(value, white_pawn)) as u16;
            let bp = _mm_movemask_epi8(_mm_cmpeq_epi8(value, black_pawn)) as u16;
            let shift = block * 16;
            masks[0] |= (occupied as u64) << shift;
            masks[1] |= (black as u64) << shift;
            masks[2] |= (wp as u64) << shift;
            masks[3] |= (bp as u64) << shift;
        }
        return from_internal(masks);
    }
    #[allow(unreachable_code)]
    geometry_scalar(board)
}

#[inline]
fn from_internal(masks: [u64; 4]) -> Geometry {
    let occupied = masks[0].swap_bytes();
    let black = masks[1].swap_bytes();
    Geometry { occupied, colors: [occupied & !black, black],
        pawns: [masks[2].swap_bytes(), masks[3].swap_bytes()] }
}

/// Independent scalar implementation, also the portable fallback.
#[inline]
pub fn geometry_scalar(board: &[Piece; 64]) -> Geometry {
    let mut result = Geometry { occupied: 0, colors: [0; 2], pawns: [0; 2] };
    for (internal, &piece) in board.iter().enumerate() {
        if piece == Piece::Empty { continue; }
        let bit = 1_u64 << (internal ^ 56);
        let code = piece as usize;
        let color = usize::from(code >= 7);
        result.occupied |= bit;
        result.colors[color] |= bit;
        if code == 1 || code == 7 { result.pawns[color] |= bit; }
    }
    result
}
