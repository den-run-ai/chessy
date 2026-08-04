"""Reasoner = the per-node 'LLM sub-call'.

RuleBasedReasoner is a deterministic stand-in so the recursion scaffold can be
tested end-to-end without API access. AnthropicReasoner shows the intended
real implementation: one cheap model call per node, JSON out. The recursion
logic (recursion.py) is identical for both — that separation is the point.
"""
from __future__ import annotations
import json
import hashlib
import pathlib
import os
import urllib.request
import chess
from .labels import Motif, NodeAnnotation
from .features import node_features, material_cp


class Reasoner:
    def label_node(self, board: chess.Board, move_in, pov,
                   child_annotations: list[NodeAnnotation]) -> NodeAnnotation:
        raise NotImplementedError

    def compose_tree(self, summary: dict) -> NodeAnnotation | None:
        """Optional tree-level judgment given BOTH branches (the contrast).
        Rule-based reasoners return None; LLM reasoners implement it so we
        can test whether the model itself recognises tree-level motifs like
        the intermezzo when shown the contrastive evidence."""
        return None


class RuleBasedReasoner(Reasoner):
    """Deterministic per-node labeller mimicking what one LLM sub-call should
    return given (node features + already-labelled children)."""

    def __init__(self, root_material_cp: int):
        self.root_material = root_material_cp
        self.calls = 0

    def label_node(self, board, move_in, pov, child_annotations):
        self.calls += 1
        f = node_features(board, move_in, pov)
        ann = NodeAnnotation()
        ann.material_delta_cp = f["material_cp"] - self.root_material
        ann.evidence["features"] = {k: v for k, v in f.items()
                                    if k in ("pins", "hanging", "fork_targets",
                                             "discovered_check")}
        bits = []

        if f.get("mate"):
            ann.motifs.append(Motif.MATE_THREAT)
            bits.append("checkmate on the board")
        if f.get("discovered_check"):
            ann.motifs.append(Motif.DISCOVERED_CHECK)
            bits.append("discovered check")
        if len(f.get("fork_targets", [])) >= 2:
            ann.motifs.append(Motif.FORK)
            sq = [t["square"] for t in f["fork_targets"]]
            bits.append(f"fork hitting {', '.join(sq)}")
        if any(p["value"] >= 300 for p in f.get("pins", [])):
            ann.motifs.append(Motif.PIN)
            bits.append("pinned piece")
        if f.get("hanging"):
            ann.motifs.append(Motif.HANGING_PIECE)

        # inherit motifs proven deeper in the line (semantic backup)
        for ca in child_annotations:
            for m in ca.motifs:
                if m not in ann.motifs and m != Motif.QUIET:
                    ann.motifs.append(m)
            if ca.narrative and not bits:
                bits.append(ca.narrative)

        ann.narrative = "; ".join(bits) if bits else ""
        return ann


class AnthropicReasoner(Reasoner):
    """Real recursive-LLM sub-call (one small-model call per node).
    Requires ANTHROPIC_API_KEY. Untested in the sandbox; provided to show
    the swap-in surface is ~40 lines."""

    MODEL = "claude-haiku-4-5-20251001"
    PROMPT = (
        "You are labelling ONE node of a chess analysis tree.\n"
        "Position (FEN): {fen}\nMove that led here: {move}\n"
        "Node features (JSON): {features}\n"
        "Child-node labels already computed (JSON): {children}\n"
        "Return STRICT JSON: {{\"motifs\": [..], \"narrative\": \"..\"}} "
        "using motif ids: fork, pin, skewer, discoveredAttack, "
        "discoveredCheck, deflection, hangingPiece, mateThreat, quiet."
    )

    def __init__(self):
        self.key = os.environ.get("ANTHROPIC_API_KEY")
        if not self.key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        self.calls = 0

    def label_node(self, board, move_in, pov, child_annotations):
        self.calls += 1
        f = node_features(board, move_in, pov)
        body = json.dumps({
            "model": self.MODEL, "max_tokens": 300,
            "messages": [{"role": "user", "content": self.PROMPT.format(
                fen=board.fen(), move=move_in.uci() if move_in else "root",
                features=json.dumps(f, default=str),
                children=json.dumps([{"motifs": [m.value for m in c.motifs],
                                      "narrative": c.narrative}
                                     for c in child_annotations]))}]
        }).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages", data=body,
            headers={"content-type": "application/json",
                     "x-api-key": self.key,
                     "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
        text = "".join(b["text"] for b in data["content"]
                       if b["type"] == "text")
        parsed = json.loads(text.strip().removeprefix("```json")
                            .removesuffix("```"))
        ann = NodeAnnotation(
            motifs=[Motif(m) for m in parsed.get("motifs", [])
                    if m in Motif._value2member_map_],
            narrative=parsed.get("narrative", ""))
        ann.material_delta_cp = material_cp(board, pov)
        return ann


class OpenRouterReasoner(Reasoner):
    """Recursive-LLM reasoner via OpenRouter (OpenAI-compatible API).

    - key from env OPENROUTER_API_KEY (never hard-code keys)
    - one small-model call per node + one tree-level compose call per position
    - temperature 0, strict JSON out, fenced-JSON tolerated
    - on-disk cache keyed by (model, prompt) so re-runs don't re-spend budget
    - token usage accumulated in `usage` for cost reporting
    """
    URL = "https://openrouter.ai/api/v1/chat/completions"

    NODE_PROMPT = (
        "You are one sub-call in a recursive chess-analysis system, labelling "
        "ONE node of a search tree.\n"
        "Position after the move (FEN): {fen}\nMove that led here: {move}\n"
        "Point of view: {pov} (the side whose tactic we are analysing).\n"
        "Node features (JSON): {features}\n"
        "Labels of this node's child nodes, already computed: {children}\n\n"
        "Identify tactical motifs visible AT THIS NODE or proven by the "
        "children. Allowed motif ids: fork, pin, skewer, discoveredAttack, "
        "discoveredCheck, deflection, hangingPiece, mateThreat, quiet.\n"
        'Reply with STRICT JSON only: {{"motifs": ["..."], '
        '"narrative": "<=20 words"}}'
    )

    COMPOSE_PROMPT = (
        "You are the ROOT call of a recursive chess-analysis system. You see "
        "a minimal contrastive tree: the engine's best line versus the "
        "'natural' human reply (e.g. automatic recapture).\n"
        "Root position (FEN): {fen}, {pov} to move.\n"
        "NATURAL move: {nat} -> engine eval {nat_cp}cp for {pov}.\n"
        "BEST move: {best} -> engine eval {best_cp}cp for {pov}.\n"
        "Best line (SAN): {best_line}\nNatural line (SAN): {nat_line}\n"
        "Motifs already found at nodes of the best line: {node_motifs}\n\n"
        "Judge TREE-LEVEL motifs that only exist in the contrast between the "
        "two lines. Allowed ids: intermezzo, deflection, fork, pin, skewer, "
        "discoveredAttack, discoveredCheck, mateThreat, quiet. In particular: "
        "is the best move an intermezzo (zwischenzug), i.e. a forcing "
        "in-between move played INSTEAD of the natural reply, after which "
        "the deferred gain still lands?\n"
        'Reply with STRICT JSON only: {{"motifs": ["..."], '
        '"narrative": "<=30 words"}}'
    )

    def __init__(self, model: str = "google/gemini-3.6-flash",
                 usage: dict | None = None,
                 cache_dir: str = ".llmcache"):
        self.key = os.environ.get("OPENROUTER_API_KEY")
        if not self.key:
            raise RuntimeError("Set OPENROUTER_API_KEY (do not hard-code it).")
        self.model = model
        self.calls = 0
        self.usage = usage if usage is not None else {"in": 0, "out": 0}
        self.cache = pathlib.Path(cache_dir)
        self.cache.mkdir(exist_ok=True)

    # ---- plumbing -----------------------------------------------------------
    def _call(self, prompt: str) -> dict:
        h = hashlib.sha1((self.model + prompt).encode()).hexdigest()
        cached = self.cache / f"{h}.json"
        if cached.exists():
            return json.loads(cached.read_text())
        # max_tokens is headroom, not spend: gemini-3.6-flash burns ~300-600
        # hidden reasoning tokens per call, and a 400 cap truncates the JSON.
        body = json.dumps({
            "model": self.model, "temperature": 0, "max_tokens": 2000,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        req = urllib.request.Request(self.URL, data=body, headers={
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        self.calls += 1
        u = data.get("usage", {})
        self.usage["in"] += u.get("prompt_tokens", 0)
        self.usage["out"] += u.get("completion_tokens", 0)
        text = data["choices"][0]["message"]["content"]
        text = text.strip().removeprefix("```json").removeprefix("```")
        text = text.removesuffix("```").strip()
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = {"motifs": [], "narrative": text[:80]}
        cached.write_text(json.dumps(parsed))
        return parsed

    @staticmethod
    def _to_ann(parsed: dict) -> NodeAnnotation:
        return NodeAnnotation(
            motifs=[Motif(m) for m in parsed.get("motifs", [])
                    if m in Motif._value2member_map_],
            narrative=str(parsed.get("narrative", ""))[:160])

    # ---- Reasoner interface -------------------------------------------------
    def label_node(self, board, move_in, pov, child_annotations):
        f = node_features(board, move_in, pov)
        prompt = self.NODE_PROMPT.format(
            fen=board.fen(), move=move_in.uci() if move_in else "(root)",
            pov="white" if pov else "black",
            features=json.dumps(f, default=str),
            children=json.dumps([{"motifs": [m.value for m in c.motifs],
                                  "narrative": c.narrative}
                                 for c in child_annotations]))
        ann = self._to_ann(self._call(prompt))
        ann.material_delta_cp = material_cp(board, pov)
        return ann

    def compose_tree(self, summary):
        return self._to_ann(self._call(self.COMPOSE_PROMPT.format(**summary)))
