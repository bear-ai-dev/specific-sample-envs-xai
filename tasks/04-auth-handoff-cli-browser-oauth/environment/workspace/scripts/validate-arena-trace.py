"""Full schema validation using retro-backend's existing jsonschema dependency.

uv run --project ../retro-backend --frozen python scripts/validate-arena-trace.py TRACE [--backend ../retro-backend]
"""

import argparse
import json
from pathlib import Path
import sys

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


def validate(path: Path, backend: Path | None = None) -> None:
    if path.suffix == ".jsonl":
        header, *events = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        trace = {**header, "events": events}
    else:
        trace = json.loads(path.read_text())
    contracts = Path(__file__).resolve().parents[1] / "contracts"
    schemas = [json.loads(file.read_text()) for file in contracts.glob("restaurant-arena-*.schema.json")]
    registry = Registry().with_resources((schema["$id"], Resource.from_contents(schema)) for schema in schemas)
    schema = json.loads((contracts / "restaurant-arena-trace-v3.schema.json").read_text())
    validator = Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(trace), key=lambda error: str(error.json_path))
    if errors:
        raise ValueError("\n".join(f"{error.json_path}: {error.message}" for error in errors))
    print(f"Full v3 schema passed: {path} ({len(trace['events'])} events)")
    if backend:
        sys.path.insert(0, str(backend.resolve() / "src"))
        from pydantic import ValidationError
        from retro_backend.esim.contracts import RestaurantState
        from retro_backend.esim.trajectory import Trajectory

        RestaurantState.model_validate(trace["initialState"])
        print("Backend v1 initial-state consumer: passed")
        try:
            Trajectory.model_validate(trace)
        except ValidationError as error:
            print(f"Backend grader trajectory: incompatible ({error.error_count()} validation errors); native Arena replay + standalone E-Sim required")
        else:
            print("Backend trajectory shape accepted; behavior parity still requires verification")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--backend", type=Path)
    args = parser.parse_args()
    validate(args.trace, args.backend)
