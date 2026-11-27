//! Independent historical-score and board-mask contracts. No timing gate.
#![allow(dead_code, static_mut_refs)]

#[path = "../../experiments/wasm/src/engine.rs"] mod engine;
#[path = "../../experiments/wasm/src/eval.rs"] mod baseline;
#[path = "../../tools/eval_pipeline/core.rs"] mod candidate;
#[path = "../../tools/eval_pipeline/simd.rs"] mod simd;
#[path = "../../tools/sparse_eval_v2/core.rs"] mod prior;
#[cfg(eval_pipeline_baked)] use candidate as pipeline_core;
#[cfg(eval_pipeline_baked)] mod baked { include!(env!("EVAL_PIPELINE_BAKED_MODEL")); }

use engine::{Piece, Position};

const WEIGHTS: &[u8] = include_bytes!("../../eval/sparse-pesto-v1/fit/full.i16le");
const SPARSE_WEIGHTS: &[u8] = include_bytes!("../../eval/sparse-pesto-v1/fit/full.spv");

fn selected_weights() -> Vec<u8> {
    let mut weights = WEIGHTS.to_vec();
    #[cfg(eval_pipeline_no_pawn)]
    let removed = Some((6528, 8064));
    #[cfg(eval_pipeline_no_ray)]
    let removed = Some((8064, candidate::BASE));
    #[cfg(not(any(eval_pipeline_no_pawn, eval_pipeline_no_ray)))]
    let removed: Option<(usize, usize)> = None;
    if let Some((start, stop)) = removed {
        for offset in [0, candidate::BASE] {
            weights[(offset + start) * 2..(offset + stop) * 2].fill(0);
        }
    }
    weights
}

fn selected_sparse_weights() -> Vec<u8> {
    if !cfg!(any(eval_pipeline_no_pawn, eval_pipeline_no_ray)) { return SPARSE_WEIGHTS.to_vec(); }
    let mut records = Vec::new();
    for (index, pair) in selected_weights().chunks_exact(2).enumerate() {
        if pair != [0, 0] {
            records.extend_from_slice(&(index as u16).to_le_bytes());
            records.extend_from_slice(pair);
        }
    }
    let mut encoded = b"SPV1".to_vec();
    encoded.extend_from_slice(&((records.len() / 4) as u32).to_le_bytes());
    encoded.extend_from_slice(&records);
    encoded
}
const PIECES: [Piece; 13] = [Piece::Empty, Piece::WhitePawn, Piece::WhiteKnight,
    Piece::WhiteBishop, Piece::WhiteRook, Piece::WhiteQueen, Piece::WhiteKing,
    Piece::BlackPawn, Piece::BlackKnight, Piece::BlackBishop, Piece::BlackRook,
    Piece::BlackQueen, Piece::BlackKing];

fn oracle_masks(board: &[Piece; 64]) -> simd::Geometry {
    let mut result = simd::Geometry { occupied: 0, colors: [0; 2], pawns: [0; 2] };
    // Deliberately use coordinate iteration and enum matching, independently of
    // the candidate's piece-code comparisons and internal-mask byte swapping.
    for rank in 0..8 {
        for file in 0..8 {
            let piece = board[(7 - rank) * 8 + file];
            let bit = 1_u64 << (rank * 8 + file);
            let color = match piece {
                Piece::Empty => continue,
                Piece::WhitePawn | Piece::WhiteKnight | Piece::WhiteBishop |
                Piece::WhiteRook | Piece::WhiteQueen | Piece::WhiteKing => 0,
                _ => 1,
            };
            result.occupied |= bit;
            result.colors[color] |= bit;
            if matches!(piece, Piece::WhitePawn | Piece::BlackPawn) {
                result.pawns[color] |= bit;
            }
        }
    }
    result
}

fn random(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

#[test]
fn combined_masks_match_independent_enum_oracle() {
    #[cfg(all(eval_pipeline_simd, target_arch = "x86_64"))]
    assert!(simd::HAS_EXPLICIT_SIMD, "the SIMD test must exercise explicit SSE2");
    #[cfg(not(eval_pipeline_simd))]
    assert!(!simd::HAS_EXPLICIT_SIMD);
    for piece in PIECES {
        for square in 0..64 {
            let mut board = [Piece::Empty; 64];
            board[square] = piece;
            assert_eq!(simd::geometry(&board), oracle_masks(&board));
            assert_eq!(simd::geometry_scalar(&board), oracle_masks(&board));
        }
        assert_eq!(simd::geometry(&[piece; 64]), oracle_masks(&[piece; 64]));
    }
    let mut seed = 0x0625_1772_9384_1567_u64;
    for _ in 0..4096 {
        let mut board = [Piece::Empty; 64];
        for piece in &mut board { *piece = PIECES[(random(&mut seed) % 13) as usize]; }
        assert_eq!(simd::geometry(&board), oracle_masks(&board));
        assert_eq!(simd::geometry_scalar(&board), oracle_masks(&board));
    }
}

fn models() -> (candidate::Model, prior::Model) {
    let mut current = candidate::Model::ZERO;
    let mut historical = prior::Model::ZERO;
    current.load_dense(&selected_weights()).unwrap();
    historical.load_dense(&selected_weights()).unwrap();
    (current, historical)
}

fn check(position: &Position, current: &candidate::Model, historical: &prior::Model) {
    let hce = baseline::evaluate(position);
    let independent_full = hce + historical.correction(position);
    assert_eq!(candidate::evaluate_hce(position), hce, "specialized HCE");
    assert_eq!(current.evaluate(position), independent_full, "original HCE + original residual");
    assert_eq!(current.parts(position), historical.fused_parts(position), "separate rounding");
    assert_eq!(candidate::Model::ZERO.evaluate(position), hce, "zero-model identity");
    #[cfg(eval_pipeline_baked)]
    assert_eq!(baked::MODEL.evaluate(position), independent_full, "immutable generated tables");
}

#[test]
fn exact_scores_through_legal_paths_and_unmake() {
    let (current, historical) = models();
    let roots = [
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
        "8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1",
    ];
    let mut seed = 0x6120_7264_5338_4729;
    let mut examined = 0;
    for fen in roots {
        for _ in 0..12 {
            let mut position = engine::parse_fen(fen.as_bytes()).unwrap();
            for _ in 0..160 {
                check(&position, &current, &historical);
                examined += 1;
                let before = position;
                let mut moves = [0; engine::MAX_MOVES];
                let count = engine::generate_legal(&mut position, &mut moves);
                assert!(position == before, "legality must restore board");
                if count == 0 { break; }
                let mv = moves[(random(&mut seed) % count as u64) as usize];
                let undo = engine::make_move(&mut position, mv);
                check(&position, &current, &historical);
                engine::unmake_move(&mut position, mv, undo);
                assert!(position == before, "unmake must restore board");
                check(&position, &current, &historical);
                engine::make_move(&mut position, mv);
            }
        }
    }
    assert!(examined > 4000, "retain substantial deterministic path coverage");
}

#[test]
fn special_moves_promoted_phase_and_king_buckets_preserve_scores() {
    let (current, historical) = models();
    let roots = [
        "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
        "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1",
        "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
        "4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1",
        "1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1",
        "4k3/8/8/8/8/8/p7/1R2K3 b - - 0 1",
        "r3k2r/ppp1pppp/8/8/8/QQQ5/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "8/8/8/3k4/8/8/8/R3K3 w - - 0 1",
        "8/8/8/3K4/8/8/8/r3k3 b - - 0 1",
        "4k3/8/8/8/8/8/8/4K3 w - - 99 1",
    ];
    let mut castle = 0;
    let mut ep = 0;
    let mut promotions = [[0_u32; 4]; 2];
    for fen in roots {
        let mut position = engine::parse_fen(fen.as_bytes()).unwrap();
        check(&position, &current, &historical);
        let initial = position;
        let color = usize::from(position.turn == engine::Color::Black);
        let mut moves = [0; engine::MAX_MOVES];
        let count = engine::generate_legal(&mut position, &mut moves);
        for &mv in &moves[..count] {
            castle += usize::from(engine::move_castle(mv).is_some());
            ep += usize::from(engine::move_is_en_passant(mv));
            if let Some(kind) = engine::move_promotion(mv) {
                promotions[color][kind as usize - 1] += 1;
            }
            let undo = engine::make_move(&mut position, mv);
            check(&position, &current, &historical);
            engine::unmake_move(&mut position, mv, undo);
            assert!(position == initial);
        }
    }
    assert_eq!(castle, 4, "both castling sides and colors");
    assert_eq!(ep, 2, "both en-passant colors");
    assert_eq!(promotions, [[2; 4]; 2], "Q/R/B/N quiet and capture promotions, both colors");
}

#[test]
fn strict_export_and_failed_load_preserve_exact_model() {
    assert_eq!(core::mem::size_of::<candidate::Model>(), candidate::COEFFICIENT_BYTES);
    let (mut current, historical) = models();
    let position = engine::parse_fen(b"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1").unwrap();
    let expected = current.evaluate(&position);
    current.load_dense(&selected_sparse_weights()).unwrap();
    assert_eq!(current.evaluate(&position), expected);
    let mut bad = selected_weights();
    bad[0..2].copy_from_slice(&128_i16.to_le_bytes());
    assert!(current.load_dense(&bad).is_err());
    assert_eq!(current.evaluate(&position), expected);
    let mut bad = vec![0; candidate::TOTAL * 2];
    bad[0..2].copy_from_slice(&127_i16.to_le_bytes());
    bad[768..770].copy_from_slice(&1_i16.to_le_bytes());
    assert!(current.load_dense(&bad).is_err(), "reject out-of-range fused sum");
    assert_eq!(current.evaluate(&position), expected);
    assert!(current.load_dense(b"SPV1\x01\x00\x00\x00\x00\x00\x00\x00").is_err());
    assert!(current.load_dense(&WEIGHTS[..WEIGHTS.len()-1]).is_err());
    #[cfg(any(eval_pipeline_no_pawn, eval_pipeline_no_ray))]
    {
        assert!(current.load_dense(WEIGHTS).is_err(), "a dropped family must not silently discard full-model weights");
        assert_eq!(current.evaluate(&position), expected);
        #[cfg(eval_pipeline_no_pawn)]
        assert_eq!(candidate::COEFFICIENT_BYTES, 13_640);
        #[cfg(eval_pipeline_no_ray)]
        assert_eq!(candidate::COEFFICIENT_BYTES, 15_360);
    }
    check(&position, &current, &historical);
}
