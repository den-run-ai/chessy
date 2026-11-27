#!/usr/bin/env python3
"""Plot a completed, replay-audited equal-time development campaign.

Usage, after the retained games.py audit has produced audit.json::

    python3 -m tools.eval_pipeline.plot --results RUN/audit.json \
        --output FIGURES/equal-time-frontier --score-axis

Creates equal-time-frontier.png, .svg, and .json without replacing any file.
The JSON receipt binds the audited input, plot source, and both images. The
figure shows only registered time controls: no fitted curve, interpolation,
absolute rating calibration, or production activation is inferred.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import textwrap

try:
    from . import frontier
except ImportError:
    import frontier


def validate(report):
    """Accept only a complete report with its separate campaign replay audit."""
    require = frontier.require
    require(report.get("schema") == frontier.SCHEMA + ".report"
            and report.get("status") == "complete-development-screen"
            and report.get("completeSchedule") is True,
            "a complete frontier report is required")
    require(report.get("researchOnly") is True and report.get("productionAdmission") is False
            and report.get("formalPass") is False and report.get("policy", {}).get("productionEnable") is False,
            "plot is development-only")
    audit = report.get("campaignAudit", {})
    require(audit.get("status") == "pass" and audit.get("fullHistoryVerified") is True
            and audit.get("javascriptRulesReplayVerified") is True
            and audit.get("gamesReplayed") == audit.get("pgnsVerified") == report.get("games")
            and audit.get("searchesRerun") == 0,
            "complete independent history/PGN audit is required; bare analyzer output is insufficient")
    profiles = report.get("profiles", [])
    times = [row["timeMs"] for row in profiles]
    require(len(profiles) >= 2 and all(type(t) is int and t > 0 for t in times)
            and times == sorted(set(times)), "invalid registered time grid")
    require(sum(row["games"] for row in profiles) == report["games"], "incomplete game totals")
    for row in profiles:
        count = row["games"]
        require(type(count) is int and count > 0 and row["openingPairs"] * 2 == count,
                "incomplete opening pairs")
        require(all(type(row[k]) is int and row[k] >= 0 for k in ("wins", "draws", "losses"))
                and row["wins"] + row["draws"] + row["losses"] == count,
                "inconsistent game results")
        point = (row["wins"] + .5 * row["draws"]) / count
        require(math.isclose(point, row["candidateScore"], abs_tol=1e-12), "inconsistent game score")
        interval = row["simultaneousInterval"]
        require(isinstance(interval, list) and len(interval) == 2
                and 0 <= interval[0] <= point <= interval[1] <= 1, "invalid simultaneous score interval")
        elo = row["relativeElo"]
        expected = [frontier.relative_elo(value) for value in (point, *interval)]
        for have, want in zip([elo["point"], *elo["interval"]], expected):
            require(have is None if want is None else have is not None and math.isclose(have, want, abs_tol=1e-9),
                    "relative Elo does not match the audited score transform")
        reasons = row["terminationCounts"]
        require(all(type(n) is int and n >= 0 for n in reasons.values())
                and sum(reasons.values()) == count and reasons.get("ply-cap", 0) <= row["draws"],
                "invalid termination/cap counts")
    bootstrap = report["bootstrap"]
    require(bootstrap.get("method") == "paired-cluster-bootstrap-bonferroni-percentile"
            and bootstrap.get("sameClusterDrawAcrossTimeGrid") is True
            and 0 < bootstrap["confidence"] < 1, "unsupported uncertainty method")
    require([row["timeMs"] for row in report.get("timing", [])] == times,
            "measured-time audit must cover the complete grid")
    return profiles


def build_figure(report, score_axis=False):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator
    import numpy as np

    profiles = validate(report)
    times = [row["timeMs"] for row in profiles]
    finite = [value for row in profiles for value in [row["relativeElo"]["point"], *row["relativeElo"]["interval"]]
              if value is not None]
    extent = max(100, math.ceil(max((abs(value) for value in finite), default=0) / 50) * 50)
    if any(value is None for row in profiles for value in row["relativeElo"]["interval"]):
        extent = max(extent, 400)
    limit = extent * 1.16
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "svg.fonttype": "none",
                         "svg.hashsalt": "chessy-equal-time-frontier-v1"})
    fig = plt.figure(figsize=(12, 8), facecolor="#ffffff")
    ax = fig.add_axes([.10, .34, .79 if score_axis else .84, .43])
    ax.set_xscale("log")
    ax.set_xlim(times[0] / 1.35, times[-1] * 1.35)
    ax.set_ylim(-limit, limit)
    ax.xaxis.set_major_locator(FixedLocator(times))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:g}"))
    ax.xaxis.set_minor_locator(NullLocator())
    ax.grid(axis="y", color="#e2e8f0", linewidth=.8)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("bottom", "left"):
        ax.spines[spine].set_color("#94a3b8")
    ax.axhline(0, color="#475569", linewidth=1.15, linestyle=(0, (4, 3)))
    failed = {row["timeMs"] for row in report["timing"] if not row["cleanRealizedEqualTime"]}
    unbounded = False
    for row in profiles:
        time_ms = row["timeMs"]
        elo = row["relativeElo"]
        color = "#b45309" if time_ms in failed else "#0f766e"
        lower = -limit * .96 if elo["interval"][0] is None else elo["interval"][0]
        upper = limit * .96 if elo["interval"][1] is None else elo["interval"][1]
        point = elo["point"]
        if point is None:
            point = limit * .88 * (1 if row["candidateScore"] == 1 else -1)
        ax.vlines(time_ms, lower, upper, color=color, alpha=.18, linewidth=12)
        ax.vlines(time_ms, lower, upper, color=color, linewidth=1.8)
        for bound, direction in ((elo["interval"][0], -1), (elo["interval"][1], 1)):
            if bound is None:
                unbounded = True
                ax.annotate("", xy=(time_ms, direction * limit * .98),
                            xytext=(time_ms, direction * limit * .86),
                            arrowprops={"arrowstyle": "-|>", "color": color, "lw": 1.8})
            else:
                ax.plot([time_ms / 1.025, time_ms * 1.025], [bound, bound], color=color, linewidth=1.8)
        ax.scatter([time_ms], [point], s=72, marker="X" if time_ms in failed else "o",
                   color=color, edgecolor="white", linewidth=.9, zorder=3)
        label = f"{row['candidateScore']:.1%}"
        if elo["point"] is None:
            label += " / " + ("+∞" if row["candidateScore"] == 1 else "−∞")
        ax.annotate(label, (time_ms, point), xytext=(10, 9), textcoords="offset points",
                    fontsize=10, color=color, weight="semibold")
    ax.set_xlabel("Registered budget per move (ms, logarithmic spacing)", labelpad=12)
    ax.set_ylabel("Relative Elo against the paired HCE", labelpad=12)
    if score_axis:
        def to_score(value):
            return 1 / (1 + np.power(10., -np.asarray(value) / 400))

        def to_elo(value):
            value = np.clip(np.asarray(value), 1e-12, 1 - 1e-12)
            return 400 * np.log10(value / (1 - value))

        right = ax.secondary_yaxis("right", functions=(to_score, to_elo))
        right.set_ylabel("Candidate score (equivalent scale)", labelpad=12)
        right.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:.0%}"))
        right.spines["right"].set_color("#94a3b8")
    confidence = report["bootstrap"]["confidence"] * 100
    handles = [Line2D([0], [0], marker="o", color="#0f766e", linewidth=1.8,
                      label=f"Point and nominal simultaneous {confidence:g}% interval"),
               Line2D([0], [0], color="#475569", linestyle="--", label="Parity (50% score)")]
    if failed:
        handles.append(Line2D([0], [0], marker="X", color="#b45309", linestyle="none",
                              label="Measured-time check failed"))
    fig.legend(handles=handles, loc="upper left", bbox_to_anchor=(.09, .837), frameon=False, fontsize=10,
               ncol=1 if failed else 2, handlelength=2.0)
    fig.text(.10, .94, "Does richer evaluation earn its time?", fontsize=21, weight="bold", color="#0f172a")
    fig.text(.10, .897, "Development screen · not a calibrated human rating", fontsize=12, color="#475569")
    fig.text(.10, .858, f"{report['candidate']['id']} vs {report['base']['id']}  |  "
             f"{report['games']} audited complete games  |  {report['bootstrap']['clusterCount']} opening-family clusters",
             fontsize=10, color="#475569")
    caps = "; ".join(f"{row['timeMs']} ms: {row['terminationCounts'].get('ply-cap', 0)}/{row['games']}"
                     for row in profiles)
    caption = (f"Ply-cap draws / games — {caps}. Draws count as half a point. "
               f"Both colors and all times stay together in {report['bootstrap']['replicates']:,} cluster resamples; "
               f"Bonferroni percentile intervals cover the {len(profiles)}-control grid nominally and remain approximate. "
               "The points describe this exact evaluator pair, openings, host, and runtime. "
               "No curve is fitted between tested budgets. This development evidence does not enable production.")
    if failed:
        caption += " Timing-check failures retain their outcomes but cannot qualify for confirmation."
    if unbounded:
        caption += " Arrows show unbounded Elo interval endpoints; they are not finite clipped estimates."
    fig.text(.10, .229, textwrap.fill(caption, 126), va="top", fontsize=9.3, linespacing=1.45, color="#475569")
    fig.text(.10, .04, "Experiment: " + report["experimentId"], fontsize=8.5, color="#64748b")
    return fig, matplotlib.__version__


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--results", type=Path, required=True, help="complete campaign audit.json")
    parser.add_argument("--output", type=Path, required=True, help="new output filename prefix (without extension)")
    parser.add_argument("--score-axis", action="store_true", help="show the equivalent candidate-score scale at right")
    args = parser.parse_args()
    raw = args.results.read_bytes()
    report = frontier.decoded(raw)
    outputs = {suffix: args.output.with_name(args.output.name + "." + suffix) for suffix in ("png", "svg", "json")}
    frontier.require(not any(path.exists() or path.is_symlink() for path in outputs.values()),
                     "plot outputs already exist; replacement is forbidden")
    fig, version = build_figure(report, args.score_axis)
    payloads = {}
    for suffix in ("png", "svg"):
        stream = io.BytesIO()
        metadata = {"Title": "Chessy equal-time evaluator frontier",
                    "Description": "Complete audited development games; relative Elo is not a human rating."}
        if suffix == "svg":
            metadata["Date"] = None
        fig.savefig(stream, format=suffix, dpi=180, metadata=metadata, facecolor="white")
        payloads[suffix] = stream.getvalue()
    receipt = {"schema": "chessy.eval-frontier-figure.v1", "researchOnly": True, "productionAdmission": False,
               "resultsSha256": hashlib.sha256(raw).hexdigest(),
               "plotSourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "matplotlibVersion": version, "scoreAxis": args.score_axis,
               "experimentId": report["experimentId"], "campaignAudit": report["campaignAudit"]["registrationSha256"],
               "files": {suffix: {"name": outputs[suffix].name, "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest()} for suffix, data in payloads.items()}}
    payloads["json"] = (json.dumps(receipt, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for suffix, data in payloads.items():
        with outputs[suffix].open("xb") as stream:
            stream.write(data)
    print(json.dumps({"files": [str(path) for path in outputs.values()], "resultsSha256": receipt["resultsSha256"]}))


if __name__ == "__main__":
    main()
