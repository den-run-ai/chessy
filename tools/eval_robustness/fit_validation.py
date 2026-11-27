"""Evaluate frozen shrinkage on the previously exposed quiet-position validation set."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.sparse_eval.fit import metrics

# Score exports and packed validation arrays from the authenticated #202 refit.
INPUTS = {
    "hce": ("hce.validation.i32", "<i4", "a7b08bcbb6bb2dc60d9d866ee5b18ee6dbff9e2e76c5e3f3aaae002e42f3351e"),
    "full": ("full.validation.i32", "<i4", "7a615c0166b8cf94b6dcc4203f3284f9679dcc9bc707e92a25306b25ca06dc28"),
    "noPawn": ("refit-no-pawn.validation.i32", "<i4", "1d9d06f813ddf2e2c94f111d412d0562876b32bb374aa7e9d5b178f3d9339853"),
    "teacher": ("packed/validation.teacher.f64", "<f8", "2bf88496e93968f3d97d03e0fbdbfb8b04430612aef11f7bd1cbe6420820e2c0"),
    "phase": ("packed/validation.phase.u8", "u1", "36a71d708755af1d089fcb54106a7dab8e019cd335996b3b5e3ddad8b76c2758"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("refit_study", type=Path)
    parser.add_argument("fit_results", type=Path)
    args = parser.parse_args()
    fit_raw = args.fit_results.read_bytes()
    recipe = json.loads(fit_raw)["fits"]["calibrated"]
    numerator = recipe["numerator"]
    if type(numerator) is not int or not 0 <= numerator <= 16 or recipe["denominator"] != 16:
        raise ValueError("invalid exported scale")
    data = {}
    for name, (path, dtype, expected) in INPUTS.items():
        raw = (args.refit_study / path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError(f"validation snapshot mismatch: {name}")
        data[name] = np.frombuffer(raw, dtype=dtype)
    teachers, phase = data.pop("teacher"), data.pop("phase")
    scaled = (data["noPawn"] - data["hce"]) * numerator
    data["calibrated"] = data["hce"] + np.sign(scaled) * (np.abs(scaled) // 16)
    print(json.dumps({"researchOnly": True, "schema": "chessy.hard-position-quiet-validation.v1",
                      "purpose": "Previously exposed validation rows only; retrospective transfer diagnostic.",
                      "fitResultsSha256": hashlib.sha256(fit_raw).hexdigest(), "numerator": numerator,
                      "denominator": 16, "results": {k: metrics(v, teachers, phase) for k, v in data.items()}},
                     indent=2, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
