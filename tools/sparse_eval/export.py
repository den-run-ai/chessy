#!/usr/bin/env python3
"""Strict SPV1 sparse storage for the fixed 17,280-coefficient research model.

Format: ASCII SPV1, little-endian u32 nonzero count, then strictly increasing
(little-endian u16 feature ID, little-endian i16 nonzero coefficient) records.
Absent coefficients are exactly zero. The native runtime expands this at load
time into its existing tables: this saves artifact bytes, not evaluation work.
"""
from __future__ import annotations

import argparse
from array import array
import hashlib
import json
from numbers import Integral
import os
from pathlib import Path
import struct

MAGIC = b"SPV1"
DIMENSION = 17280
HEADER = struct.Struct("<4sI")
RECORD = struct.Struct("<Hh")


def encode(weights) -> bytes:
    """Encode one complete integer vector; never silently round or saturate."""
    if isinstance(weights, (str, bytes, bytearray, memoryview, dict)):
        raise TypeError("weights must be an integer coefficient sequence")
    try:
        count = len(weights)
    except TypeError as error:
        raise TypeError("weights must be a sized integer sequence") from error
    if count != DIMENSION:
        raise ValueError(f"expected exactly {DIMENSION} coefficients")
    records = bytearray()
    nonzero = 0
    for index, coefficient in enumerate(weights):
        if isinstance(coefficient, bool) or not isinstance(coefficient, Integral):
            raise TypeError("coefficients must be integers, not booleans or floats")
        coefficient = int(coefficient)
        if not -32768 <= coefficient <= 32767:
            raise ValueError("coefficient is outside signed int16 range")
        if coefficient:
            records.extend(RECORD.pack(index, coefficient))
            nonzero += 1
    return HEADER.pack(MAGIC, nonzero) + records


def decode(payload) -> array:
    """Decode strict SPV1 bytes to a dense native-endian array('h')."""
    if not isinstance(payload, (bytes, bytearray, memoryview)):
        raise TypeError("SPV1 payload must be bytes-like")
    payload = bytes(payload)
    if len(payload) < HEADER.size:
        raise ValueError("truncated SPV1 header")
    magic, count = HEADER.unpack_from(payload)
    if magic != MAGIC:
        raise ValueError("unknown sparse weight format")
    if count > DIMENSION or len(payload) != HEADER.size + count * RECORD.size:
        raise ValueError("SPV1 record count/length mismatch")
    weights = array("h", [0]) * DIMENSION
    previous = -1
    for index, coefficient in RECORD.iter_unpack(payload[HEADER.size:]):
        if index >= DIMENSION or index <= previous:
            raise ValueError("SPV1 IDs must be in range and strictly increasing")
        if coefficient == 0:
            raise ValueError("SPV1 zero coefficients must be omitted")
        weights[index] = coefficient
        previous = index
    return weights


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--decode", action="store_true", help="SPV1 input to little-endian dense i16 output")
    args = parser.parse_args()
    original = args.input.read_bytes()
    if args.decode:
        weights = decode(original)
        payload = struct.pack("<" + "h" * DIMENSION, *weights)
    else:
        if len(original) != DIMENSION * 2:
            raise ValueError("dense input must contain exactly 34560 bytes")
        weights = struct.unpack("<" + "h" * DIMENSION, original)
        payload = encode(weights)
    with open(args.output, "xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({"inputSha256": hashlib.sha256(original).hexdigest(),
                      "outputSha256": hashlib.sha256(payload).hexdigest(),
                      "inputBytes": len(original), "outputBytes": len(payload),
                      "nonzero": sum(coefficient != 0 for coefficient in weights),
                      "dimension": DIMENSION, "coefficientIdentityPreserved": True}, sort_keys=True))


if __name__ == "__main__":
    main()
