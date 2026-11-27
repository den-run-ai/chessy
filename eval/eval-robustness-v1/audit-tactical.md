# Frozen evaluator on tactical positions

The original transfer test screened out positions where Stockfish recommended a capture, check, or promotion. The archived UCI transcripts recover scores for all 344 such positions while preserving the other admission criteria. Each score came from Stockfish 18 with at least 100,000 reported nodes. Each row represents a different recorded game and structural family. The move played in the original game was quiet, and the player to move was outside check.

| SF18 first move | Roots | HCE MAE | Full model MAE | Relative MAE reduction, nominal 95% interval | HCE → full score-sign accuracy |
|---|---:|---:|---:|---:|---:|
| Tactical | 344 | 204.71 cp | 198.17 cp | 3.19% (−0.99% to 7.29%) | 86.34% → 86.34% |
| Quiet | 2,425 | 153.58 cp | 146.83 cp | 4.39% (2.54% to 6.32%) | 89.94% → 89.90% |

Both evaluators had larger errors on the tactical sample. The full model's tactical error was slightly lower on average. Sampling uncertainty allows either sign of that difference. The 99th-percentile tactical error was 753 cp for HCE and 752 cp for the full model. This comparison measures agreement with teacher scores at the roots. It leaves move choice and game strength to the search experiments.

The audit joins all 4,096 historical roots to their authenticated UCI traces, replays legal histories and PVs when admitting centipawn labels, and relaxes only the restriction on the teacher's first move. The other 1,327 roots comprise 1,166 bounded reports, 160 mate scores, and one search below budget. The original native evaluator and full integer weights reproduce the previously published quiet scores byte for byte. The 4,000 paired bootstrap samples preserve the phase counts within each cohort. The intervals describe each metric separately and may understate dependence between games with similar openings or players. Neither cohort supplied training or model selection for this audit.

[Full results and input hashes](audit-tactical.json) · [Historical corpus and admission rules](../sparse-pesto-v1/OOD.md)

## Reproduce on Linux x86-64

From the repository root, extract the two small inputs and the original native executable from the previously delivered archive. The Python command prints the full JSON report.

```sh
mkdir -p /tmp/sparse-pesto-transfer
tar --zstd -xf chessy-sparse-pesto-data-and-evidence.tar.zst \
  -C /tmp/sparse-pesto-transfer data/ood-labels-v1 ood-evaluation-v1/sparse-eval
python -m tools.eval_robustness.audit_tactical /tmp/sparse-pesto-transfer
```
