"""Preregistered research-only material-phase hybrid arithmetic."""
from __future__ import annotations
import numpy as np


def gate(phase, config):
    p = np.asarray(phase)
    if p.ndim != 1 or p.dtype.kind not in 'iu' or np.any((p < 0) | (p > 24)):
        raise ValueError('phase requires integer units in [0,24]')
    if config['kind'] == 'hard':
        t = config['threshold']
        if type(t) is not int or not 0 <= t < 24:
            raise ValueError('invalid hard threshold')
        return (p > t).astype(np.int64), 1
    if config['kind'] == 'smooth':
        lo, hi = config['lo'], config['hi']
        if type(lo) is not int or type(hi) is not int or not 0 <= lo < hi <= 24:
            raise ValueError('invalid smooth endpoints')
        return np.clip(p - lo, 0, hi - lo).astype(np.int64), hi - lo
    raise ValueError('unknown gate')


def blend(neural, fallback, phase, config, *, integer=True):
    n, f = np.asarray(neural), np.asarray(fallback)
    w, d = gate(phase, config)
    if n.shape != w.shape or f.shape != w.shape or not np.all(np.isfinite(n)) or not np.all(np.isfinite(f)):
        raise ValueError('invalid score arrays')
    if np.any(np.abs(n) > 10000) or np.any(np.abs(f) > 10000):
        raise ValueError('score bound exceeded')
    if integer:
        if n.dtype.kind not in 'iu' or f.dtype.kind not in 'iu':
            raise ValueError('integer blend requires integer cp')
        # White-perspective ties toward +infinity; do not reuse STM rounding.
        # d<=24 and |components|<=10000 prove numerator fits signed int32.
        return (2 * (w * n.astype(np.int64) + (d - w) * f.astype(np.int64)) + d) // (2 * d)
    return (w * n + (d - w) * f) / d
