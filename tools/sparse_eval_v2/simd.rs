//! Exact occupancy extraction; no gather, relaxed SIMD, or precision changes.
//! Piece is repr(u8), Empty=0. Bit 0 of the result is a1 in both paths.

pub const HAS_EXPLICIT_SIMD: bool = cfg!(any(
    all(target_arch = "wasm32", target_feature = "simd128"),
    target_arch = "x86_64",
));

#[inline]
pub fn occupied_a1_mask(board: &[crate::engine::Piece; 64]) -> u64 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    unsafe {
        use core::arch::wasm32::{i8x16_bitmask, i8x16_eq, i8x16_splat, v128_load};
        let zero = i8x16_splat(0);
        let mut internal = 0_u64;
        for block in 0..4 {
            let value = v128_load(board.as_ptr().cast::<u8>().add(block * 16).cast());
            let empty = i8x16_bitmask(i8x16_eq(value, zero));
            internal |= ((!empty as u16) as u64) << (block * 16);
        }
        return internal.swap_bytes();
    }
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::{__m128i, _mm_cmpeq_epi8, _mm_loadu_si128,
                                 _mm_movemask_epi8, _mm_setzero_si128};
        let zero = _mm_setzero_si128();
        let mut internal = 0_u64;
        for block in 0..4 {
            let value = _mm_loadu_si128(board.as_ptr().cast::<u8>().add(block * 16).cast::<__m128i>());
            let empty = _mm_movemask_epi8(_mm_cmpeq_epi8(value, zero));
            internal |= ((!empty as u16) as u64) << (block * 16);
        }
        return internal.swap_bytes();
    }
    #[allow(unreachable_code)]
    {
        let mut occupied = 0_u64;
        for (internal, piece) in board.iter().enumerate() {
            if *piece != crate::engine::Piece::Empty { occupied |= 1_u64 << (internal ^ 56); }
        }
        occupied
    }
}
