"""Aggregate the Lichess run JSONL into the report tables.

Adds a tag-verifiable precision metric: a predicted motif counts as verified
if its mapped Lichess theme appears anywhere in the puzzle's full tag list.
(Recall is scored against the SAMPLED theme only; precision uses all tags.)
"""
import collections
import json
import pathlib
import sys

MOTIF_TO_TAGS = {
    "fork": {"fork"}, "pin": {"pin"}, "skewer": {"skewer"},
    "discoveredAttack": {"discoveredAttack"},
    "discoveredCheck": {"discoveredAttack", "doubleCheck"},
    "intermezzo": {"intermezzo"}, "deflection": {"deflection", "attraction"},
    "hangingPiece": {"hangingPiece"},
    "mateThreat": {"mate", "mateIn1", "mateIn2", "mateIn3", "mateIn4", "mateIn5"},
}
COLS = ["static", "rules", "llm", "llm_only"]
BANDS = [(800, 1200), (1200, 1800), (1800, 2401)]


def main(path):
    recs = [json.loads(l) for l in open(path) if l.strip()]
    ok = [r for r in recs if "hits" in r]
    errs = [r for r in recs if "error" in r]

    print(f"scored {len(ok)} puzzles, {len(errs)} errors\n")
    print(f"{'theme':18}{'n':>3}" + "".join(f"{c:>9}" for c in COLS)
          + f"{'nat?':>6}{'eng=':>6}")
    per = collections.defaultdict(list)
    for r in ok:
        per[r["theme"]].append(r)
    for t in sorted(per, key=lambda t: -len(per[t])):
        rs = per[t]
        row = [sum(r["hits"][c] for r in rs) for c in COLS]
        print(f"{t:18}{len(rs):>3}" + "".join(f"{v:>9}" for v in row)
              + f"{sum(r['natural_exists'] for r in rs):>6}"
              + f"{sum(r['engine_matches_solution'] for r in rs):>6}")
    tot = [sum(r["hits"][c] for r in ok) for c in COLS]
    print(f"{'TOTAL':18}{len(ok):>3}" + "".join(f"{v:>9}" for v in tot))
    print(f"{'':21}" + "".join(f"{100 * v / len(ok):>8.0f}%" for v in tot))

    print("\n--- recall by rating band (llm_only) ---")
    for lo, hi in BANDS:
        rs = [r for r in ok if lo <= r["rating"] < hi]
        if rs:
            h = sum(r["hits"]["llm_only"] for r in rs)
            print(f"  {lo}-{hi - 1}: {h}/{len(rs)}")

    print("\n--- tag-verifiable precision (predictions found in full tag set) ---")
    for c in ["static", "rules", "llm_only"]:
        good = total = 0
        for r in ok:
            tags = set(r["themes_all"].split())
            for m in r.get(c, []):
                if m in MOTIF_TO_TAGS:
                    total += 1
                    good += bool(MOTIF_TO_TAGS[m] & tags)
        print(f"  {c:10} {good}/{total} = {100 * good / max(total, 1):.0f}%")

    print("\n--- system disagreements ---")
    print("llm>rules:", [(r["id"], r["theme"]) for r in ok
                         if r["hits"]["llm"] and not r["hits"]["rules"]])
    print("rules>llm:", [(r["id"], r["theme"]) for r in ok
                         if r["hits"]["rules"] and not r["hits"]["llm"]])
    print("hybrid>llm_only:", [(r["id"], r["theme"]) for r in ok
                               if r["hits"]["llm"] and not r["hits"]["llm_only"]])

    comp = [r for r in ok if r.get("compose")]
    hist = collections.Counter(m for r in comp for m in r["compose"])
    print(f"\ncompose fired {len(comp)}x, verdict histogram: {dict(hist)}")

    misses = [r for r in ok if not r["hits"]["llm"]]
    print(f"\n--- all hybrid-LLM misses ({len(misses)}) ---")
    for r in misses:
        print(f"  {r['id']} {r['theme']:16} r{r['rating']} nat={r['natural_exists']}"
              f" eng={r['engine_matches_solution']} llm_only={r['llm_only']}")

    if ok:
        last = recs[-1].get("cum_tokens", {})
        est = last.get("in", 0) / 1e6 * 1.50 + last.get("out", 0) / 1e6 * 7.50
        print(f"\nsession tokens: {last.get('in', 0)} in / {last.get('out', 0)} out"
              f" ≈ ${est:.2f} | wall {sum(r.get('dt', 0) for r in recs):.0f}s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else
         pathlib.Path(__file__).parent / "lichess/results_gemini-3.6-flash.jsonl")
