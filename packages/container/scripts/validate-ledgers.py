#!/usr/bin/env python3
"""Check the audit and evidence ledgers' hash chains, and optionally their heads against an anchor.

The chain (sequence, previous_hash, record_hash) detects accidental damage: a lost, reordered or
edited line. It cannot detect a deliberate rewrite by whoever can write the data root, because
they can recompute every hash. The anchor closes part of that gap: `--write-anchor FILE` records
each ledger's head (record count and last record_hash) in a file the operator keeps OUTSIDE the
data root (the container cannot write it), and `--anchor FILE` then requires every anchored head
to still be in the ledger at the same sequence with the same hash. A rewrite of anchored history,
or a truncation below the anchor, fails; records appended after the anchor are only chain-checked.
tests/ledger-anchor-smoke.ts pins both behaviours.
"""
import argparse
import hashlib
import json
import pathlib
import sys


DEFAULT_DATA_ROOT = pathlib.Path("/srv/data/pi-system")


def stable_json(value) -> str:
    return json.dumps(value, sort_keys=True, indent=2, separators=(",", ": "))


def hash_record(record) -> str:
    return hashlib.sha256(stable_json(record).encode("utf-8")).hexdigest()


def validate_ledger(path: pathlib.Path, heads=None, anchor=None) -> int:
    """Chain-check one ledger. `heads` (a dict) receives {sequence, record_hash} per record; `anchor`
    is the {count, record_hash} this ledger must still contain."""
    if not path.exists():
        if anchor and anchor.get("count", 0) > 0:
            print(f"{path}: ledger is missing but the anchor records {anchor['count']} record(s)", file=sys.stderr)
            return 1
        print(f"Ledger absent, skipping: {path}")
        return 0

    previous_hash = ""
    expected_sequence = 1
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except Exception as exc:
                print(f"{path}:{line_number}: invalid JSON: {exc}", file=sys.stderr)
                return 1

            record_hash = record.get("record_hash")
            base_record = dict(record)
            base_record.pop("record_hash", None)

            if record.get("sequence") != expected_sequence:
                print(f"{path}:{line_number}: invalid sequence", file=sys.stderr)
                return 1
            if record.get("previous_hash") != previous_hash:
                print(f"{path}:{line_number}: previous_hash does not match prior record", file=sys.stderr)
                return 1
            if record_hash != hash_record(base_record):
                print(f"{path}:{line_number}: record_hash does not match record contents", file=sys.stderr)
                return 1

            if heads is not None:
                heads[expected_sequence] = record_hash
            previous_hash = record_hash
            expected_sequence += 1

    if anchor:
        count = anchor.get("count")
        if count and heads is not None:
            if count > expected_sequence - 1:
                print(f"{path}: has {expected_sequence - 1} record(s) but the anchor records {count}: history was removed", file=sys.stderr)
                return 1
            if heads.get(count) != anchor.get("record_hash"):
                print(f"{path}: record {count} no longer has the anchored hash: anchored history was rewritten", file=sys.stderr)
                return 1
    print(f"Ledger integrity checks passed: {path}")
    return 0


LEDGERS = {"audit": pathlib.Path("audit") / "audit.jsonl", "evidence": pathlib.Path("evidence") / "ledger.jsonl"}


def inside(child: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", default=str(DEFAULT_DATA_ROOT))
    parser.add_argument("--anchor", help="check each ledger still contains the head recorded in this file")
    parser.add_argument("--write-anchor", help="after checking, record each ledger's head in this file (outside the data root)")
    args = parser.parse_args()
    data_root = pathlib.Path(args.data_root)

    anchors = {}
    if args.anchor:
        anchor_path = pathlib.Path(args.anchor)
        try:
            loaded = json.loads(anchor_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"{anchor_path}: cannot read the anchor: {exc}", file=sys.stderr)
            return 1
        anchors = loaded.get("ledgers", {}) if isinstance(loaded, dict) else {}
        if not isinstance(anchors, dict):
            print(f"{anchor_path}: not a ledger anchor", file=sys.stderr)
            return 1
    for target in (args.anchor, args.write_anchor):
        if target and inside(pathlib.Path(target), data_root):
            print(f"{target}: the anchor must live outside the data root, where the agent cannot rewrite it", file=sys.stderr)
            return 2

    heads_out = {}
    for name, rel in LEDGERS.items():
        heads = {}
        anchor = anchors.get(name)
        status = validate_ledger(data_root / rel, heads, anchor if isinstance(anchor, dict) else None)
        if status:
            return status
        count = max(heads) if heads else 0
        heads_out[name] = {"count": count, "record_hash": heads.get(count, "")}

    if args.write_anchor:
        out = pathlib.Path(args.write_anchor)
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.name + ".tmp")
        tmp.write_text(json.dumps({"schemaVersion": 1, "ledgers": heads_out}, indent=2) + "\n", encoding="utf-8")
        tmp.replace(out)
        print(f"Ledger anchor written: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
