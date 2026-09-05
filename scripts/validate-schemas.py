#!/usr/bin/env python3
"""
Validate the JSON Schemas in docs/specs/ and check representative instances against them.

The schemas are the source of truth (ADR 0011), so this runs independently of the
TypeScript implementation: a schema change that breaks the shapes the control plane emits
should fail here even if the code still compiles.

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
EXAMPLES = os.path.join(ROOT, "examples")
NOW = "2026-08-17T12:00:00.000Z"


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load_registry() -> tuple[dict, Registry]:
    schemas = {}
    for path in sorted(glob.glob(os.path.join(SPECS, "*.json"))):
        schema = load_json(path)
        if "$id" not in schema:
            sys.exit(f"{os.path.basename(path)} is missing $id (ADR 0011)")
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


DELEGATED_TASK = {
    "task_id": "task-002", "parent_task_id": "task-001",
    "sender_id": "repo-maintainer", "recipient_id": "worker-001",
    "objective": "Analyze the failing tests and return root cause plus evidence.",
    "expected_output": "Root cause with file:line evidence.",
    "priority": 1, "correlation_id": "corr-001", "status": "queued", "created_at": NOW,
    "delegation": {
        "delegation_id": "dlg-001", "manager_agent_id": "repo-maintainer",
        "granted_permissions": [{"kind": "fs.read", "scope": {"paths": ["/workspace"]}}],
        "output_contract": "root_cause: string; evidence: string[]",
        "budget": {"timeout_seconds": 900, "max_cost_usd": 1},
    },
}

WORKER_RESULT = {
    "task_id": "task-002", "delegation_id": "dlg-001", "status": "completed",
    "summary": "Timeout regression: checkout test exceeds the 2000ms default.",
    "evidence": ["src/checkout.js:1"],
    "proposed_learnings": [{
        "agent_id": "repo-maintainer", "operation": "create", "kind": "knowledge",
        "content": "checkout-service uses a 2000ms default request timeout.",
        "rationale": "Root cause of the failing suite; likely to recur.",
        "confidence": 0.8,
    }],
    "usage": {"input_tokens": 5200, "output_tokens": 640, "cost_usd": 0.05},
}

EXAMPLE_AGENT = load_json(os.path.join(EXAMPLES, "agent.json"))
EXAMPLE_TASK = load_json(os.path.join(EXAMPLES, "task.json"))

CASES: list[tuple[str, str, dict, bool]] = [
    ("delegated Task", "Task", DELEGATED_TASK, True),
    ("Task without parent_task_id but with delegation", "Task",
     {k: v for k, v in DELEGATED_TASK.items() if k != "parent_task_id"}, False),
    ("plain Task", "Task", {
        "task_id": "task-001", "sender_id": "human:operator", "recipient_id": "repo-maintainer",
        "objective": "Inspect the repository.", "status": "queued", "created_at": NOW,
    }, True),
    ("InboxItem carrying the Task", "InboxItem", {
        "item_id": "inbox-002", "sender_id": "repo-maintainer", "recipient_id": "worker-001",
        "kind": "task", "correlation_id": "corr-001", "priority": 1,
        "created_at": NOW, "payload": DELEGATED_TASK,
    }, True),
    ("InboxItem kind=task with a malformed payload", "InboxItem", {
        "item_id": "inbox-003", "sender_id": "a", "recipient_id": "b", "kind": "task",
        "created_at": NOW, "payload": {"objective": "no ids"},
    }, False),
    ("WorkerResult", "WorkerResult", WORKER_RESULT, True),
    ("WorkerResult missing task_id", "WorkerResult",
     {k: v for k, v in WORKER_RESULT.items() if k != "task_id"}, False),
    ("Agent with parameterized permissions", "Agent", {
        "agent_id": "repo-maintainer", "name": "Repository Maintainer",
        "responsibility": "Keep the repository healthy.", "mission": "Find leverage.",
        "lifecycle_state": "active", "created_at": NOW, "revision": 1,
        "permissions": [
            {"kind": "fs.write", "scope": {"paths": ["/workspace"]}},
            {"kind": "model.invoke", "scope": {"budget_usd_per_day": 5}},
            {"kind": "agent.delegate"},
        ],
        "subscriptions": {"kinds": ["task", "delegation_result"], "min_priority": 0},
    }, True),
    ("checked-in agent creation example promoted to a stored Agent", "Agent", {
        **EXAMPLE_AGENT,
        "lifecycle_state": EXAMPLE_AGENT.get("lifecycle_state", "active"),
        "created_at": NOW,
        "revision": 1,
    }, True),
    ("Agent with flat string permissions", "Agent", {
        "agent_id": "x", "name": "X", "responsibility": "r", "mission": "m",
        "lifecycle_state": "active", "created_at": NOW, "revision": 1,
        "permissions": ["repo.read"],
    }, False),
    ("Agent with an unknown permission scope key", "Agent", {
        "agent_id": "x", "name": "X", "responsibility": "r", "mission": "m",
        "lifecycle_state": "active", "created_at": NOW, "revision": 1,
        "permissions": [{"kind": "fs.read", "scope": {"future_magic": True}}],
    }, False),
    ("Execution", "Execution", {
        "execution_id": "exec-001", "agent_id": "repo-maintainer",
        "trigger": {"type": "inbox", "ref": "inbox-001"}, "status": "completed",
        "started_at": NOW, "usage": {"input_tokens": 2400, "output_tokens": 320, "cost_usd": 0.02},
    }, True),
    ("Approval", "Approval", {
        "approval_id": "approval-001", "action": "memory.delete",
        "requested_by_agent_id": "repo-maintainer", "execution_id": "exec-001",
        "subject_ref": "memory-001", "approver": "human:operator", "status": "approved",
        "reason": "The superseded record is safe to remove.",
        "created_at": NOW, "decided_at": NOW,
    }, True),
    ("Artifact", "Artifact", {
        "artifact_id": "artifact-001", "kind": "file",
        "uri": "/var/lib/peers/exec-001/outputs/report.txt",
        "content_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "created_by_agent_id": "repo-maintainer", "created_in_execution": "exec-001",
        "created_at": NOW,
        "provenance": {"source": "untrusted_content", "detail": "sandbox output"},
        "metadata": {"media_type": "text/plain"},
    }, True),
    ("MemoryRecord", "MemoryRecord", {
        "memory_id": "memory-001", "agent_id": "repo-maintainer", "kind": "knowledge",
        "content": "The checkout suite uses a 2000ms timeout.", "revision": 2,
        "confidence": 0.9, "source_refs": ["artifact-001"],
        "provenance": {"source": "untrusted_content", "detail": "repository inspection"},
        "supersedes": ["memory-000"], "status": "active",
        "created_at": NOW, "updated_at": NOW,
        "metadata": {"topic": "tests"},
    }, True),
    ("MemoryRevision", "MemoryRevision", {
        "revision_id": "memory-revision-002", "memory_id": "memory-001", "revision": 2,
        "operation": "revise", "proposal_id": "memory-proposal-002",
        "rationale": "The failing test supplied a more precise timeout value.",
        "confidence": 0.9, "source_execution": "exec-001",
        "evidence_refs": ["artifact-001"],
        "provenance": {"source": "untrusted_content", "detail": "repository inspection"},
        "previous_revision": 1, "actor_agent_id": "repo-maintainer",
        "approval_id": "approval-001", "created_at": NOW,
    }, True),
    ("MemoryProposal", "MemoryProposal", {
        "proposal_id": "memory-proposal-002", "agent_id": "repo-maintainer",
        "operation": "revise", "target_memory_ids": ["memory-001"], "kind": "knowledge",
        "content": "The checkout suite uses a 2000ms default timeout.",
        "rationale": "The failing test supplied a more precise timeout value.",
        "confidence": 0.9, "source_execution": "exec-001",
        "evidence_refs": ["artifact-001"],
        "provenance": {"source": "untrusted_content", "detail": "repository inspection"},
    }, True),
    ("checked-in task creation example promoted to a stored Task", "Task", {
        **EXAMPLE_TASK,
        "task_id": "task-example",
        "status": "queued",
        "created_at": NOW,
    }, True),
    ("WaitCondition", "WaitCondition", {
        "wait_id": "wait-001", "agent_id": "repo-maintainer", "task_id": "task-001",
        "kind": "task_completed", "predicate": {"task_id": "task-002"},
        "timeout_seconds": 1800, "status": "active", "created_at": NOW,
    }, True),
    ("Event", "AgentEvent", {
        "event_id": "evt-009", "event_type": "delegation.created", "timestamp": NOW,
        "agent_id": "repo-maintainer", "execution_id": "exec-001",
        "correlation_id": "corr-001", "causation_id": "evt-002", "visibility": "organization",
    }, True),
    ("Event with a non-dotted type", "AgentEvent", {
        "event_id": "evt-x", "event_type": "DelegationCreated", "timestamp": NOW,
        "agent_id": "repo-maintainer",
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
