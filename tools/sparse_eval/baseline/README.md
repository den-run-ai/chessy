# Pinned standalone research baseline

These three files are exact, unmodified Git blobs from Chessy **r84**, commit
`5e3558378deab8ba21f648cc2cca98195b1beced`, the production baseline used in the
sparse-evaluator training and native runtime experiments. `manifest.json`
records original paths, Git blob IDs, byte counts and SHA-256 hashes.

The standalone Rust bridge imports these modules directly. Its Python HCE
reference reads the pinned `eval.rs` constants. Production `lib.rs` and the
WASM ABI are not part of this native bridge, so they are not copied here.

This snapshot prevents later production changes—such as r85's seeded-root
search API—from silently changing or breaking historical research code. It
does not change the shipped engine, and these files must not automatically
track production updates. A new experimental baseline needs its own explicit
identity and new evidence.

The initial results keep their original implementation and executable hashes.
Switching imports to this snapshot is a later packaging change, validated by
complete score parity. It does not retroactively assign historical timings or
training receipts to the packaged executable.

Repository `LICENSE` and `THIRD_PARTY_NOTICES.md` continue to apply; all original
source attribution is preserved.
