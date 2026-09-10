"""Validate the published cross-engine fixture with the contract's Draft 2020-12 schema."""

import argparse
import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "contracts/restaurant-arena-cross-engine-v2.schema.json").read_text())
FIXTURE = json.loads((ROOT / "contracts/fixtures/restaurant-arena-cross-engine-v2.json").read_text())


def errors(value: object) -> list[object]:
    return list(Draft202012Validator(SCHEMA).iter_errors(value))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prove-duplicate-id-rejected", action="store_true")
    args = parser.parse_args()
    if errors(FIXTURE):
        raise ValueError("published cross-engine fixture failed schema validation")
    if args.prove_duplicate_id_rejected:
        duplicate = copy.deepcopy(FIXTURE)
        for scenario in duplicate["scenarios"]:
            scenario["id"] = "routine"
        if not errors(duplicate):
            raise ValueError("schema accepted duplicate cross-engine scenario IDs")
        print("duplicate fixture: validation failure")
    else:
        print("cross-engine fixture: validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
