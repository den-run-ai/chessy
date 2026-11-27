#[cfg(test)]
mod pawn_rank_tests {
    use super::*;
    mod reference {
/* RETAINED_BASELINE_EVALUATOR */
    }

    fn equal(position: &Position) {
        assert_eq!(evaluate(position), reference::evaluate(position));
    }

    #[test]
    fn pawn_ranks_exhaustive_single_pawn_pairs() {
        let mut checked = 0;
        for white in 0..64 {
            for black in 0..64 {
                if white == black || white == 4 || white == 60 || black == 4 || black == 60 {
                    continue;
                }
                let mut position = Position::EMPTY;
                position.board[4] = Piece::BlackKing;
                position.board[60] = Piece::WhiteKing;
                position.board[white] = Piece::WhitePawn;
                position.board[black] = Piece::BlackPawn;
                equal(&position);
                checked += 1;
            }
        }
        assert_eq!(checked, 3782);
        println!("pawn-ranks: {} exhaustive pawn pairs", checked);
    }

    #[test]
    fn pawn_ranks_seeded_legal_walks_and_dense_pawns() {
        let mut seed = 0x715262dd_u32;
        let mut checked = 0;
        for _ in 0..64 {
            let mut position = engine::parse_fen(b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
            for _ in 0..80 {
                equal(&position);
                checked += 1;
                let mut moves = [0_u32; engine::MAX_MOVES];
                let count = engine::generate_legal(&mut position, &mut moves);
                if count == 0 || position.halfmove >= 100 || engine::position_insufficient_material(&position) {
                    break;
                }
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                engine::make_move(&mut position, moves[seed as usize % count]);
            }
        }
        assert!(checked >= 4000, "seeded legal-walk coverage shrank");
        println!("pawn-ranks: {} legal-walk positions", checked);

        // Synthetic dense arrangements exercise doubled/tripled files and
        // combined blocker masks beyond ordinary starting pawn structures.
        for _ in 0..1024 {
            let mut position = Position::EMPTY;
            for square in 0..64 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                position.board[square] = match seed >> 29 {
                    0 | 1 => Piece::WhitePawn,
                    2 | 3 => Piece::BlackPawn,
                    _ => Piece::Empty,
                };
            }
            equal(&position);
        }
    }

    #[test]
    fn pawn_ranks_special_move_edges_restore_identically() {
        let cases: &[&[u8]] = &[
            b"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
            b"4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
            b"4k3/8/8/r4pPK/8/8/8/8 w - f6 0 1",
            b"8/5P1k/8/5K2/8/8/8/8 w - - 0 1",
            b"4k3/2P5/8/8/8/8/5p2/4K3 w - - 0 1",
            b"4k3/2P5/8/8/8/8/5p2/4K3 b - - 0 1",
        ];
        let mut checked = 0;
        for fen in cases {
            let mut position = engine::parse_fen(fen).unwrap();
            let before = position;
            equal(&position);
            let mut moves = [0_u32; engine::MAX_MOVES];
            let count = engine::generate_legal(&mut position, &mut moves);
            for &mv in &moves[..count] {
                let undo = engine::make_move(&mut position, mv);
                equal(&position);
                engine::unmake_move(&mut position, mv, undo);
                assert!(position == before);
                equal(&position);
                checked += 1;
            }
        }
        assert!(checked >= 80);
        println!("pawn-ranks: {} special-move edges", checked);
    }
}
