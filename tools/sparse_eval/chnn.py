"""Frozen-output-head adapter for external Chatarunga CHNN v1 SCReLU nets.

Format/orientation follows deedy/chess-chatarunga src/nnue.rs, revision
4f389446c685e011bcc2550c682e26bdb9f7a96b (MIT, Deedy Das 2026). No network is
vendored. Only uniform 1/16 king buckets are admitted; other formats fail.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import struct

import numpy as np
from scipy import sparse

from .features import parse_fen


def _sha(payload):
    return hashlib.sha256(payload).hexdigest()


def _trunc_div(numerator, denominator):
    """Rust signed integer division, unlike Python's floor division."""
    return np.sign(numerator) * (np.abs(numerator) // denominator)


def _integer_vector(value, size, name):
    a = np.asarray(value)
    if (a.shape != (size,) or a.dtype.kind not in "iuf" or not np.all(np.isfinite(a))
            or np.any(a != np.rint(a)) or np.any(np.abs(a.astype(np.float64)) > 2**31-1)):
        raise ValueError(f"{name} must contain finite bounded integers of length {size}")
    return a.astype(np.int64)


@dataclass(frozen=True)
class Activations:
    # Exact squared, clipped integer accumulators, STM perspective first.
    squared: np.ndarray
    bucket: np.ndarray
    turn: np.ndarray
    source_sha256: str


class FrozenCHNN:
    def __init__(self, payload):
        self.payload = bytes(payload)
        if len(self.payload) < 32:
            raise ValueError("truncated CHNN header")
        magic, version, kb, hidden, ob, qa, qb, scale = struct.unpack("<4sIIIIiii", self.payload[:32])
        if (magic != b"CHNN" or version != 1 or kb not in (1, 16)
                or not 1 <= hidden <= 4096 or not 1 <= ob <= 32
                or not 1 <= qa <= 255 or not 1 <= qb <= 65536 or not 1 <= scale <= 65536):
            raise ValueError("unsupported or invalid CHNN architecture")
        self.king_buckets, self.hidden, self.output_buckets = kb, hidden, ob
        self.qa, self.qb, self.scale = qa, qb, scale
        self.output_offset = 32 + (kb*768*hidden+hidden)*2
        self.weight_count = ob*2*hidden
        expected = self.output_offset + self.weight_count*2 + ob*4
        if len(self.payload) != expected:
            raise ValueError("CHNN length does not match its complete declared arrays")
        self.source_sha256 = _sha(self.payload)
        self.ft_w = np.frombuffer(self.payload, dtype="<i2", count=kb*768*hidden, offset=32).reshape(kb*768, hidden)
        self.ft_b = np.frombuffer(self.payload, dtype="<i2", count=hidden, offset=32+kb*768*hidden*2)
        self.out_w = np.frombuffer(self.payload, dtype="<i2", count=self.weight_count,
                                   offset=self.output_offset).reshape(ob, 2*hidden)
        self.out_b = np.frombuffer(self.payload, dtype="<i4", count=ob,
                                   offset=self.output_offset+self.weight_count*2)
        self._check_head(self.out_w, self.out_b)

    @classmethod
    def from_file(cls, path, *, expected_sha256):
        if (not isinstance(expected_sha256, str) or len(expected_sha256) != 64
                or any(c not in "0123456789abcdef" for c in expected_sha256)):
            raise ValueError("an explicit lowercase source SHA-256 is required")
        payload = Path(path).read_bytes()
        if _sha(payload) != expected_sha256:
            raise ValueError("CHNN source SHA-256 mismatch")
        return cls(payload)

    def _check_head(self, w, b):
        # Upstream SIMD computes clipped_activation * head_weight in int16.
        # A merely int16-valid output weight could silently overflow there.
        safe = min(32767, 32767 // self.qa)
        if np.max(np.abs(np.asarray(w, dtype=np.int64)), initial=0) > safe:
            raise ValueError("output weights violate upstream SIMD product bound")
        head_sum = 2*self.hidden*self.qa*self.qa*safe
        scaled = (head_sum//self.qa+int(np.max(np.abs(b.astype(np.int64)), initial=0)))*self.scale
        if scaled > np.iinfo(np.int64).max or scaled//(self.qa*self.qb) > np.iinfo(np.int32).max:
            raise ValueError("theoretical CHNN scalar output overflow")

    def metadata(self):
        return {"format": "CHNN-v1-SCReLU", "kingBuckets": self.king_buckets,
                "hidden": self.hidden, "outputBuckets": self.output_buckets,
                "qa": self.qa, "qb": self.qb, "scale": self.scale,
                "sourceSha256": self.source_sha256, "sourceBytes": len(self.payload),
                "editedLayer": "final-linear-output-weights-only",
                "outputBiasFrozen": True, "featureTransformerFrozen": True,
                "maximumSimdSafeHeadWeight": min(32767, 32767//self.qa),
                "integerRounding": "trunc(sum/qa), then trunc((total*scale)/(qa*qb))",
                "upstreamSearchCalibrationIncluded": False,
                "productionEligible": False}

    def feature_indices(self, fen, perspective):
        if type(perspective) is not int or perspective not in (0, 1):
            raise ValueError("perspective must be white=0 or black=1")
        p = parse_fen(fen)
        pieces = [(sq, value) for sq, value in enumerate(p.board) if value]
        if len(pieces) > 32:
            raise ValueError("CHNN board exceeds 32 pieces")
        k = p.kings[perspective] ^ (56 if perspective else 0)
        mirror = self.king_buckets > 1 and k % 8 >= 4
        k ^= 7 if mirror else 0
        bucket = 0 if self.king_buckets == 1 else (k//8//2)*4+k%8
        indices = []
        for square, value in pieces:
            color, kind = divmod(value-1, 6)
            oriented = square ^ (56 if perspective else 0) ^ (7 if mirror else 0)
            indices.append(bucket*768 + int(color != perspective)*384 + kind*64+oriented)
        return indices

    def activations(self, fens):
        squared, buckets, turns = [], [], []
        for fen in fens:
            p = parse_fen(fen)
            count = sum(bool(v) for v in p.board)
            acc = []
            for perspective in (0, 1):
                indices = self.feature_indices(fen, perspective)
                total = self.ft_w[indices].astype(np.int64).sum(axis=0)+self.ft_b
                # Runtime accumulator arithmetic is wrapping i16, even during refresh.
                total = (total+32768) % 65536-32768
                acc.append(np.clip(total, 0, self.qa))
            ordered = np.concatenate((acc[p.turn], acc[1-p.turn]))
            squared.append(ordered*ordered)
            divisor = (32+self.output_buckets-1)//self.output_buckets
            buckets.append(min(max(0, count-2)//divisor, self.output_buckets-1))
            turns.append(1 if p.turn == 0 else -1)
        values = np.asarray(squared, dtype=np.int64).reshape(-1, 2*self.hidden)
        bucket = np.asarray(buckets, dtype=np.int64)
        turn = np.asarray(turns, dtype=np.int64)
        for a in (values, bucket, turn):
            a.setflags(write=False)
        return Activations(values, bucket, turn, self.source_sha256)

    def _batch(self, batch):
        if not isinstance(batch, Activations) or batch.source_sha256 != self.source_sha256:
            raise ValueError("activations are not bound to this frozen network")
        a, b, t = batch.squared, batch.bucket, batch.turn
        if (a.ndim != 2 or a.shape[1] != 2*self.hidden or b.shape != (len(a),)
                or t.shape != b.shape or a.dtype.kind not in "iu" or b.dtype.kind not in "iu"
                or t.dtype.kind not in "iu" or np.any((a < 0) | (a > self.qa*self.qa))
                or np.any((b < 0) | (b >= self.output_buckets)) or np.any((t != 1) & (t != -1))):
            raise ValueError("invalid frozen activation shape or range")
        return a, b, t

    def design(self, batch):
        """White CP per integer output-weight unit, before both truncations."""
        a, b, t = self._batch(batch)
        local = sparse.coo_matrix(a)
        indices = b[local.row]*(2*self.hidden)+local.col
        values = local.data.astype(np.float64)*t[local.row]*(self.scale/(self.qa*self.qa*self.qb))
        return sparse.csr_matrix((values, (local.row, indices)), shape=(len(a), self.weight_count))

    def predict(self, batch, *, integer=True, delta=None):
        """Raw network White CP, excluding upstream search's material scaling."""
        a, b, t = self._batch(batch)
        if not integer:
            X = self.design(batch)
            weights = self.out_w.ravel().astype(np.float64)
            if delta is not None:
                d = np.asarray(delta, dtype=np.float64)
                if d.shape != weights.shape or not np.all(np.isfinite(d)):
                    raise ValueError("invalid floating head delta")
                weights += d
            return X @ weights+self.out_b[b]*t*(self.scale/(self.qa*self.qb))
        w = self.out_w.astype(np.int64)
        if delta is not None:
            w = w+_integer_vector(delta, self.weight_count, "head delta").reshape(w.shape)
            self._check_head(w, self.out_b)
        total = (a*w[b]).sum(axis=1)
        total = _trunc_div(total, self.qa)+self.out_b[b]
        return _trunc_div(total*self.scale, self.qa*self.qb)*t

    def patch(self, integer_delta):
        """Return a hash-bound sparse JSON patch and complete new bytes.

        Integer rounding is the caller's explicit decision; fractional deltas
        are rejected. The original payload and input arrays remain unchanged.
        """
        d = _integer_vector(integer_delta, self.weight_count, "head delta")
        w = self.out_w.astype(np.int64).ravel()+d
        self._check_head(w, self.out_b)
        changed = np.flatnonzero(d)
        body = {"schema": "chessy.chnn-output-patch.v1", "sourceSha256": self.source_sha256,
                "sourceBytes": len(self.payload), "outputWeightsOnly": True,
                "changes": [{"index": int(j), "old": int(self.out_w.ravel()[j]), "new": int(w[j])}
                            for j in changed]}
        payload = (self.payload[:self.output_offset]+w.astype("<i2").tobytes()
                   +self.payload[self.output_offset+self.weight_count*2:])
        body["resultSha256"] = _sha(payload)
        return body, payload

    def apply_patch(self, document):
        keys = {"schema", "sourceSha256", "sourceBytes", "outputWeightsOnly", "changes", "resultSha256"}
        if (not isinstance(document, dict) or document.keys() != keys
                or document["schema"] != "chessy.chnn-output-patch.v1"
                or document["sourceSha256"] != self.source_sha256
                or type(document["sourceBytes"]) is not int or document["sourceBytes"] != len(self.payload)
                or document["outputWeightsOnly"] is not True or not isinstance(document["changes"], list)):
            raise ValueError("patch is not bound to this source network")
        delta = np.zeros(self.weight_count, dtype=np.int64)
        seen = set()
        for edit in document["changes"]:
            if (not isinstance(edit, dict) or edit.keys() != {"index", "old", "new"}
                    or any(type(edit[k]) is not int for k in edit)):
                raise ValueError("invalid patch edit")
            j = edit["index"]
            if (not 0 <= j < self.weight_count or j in seen or edit["old"] != int(self.out_w.ravel()[j])
                    or edit["new"] == edit["old"] or not -32768 <= edit["new"] <= 32767):
                raise ValueError("patch has duplicate, mismatched or invalid coordinates")
            seen.add(j)
            delta[j] = edit["new"]-edit["old"]
        checked, payload = self.patch(delta)
        if checked["resultSha256"] != document["resultSha256"]:
            raise ValueError("patch result SHA-256 mismatch")
        return payload
