#!/usr/bin/env python3
"""
Validate the JSON Schemas in docs/specs/ and check representative instances against them.

The schemas are the source of truth, so this runs independently of the TypeScript
implementation: a schema change that breaks the shapes Peers writes (agent definitions,
notes, layouts) should fail here even if the code still compiles.

    pip install jsonschema
    python3 scripts/validate-schemas.py
"""
from __future__ import annotations

import glob
import json
import os
import sys

try:
    from jsonschema import Draft202012Validator
    from jsonschema.exceptions import SchemaError
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: pip install jsonschema")

ROOT = os.path.join(os.path.dirname(__file__), "..")
SPECS = os.path.join(ROOT, "docs", "specs")
NOW = "2026-08-17T12:00:00.000Z"


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load_registry() -> tuple[dict, Registry]:
    schemas = {}
    for path in sorted(glob.glob(os.path.join(SPECS, "*.json"))):
        schema = load_json(path)
        if "$id" not in schema:
            sys.exit(f"{os.path.basename(path)} is missing $id")
        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError as error:
            sys.exit(f"{os.path.basename(path)} is not a valid Draft 2020-12 schema: {error}")
        schemas[schema["$id"]] = schema
    registry = Registry().with_resources(
        [(sid, Resource.from_contents(s, default_specification=DRAFT202012))
         for sid, s in schemas.items()]
    )
    return schemas, registry


def by_title(schemas: dict, title: str) -> dict:
    for s in schemas.values():
        if s.get("title") == title:
            return s
    sys.exit(f"no schema titled {title}")



CASES: list[tuple[str, str, dict, bool]] = [
    ("Agent definition (.peers/agents/<id>.json)", "Bot", {
        "id": "bot-website-relaunch-7k2p", "name": "Website Relaunch", "color": "teal",
        "instructions": "Summaries under 5 bullets.", "model": {"provider": "codex", "model": "gpt-6-astra", "thinking": "low"},
        "write_scope": "folder", "paused": False, "archived_from": None,
        "triggers": [
            {"id": "t1", "kind": "schedule", "every": "weekday", "at": "08:00", "prompt": "Brief", "enabled": False},
            {"id": "t2", "kind": "file_change", "path": "Inbox", "prompt": "Triage", "enabled": True},
        ],
    }, True),
    ("Agent for a single Org page (ADR 0005)", "Bot", {
        "id": "bot-job-search-a1b2c3", "name": "Job search", "path": "projects/job-search.org",
        "archived_from": "projects/job-search.org", "triggers": [],
    }, True),
    ("Layout for an Org repository", "Layout", {
        "preset": "para", "agents": ["projects/*.org", "areas/*.org", "properties"], "exclude": [],
        "paused": ["archive/**"], "inbox": "inbox.org", "archive": "archive",
        "readonly": ["views/**"], "hidden": ["raw", "scripts"], "rules": ["AGENTS.md"],
    }, True),
    ("Layout with a parent-folder path", "Layout", {"agents": ["../outside"]}, False),
    ("Layout with an unknown field", "Layout", {"agents": [], "roots": {}}, False),
    ("Agent definition from an older version", "Bot", {
        "id": "bot-x-123", "name": "X", "model": {"provider": "claude-code", "thinking": "low"}, "daily_budget_usd": 5,
    }, True),
    ("Agent definition with an unknown field", "Bot", {"id": "bot-x-123", "name": "X", "admin": True}, False),
    ("Agent definition with a schedule at an invalid time", "Bot", {
        "id": "bot-x-123", "name": "X", "triggers": [{"id": "t1", "kind": "schedule", "every": "day", "at": "25:00", "prompt": "p"}],
    }, False),
    ("Annotation (note)", "Annotation", {
        "annotation_id": "ann-0042", "client_key": "note-0123456789", "path": "Projects/A/Launch plan.md",
        "doc_blob": "0" * 64, "tool": "pen",
        "anchor": {"lines": [14, 14], "quote": {"exact": "March 6", "prefix": "Content locks on ", "suffix": ". Maya"},
                   "to": {"lines": [6, 6], "quote": {"exact": "## Milestones"}}},
        "ink": {"paths": ["M10 20 L30 40"], "frame": {"width": 720, "height": 1840}},
        "instruction": "move to the 9th", "attachment_id": None, "status": "applied",
        "thread_id": "0e90dd1f-5fa6-44dd-96c8-1494dd06e263", "bot_id": "bot-a-123", "sent_at": NOW, "sent_blob": "1" * 64,
        "created_at": NOW,
    }, True),
    ("Annotation with an unknown status", "Annotation", {
        "annotation_id": "a", "client_key": "note-0123456789", "path": "x.md", "tool": "pen",
        "status": "maybe", "created_at": NOW,
    }, False),
]


def main() -> int:
    schemas, registry = load_registry()
    print(f"loaded {len(schemas)} schemas from docs/specs/")
    failures = 0
    for label, title, instance, should_pass in CASES:
        validator = Draft202012Validator(by_title(schemas, title), registry=registry)
        errors = list(validator.iter_errors(instance))
        passed = not errors
        if passed == should_pass:
            print(f"  PASS  {label}")
        else:
            failures += 1
            detail = errors[0].message if errors else "unexpectedly valid"
            print(f"  FAIL  {label}: {detail}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} checks behaved as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
