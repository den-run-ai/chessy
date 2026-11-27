#!/usr/bin/env python3
"""Large, explicitly exploratory CC0 input for sparse PeSTO experiments.

The eval export has mixed Stockfish labels and no game lineage. These files
are NEVER production/certification inputs. A bounded compressed prefix is a
declared sample, not a copy of the complete database. Inputs are hashed and
consumed through the same retained descriptor; related outputs are committed
under an exclusive directory reservation, with the manifest written last.
"""
import argparse
import ast
from collections import Counter
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import re
import sys
import urllib.request

import chess
import chess.pgn
import zstandard

ROOT = Path(__file__).resolve().parents[2]
ROLES = ("train", "validation", "holdout")
EVAL_URL = "https://database.lichess.org/lichess_db_eval.jsonl.zst"
PGN_URL = "https://database.lichess.org/standard/lichess_db_standard_rated_2014-01.pgn.zst"
QUARANTINE = (
    "eval/corpus/eval-v1.ndjson", "eval/corpus/sources/lichess-puzzles-v1.csv",
    "test/fixtures/master-incident-20260724.json",
    "test/fixtures/master-e4-regression-20260729.json",
    "test/fixtures/master-e4-regression-20260729.pgn",
    "test/ai-match-openings.js", "eval/match-v2/openings.json",
    "test/fixtures/wasm-r69-signatures.json",
)
RULES = {
    "id": "sparse-pesto-v1-2026-11", "sourceBytes": 512 * 1024 * 1024,
    "minimumDepth": 20, "minimumKnodes": 100, "maximumAbsCp": 2000,
    "maximumRows": 1_000_000, "maximumRowsPerFamily": 8,
    "roleFractions": [80, 10, 10],
    "roleRule": "sha256(id NUL structural-family) first12 hex modulo100; 0..79/80..89/90..99",
    "quietness": "root not in check; first teacher PV move legal, noncapture, nonpromotion, nonchecking; entire PV legal",
    "labelRule": "deepest evaluation, ties most knodes, first PV; reject mate/absCP>2000; White POV",
    "selection": "stream order, dedup color/rank/file mirrors, cap8 per family, stop admissions at1M but inventory whole declared prefix",
    "researchOnly": True, "productionFitAllowed": False,
}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def write_json(path, value):
    with open(path, "xb") as stream:
        stream.write(encoded(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())


def descriptor_identity(stream):
    """Hash a retained descriptor and restore its offset; never reopen by path."""
    at = stream.tell()
    stream.seek(0)
    h, size = hashlib.sha256(), 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        h.update(chunk)
        size += len(chunk)
    stream.seek(at)
    return {"sha256": h.hexdigest(), "bytes": size}


def key_data(fen):
    """Exact corpus.js model cluster/family semantics, independent of turn.

    Ignoring turn/counters is deliberately conservative for leakage control.
    Four transforms include file reflection and color/rank reflection.
    """
    original = []
    for rank in fen.split()[0].split("/"):
        cells = []
        for piece in rank:
            if piece in "12345678":
                cells.extend([None] * int(piece))
            elif piece in "PNBRQKpnbrqk":
                cells.append(piece)
            else:
                raise ValueError("invalid board character")
        if len(cells) != 8:
            raise ValueError("invalid rank")
        original.append(cells)
    if len(original) != 8:
        raise ValueError("invalid board")
    boards, families = [], []
    for mirror, color in ((False, False), (True, False), (False, True), (True, True)):
        board = [list(reversed(rank)) if mirror else list(rank) for rank in original]
        if color:
            board = [[p.swapcase() if p else None for p in rank] for rank in reversed(board)]
        ranks, pawns, kings = [], [], []
        material = {p: 0 for p in "PNBRQpnbrq"}
        for r, rank in enumerate(board):
            result, empty = "", 0
            for f, p in enumerate(rank):
                if p is None:
                    empty += 1
                    continue
                if empty:
                    result += str(empty)
                    empty = 0
                result += p
                if p in "Pp":
                    pawns.append(p + str(r * 8 + f))
                elif p in "Kk":
                    kings.append(p + str(r * 8 + f))
                else:
                    material[p] += 1
            ranks.append(result + (str(empty) if empty else ""))
        boards.append("/".join(ranks))
        families.append(json.dumps({"pawns": sorted(pawns), "kings": sorted(kings),
                                    "material": [[p, material[p]] for p in sorted(material)]}, separators=(",", ":")))
    phase = min(24, sum({"n": 1, "b": 1, "r": 2, "q": 4}.get(p.lower(), 0)
                        for rank in original for p in rank if p))
    return {"cluster": digest(min(boards).encode()), "family": digest(min(families).encode()),
            "phase": phase, "phaseBucket": "opening" if phase >= 18 else "middlegame" if phase >= 7 else "endgame"}


def role_for_family(family):
    cell = int(digest((RULES["id"] + "\0" + family).encode())[:12], 16) % 100
    return "train" if cell < 80 else "validation" if cell < 90 else "holdout"


def load_quarantine(root):
    clusters, families, sources, bindings = set(), set(), set(), []
    def add(fen):
        if isinstance(fen, str) and len(fen.split()) in (4, 6):
            keys = key_data(fen)
            clusters.add(keys["cluster"])
            families.add(keys["family"])
    def walk(value):
        if isinstance(value, dict):
            for k, v in value.items():
                if k.lower() in ("fen", "fen4", "source_fen", "startfen", "setupfen"):
                    add(v)
                if isinstance(v, str):
                    m = re.fullmatch(r"https?://(?:www\.)?lichess\.org/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:[/#?].*)?", v)
                    if m:
                        sources.add(m.group(1))
                walk(v)
            if isinstance(value.get("sans"), list):
                b = chess.Board(value.get("setupFen") or chess.STARTING_FEN)
                add(b.fen())
                for san in value["sans"]:
                    b.push_san(san)
                    add(b.fen())
            if isinstance(value.get("uci"), str) and value.get("pgn"):
                b = chess.Board()
                add(b.fen())
                for uci in value["uci"].split():
                    b.push_uci(uci)
                    add(b.fen())
        elif isinstance(value, list):
            for child in value:
                walk(child)
    for relative in QUARANTINE:
        raw = (Path(root) / relative).read_bytes()
        bindings.append({"path": relative, "sha256": digest(raw), "bytes": len(raw)})
        text = raw.decode()
        if relative.endswith(".ndjson"):
            for line in text.splitlines():
                walk(json.loads(line))
        elif relative.endswith(".json"):
            walk(json.loads(text))
        elif relative.endswith(".csv"):
            for row in csv.DictReader(io.StringIO(text)):
                walk(row)
        elif relative.endswith(".pgn"):
            game = chess.pgn.read_game(io.StringIO(text))
            if game is None or game.errors:
                raise ValueError("invalid quarantine PGN")
            b = game.board()
            add(b.fen())
            for move in game.mainline_moves():
                b.push(move)
                add(b.fen())
        elif relative.endswith(".js"):
            # This frozen module's OPENINGS array consists only of string pairs.
            # Decode retained literal bytes without executing its dependencies.
            literal = re.search(r"const OPENINGS\s*=\s*(\[.*?\n\]);", text, re.S)
            if literal is None:
                raise ValueError("unknown opening module format")
            openings = ast.literal_eval(literal.group(1))
            for _, sans in openings:
                b = chess.Board()
                add(b.fen())
                for san in sans.split():
                    b.push_san(san)
                    add(b.fen())
    return {"clusters": clusters, "families": families, "sources": sources,
            "manifest": {"files": bindings, "clusters": len(clusters), "families": len(families),
                         "knownSourceGames": len(sources), "clusterSha256": digest(encoded(sorted(clusters))),
                         "familySha256": digest(encoded(sorted(families))),
                         "incidentCrossSourceLineage": "unknown; not inferred"}}


def adapt_eval(record):
    """Return (row, reason). No outcome or historical locked label is consulted."""
    if not isinstance(record, dict) or not isinstance(record.get("fen"), str):
        return None, "invalid-schema"
    evaluations = record.get("evals")
    if not isinstance(evaluations, list):
        return None, "no-evaluation"
    entries = [e for e in evaluations if isinstance(e, dict) and type(e.get("depth")) is int
               and type(e.get("knodes")) in (int, float) and e["knodes"] >= 0]
    if not entries:
        return None, "no-evaluation"
    e = max(entries, key=lambda e: (e["depth"], e["knodes"]))
    if e["depth"] < RULES["minimumDepth"] or e["knodes"] < RULES["minimumKnodes"]:
        return None, "insufficient-search"
    pvs = e.get("pvs")
    if not isinstance(pvs, list) or not pvs or not isinstance(pvs[0], dict):
        return None, "missing-pv"
    pv = pvs[0]
    if type(pv.get("cp")) is not int or "mate" in pv:
        return None, "mate-or-invalid-cp"
    if abs(pv["cp"]) > RULES["maximumAbsCp"]:
        return None, "cp-outside-band"
    fields = record["fen"].split()
    if len(fields) not in (4, 6):
        return None, "invalid-fen"
    fen = " ".join(fields) + (" 0 1" if len(fields) == 4 else "")
    try:
        board = chess.Board(fen)
    except ValueError:
        return None, "invalid-fen"
    if not board.is_valid():
        return None, "invalid-board"
    if board.is_check() or board.is_insufficient_material():
        return None, "check-or-insufficient"
    line = pv.get("line", pv.get("moves"))
    if not isinstance(line, str) or not line.split():
        return None, "missing-pv"
    moves = line.split()
    try:
        first = chess.Move.from_uci(moves[0])
        if first not in board.legal_moves:
            return None, "illegal-pv"
        if first.promotion or board.is_capture(first) or board.gives_check(first):
            return None, "tactical-first-pv"
        for token in moves:
            move = chess.Move.from_uci(token)
            if move not in board.legal_moves:
                return None, "illegal-pv"
            board.push(move)
    except ValueError:
        return None, "illegal-pv"
    return {"fen": fen, "cpWhite": pv["cp"], "depth": e["depth"], "knodes": e["knodes"],
            "pvFirst": moves[0], "pvPlies": len(moves), "pvSha256": digest(line.encode()),
            "sourceGameId": None, "sourceId": "lichess-eval-2026-11-prefix512m", **key_data(fen)}, None


def adapt_line(line):
    try:
        return adapt_eval(json.loads(line))
    except (ValueError, TypeError, OverflowError):
        return None, "invalid-json-or-schema"


def download(url, output, byte_count=None, expected_sha=None):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"Range": f"bytes=0-{byte_count-1}"} if byte_count else {})
    with urllib.request.urlopen(request, timeout=60) as response, open(output, "xb") as stream:
        if byte_count and (response.status != 206 or not re.fullmatch(r"bytes 0-" + str(byte_count - 1) + r"/\d+", response.headers.get("Content-Range", ""))):
            raise ValueError("server did not honor exact byte-range sample")
        if not byte_count and response.status != 200:
            raise ValueError("full archive request was not complete")
        declared = int(response.headers["Content-Length"])
        h, count = hashlib.sha256(), 0
        while True:
            part = response.read(1024 * 1024)
            if not part:
                break
            count += len(part)
            stream.write(part)
            h.update(part)
            if count % (64 * 1024 * 1024) == 0:
                print(json.dumps({"stage": "download", "bytes": count}), flush=True)
        if count != declared or (byte_count and count != byte_count):
            raise ValueError("download byte count mismatch")
        if expected_sha and h.hexdigest() != expected_sha:
            raise ValueError("download checksum mismatch")
        stream.flush()
        os.fsync(stream.fileno())
        identity = {"url": url, "path": output.name, "bytes": count, "sha256": h.hexdigest(),
                    "license": "CC0-1.0", "licenseUrl": "https://database.lichess.org/",
                    "retrievedAt": datetime.now(timezone.utc).isoformat(), "contentRange": response.headers.get("Content-Range"),
                    "etag": response.headers.get("ETag"), "lastModified": response.headers.get("Last-Modified"),
                    "sample": "bounded-compressed-prefix" if byte_count else "complete-archive",
                    "upstreamChecksumVerified": expected_sha is not None}
    os.chmod(output, 0o444)
    write_json(str(output) + ".source.json", identity)
    return identity


def import_eval(source, source_manifest, output, root=ROOT, workers=4):
    source, output = Path(source), Path(output)
    raw_manifest = Path(source_manifest).read_bytes()
    metadata = json.loads(raw_manifest)
    if metadata.get("url") != EVAL_URL or metadata.get("license") != "CC0-1.0" or metadata.get("bytes") != RULES["sourceBytes"]:
        raise ValueError("unexpected source declaration")
    code = Path(__file__).read_bytes()
    boundary = load_quarantine(root)
    output.mkdir(parents=False, exist_ok=False)  # Exclusive no-replace reservation.
    write_json(output / "plan.json", {"rules": RULES, "source": metadata, "sourceManifestSha256": digest(raw_manifest),
                                     "implementationSha256": digest(code), "quarantine": boundary["manifest"]})
    handles, hashes, rows = {}, {}, Counter()
    counts, families, seen = Counter(), Counter(), set()
    phases = {role: Counter() for role in ROLES}
    depth = Counter()
    for role in ROLES:
        handles[role] = open(output / (role + ".jsonl"), "xb")
        hashes[role] = hashlib.sha256()
    complete_hash, tail = hashlib.sha256(), b""
    try:
        with open(source, "rb") as compressed:
            before = descriptor_identity(compressed)
            if any(before[k] != metadata[k] for k in ("bytes", "sha256")):
                raise ValueError("source bytes do not match declaration")
            with zstandard.ZstdDecompressor().stream_reader(compressed, closefd=False) as decompressed, \
                    multiprocessing.Pool(workers) as pool:
                reader = io.BufferedReader(decompressed)
                # Bounded batches prevent a decompressor/read-ahead thread from
                # queuing the whole multi-million-record prefix in memory.
                def batches():
                    nonlocal tail
                    batch = []
                    for line in reader:
                        if not line.endswith(b"\n"):
                            tail = line
                            break
                        complete_hash.update(line)
                        batch.append(line)
                        if len(batch) == 2048:
                            yield batch
                            batch = []
                    if batch:
                        yield batch
                for batch in batches():
                  if counts["admitted"] >= RULES["maximumRows"]:
                    counts["sourceRecords"] += len(batch)
                    counts["global-row-cap"] += len(batch)
                    continue
                  for row, reason in pool.imap(adapt_line, batch, chunksize=64):
                    counts["sourceRecords"] += 1
                    if counts["admitted"] >= RULES["maximumRows"]:
                        counts["global-row-cap"] += 1
                        continue
                    if row is not None:
                        cluster, family = row["cluster"], row["family"]
                        if cluster in boundary["clusters"] or family in boundary["families"]:
                            reason = "quarantine"
                        elif cluster in seen:
                            reason = "duplicate-cluster"
                        elif families[family] >= RULES["maximumRowsPerFamily"]:
                            reason = "family-cap"
                        else:
                            row["role"] = role_for_family(family)
                            row["sourceRecord"] = counts["sourceRecords"]
                            raw = encoded(row) + b"\n"
                            handles[row["role"]].write(raw)
                            hashes[row["role"]].update(raw)
                            rows[row["role"]] += 1
                            phases[row["role"]][row["phaseBucket"]] += 1
                            depth[str(row["depth"])] += 1
                            seen.add(cluster)
                            families[family] += 1
                            reason = "admitted"
                    counts[reason] += 1
                    if counts["sourceRecords"] % 100000 == 0:
                        print(json.dumps({"stage": "import", "records": counts["sourceRecords"], "admitted": counts["admitted"]}), flush=True)
            if descriptor_identity(compressed) != before:
                raise ValueError("input descriptor changed during import")
            if os.stat(source).st_ino != os.fstat(compressed.fileno()).st_ino:
                raise ValueError("input pathname replaced during import")
        files = []
        for role, handle in handles.items():
            handle.flush()
            os.fsync(handle.fileno())
            files.append({"path": role + ".jsonl", "role": role, "sha256": hashes[role].hexdigest(),
                          "bytes": handle.tell(), "rows": rows[role]})
        if digest(Path(__file__).read_bytes()) != digest(code):
            raise ValueError("implementation changed during import")
        # Boundary files are authenticated again before completion publication.
        for binding in boundary["manifest"]["files"]:
            if digest((Path(root) / binding["path"]).read_bytes()) != binding["sha256"]:
                raise ValueError("quarantine changed during import")
        manifest = {"schema": "chessy.sparse-eval-data.v1", "status": "complete-research-only",
                    "researchOnly": True, "productionFitAllowed": False, "publishableArtifact": False,
                    "rules": RULES, "source": metadata, "implementationSha256": digest(code),
                    "quarantine": boundary["manifest"], "files": files, "counts": dict(counts),
                    "uniqueClusters": len(seen), "uniqueFamilies": len(families), "uniqueSourceGames": None,
                    "byRoleAndPhase": {r: dict(c) for r, c in phases.items()}, "depthHistogram": dict(depth),
                    "completeSourceLinesSha256": complete_hash.hexdigest(), "discardedPartialLineBytes": len(tail),
                    "discardedPartialLineSha256": digest(tail),
                    "limitations": ["prefix sample, not representative full-export random sample",
                                    "mixed Stockfish versions and settings; no pinned-teacher quality certification",
                                    "no source-game IDs, repetition history or authentic move counters",
                                    "family grouping prevents recorded mirror/family overlap, not all opening/player dependence",
                                    "four-field FENs receive synthetic 0/1 counters for static evaluation only"]}
        write_json(output / "manifest.json", manifest)
        return manifest
    finally:
        for handle in handles.values():
            handle.close()


def raw_games(stream):
    parts = []
    for line in stream:
        if line.startswith(b'[Event "'):
            if parts:
                yield b"".join(parts)
            parts = [line]
        elif parts:
            parts.append(line)
        elif line.strip():
            raise ValueError("unexpected PGN preamble")
    if parts:
        yield b"".join(parts)


def strict_mainline_tokens(text):
    """Reject unknown tokens that python-chess would otherwise skip.

    Same strict grammar as the independently checked historical natural-game
    selector. Variations/comments are ignored only after balanced framing.
    """
    header = re.match(r'^\s*(?:\[\w+\s+"(?:[^"\\]|\\.)*"\]\s*)+', text)
    body = text[header.end():] if header else text
    out, depth, comment, semicolon = [], 0, False, False
    for char in body:
        if semicolon:
            if char == "\n":
                semicolon = False
                out.append(" ")
        elif comment:
            if char == "}":
                comment = False
                out.append(" ")
        elif char == "{":
            comment = True
        elif char == ";":
            semicolon = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("unbalanced variation")
        elif char == "}":
            raise ValueError("unbalanced comment")
        elif depth == 0:
            out.append(char)
    if comment or depth:
        raise ValueError("unterminated comment or variation")
    body = re.sub(r"\d+\.(?:\.\.)?", " ", "".join(out))
    san = re.compile(r"(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?|O-O(?:-O)?|0-0(?:-0)?)[+#]?[!?]*$")
    tokens, result_seen = [], False
    for token in body.split():
        if re.fullmatch(r"\$\d+|[!?]+", token):
            continue
        if token in ("1-0", "0-1", "1/2-1/2", "*"):
            if result_seen:
                raise ValueError("multiple result tokens")
            result_seen = True
        elif result_seen or not san.fullmatch(token):
            raise ValueError("unrecognized mainline token")
        else:
            tokens.append(token)
    return tokens


def parse_pgn(raw):
    """One label-blind quiet position per complete legal natural game."""
    inventory = {"rawSha256": digest(raw), "bytes": len(raw)}
    try:
        text = raw.decode("utf-8")
        # Cheap metadata screen before legal replay. No names are retained.
        tags = dict(re.findall(r'^\[(\w+) "([^"\n]*)"\]$', text, re.M))
        site = re.fullmatch(r"https://lichess\.org/([A-Za-z0-9]{8})", tags.get("Site", ""))
        if not site:
            return None, dict(inventory, reason="missing-source-id")
        sid = site.group(1)
        inventory["sourceGameId"] = digest(("lichess:" + sid).encode())
        if tags.get("Variant", "Standard") != "Standard" or tags.get("SetUp") or tags.get("FEN"):
            return None, dict(inventory, reason="nonstandard-start")
        if tags.get("WhiteTitle") == "BOT" or tags.get("BlackTitle") == "BOT":
            return None, dict(inventory, reason="bot")
        result = tags.get("Result")
        if result not in ("1-0", "0-1", "1/2-1/2") or not text.rstrip().endswith(result):
            return None, dict(inventory, reason="unfinished-or-truncated")
        ratings = [int(tags.get(k, "0")) for k in ("WhiteElo", "BlackElo")]
        tc = re.fullmatch(r"(\d+)\+(\d+)", tags.get("TimeControl", ""))
        if min(ratings) < 1200 or max(ratings) > 3500 or not tc or int(tc.group(1)) < 180:
            return None, dict(inventory, reason="rating-or-time-control")
        tokens = strict_mainline_tokens(text)
        game = chess.pgn.read_game(io.StringIO(text))
        if game is None or game.errors:
            return None, dict(inventory, reason="pgn-error")
        moves = list(game.mainline_moves())
        if len(moves) != len(tokens):
            return None, dict(inventory, reason="mainline-token-count-mismatch")
        if len(moves) < 30:
            return None, dict(inventory, reason="short-game")
        board, prefix, best = chess.Board(), [], None
        for ply, move in enumerate(moves):
            if move not in board.legal_moves:
                return None, dict(inventory, reason="illegal-mainline")
            if 16 <= ply <= 160 and 2 <= board.halfmove_clock <= 79 and not board.is_check() \
                    and not board.is_capture(move) and not move.promotion and not board.gives_check(move) \
                    and not board.is_insufficient_material() and not board.is_repetition(3):
                priority = digest((RULES["id"] + "\0pgn\0" + sid + "\0" + str(ply)).encode())
                if best is None or priority < best[0]:
                    best = (priority, board.fen(en_passant="fen"), list(prefix), ply)
            board.push(move)
            prefix.append(move.uci())
        if best is None:
            return None, dict(inventory, reason="no-quiet-position")
        priority, fen, prefix, ply = best
        row = {"fen": fen, "sourceId": "lichess-standard-2014-01", "sourceGameId": inventory["sourceGameId"],
               "selectedPly": ply, "prefixUci": prefix, "gamePlies": len(moves), "selectionPriority": priority,
               "cpWhite": None, "role": "unlabelled-natural", **key_data(fen)}
        return (row, sid), dict(inventory, reason="candidate")
    except (ValueError, TypeError, OverflowError):
        return None, dict(inventory, reason="invalid-metadata-or-game")


def select_pgn(source, source_manifest, output, root=ROOT, workers=4):
    """Inventory complete Jan2014 and retain all eligible one-game candidates.

    These are UNLABELLED, not silently added to the fit. A separate pinned
    teacher pass can choose a prospective OOD subset, excluding eval families.
    """
    source, output = Path(source), Path(output)
    raw_manifest = Path(source_manifest).read_bytes()
    metadata = json.loads(raw_manifest)
    expected = "f4e9efea9aeb608211a1e1b62aff00b92679eab6b70f957e77a1d7c4d8bfbbc8"
    if metadata.get("url") != PGN_URL or metadata.get("sha256") != expected or metadata.get("sample") != "complete-archive":
        raise ValueError("unexpected PGN declaration")
    boundary, code = load_quarantine(root), Path(__file__).read_bytes()
    output.mkdir(parents=False, exist_ok=False)
    write_json(output / "plan.json", {"schema": "chessy.sparse-natural-selection-plan.v1", "source": metadata,
                                      "implementationSha256": digest(code), "maximumRowsPerGame": 1,
                                      "maximumRowsPerFamily": 8, "minimumRating": 1200, "minimumBaseSeconds": 180,
                                      "positionRule": "lowest SHA256(id NUL pgn NUL source-game NUL ply) quiet candidate",
                                      "labels": "none; later pinned-teacher stage", "researchOnly": True,
                                      "quarantine": boundary["manifest"]})
    counts, families, seen_clusters, seen_games = Counter(), Counter(), set(), set()
    hashes = {key: hashlib.sha256() for key in ("positions", "inventory")}
    with open(source, "rb") as compressed, open(output / "positions.jsonl", "xb") as rows, \
            open(output / "inventory.jsonl", "xb") as inventory:
        before = descriptor_identity(compressed)
        if before["sha256"] != expected or before["bytes"] != metadata["bytes"]:
            raise ValueError("PGN descriptor checksum mismatch")
        with zstandard.ZstdDecompressor().stream_reader(compressed, closefd=False) as decompressed, multiprocessing.Pool(workers) as pool:
            games = raw_games(io.BufferedReader(decompressed))
            while True:
                batch = []
                for _ in range(1024):
                    raw = next(games, None)
                    if raw is None:
                        break
                    batch.append(raw)
                if not batch:
                    break
                for candidate, record in pool.imap(parse_pgn, batch, chunksize=32):
                    counts["sourceGames"] += 1
                    record["sourceIndex"] = counts["sourceGames"]
                    if candidate:
                        row, raw_sid = candidate
                        family, cluster, sid = row["family"], row["cluster"], row["sourceGameId"]
                        if raw_sid in boundary["sources"] or family in boundary["families"] or cluster in boundary["clusters"]:
                            record["reason"] = "quarantine"
                        elif sid in seen_games or cluster in seen_clusters:
                            record["reason"] = "duplicate-game-or-cluster"
                        elif families[family] >= 8:
                            record["reason"] = "family-cap"
                        else:
                            record["reason"] = "selected-unlabelled"
                            raw_row = encoded(row) + b"\n"
                            rows.write(raw_row)
                            hashes["positions"].update(raw_row)
                            families[family] += 1
                            seen_clusters.add(cluster)
                            seen_games.add(sid)
                    counts[record["reason"]] += 1
                    raw_record = encoded(record) + b"\n"
                    inventory.write(raw_record)
                    hashes["inventory"].update(raw_record)
                if counts["sourceGames"] % 10240 == 0:
                    print(json.dumps({"stage": "pgn", "games": counts["sourceGames"], "selected": len(seen_games)}), flush=True)
        if counts["sourceGames"] != 697600 or descriptor_identity(compressed) != before:
            raise ValueError("PGN incomplete inventory or changed descriptor")
        if os.stat(source).st_ino != os.fstat(compressed.fileno()).st_ino:
            raise ValueError("PGN pathname replaced")
        files = []
        for name, handle in (("positions", rows), ("inventory", inventory)):
            handle.flush()
            os.fsync(handle.fileno())
            files.append({"path": name + ".jsonl", "sha256": hashes[name].hexdigest(), "bytes": handle.tell(),
                          "rows": len(seen_games) if name == "positions" else counts["sourceGames"]})
        if digest(Path(__file__).read_bytes()) != digest(code):
            raise ValueError("implementation changed during selection")
        manifest = {"schema": "chessy.sparse-natural-data.v1", "status": "complete-unlabelled-research-only",
                    "researchOnly": True, "productionFitAllowed": False, "source": metadata,
                    "counts": dict(counts), "uniqueSelectedGames": len(seen_games), "uniqueFamilies": len(families),
                    "files": files, "implementationSha256": digest(code), "quarantine": boundary["manifest"],
                    "limitations": ["unlabelled natural games are not training labels", "source-game IDs are irreversible opaque hashes",
                                    "future OOD selection must additionally quarantine every eval-sample family before labelling"]}
        write_json(output / "manifest.json", manifest)
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("download-eval")
    p.add_argument("output", type=Path)
    p = sub.add_parser("download-pgn")
    p.add_argument("output", type=Path)
    p.add_argument("--sha256", required=True)
    p = sub.add_parser("import-eval")
    p.add_argument("source", type=Path)
    p.add_argument("source_manifest", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--root", type=Path, default=ROOT)
    p.add_argument("--workers", type=int, default=4)
    p = sub.add_parser("select-pgn")
    p.add_argument("source", type=Path)
    p.add_argument("source_manifest", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--root", type=Path, default=ROOT)
    p.add_argument("--workers", type=int, default=4)
    a = parser.parse_args()
    if a.command == "download-eval":
        result = download(EVAL_URL, a.output, RULES["sourceBytes"])
    elif a.command == "download-pgn":
        result = download(PGN_URL, a.output, expected_sha=a.sha256)
    else:
        if not 1 <= a.workers <= 8:
            parser.error("workers must be 1..8")
        fn = import_eval if a.command == "import-eval" else select_pgn
        result = fn(a.source, a.source_manifest, a.output, a.root, a.workers)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
