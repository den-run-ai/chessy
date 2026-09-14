#!/usr/bin/env python3
"""Complete-source, label-blind natural-game selection. Research only.

Only authored code/manifests belong in Git. Archive, prefix histories, source
inventory and selection rows remain external. No production adapter is used.
"""
import argparse
import csv
import hashlib
import io
import json
import logging
import multiprocessing
import os
from pathlib import Path
import re
import subprocess
import sys
from collections import Counter

import chess
import chess.pgn
import zstandard

ROOT = Path(__file__).resolve().parents[2]
RULES = ROOT / "eval/training/natural-pilot-v1.json"
ROLES = ("shared-train", "hce-validation", "hce-test", "nnue-validation", "nnue-test")
PHASES = ("opening", "middlegame", "endgame")
GAME_URL = re.compile(r"https?://(?:www\.)?lichess\.org/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:[/#?].*)?$")


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def file_identity(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return {"path": str(path), "sha256": digest.hexdigest(), "bytes": size}


def write_json(path, value):
    with open(path, "xb") as stream:
        stream.write(encoded(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())


def write_rows(path, rows):
    count = 0
    with open(path, "xb") as stream:
        for row in rows:
            stream.write(encoded(row) + b"\n")
            count += 1
        stream.flush()
        os.fsync(stream.fileno())
    identity = file_identity(path)
    identity.update(path=path.name, rows=count)
    return identity


def key_data(fen):
    """Exact port of corpus.js keys; executable parity is tested against JS."""
    original = []
    for rank in fen.split()[0].split("/"):
        expanded = []
        for piece in rank:
            expanded.extend([None] * int(piece) if piece.isdigit() else [piece])
        if len(expanded) != 8:
            raise ValueError("bad FEN rank")
        original.append(expanded)
    if len(original) != 8:
        raise ValueError("bad FEN board")
    boards, families = [], []
    for mirror, color in ((False, False), (True, False), (False, True), (True, True)):
        board = [list(reversed(rank)) if mirror else list(rank) for rank in original]
        if color:
            board = [[p.swapcase() if p else None for p in rank] for rank in reversed(board)]
        ranks = []
        pawns, kings = [], []
        material = {p: 0 for p in "PNBRQpnbrq"}
        for rank_index, rank in enumerate(board):
            compressed, empty = "", 0
            for file_index, piece in enumerate(rank):
                if piece is None:
                    empty += 1
                    continue
                if empty:
                    compressed += str(empty)
                    empty = 0
                compressed += piece
                sq = rank_index * 8 + file_index
                if piece in "Pp":
                    pawns.append(piece + str(sq))
                elif piece in "Kk":
                    kings.append(piece + str(sq))
                else:
                    material[piece] += 1
            if empty:
                compressed += str(empty)
            ranks.append(compressed)
        boards.append("/".join(ranks))
        # JS inserts these properties in this exact order, then JSON.stringify.
        families.append(json.dumps({"pawns": sorted(pawns), "kings": sorted(kings),
                                    "material": [[p, material[p]] for p in sorted(material)]},
                                   separators=(",", ":")))
    phase = min(24, sum({"n": 1, "b": 1, "r": 2, "q": 4}.get(p.lower(), 0)
                        for rank in original for p in rank if p))
    return {"cluster": sha(min(boards).encode()), "positionFamily": sha(min(families).encode()),
            "phaseBucket": "opening" if phase >= 18 else "middlegame" if phase >= 7 else "endgame"}


def role_for_family(family, rules):
    cell = int(family[:12], 16) % 100
    return next(role for role, (low, high) in rules["selection"]["roles"].items() if low <= cell < high)


def game_id(url):
    match = GAME_URL.fullmatch(url or "")
    return match.group(1) if match else None


def iter_raw_games(stream):
    """Official archive framing: game starts at a line-leading Event tag.

    Keep original bytes and offsets; refuse any non-whitespace preamble. A
    malformed/truncated game is still one inventoried source record.
    """
    parts, offset, start = [], 0, 0
    for line in stream:
        if line.startswith(b'[Event "'):
            if parts:
                yield start, b"".join(parts)
            parts, start = [line], offset
        elif parts:
            parts.append(line)
        elif line.strip():
            raise ValueError("unexpected bytes before first Event tag")
        offset += len(line)
    if parts:
        yield start, b"".join(parts)


def strict_mainline_tokens(text):
    """python-chess ignores unrecognized tokens; independently reject them."""
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
    tokens = []
    result_seen = False
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


def parse_game(raw, index, offset, rules):
    record = {"index": index, "rawSha256": sha(raw), "pgnByteStart": offset, "pgnBytes": len(raw)}
    try:
        text = raw.decode("utf-8", errors="strict")
        tokens = strict_mainline_tokens(text)
        game = chess.pgn.read_game(io.StringIO(text))
    except (ValueError, UnicodeDecodeError) as error:
        return None, dict(record, reason="malformed-pgn", detail=str(error)[:200])
    if game is None or game.errors:
        return None, dict(record, reason="illegal-or-malformed-game")
    tags = game.headers
    sid = game_id(tags.get("Site"))
    record["sourceId"] = sid
    if not sid or any(not tags.get(key) for key in rules["selection"]["requiredMetadata"]):
        return None, dict(record, reason="missing-source-metadata")
    if tags.get("Variant", "Standard") != "Standard" or tags.get("FEN") or tags.get("SetUp"):
        return None, dict(record, reason="nonstandard-start")
    if tags["Result"] not in rules["selection"]["allowedResults"]:
        return None, dict(record, reason="unfinished-or-invalid-result")
    # Require a terminal PGN result token (python-chess permits truncated input).
    result_token = re.search(r"(1-0|0-1|1/2-1/2)\s*$", text)
    if not result_token:
        return None, dict(record, reason="missing-final-result-token")
    if result_token.group(1) != tags["Result"]:
        return None, dict(record, reason="conflicting-result-token")
    if not rules["selection"]["utcDates"][0] <= tags["UTCDate"] <= rules["selection"]["utcDates"][1]:
        return None, dict(record, reason="source-date-outside-frozen-range")
    try:
        ratings = [int(tags[key]) for key in ("WhiteElo", "BlackElo")]
        tc = re.fullmatch(r"(\d+)\+(\d+)", tags["TimeControl"])
        if not tc:
            raise ValueError("time control")
    except ValueError:
        return None, dict(record, reason="invalid-rating-or-time-control")
    conf = rules["selection"]
    if min(ratings) < conf["minimumRating"] or max(ratings) > conf["maximumRating"]:
        return None, dict(record, reason="rating-outside-frozen-range")
    if int(tc.group(1)) < conf["minimumBaseSeconds"]:
        return None, dict(record, reason="time-control-too-fast")
    moves = list(game.mainline_moves())
    if len(moves) != len(tokens):
        return None, dict(record, reason="parser-mainline-token-count-mismatch")
    if len(moves) < conf["minimumGamePlies"]:
        return None, dict(record, reason="game-too-short")
    board, prefix, candidates = chess.Board(), [], []
    for ply, move in enumerate(moves):
        # The parser has validated the complete mainline; retain legal prefix
        # and use the actual next recorded move only for label-blind quietness.
        if conf["minimumPly"] <= ply <= conf["maximumPly"] and not board.is_check() and \
                conf["minimumHalfmoveClock"] <= board.halfmove_clock <= conf["maximumHalfmoveClock"] and \
                not move.promotion and not board.is_capture(move) and not board.gives_check(move) and \
                not board.is_insufficient_material() and not board.is_repetition(3):
            priority = sha((conf["seed"] + "\0" + sid + "\0" + str(ply)).encode())
            candidates.append((priority, ply, board.fen(en_passant="fen")))
        board.push(move)
        prefix.append(move.uci())
    if not candidates:
        return None, dict(record, reason="no-quiet-candidate")
    priority, ply, fen = min(candidates)
    source = dict(record, id=sid, url="https://lichess.org/" + sid, plies=len(moves), selectedPly=ply,
                  ratings=ratings, timeControl=tags["TimeControl"], utcDate=tags["UTCDate"])
    identity = sha((rules["id"] + "\0" + rules["source"]["sha256"] + "\0" + sid + "\0" + str(ply)).encode())
    row = {"schema": "chessy.natural-pilot-row.v1", "id": identity, "fen": fen,
           "fen4": " ".join(fen.split()[:4]), "sourceId": sid, "sourceGame": source,
           "prefixUci": prefix[:ply], "selectionPriority": priority, **key_data(fen)}
    row["role"] = role_for_family(row["positionFamily"], rules)
    row["split"] = {"shared-train": "train", "hce-validation": "validation", "hce-test": "test"}.get(row["role"], row["role"])
    return row, dict(record, candidateId=identity, reason="candidate-pending-global-selection")


def parse_job(args):
    return parse_game(*args)


def quarantine(root, rules):
    clusters, families, sources = set(), set(), set()
    bindings, positions = [], []
    def add_fen(fen):
        if isinstance(fen, str) and len(fen.split()) in (4, 6):
            data = key_data(fen)
            clusters.add(data["cluster"])
            families.add(data["positionFamily"])
    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in ("fen", "fen4", "source_fen", "startfen", "setupfen"):
                    add_fen(child)
                if isinstance(child, str) and game_id(child):
                    sources.add(game_id(child))
                walk(child)
            # Recorded incident SAN trajectories are entirely quarantined.
            if isinstance(value.get("sans"), list):
                board = chess.Board(value.get("setupFen") or chess.STARTING_FEN)
                add_fen(board.fen())
                for san in value["sans"]:
                    board.push_san(san)
                    add_fen(board.fen())
            if isinstance(value.get("uci"), str) and value.get("pgn"):
                board = chess.Board()
                add_fen(board.fen())
                for uci in value["uci"].split():
                    board.push_uci(uci)
                    add_fen(board.fen())
        elif isinstance(value, list):
            for child in value:
                walk(child)
    for relative in rules["quarantine"]["requiredFiles"]:
        path = root / relative
        bindings.append(dict(file_identity(path), path=relative))
        if relative.endswith(".ndjson"):
            for line in path.read_text().splitlines():
                walk(json.loads(line))
        elif relative.endswith(".json"):
            walk(json.loads(path.read_text()))
        elif relative.endswith(".csv"):
            for row in csv.DictReader(io.StringIO(path.read_text())):
                walk(row)
        elif relative.endswith(".pgn"):
            game = chess.pgn.read_game(io.StringIO(path.read_text()))
            if game is None or game.errors:
                raise ValueError("invalid quarantine PGN")
            board = game.board()
            add_fen(board.fen())
            for move in game.mainline_moves():
                board.push(move)
                add_fen(board.fen())
        elif relative.endswith(".js"):
            data = subprocess.check_output(["node", "-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))", str(path)], text=True)
            for _name, sans in json.loads(data):
                board = chess.Board()
                add_fen(board.fen())
                for san in sans.split():
                    board.push_san(san)
                    add_fen(board.fen())
    return {"clusters": clusters, "families": families, "sources": sources,
            "manifest": {"sourceFiles": bindings, "clusters": len(clusters), "families": len(families),
                         "knownSourceGames": len(sources), "clusterSha256": sha(encoded(sorted(clusters))),
                         "familySha256": sha(encoded(sorted(families))), "sourceGamesSha256": sha(encoded(sorted(sources))),
                         "incidentSourceLineage": rules["quarantine"]["incidentCrossSourceLineage"]}}


def select_global(candidates, inventory, boundary, rules):
    seen_sources, seen_clusters, counts = set(), set(), Counter()
    selected = []
    for row in sorted(candidates, key=lambda r: (r["selectionPriority"], r["id"])):
        record = inventory[row["sourceGame"]["index"]]
        sid, family, cluster = row["sourceId"], row["positionFamily"], row["cluster"]
        if sid in boundary["sources"]:
            reason = "quarantined-source-game"
        elif cluster in boundary["clusters"]:
            reason = "quarantined-model-cluster"
        elif family in boundary["families"]:
            reason = "quarantined-structural-family"
        elif sid in seen_sources:
            reason = "duplicate-source-game"
        elif cluster in seen_clusters:
            reason = "duplicate-model-cluster"
        elif counts[family] >= rules["selection"]["maximumRowsPerFamily"]:
            reason = "structural-family-cap"
        elif len(selected) >= rules["selection"]["maximumRows"]:
            reason = "global-row-cap"
        else:
            reason = "selected"
            selected.append(row)
            seen_sources.add(sid)
            seen_clusters.add(cluster)
            counts[family] += 1
        record["reason"] = reason
    return sorted(selected, key=lambda row: row["id"])


def coverage(rows, rules):
    role = Counter(row["role"] for row in rows)
    phases = {r: Counter(row["phaseBucket"] for row in rows if row["role"] == r) for r in ROLES}
    families = {r: len({row["positionFamily"] for row in rows if row["role"] == r}) for r in ROLES}
    gates = rules["selection"]["coverageBeforeLabelling"]
    failures = []
    if len(rows) < rules["selection"]["minimumRowsForFullPilot"]:
        failures.append("fewer-than-40000-selected")
    for r in ROLES[:3]:
        if role[r] < gates["minimumPerHceRole"]:
            failures.append(r + ":rows")
        if families[r] < gates["minimumUniqueFamiliesPerHceRole"]:
            failures.append(r + ":families")
        for phase in PHASES:
            if phases[r][phase] < gates["minimumPerPhasePerHceRole"]:
                failures.append(r + ":" + phase)
    for r in ROLES[3:]:
        if role[r] < gates["minimumPerNnueRole"]:
            failures.append(r + ":rows")
    return {"fullPilotReady": not failures, "failedGates": failures, "byRole": dict(role),
            "byRoleAndPhase": {r: dict(c) for r, c in phases.items()}, "familiesByRole": families}


def run(archive, output, quarantine_root):
    rules = json.loads(RULES.read_text())
    if chess.__version__ != rules["dependencies"]["pythonChess"] or zstandard.__version__ != rules["dependencies"]["zstandard"]:
        raise ValueError("pinned parser/decompressor dependency mismatch")
    archive_identity = file_identity(archive)
    if archive_identity["sha256"] != rules["source"]["sha256"]:
        raise ValueError("complete official compressed archive SHA-256 mismatch")
    fit_path = ROOT / rules["teacher"]["fitContract"]
    teacher_path = ROOT / rules["teacher"]["contract"]
    identities = {p: file_identity(p) for p in (RULES, fit_path, teacher_path, Path(__file__), ROOT / "test/training/corpus.js")}
    boundary = quarantine(quarantine_root, rules)
    output.mkdir(parents=False, exist_ok=False)
    # Snapshot preregistrations before inspecting any game or generating labels.
    write_json(output / "preregistration.json", rules)
    write_json(output / "fit-preregistration.json", json.loads(fit_path.read_text()))
    candidates, inventory = [], []
    digest = hashlib.sha256()
    class HashReader:
        def __init__(self, stream):
            self.stream = stream
        def __iter__(self):
            for line in self.stream:
                digest.update(line)
                yield line
    with open(archive, "rb") as compressed:
        with zstandard.ZstdDecompressor().stream_reader(compressed) as decompressed:
            with io.BufferedReader(decompressed) as buffered:
                jobs = ((raw, index, offset, rules) for index, (offset, raw) in enumerate(iter_raw_games(HashReader(buffered))))
                # Ordered imap keeps output deterministic regardless of workers.
                with multiprocessing.Pool(rules["selection"]["parserWorkers"]) as pool:
                    for index, (row, record) in enumerate(pool.imap(parse_job, jobs, chunksize=32)):
                        inventory.append(record)
                        if row is not None:
                            candidates.append(row)
                        if (index + 1) % 10000 == 0:
                            print(json.dumps({"games": index + 1, "quietCandidates": len(candidates)}), file=sys.stderr, flush=True)
    if len(inventory) != rules["source"]["games"]:
        raise ValueError("complete source game count mismatch")
    selected = select_global(candidates, inventory, boundary, rules)
    coverage_report = coverage(selected, rules)
    files = [dict(write_rows(output / (role + ".ndjson"), (r for r in selected if r["role"] == role)), role=role) for role in ROLES]
    inventory_file = write_rows(output / "source-inventory.ndjson", inventory)
    manifest = {"schema": "chessy.natural-pilot-selection.v1", "status": "complete-research-only-selection",
                "productionFitAllowed": False, "publishableArtifact": False,
                "preregistration": dict(identities[RULES], path=str(RULES.relative_to(ROOT))),
                "fitPreregistration": dict(identities[fit_path], path=str(fit_path.relative_to(ROOT))),
                "teacherContract": dict(identities[teacher_path], path=str(teacher_path.relative_to(ROOT))),
                "implementation": [dict(v, path=str(p.relative_to(ROOT))) for p, v in identities.items() if p not in (RULES, fit_path, teacher_path)],
                "source": dict(archive_identity, path=archive.name, url=rules["source"]["url"], games=len(inventory),
                               uncompressedSha256=digest.hexdigest(), license=rules["source"]["license"]),
                "quarantine": boundary["manifest"], "coverage": coverage_report,
                "selection": {"rows": len(selected), "byRole": coverage_report["byRole"], "files": files,
                              "sourceInventory": inventory_file, "sourceDispositions": dict(Counter(r["reason"] for r in inventory)),
                              "uniqueSourceGames": len({r["sourceId"] for r in selected}),
                              "uniqueClusters": len({r["cluster"] for r in selected}),
                              "uniqueFamilies": len({r["positionFamily"] for r in selected})},
                "limitations": ["Full-game source identity exists only for the official PGN and known puzzle game URLs.",
                                "Incident upstream lineage remains unknown; all known incident position families are quarantined.",
                                "Family isolation does not prove independence of players, opening ideas or study selection.",
                                "No teacher outputs or HCE/NNUE test labels have been generated or inspected by this selector."]}
    # Scope: trusted isolated research runner. Same-UID hostile mutation is not
    # certified. Complete source/contracts/quarantine are rehashed before marker.
    if file_identity(archive) != archive_identity:
        raise ValueError("archive changed during selection")
    for path, identity in identities.items():
        if file_identity(path) != identity:
            raise ValueError("preregistration/implementation changed during selection")
    for binding in boundary["manifest"]["sourceFiles"]:
        current = file_identity(quarantine_root / binding["path"])
        if current["sha256"] != binding["sha256"]:
            raise ValueError("quarantine changed during selection")
    write_json(output / "manifest.json", manifest)  # Sole completion marker.
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--quarantine-root", type=Path, default=ROOT)
    args = parser.parse_args()
    logging.getLogger("chess.pgn").setLevel(logging.CRITICAL)
    manifest = run(args.archive.resolve(), args.output.resolve(), args.quarantine_root.resolve())
    print(json.dumps({"manifest": str(args.output / "manifest.json"), "selection": manifest["selection"]["rows"], "coverage": manifest["coverage"]}, sort_keys=True))


if __name__ == "__main__":
    main()
