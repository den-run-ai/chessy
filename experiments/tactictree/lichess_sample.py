"""Stream-sample a theme-stratified set of Lichess puzzles.

Streams the official CSV dump (zstd) WITHOUT writing it to disk, assigns each
qualifying puzzle to at most one target-theme bucket (rare themes get priority
when a puzzle carries several target tags), then picks a deterministic
rating-quantile spread per theme — diverse in rating, reproducible without a
random seed.

Filters: Popularity >= 90, NbPlays >= 1000, 800 <= Rating <= 2400, and the
puzzle must parse (legal setup move, >= 2 moves).

Lichess CSV columns: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,
NbPlays,Themes,GameUrl,OpeningTags. The FEN is the position BEFORE the
opponent's setup move Moves[0]; the solver's line is Moves[1:].
"""
import csv
import io
import pathlib
import urllib.request

import zstandard
import chess

URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"

# (theme, how many to sample) in assignment-priority order: rarest first, so a
# puzzle tagged e.g. both intermezzo and fork lands in the intermezzo bucket.
WANT = [("intermezzo", 8), ("deflection", 6), ("skewer", 6),
        ("discoveredAttack", 6), ("mateIn2", 6), ("fork", 6),
        ("pin", 6), ("hangingPiece", 6)]

CAP = 250          # candidates per theme before early stop
MAX_ROWS = 3_000_000


def valid(row) -> bool:
    try:
        b = chess.Board(row["FEN"])
        ms = row["Moves"].split()
        if len(ms) < 2:
            return False
        return chess.Move.from_uci(ms[0]) in b.legal_moves
    except Exception:
        return False


def main():
    buckets = {t: [] for t, _ in WANT}
    rows_seen = 0
    req = urllib.request.Request(URL, headers={"User-Agent": "tactictree-research"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        stream = zstandard.ZstdDecompressor().stream_reader(resp)
        reader = csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8", newline=""))
        for row in reader:
            rows_seen += 1
            if rows_seen % 200_000 == 0:
                sizes = {t: len(b) for t, b in buckets.items()}
                print(f"scanned {rows_seen} rows, buckets: {sizes}", flush=True)
            if rows_seen >= MAX_ROWS or all(len(b) >= CAP for b in buckets.values()):
                break
            try:
                if int(row["Popularity"]) < 90 or int(row["NbPlays"]) < 1000:
                    continue
                r = int(row["Rating"])
            except (ValueError, KeyError):
                continue
            if not 800 <= r <= 2400:
                continue
            themes = set(row["Themes"].split())
            for t, _ in WANT:
                if t in themes and len(buckets[t]) < CAP:
                    buckets[t].append(row)
                    break

    print(f"\nscan done: {rows_seen} rows")
    out = []
    for t, n in WANT:
        cand = [c for c in sorted(buckets[t],
                                  key=lambda x: (int(x["Rating"]), x["PuzzleId"]))
                if valid(c)]
        if len(cand) < n:
            print(f"WARNING: theme {t} has only {len(cand)} valid candidates")
            picks = cand
        else:
            idx = sorted({round(k * (len(cand) - 1) / max(n - 1, 1))
                          for k in range(n)})
            while len(idx) < n:                      # collision fill-in
                idx = sorted(set(idx) | {min(i + 1 for i in idx
                                             if i + 1 < len(cand)
                                             and i + 1 not in idx)})
            picks = [cand[i] for i in idx[:n]]
        rr = [int(p["Rating"]) for p in picks]
        print(f"{t:18} {len(picks)} picks, rating {min(rr)}-{max(rr)}"
              f" (from {len(cand)} candidates)")
        out.extend((t, p) for p in picks)

    dest = pathlib.Path(__file__).parent / "lichess" / "puzzles_50.csv"
    dest.parent.mkdir(exist_ok=True)
    with open(dest, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["sampled_theme", "puzzle_id", "rating", "popularity",
                    "nb_plays", "fen", "moves", "themes", "game_url"])
        for t, p in out:
            w.writerow([t, p["PuzzleId"], p["Rating"], p["Popularity"],
                        p["NbPlays"], p["FEN"], p["Moves"], p["Themes"],
                        p["GameUrl"]])
    print(f"\nwrote {len(out)} puzzles -> {dest}")


if __name__ == "__main__":
    main()
