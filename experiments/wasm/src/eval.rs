//! Exact scalar port of the shipped JavaScript evaluation.

use crate::engine::{self, Color, Piece, PieceType, Position};

const PHASE_MAX: i32 = 24;
const DOUBLED: i32 = 12;
const ISOLATED: i32 = 12;
const SHIELD: i32 = 8;

const VALUES_MG: [i32; 6] = [82, 337, 365, 477, 1025, 0];
const VALUES_EG: [i32; 6] = [94, 281, 297, 512, 936, 0];
const PHASE: [i32; 6] = [0, 1, 1, 2, 4, 0];
const MOBILITY: [i32; 6] = [0, 3, 3, 2, 1, 0];
const PASSED_MG: [i32; 7] = [0, 5, 10, 20, 35, 60, 80];
const PASSED_EG: [i32; 7] = [0, 15, 30, 50, 80, 130, 180];

const PST_MG: [[i16; 64]; 6] = [
    [
        0, 0, 0, 0, 0, 0, 0, 0, 98, 134, 61, 95, 68, 126, 34, -11, -6, 7, 26, 31, 65, 56, 25, -20,
        -14, 13, 6, 21, 23, 12, 17, -23, -27, -2, -5, 12, 17, 6, 10, -25, -26, -4, -4, -10, 3, 3,
        33, -12, -35, -1, -20, -23, -15, 24, 38, -22, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    [
        -167, -89, -34, -49, 61, -97, -15, -107, -73, -41, 72, 36, 23, 62, 7, -17, -47, 60, 37, 65,
        84, 129, 73, 44, -9, 17, 19, 53, 37, 69, 18, 22, -13, 4, 16, 13, 28, 19, 21, -8, -23, -9,
        12, 10, 19, 17, 25, -16, -29, -53, -12, -3, -1, 18, -14, -19, -105, -21, -58, -33, -17,
        -28, -19, -23,
    ],
    [
        -29, 4, -82, -37, -25, -42, 7, -8, -26, 16, -18, -13, 30, 59, 18, -47, -16, 37, 43, 40, 35,
        50, 37, -2, -4, 5, 19, 50, 37, 37, 7, -2, -6, 13, 13, 26, 34, 12, 10, 4, 0, 15, 15, 15, 14,
        27, 18, 10, 4, 15, 16, 0, 7, 21, 33, 1, -33, -3, -14, -21, -13, -12, -39, -21,
    ],
    [
        32, 42, 32, 51, 63, 9, 31, 43, 27, 32, 58, 62, 80, 67, 26, 44, -5, 19, 26, 36, 17, 45, 61,
        16, -24, -11, 7, 26, 24, 35, -8, -20, -36, -26, -12, -1, 9, -7, 6, -23, -45, -25, -16, -17,
        3, 0, -5, -33, -44, -16, -20, -9, -1, 11, -6, -71, -19, -13, 1, 17, 16, 7, -37, -26,
    ],
    [
        -28, 0, 29, 12, 59, 44, 43, 45, -24, -39, -5, 1, -16, 57, 28, 54, -13, -17, 7, 8, 29, 56,
        47, 57, -27, -27, -16, -16, -1, 17, -2, 1, -9, -26, -9, -10, -2, -4, 3, -3, -14, 2, -11,
        -2, -5, 2, 14, 5, -35, -8, 11, 2, 8, 15, -3, 1, -1, -18, -9, 10, -15, -25, -31, -50,
    ],
    [
        -65, 23, 16, -15, -56, -34, 2, 13, 29, -1, -20, -7, -8, -4, -38, -29, -9, 24, 2, -16, -20,
        6, 22, -22, -17, -20, -12, -27, -30, -25, -14, -36, -49, -1, -27, -39, -46, -44, -33, -51,
        -14, -14, -22, -46, -44, -30, -15, -27, 1, 7, -8, -64, -43, -16, 9, 8, -15, 36, 12, -54, 8,
        -28, 24, 14,
    ],
];

const PST_EG: [[i16; 64]; 6] = [
    [
        0, 0, 0, 0, 0, 0, 0, 0, 178, 173, 158, 134, 147, 132, 165, 187, 94, 100, 85, 67, 56, 53,
        82, 84, 32, 24, 13, 5, -2, 4, 17, 17, 13, 9, -3, -7, -7, -8, 3, -1, 4, 7, -6, 1, 0, -5, -1,
        -8, 13, 8, 8, 10, 13, 0, 2, -7, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    [
        -58, -38, -13, -28, -31, -27, -63, -99, -25, -8, -25, -2, -9, -25, -24, -52, -24, -20, 10,
        9, -1, -9, -19, -41, -17, 3, 22, 22, 22, 11, 8, -18, -18, -6, 16, 25, 16, 17, 4, -18, -23,
        -3, -1, 15, 10, -3, -20, -22, -42, -20, -10, -5, -2, -20, -23, -44, -29, -51, -23, -15,
        -22, -18, -50, -64,
    ],
    [
        -14, -21, -11, -8, -7, -9, -17, -24, -8, -4, 7, -12, -3, -13, -4, -14, 2, -8, 0, -1, -2, 6,
        0, 4, -3, 9, 12, 9, 14, 10, 3, 2, -6, 3, 13, 19, 7, 10, -3, -9, -12, -3, 8, 10, 13, 3, -7,
        -15, -14, -18, -7, -1, 4, -9, -15, -27, -23, -9, -23, -5, -9, -16, -5, -17,
    ],
    [
        13, 10, 18, 15, 12, 12, 8, 5, 11, 13, 13, 11, -3, 3, 8, 3, 7, 7, 7, 5, 4, -3, -5, -3, 4, 3,
        13, 1, 2, 1, -1, 2, 3, 5, 8, 4, -5, -6, -8, -11, -4, 0, -5, -1, -7, -12, -8, -16, -6, -6,
        0, 2, -9, -9, -11, -3, -9, 2, 3, -1, -5, -13, 4, -20,
    ],
    [
        -9, 22, 22, 27, 27, 19, 10, 20, -17, 20, 32, 41, 58, 25, 30, 0, -20, 6, 9, 49, 47, 35, 19,
        9, 3, 22, 24, 45, 57, 40, 57, 36, -18, 28, 19, 47, 31, 34, 39, 23, -16, -27, 15, 6, 9, 17,
        10, 5, -22, -23, -30, -16, -16, -23, -36, -32, -33, -28, -22, -43, -5, -32, -20, -41,
    ],
    [
        -74, -35, -18, -18, -11, 15, 4, -17, -12, 17, 14, 17, 17, 38, 23, 11, 10, 17, 23, 15, 20,
        45, 44, 13, -8, 22, 24, 27, 26, 33, 26, 3, -18, -4, 21, 24, 27, 23, 9, -11, -19, -3, 11,
        21, 23, 16, 7, -9, -27, -11, 4, 13, 14, 4, -5, -17, -53, -34, -21, -11, -28, -14, -24, -43,
    ],
];

#[derive(Clone, Copy)]
struct Direction {
    rank: i8,
    file: i8,
}

const DIAGONALS: [Direction; 4] = [
    Direction { rank: -1, file: -1 },
    Direction { rank: -1, file: 1 },
    Direction { rank: 1, file: -1 },
    Direction { rank: 1, file: 1 },
];
const ORTHOGONALS: [Direction; 4] = [
    Direction { rank: -1, file: 0 },
    Direction { rank: 1, file: 0 },
    Direction { rank: 0, file: -1 },
    Direction { rank: 0, file: 1 },
];
const ALL_DIRECTIONS: [Direction; 8] = [
    Direction { rank: -1, file: -1 },
    Direction { rank: -1, file: 1 },
    Direction { rank: 1, file: -1 },
    Direction { rank: 1, file: 1 },
    Direction { rank: -1, file: 0 },
    Direction { rank: 1, file: 0 },
    Direction { rank: 0, file: -1 },
    Direction { rank: 0, file: 1 },
];
const KNIGHT_JUMPS: [Direction; 8] = [
    Direction { rank: -2, file: -1 },
    Direction { rank: -2, file: 1 },
    Direction { rank: -1, file: -2 },
    Direction { rank: -1, file: 2 },
    Direction { rank: 1, file: -2 },
    Direction { rank: 1, file: 2 },
    Direction { rank: 2, file: -1 },
    Direction { rank: 2, file: 1 },
];

#[inline]
fn sliding_mobility(
    board: &[Piece; 64],
    square: usize,
    color: Color,
    directions: &[Direction],
) -> i32 {
    let rank = (square / 8) as i32;
    let file = (square % 8) as i32;
    let mut count = 0;
    for direction in directions {
        let rank_step = direction.rank as i32;
        let file_step = direction.file as i32;
        let mut next_rank = rank + rank_step;
        let mut next_file = file + file_step;
        while next_rank >= 0 && next_rank < 8 && next_file >= 0 && next_file < 8 {
            let occupant = board[(next_rank * 8 + next_file) as usize];
            if occupant != Piece::Empty {
                if engine::piece_color(occupant).unwrap() != color {
                    count += 1;
                }
                break;
            }
            count += 1;
            next_rank += rank_step;
            next_file += file_step;
        }
    }
    count
}

#[inline]
fn mobility(board: &[Piece; 64], square: usize, piece_type: PieceType, color: Color) -> i32 {
    if piece_type == PieceType::Knight {
        let rank = (square / 8) as i32;
        let file = (square % 8) as i32;
        let mut count = 0;
        for jump in KNIGHT_JUMPS {
            let next_rank = rank + jump.rank as i32;
            let next_file = file + jump.file as i32;
            if next_rank < 0 || next_rank >= 8 || next_file < 0 || next_file >= 8 {
                continue;
            }
            let occupant = board[(next_rank * 8 + next_file) as usize];
            if occupant == Piece::Empty || engine::piece_color(occupant).unwrap() != color {
                count += 1;
            }
        }
        return count;
    }
    match piece_type {
        PieceType::Bishop => sliding_mobility(board, square, color, &DIAGONALS),
        PieceType::Rook => sliding_mobility(board, square, color, &ORTHOGONALS),
        PieceType::Queen => sliding_mobility(board, square, color, &ALL_DIRECTIONS),
        _ => 0,
    }
}

#[inline]
fn clamp_passed_rank(rank: i32) -> usize {
    rank.clamp(0, 6) as usize
}

#[inline]
fn abs_diff(a: i32, b: i32) -> i32 {
    if a >= b {
        a - b
    } else {
        b - a
    }
}

fn mop_up(loser: i8, winner: i8) -> i32 {
    let loser_square = loser as i32;
    let winner_square = winner as i32;
    let loser_rank = loser_square / 8;
    let loser_file = loser_square % 8;
    let winner_rank = winner_square / 8;
    let winner_file = winner_square % 8;
    let center_manhattan = core::cmp::max(3 - loser_file, loser_file - 4)
        + core::cmp::max(3 - loser_rank, loser_rank - 4);
    let king_distance = abs_diff(loser_rank, winner_rank) + abs_diff(loser_file, winner_file);
    8 * center_manhattan + 2 * (14 - king_distance)
}

/// Evaluate from White's point of view.
pub fn evaluate(position: &Position) -> i32 {
    let board = &position.board;
    let mut midgame = 0_i32;
    let mut endgame = 0_i32;
    let mut phase = 0_i32;

    let mut pawn_files = [[0_u8; 8]; 2];
    let mut pawn_squares = [[0_u8; 64]; 2];
    let mut pawn_counts = [0_usize; 2];
    let mut kings = [-1_i8; 2];
    let mut force = [0_u8; 2];
    let mut pieces = [0_u8; 2];

    let mut square = 0;
    while square < 64 {
        let piece = board[square];
        if piece == Piece::Empty {
            square += 1;
            continue;
        }
        let color = engine::piece_color(piece).unwrap();
        let piece_type = engine::piece_type(piece).unwrap();
        let color_index = color as usize;
        let piece_index = piece_type as usize;
        let table_square = if color == Color::White {
            square
        } else {
            (7 - square / 8) * 8 + square % 8
        };

        phase += PHASE[piece_index];
        let mut piece_midgame = VALUES_MG[piece_index] + PST_MG[piece_index][table_square] as i32;
        let mut piece_endgame = VALUES_EG[piece_index] + PST_EG[piece_index][table_square] as i32;

        if piece_type != PieceType::King {
            force[color_index] += 1;
        }
        if piece_type == PieceType::Pawn {
            pawn_files[color_index][square % 8] += 1;
            pawn_squares[color_index][pawn_counts[color_index]] = square as u8;
            pawn_counts[color_index] += 1;
        } else if piece_type == PieceType::King {
            kings[color_index] = square as i8;
        } else {
            pieces[color_index] += 1;
            let mobility_score = mobility(board, square, piece_type, color) * MOBILITY[piece_index];
            piece_midgame += mobility_score;
            piece_endgame += mobility_score;
        }

        if color == Color::White {
            midgame += piece_midgame;
            endgame += piece_endgame;
        } else {
            midgame -= piece_midgame;
            endgame -= piece_endgame;
        }
        square += 1;
    }

    for color in [Color::White, Color::Black] {
        let color_index = color as usize;
        let enemy_index = engine::opposite(color) as usize;
        let sign = if color == Color::White { 1 } else { -1 };

        let mut file = 0;
        while file < 8 {
            let count = pawn_files[color_index][file];
            if count > 1 {
                let extra = (count - 1) as i32 * DOUBLED;
                midgame -= sign * extra;
                endgame -= sign * extra;
            }
            file += 1;
        }

        let mut pawn_index = 0;
        while pawn_index < pawn_counts[color_index] {
            let square = pawn_squares[color_index][pawn_index] as usize;
            let file = square % 8;
            let rank = square / 8;
            let has_left_pawn = file > 0 && pawn_files[color_index][file - 1] != 0;
            let has_right_pawn = file < 7 && pawn_files[color_index][file + 1] != 0;
            if !has_left_pawn && !has_right_pawn {
                midgame -= sign * ISOLATED;
                endgame -= sign * ISOLATED;
            }

            let mut passed = true;
            let mut enemy_pawn_index = 0;
            while enemy_pawn_index < pawn_counts[enemy_index] {
                let enemy_square = pawn_squares[enemy_index][enemy_pawn_index] as usize;
                let enemy_file = enemy_square % 8;
                let enemy_rank = enemy_square / 8;
                let file_distance = enemy_file.abs_diff(file);
                let is_ahead = if color == Color::White {
                    enemy_rank < rank
                } else {
                    enemy_rank > rank
                };
                if file_distance <= 1 && is_ahead {
                    passed = false;
                    break;
                }
                enemy_pawn_index += 1;
            }
            if passed {
                let relative_rank = clamp_passed_rank(if color == Color::White {
                    6 - rank as i32
                } else {
                    rank as i32 - 1
                });
                midgame += sign * PASSED_MG[relative_rank];
                endgame += sign * PASSED_EG[relative_rank];
            }
            pawn_index += 1;
        }

        let king_square = kings[color_index];
        if king_square >= 0 {
            let forward = if color == Color::White { -1 } else { 1 };
            let king_rank = king_square as i32 / 8 + forward;
            let king_file = king_square as i32 % 8;
            if king_rank >= 0 && king_rank < 8 {
                let mut file_delta = -1;
                while file_delta <= 1 {
                    let shield_file = king_file + file_delta;
                    if shield_file >= 0 && shield_file < 8 {
                        let shield_square = (king_rank * 8 + shield_file) as usize;
                        let expected_pawn = if color == Color::White {
                            Piece::WhitePawn
                        } else {
                            Piece::BlackPawn
                        };
                        if board[shield_square] == expected_pawn {
                            midgame += sign * SHIELD;
                        }
                    }
                    file_delta += 1;
                }
            }
        }
    }

    let tapered_phase = core::cmp::min(phase, PHASE_MAX);
    let numerator = midgame * tapered_phase + endgame * (PHASE_MAX - tapered_phase);
    // Math.round(x) is floor(x + 0.5), including negative ties. Rust integer
    // division truncates, so use an explicit floor division for negatives.
    let adjusted = numerator + PHASE_MAX / 2;
    let mut score = adjusted / PHASE_MAX;
    if adjusted < 0 && adjusted % PHASE_MAX != 0 {
        score -= 1;
    }

    if kings[0] >= 0 && kings[1] >= 0 {
        if pieces[0] > 0 && force[1] == 0 {
            score += mop_up(kings[1], kings[0]);
        } else if pieces[1] > 0 && force[0] == 0 {
            score -= mop_up(kings[0], kings[1]);
        }
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_shipped_javascript_reference_positions() {
        let cases: &[(&[u8], i32)] = &[
            (
                b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                0,
            ),
            (
                b"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
                57,
            ),
            (b"1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1", 347),
            (b"8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1", -76),
            (b"8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1", 0),
            (b"8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1", 0),
            (b"8/8/8/8/8/8/3k4/R3K3 w - - 0 1", 519),
            (b"8/8/8/8/8/8/4K3/r3k3 b - - 0 1", -562),
        ];

        for &(fen, expected) in cases {
            let position = engine::parse_fen(fen).unwrap();
            assert_eq!(evaluate(&position), expected);
        }
    }
}
