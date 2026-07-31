"""Crash-safe, no-replace publication for authenticated artifact pairs."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def acquire_output_prefix_lock(lock_path: Path, subject: str) -> int:
    """Reserve one artifact prefix until its completion marker is published."""
    try:
        descriptor = os.open(
            lock_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError as error:
        raise FileExistsError(
            f"another {subject} publication holds the output-prefix lock: "
            f"{lock_path}"
        ) from error
    try:
        body = (
            json.dumps({"pid": os.getpid()}, separators=(",", ":"), sort_keys=True)
            + "\n"
        ).encode("utf-8")
        offset = 0
        while offset < len(body):
            written = os.write(descriptor, body[offset:])
            if written <= 0:
                raise OSError("short write while creating output-prefix lock")
            offset += written
        os.fsync(descriptor)
        return descriptor
    except BaseException:
        release_output_prefix_lock(descriptor, lock_path)
        raise


def release_output_prefix_lock(descriptor: int, lock_path: Path) -> None:
    """Remove only the lock inode owned by descriptor, then close it."""
    try:
        held = os.fstat(descriptor)
        try:
            current = os.stat(lock_path, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if (
            current is not None
            and current.st_dev == held.st_dev
            and current.st_ino == held.st_ino
        ):
            lock_path.unlink()
    finally:
        os.close(descriptor)


def refuse_existing_pair(paths: tuple[Path, Path], subject: str) -> None:
    existing = [str(path) for path in paths if path.exists()]
    if existing:
        raise FileExistsError(
            f"refusing to overwrite {subject}: " + ", ".join(existing)
        )


def _fsync_file(filename: Path) -> None:
    descriptor = os.open(filename, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(directory, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _unlink_if_same_file(reference: Path, target: Path) -> bool:
    try:
        expected = os.stat(reference, follow_symlinks=False)
        current = os.stat(target, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if current.st_dev != expected.st_dev or current.st_ino != expected.st_ino:
        return False
    target.unlink()
    return True


def _link_no_replace(temporary: Path, final: Path, subject: str) -> None:
    try:
        os.link(temporary, final)
    except FileExistsError as error:
        raise FileExistsError(
            f"refusing to overwrite {subject}: {final}"
        ) from error


def publish_pair_no_replace(
    temporary_output: Path,
    temporary_metadata: Path,
    output: Path,
    metadata: Path,
    subject: str,
) -> None:
    """Publish data first and its authenticated completion marker last.

    Cooperative writers are serialized by the output-prefix lock. Hard-link
    publication additionally makes both destination writes no-replace. If the
    metadata destination appears after preflight, the data link is rolled back
    only when it is still this writer's inode.
    """
    if output.parent != metadata.parent:
        raise ValueError("paired artifacts must share one output directory")
    _fsync_file(temporary_output)
    _fsync_file(temporary_metadata)
    output_linked = False
    metadata_linked = False
    try:
        _link_no_replace(temporary_output, output, subject)
        output_linked = True
        _fsync_directory(output.parent)
        _link_no_replace(temporary_metadata, metadata, subject)
        metadata_linked = True
        _fsync_directory(output.parent)
    except BaseException:
        if output_linked and not metadata_linked:
            if _unlink_if_same_file(temporary_output, output):
                _fsync_directory(output.parent)
        raise
    temporary_output.unlink(missing_ok=True)
    temporary_metadata.unlink(missing_ok=True)


def _sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def self_test_pair_publication(
    directory: Path,
    output_name: str,
    metadata_suffix: str,
    subject: str,
) -> int:
    """Exercise collision, lock-ownership, crash, and live-writer races."""
    checks = 0

    def check(condition: bool, label: str) -> None:
        nonlocal checks
        if not condition:
            raise AssertionError(label)
        checks += 1

    output = directory / output_name
    metadata = Path(str(output) + metadata_suffix)
    lock_path = output.with_name(output.name + ".lock")

    owner = acquire_output_prefix_lock(lock_path, subject)
    lock_path.unlink()
    replacement = os.open(
        lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
    )
    release_output_prefix_lock(owner, lock_path)
    check(
        lock_path.exists(),
        "a writer cannot remove a concurrently replaced lock inode",
    )
    os.close(replacement)
    lock_path.unlink()

    abandoned = acquire_output_prefix_lock(lock_path, subject)
    os.close(abandoned)
    try:
        acquire_output_prefix_lock(lock_path, subject)
    except FileExistsError:
        checks += 1
    else:
        raise AssertionError("an abrupt-exit lock did not fail closed")
    lock_path.unlink()

    collision_lock = acquire_output_prefix_lock(lock_path, subject)
    try:
        refuse_existing_pair((output, metadata), subject)
        with tempfile.TemporaryDirectory(
            prefix=f".{output.name}.collision-", dir=directory
        ) as temporary:
            temporary_root = Path(temporary)
            temporary_output = temporary_root / "data"
            temporary_metadata = temporary_root / "metadata"
            temporary_output.write_bytes(b"losing data\n")
            temporary_metadata.write_text(
                '{"sha256":"losing"}\n', encoding="utf-8"
            )
            metadata.write_text("concurrent metadata winner\n", encoding="utf-8")
            try:
                publish_pair_no_replace(
                    temporary_output,
                    temporary_metadata,
                    output,
                    metadata,
                    subject,
                )
            except FileExistsError:
                checks += 1
            else:
                raise AssertionError(
                    "metadata created after preflight was overwritten"
                )
            check(
                not output.exists(),
                "a metadata collision rolls back this writer's data link",
            )
            check(
                metadata.read_text(encoding="utf-8")
                == "concurrent metadata winner\n",
                "a metadata collision preserves the concurrent winner",
            )
    finally:
        release_output_prefix_lock(collision_lock, lock_path)
    metadata.unlink()

    race_output = directory / f"concurrent-{output_name}"
    race_metadata = Path(str(race_output) + metadata_suffix)
    race_lock = race_output.with_name(race_output.name + ".lock")
    barrier = threading.Barrier(2)

    def writer(token: str) -> tuple[str, str]:
        barrier.wait(timeout=5)
        try:
            descriptor = acquire_output_prefix_lock(race_lock, subject)
        except FileExistsError:
            return "refused", token
        try:
            try:
                refuse_existing_pair((race_output, race_metadata), subject)
            except FileExistsError:
                return "refused", token
            with tempfile.TemporaryDirectory(
                prefix=f".{race_output.name}.{token}-", dir=directory
            ) as temporary:
                temporary_root = Path(temporary)
                temporary_output = temporary_root / "data"
                temporary_metadata = temporary_root / "metadata"
                temporary_output.write_text(token + "\n", encoding="utf-8")
                temporary_metadata.write_text(
                    json.dumps(
                        {
                            "token": token,
                            "sha256": _sha256_file(temporary_output),
                        },
                        sort_keys=True,
                    )
                    + "\n",
                    encoding="utf-8",
                )
                time.sleep(0.05)
                publish_pair_no_replace(
                    temporary_output,
                    temporary_metadata,
                    race_output,
                    race_metadata,
                    subject,
                )
            return "published", token
        finally:
            release_output_prefix_lock(descriptor, race_lock)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(writer, ("alpha", "beta")))
    winners = [token for status, token in results if status == "published"]
    losers = [token for status, token in results if status == "refused"]
    check(
        len(winners) == 1 and len(losers) == 1,
        f"exactly one concurrent pair publisher wins: {results!r}",
    )
    published_metadata = json.loads(race_metadata.read_text(encoding="utf-8"))
    check(
        published_metadata["token"] == winners[0],
        "the completion marker belongs to the winning writer",
    )
    check(
        published_metadata["sha256"] == _sha256_file(race_output),
        "the completion marker authenticates the winning data artifact",
    )
    check(not race_lock.exists(), "successful publication releases its lock")
    preserved_output = race_output.read_bytes()
    preserved_metadata = race_metadata.read_bytes()
    retry = acquire_output_prefix_lock(race_lock, subject)
    try:
        try:
            refuse_existing_pair((race_output, race_metadata), subject)
        except FileExistsError:
            checks += 1
        else:
            raise AssertionError("a completed pair was admitted for overwrite")
    finally:
        release_output_prefix_lock(retry, race_lock)
    check(
        race_output.read_bytes() == preserved_output
        and race_metadata.read_bytes() == preserved_metadata,
        "a refused retry leaves both artifacts byte-identical",
    )
    check(
        not list(directory.glob(f".{race_output.name}.*")),
        "concurrent writers leave no temporary publication directories",
    )
    return checks
