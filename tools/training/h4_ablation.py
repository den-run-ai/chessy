"""Fail closed on the retired v1 material/mop-up ambiguity.

No corrected real-data ablation is run here. A later experiment needs a new
registered contract; the original v1 contract/results remain immutable.
"""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def require_explicit_mop_up(contract):
    if "net-plus-existing-fixed-mop-up" in contract["model"]["variants"]:
        if contract["model"].get("additiveFeature") != "mopUpCp":
            raise ValueError("retired/ambiguous mop-up contract: fixedCp includes material; a new preregistration must explicitly name mopUpCp")


def mop_up_reference(fens):
    """Semantic reference for authored fixtures; not a new v1 scoring pass."""
    script = """
const fs=require('fs'), L=require('./test/training/hce-r3-linear');
const result=JSON.parse(fs.readFileSync(0,'utf8')).map(fen=>{
 const c=L.compile(fen);
 if(Math.abs(c.fixedCp-(c.fixedTaperCp+c.mopUpCp))>1e-9)throw Error('fixed-term decomposition');
 return {mopUpCp:c.mopUpCp,fixedTaperCp:c.fixedTaperCp,fixedCp:c.fixedCp};
});process.stdout.write(JSON.stringify(result));
"""
    return json.loads(subprocess.check_output(["node", "-e", script], cwd=ROOT, input=json.dumps(fens).encode()))
