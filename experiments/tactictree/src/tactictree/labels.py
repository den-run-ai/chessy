"""Tactic taxonomy and tree data structures.

A TreeNode is one position in the minimal contrastive tree. Annotations are
attached per-node by a Reasoner (rule-based stand-in today, LLM sub-call later)
and composed upward — "semantic minimax backup".
"""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import chess


class Motif(str, Enum):
    FORK = "fork"
    PIN = "pin"
    SKEWER = "skewer"
    DISCOVERED_ATTACK = "discoveredAttack"
    DISCOVERED_CHECK = "discoveredCheck"
    INTERMEZZO = "intermezzo"          # zwischenzug — tree-level, not node-level
    DEFLECTION = "deflection"
    HANGING_PIECE = "hangingPiece"
    MATE_THREAT = "mateThreat"
    QUIET = "quiet"                    # control label: no tactic found


# Which branch of the contrastive tree a node belongs to.
BRANCH_BEST = "best"        # engine principal variation
BRANCH_NATURAL = "natural"  # refutation of the human-expected move


@dataclass
class NodeAnnotation:
    """What one reasoner sub-call returns for one node."""
    motifs: list[Motif] = field(default_factory=list)
    narrative: str = ""                 # one-line human explanation
    material_delta_cp: int = 0          # vs. root, from root-mover's POV
    evidence: dict = field(default_factory=dict)


@dataclass
class TreeNode:
    board: chess.Board                  # position AFTER move_in was played
    move_in: Optional[chess.Move]       # move that led here (None at root)
    branch: str                         # BRANCH_BEST / BRANCH_NATURAL / "root"
    ply: int
    eval_cp: Optional[int] = None       # engine eval, root-mover POV
    children: list["TreeNode"] = field(default_factory=list)
    annotation: Optional[NodeAnnotation] = None
    is_forcing: bool = False            # move_in was check/capture/mate threat

    def san_path(self) -> str:
        return self.board.fen()

    def size(self) -> int:
        return 1 + sum(c.size() for c in self.children)


@dataclass
class TreeReport:
    """Final output of recursive labelling for one position."""
    root_fen: str
    best_move_san: str
    natural_move_san: Optional[str]
    eval_best_cp: int
    eval_natural_cp: Optional[int]
    motifs: list[Motif]
    narrative: str
    node_count: int
    llm_subcalls_simulated: int
    llm_motifs: Optional[list[Motif]] = None   # tree-level motifs judged by LLM
    llm_narrative: str = ""
