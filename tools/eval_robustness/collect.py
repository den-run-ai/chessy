"""Reproduce the development sibling-decision sample from the #200/#202 evidence."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import threading

import chess
import chess.engine
import chess.pgn
import zstandard

TEACHER = "a3b3fe59985900655940c1088f3d24d2388d359b498a5d84664577fa46135e4a"
NODES = 12000
GROUPS = 320
STRATA = ("check", "recapture", "endgame", "tactical", "quiet")
LOCAL = threading.local()


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def identity(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def phase(board):
    return min(24, sum(weight * chess.popcount(board.pieces_mask(kind, chess.WHITE) |
                                              board.pieces_mask(kind, chess.BLACK))
                       for kind, weight in ((chess.KNIGHT, 1), (chess.BISHOP, 1),
                                            (chess.ROOK, 2), (chess.QUEEN, 4))))


def tactical(board, move):
    return bool(board.is_capture(move) or move.promotion or board.gives_check(move))


def strata(board, played, prior_capture):
    active = {"tactical" if tactical(board, played) else "quiet"}
    if board.is_check():
        active.add("check")
    if prior_capture and board.is_capture(played) and played.to_square == board.peek().to_square:
        active.add("recapture")
    if phase(board) <= 6:
        active.add("endgame")
    return active


def choose_roots(game, group, seen):
    board = game.board()
    positions, prefix, last_capture = [], [], False
    for ply, played in enumerate(game.mainline_moves()):
        # Preserve history for labeling, exclude near-draw and repeated positions.
        if (16 <= ply <= 145 and board.halfmove_clock < 80 and board.legal_moves.count() >= 2
                and not board.is_insufficient_material() and not board.is_repetition(2)):
            active = strata(board, played, last_capture)
            positions.append((ply, active, sha(f"{group}:{ply}"), played.uci(), board.fen()))
        last_capture = board.is_capture(played)
        prefix.append(played.uci())
        board.push(played)
    result = []
    for i in range(2):
        # Cycle the preferred stratum across games, then fall back to any eligible root.
        prefer = STRATA[(int(group[:8], 16) + i * 2) % len(STRATA)]
        for ply, active, priority, played, fen in sorted(positions,
                                                        key=lambda p: (prefer not in p[1], p[2])):
            board_field = fen.split()[0]
            if board_field in seen or any(abs(ply - row["ply"]) < 6 for row in result):
                continue
            result.append(dict(group=group, root=sha(group + ":" + str(ply)), ply=ply,
                               fen=fen, prefixUci=prefix[:ply], played=played, strata=sorted(active)))
            seen.add(board_field)
            break
    return result


def select_games(pgn, exclusions):
    rows, groups, seen = [], set(), set()
    with pgn.open("rb") as file, zstandard.ZstdDecompressor().stream_reader(file) as raw:
        with io.TextIOWrapper(raw, encoding="utf-8") as games:
            while len(groups) < GROUPS:
                game = chess.pgn.read_game(games)
                if game is None:
                    raise ValueError("insufficient natural games")
                headers = game.headers
                site = re.fullmatch(r"https://lichess\.org/([a-zA-Z0-9]{8})", headers.get("Site", ""))
                tc = re.fullmatch(r"(\d+)\+\d+", headers.get("TimeControl", ""))
                if not site or game.errors or "FEN" in headers or headers.get("Variant", "Standard") != "Standard":
                    continue
                if not tc or int(tc[1]) < 180 or headers.get("Result") not in {"1-0", "0-1", "1/2-1/2"}:
                    continue
                if any(not headers.get(key, "").isdigit() or not 1200 <= int(headers[key]) <= 3500
                       for key in ("WhiteElo", "BlackElo")):
                    continue
                group = sha("lichess:" + site[1])
                if group in groups or group in exclusions or sha(group)[0] in "def":
                    continue
                roots = choose_roots(game, group, seen)
                if roots:
                    groups.add(group)
                    rows.extend(roots)
    return rows


def init_teacher(stack, lock, exe):
    engine = chess.engine.SimpleEngine.popen_uci(str(exe))
    with lock:
        stack.callback(engine.quit)
    engine.configure({"Hash": 16, "Threads": 1})
    LOCAL.engine = engine


def analyse(board):
    # Request a new UCI game and send the complete position history. This
    # archived collector reuses its process. The teacher can retain state
    # across requests; isolated_labels.py repeats each search in a new process.
    info = LOCAL.engine.analyse(board, chess.engine.Limit(nodes=NODES), game=object())
    if info.get("upperbound") or info.get("lowerbound") or not info.get("pv"):
        raise ValueError(f"teacher returned an incomplete principal variation at {board.fen()}")
    return info


def label(row):
    board = chess.Board()
    for move in row["prefixUci"]:
        board.push_uci(move)
    if board.fen() != row["fen"]:
        raise ValueError("game prefix mismatch")
    root_color = board.turn
    legal = sorted(board.legal_moves, key=lambda move: sha(row["root"] + ":" + move.uci()))
    root_info = analyse(board)
    previous = board.peek()
    board.pop()
    prior_capture = board.is_capture(previous)
    board.push(previous)
    moves = [chess.Move.from_uci(row["played"]), root_info["pv"][0]]
    for wanted in (True, False):
        first = next((m for m in legal if tactical(board, m) == wanted and m not in moves), None)
        if first is not None:
            moves.append(first)
    if len(set(moves)) < 2:
        moves.extend(legal[:2])
    children = []
    for move in sorted(set(moves), key=lambda m: m.uci()):
        child = dict(uci=move.uci(), tactical=tactical(board, move), check=board.gives_check(move),
                     capture=board.is_capture(move), recapture=prior_capture and board.is_capture(move)
                     and previous.to_square == move.to_square)
        board.push(move)
        outcome = board.outcome()
        if outcome:
            value = 3000 if outcome.winner == root_color else -3000 if outcome.winner is not None else 0
            child.update(teacher=value, mate=0 if outcome.winner is not None else None,
                         terminal=outcome.termination.name, teacherDepth=0, teacherNodes=0)
        else:
            info = analyse(board)
            score = info["score"].pov(root_color)
            child.update(teacher=max(-3000, min(3000, score.score(mate_score=3000))),
                         mate=score.mate(), terminal=None, teacherDepth=info["depth"],
                         teacherNodes=info["nodes"])
        child.update(fen=board.fen(), phase=phase(board))
        children.append(child)
        board.pop()
    return dict(**row, phase=phase(board), teacherMove=root_info["pv"][0].uci(), children=children)


def static_scores(rows, extractor, full, no_pawn):
    children = [c for row in rows for c in row["children"]]
    fens = "".join(c["fen"] + "\n" for c in children)
    for name, weights in (("full", full), ("noPawn", no_pawn)):
        result = subprocess.run([extractor, "eval", weights], input=fens, text=True,
                                capture_output=True, check=True)
        for c, scores in zip(children, result.stdout.splitlines(), strict=True):
            hce, score, correction = map(int, scores.split())
            sign = 1 if c["fen"].split()[1] == "b" else -1
            if c.get("hce", sign*hce) != sign*hce or hce + correction != score:
                raise ValueError("inconsistent static score")
            c.update(hce=sign*hce)
            c[name] = sign*score


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("pgn", "teacher", "previous-ood", "previous-openings", "extractor",
                 "full", "no-pawn", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--workers", type=int, choices=(1, 2), default=2)
    args = parser.parse_args()
    if identity(args.teacher) != TEACHER:
        raise ValueError("teacher binary differs from the archive-pinned Chatarunga 2.0")
    exclusions = {json.loads(line)["sourceGameId"] for path in (args.previous_ood, args.previous_openings)
                  for line in path.read_text().splitlines()}
    roots = select_games(args.pgn, exclusions)
    with ExitStack() as stack:
        with ThreadPoolExecutor(max_workers=args.workers, initializer=init_teacher,
                                initargs=(stack, threading.Lock(), args.teacher.resolve())) as pool:
            rows = list(pool.map(label, roots))
    static_scores(rows, args.extractor, args.full, args.no_pawn)
    # Drop all later source games that repeat a board from an earlier game,
    # including cross-role transpositions of sibling positions with different counters.
    retained, by_group, seen = [], {}, set()
    for row in rows:
        by_group.setdefault(row["group"], []).append(row)
    for group_rows in by_group.values():
        keys = {r["fen"].split()[0] for row in group_rows for r in [row, *row["children"]]}
        if not seen.isdisjoint(keys):
            continue
        seen.update(keys)
        retained.extend(group_rows)
    with args.output.open("xb") as stream, gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0) as out:
        for row in retained:
            out.write((json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n").encode())
    children = [child for row in retained for child in row["children"]]
    report = dict(teacher="Chatarunga 2.0 embedded NNUE", nodesRequested=NODES, hashMiB=16, threads=1,
                  scorePOV="root mover", mateMapping="sign * (3000 - distance), terminal checkmate = 3000",
                  source="Lichess standard January 2014; earliest qualifying games in archive order",
                  selectedGroups=len(by_group), retainedGroups=len({r["group"] for r in retained}),
                  roots=len(retained), children=len(children), rootsSelected=len(roots),
                  rootStrata=Counter(s for r in retained for s in r["strata"]),
                  childCounts={k:sum(bool(c[k]) for c in children) for k in ("capture","check","recapture","tactical")},
                  mateLabels=sum(c["mate"] is not None for c in children), terminal=sum(bool(c["terminal"]) for c in children),
                  exclusions=len(exclusions), sha256={k:identity(v) for k,v in vars(args).items() if isinstance(v,Path)},
                  pythonChess=chess.__version__)
    args.output.with_suffix(".manifest.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
