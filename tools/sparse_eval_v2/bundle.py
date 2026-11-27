#!/usr/bin/env python3
"""Store raw evidence once; refer to exact staged Git blobs for repo content.

Creation and restoration are byte-copy operations, never experiment execution.
RESTORE.json is the final tar member. No symlink or extraction API is used.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile

import zstandard

SCHEMA = "chessy.sparse-evidence-bundle.v1"
CHUNK = 1024 * 1024
MAX_METADATA = 64 * 1024 * 1024
DEFAULT_MAX_BYTES = 16 * 1024 ** 3


def require(ok, message):
    if not ok:
        raise ValueError(message)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def safe_name(name):
    require(isinstance(name, str) and name not in ("", ".", "..") and "\\" not in name
            and all(ord(char) >= 32 for char in name), "unsafe archive path")
    path = PurePosixPath(name)
    require(not path.is_absolute() and name == path.as_posix() and all(part not in (".", "..") for part in path.parts), "unsafe archive path")
    require(len(name.encode()) <= 255, "archive path exceeds strict USTAR length")
    return name


def file_hash(stream):
    digest, size = hashlib.sha256(), 0
    for block in iter(lambda: stream.read(CHUNK), b""):
        digest.update(block)
        size += len(block)
    return digest.hexdigest(), size


class HashReader:
    def __init__(self, stream):
        self.stream, self.digest, self.size = stream, hashlib.sha256(), 0

    def read(self, size=-1):
        raw = self.stream.read(size)
        self.digest.update(raw); self.size += len(raw)
        return raw

    def readinto(self, buffer):
        raw = self.read(len(buffer)); buffer[:len(raw)] = raw
        return len(raw)


class HashWriter:
    def __init__(self, stream):
        self.stream, self.digest, self.size = stream, hashlib.sha256(), 0

    def write(self, raw):
        written = self.stream.write(raw)
        require(written == len(raw), "short archive write")
        self.digest.update(raw); self.size += written
        return written

    def flush(self):
        self.stream.flush()


class GitBlobs:
    def __init__(self, repo):
        self.process = subprocess.Popen(["git", "--no-replace-objects", "-C", str(repo), "cat-file", "--batch"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def read(self, oid, sink=None, expected_bytes=None):
        require(isinstance(oid, str) and re.fullmatch(r"[0-9a-f]{40}", oid), "invalid Git blob identity")
        self.process.stdin.write(oid.encode() + b"\n"); self.process.stdin.flush()
        fields = self.process.stdout.readline().decode().strip().split()
        require(len(fields) == 3 and fields[:2] == [oid, "blob"] and fields[2].isdigit(), "required Git blob unavailable")
        size = int(fields[2])
        require(expected_bytes is None or size == expected_bytes, "Git blob size differs")
        digest, remaining = hashlib.sha256(), size
        while remaining:
            raw = self.process.stdout.read(min(CHUNK, remaining))
            require(raw, "truncated Git blob")
            remaining -= len(raw); digest.update(raw)
            if sink is not None:
                require(sink.write(raw) == len(raw), "short restored blob write")
        require(self.process.stdout.read(1) == b"\n", "malformed Git batch framing")
        return digest.hexdigest(), size

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill(); self.process.wait()
        self.process.stdout.close(); self.process.stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def staged_map(repo):
    """Only staged immutable blobs are authority, never mutable worktree bytes."""
    command = ["git", "--no-replace-objects", "-C", str(repo), "ls-files", "--stage", "-z"]
    inventory = subprocess.check_output(command)
    entries = []
    for record in inventory.split(b"\0"):
        if not record:
            continue
        meta, name = record.split(b"\t", 1)
        mode, oid, stage = meta.decode().split()
        require(stage == "0", "Git index has unresolved merge stages")
        path = name.decode("utf-8")
        safe_name(path)
        if mode not in ("100644", "100755"):
            continue  # Symlink and gitlink contents are never ordinary source files.
        entries.append((path, oid))
    by_digest, by_blob = {}, {}
    with GitBlobs(repo) as blobs:
        for path, oid in sorted(entries):
            if oid not in by_blob:
                by_blob[oid] = blobs.read(oid)
            digest, size = by_blob[oid]
            by_digest.setdefault((digest, size), {"repoPath": path, "gitBlobSha": oid})
    require(subprocess.check_output(command) == inventory, "Git index changed during content-map construction")
    return by_digest, hashlib.sha256(inventory).hexdigest()


def inventory_roots(roots, output):
    files, names = [], set()
    output = Path(output).resolve()
    for prefix, source in roots:
        safe_name(prefix)
        require(prefix not in ("RESTORE.json", "RESTORED.json"), "reserved archive prefix")
        source = Path(source)
        require(not source.is_symlink(), "source root is a symlink")
        source = source.resolve(strict=True)
        require(output != source and not output.is_relative_to(source), "archive output lies within its own source root")
        if source.is_file():
            candidates = [(prefix, source)]
        else:
            require(source.is_dir(), "unsupported source root")
            candidates = []
            for directory, subdirs, filenames in os.walk(source, followlinks=False):
                subdirs.sort(); filenames.sort()
                for name in subdirs:
                    require(not (Path(directory) / name).is_symlink(), "source directory symlink")
                for name in filenames:
                    path = Path(directory) / name
                    candidates.append((prefix + "/" + path.relative_to(source).as_posix(), path))
        for name, path in candidates:
            safe_name(name)
            require(name not in names and name not in ("RESTORE.json", "RESTORED.json"), "duplicate/reserved archive path")
            require(stat.S_ISREG(path.lstat().st_mode), "nonregular source file")
            names.add(name); files.append((name, path))
    require(len(files) <= 100000, "excessive archive inventory")
    return sorted(files)


def create(repo, roots, output):
    repo, output = Path(repo), Path(output)
    require(not output.exists(), "archive output already exists")
    files = inventory_roots(roots, output)
    matches, index_sha = staged_map(repo)
    references, raw_files = [], []
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as destination:
        compressed = HashWriter(destination)
        with zstandard.ZstdCompressor(level=6, write_checksum=True).stream_writer(compressed, closefd=False) as writer:
            with tarfile.open(fileobj=writer, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                for name, path in files:
                    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd, "rb") as source:
                        before = os.fstat(source.fileno())
                        require(stat.S_ISREG(before.st_mode), "source ceased to be a regular file")
                        digest, size = file_hash(source)
                        mode = stat.S_IMODE(before.st_mode) & 0o777
                        item = {"archivePath": name, "sha256": digest, "bytes": size, "mode": mode}
                        match = matches.get((digest, size))
                        if match:
                            references.append({**item, **match})
                        else:
                            source.seek(0)
                            copied = HashReader(source)
                            info = tarfile.TarInfo(name)
                            info.size, info.mode, info.mtime = size, mode, 0
                            info.uid = info.gid = 0
                            archive.addfile(info, copied)
                            require(copied.size == size and copied.digest.hexdigest() == digest, "source changed while archiving")
                            raw_files.append(item)
                        after, visible = os.fstat(source.fileno()), path.stat()
                        identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
                        require(identity(before) == identity(after) == identity(visible), "source changed or was replaced")
                final_index = subprocess.check_output(["git", "--no-replace-objects", "-C", str(repo), "ls-files", "--stage", "-z"])
                require(hashlib.sha256(final_index).hexdigest() == index_sha, "Git index changed before archive completion")
                manifest = {"schema": SCHEMA, "gitIndexSha256": index_sha,
                            "sourceRoots": [{"archivePrefix": prefix, "originalPath": str(Path(path).resolve())} for prefix, path in roots],
                            "files": raw_files, "references": references, "fileCount": len(files),
                            "rawBytes": sum(item["bytes"] for item in raw_files),
                            "referencedBytes": sum(item["bytes"] for item in references),
                            "restorePolicy": "exact Git blob bytes authenticated by SHA256 and size; no executable code is run"}
                payload = encoded(manifest)
                require(len(payload) <= MAX_METADATA, "restore metadata too large")
                info = tarfile.TarInfo("RESTORE.json")
                info.size, info.mode, info.mtime = len(payload), 0o444, 0
                archive.addfile(info, io.BytesIO(payload))
        destination.flush(); os.fsync(destination.fileno())
        result = {"archive": str(output), "sha256": compressed.digest.hexdigest(), "bytes": compressed.size,
                  "files": len(files), "rawFiles": len(raw_files), "repoReferences": len(references),
                  "rawBytes": manifest["rawBytes"], "referencedBytes": manifest["referencedBytes"],
                  "restoreManifestSha256": hashlib.sha256(payload).hexdigest()}
    return result


def exact(stream, size):
    parts, remaining = [], size
    while remaining:
        raw = stream.read(min(CHUNK, remaining))
        require(raw, "truncated archive")
        parts.append(raw); remaining -= len(raw)
    return b"".join(parts)


def restore(repo, archive_path, expected_sha, output, max_bytes=DEFAULT_MAX_BYTES):
    repo, archive_path, output = map(Path, (repo, archive_path, output))
    require(re.fullmatch(r"[0-9a-f]{64}", expected_sha) is not None, "external archive SHA256 required")
    require(type(max_bytes) is int and max_bytes > 0, "invalid restoration size limit")
    require(not output.exists(), "restore output already exists")
    with archive_path.open("rb") as source:
        before = os.fstat(source.fileno())
        digest, _ = file_hash(source)
        require(digest == expected_sha, "archive differs from external SHA256")
        source.seek(0)
        consumed = HashReader(source)
        output.mkdir(parents=True, exist_ok=False, mode=0o700)
        seen, observed, total_bytes = set(), {}, 0
        manifest = None
        with zstandard.ZstdDecompressor().stream_reader(consumed, closefd=False, read_across_frames=True) as reader:
            while True:
                header = exact(reader, 512)
                if header == bytes(512):
                    require(exact(reader, 512) == bytes(512), "invalid tar end marker")
                    for trailing in iter(lambda: reader.read(CHUNK), b""):
                        require(not any(trailing), "trailing nonzero archive payload")
                    break
                require(manifest is None, "RESTORE.json must be the final tar member")
                info = tarfile.TarInfo.frombuf(header, encoding="utf-8", errors="strict")
                name = safe_name(info.name)
                require(name not in seen and len(seen) < 100001, "duplicate/excessive archive member")
                seen.add(name)
                require(info.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and not info.linkname,
                        "archive symlink, directory, sparse, or special member rejected")
                require(type(info.size) is int and info.size >= 0 and info.mode & ~0o777 == 0, "invalid member size/mode")
                if name == "RESTORE.json":
                    require(info.size <= MAX_METADATA, "restore metadata too large")
                    raw = exact(reader, info.size)
                    def unique(items):
                        value = {}
                        for key, item in items:
                            require(key not in value, "duplicate metadata key")
                            value[key] = item
                        return value
                    manifest = json.loads(raw, object_pairs_hook=unique)
                    require(encoded(manifest) == raw, "noncanonical restore metadata")
                else:
                    require(name != "RESTORED.json", "reserved output completion path")
                    total_bytes += info.size
                    require(total_bytes <= max_bytes, "restoration byte limit exceeded")
                    target = output / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    digest, remaining = hashlib.sha256(), info.size
                    with target.open("xb") as destination:
                        while remaining:
                            chunk = exact(reader, min(CHUNK, remaining))
                            destination.write(chunk); digest.update(chunk); remaining -= len(chunk)
                        destination.flush(); os.fsync(destination.fileno())
                    observed[name] = {"archivePath": name, "sha256": digest.hexdigest(), "bytes": info.size, "mode": info.mode}
                padding = (-info.size) % 512
                if padding:
                    require(exact(reader, padding) == bytes(padding), "nonzero tar padding")
        require(consumed.digest.hexdigest() == expected_sha, "compressed archive changed during restoration")
        require(manifest is not None and manifest.get("schema") == SCHEMA, "complete restore manifest missing")
        after = os.fstat(source.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "archive changed during consumption")
    files, references = manifest.get("files"), manifest.get("references")
    require(isinstance(files, list) and isinstance(references, list), "invalid restore inventory")
    expected = {}
    for item in files + references:
        name = safe_name(item["archivePath"])
        require(name not in expected and name not in ("RESTORE.json", "RESTORED.json"), "duplicate/reserved restore path")
        require(type(item["bytes"]) is int and item["bytes"] >= 0 and type(item["mode"]) is int and 0 <= item["mode"] <= 0o777, "invalid restore size/mode")
        require(isinstance(item["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "invalid restore SHA256")
        expected[name] = item
    require(manifest.get("fileCount") == len(expected) and len(expected) <= 100000, "restore file count differs")
    require(sum(item["bytes"] for item in files + references) <= max_bytes, "restoration byte limit exceeded")
    require(set(observed) == {item["archivePath"] for item in files}, "missing or extra raw archive files")
    for item in files:
        require(observed[item["archivePath"]] == item, "raw payload differs from restore manifest")
    with GitBlobs(repo) as blobs:
        for item in references:
            safe_name(item["repoPath"])
            name = item["archivePath"]
            target = output / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as destination:
                digest, size = blobs.read(item["gitBlobSha"], destination, item["bytes"])
                require(digest == item["sha256"] and size == item["bytes"], "repository blob does not match exact referenced content")
                destination.flush(); os.fsync(destination.fileno())
    for name, item in expected.items():
        (output / name).chmod(item["mode"])
    result = {"schema": SCHEMA + ".restored", "status": "complete", "archiveSha256": expected_sha,
              "fileCount": len(expected), "rawFiles": len(files), "repoReferences": len(references),
              "restoredBytes": sum(item["bytes"] for item in files + references)}
    with (output / "RESTORED.json").open("xb") as destination:
        destination.write(encoded(result)); destination.flush(); os.fsync(destination.fileno())
    return result


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("create")
    make.add_argument("--repo", required=True); make.add_argument("--root", action="append", required=True)
    make.add_argument("--output", required=True)
    unpack = commands.add_parser("restore")
    unpack.add_argument("--repo", required=True); unpack.add_argument("--archive", required=True)
    unpack.add_argument("--archive-sha256", required=True); unpack.add_argument("--output", required=True)
    unpack.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args()
    if args.command == "create":
        roots = [(part.split("=", 1)[0], Path(part.split("=", 1)[1])) if "=" in part else (Path(part).name, Path(part)) for part in args.root]
        result = create(args.repo, roots, args.output)
    else:
        result = restore(args.repo, args.archive, args.archive_sha256, args.output, args.max_bytes)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
