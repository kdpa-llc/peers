# Contract Tests

The schemas in this directory are authoritative for **shape** (ADR 0011). They cannot
express cross-record invariants — relationships between two documents, or between a
document and system state. Those invariants are just as load-bearing, so each one below
needs a deterministic test in the implementation. ADR 0010 calls for this explicitly for
the first item; the rest follow from ADRs 0007–0012 and SECURITY_AND_PERMISSIONS.

Run these against the `ScriptedModelAdapter` so the whole
set is deterministic in CI.

## Loading the schemas

Every schema declares an absolute `$id`. Load them into your validator's registry keyed by
`$id`; relative references (`"task.schema.json"`, `"artifact.schema.json#/properties/provenance"`)
then resolve against that base with no custom loader.

A validator handed a single schema file with no registry will fail with an unresolvable
reference — that is expected, not a schema bug. Load the whole directory.

## Invariants JSON Schema cannot express

### Delivery and routing

1. **Envelope/Task routing equality** (ADR 0010). For `InboxItem.kind = task`, the
   envelope's `sender_id`, `recipient_id`, `correlation_id`, `priority`, and `deadline`
   are denormalized copies of the Task fields. The control plane derives them from the
   Task and rejects a write where any present copy disagrees. Test both directions:
   a matching pair is accepted; a pair contradicting on any one field is rejected.
2. **Result correlation.** A `WorkerResult`'s `task_id` must name a Task whose
   `delegation.delegation_id` equals the result's `delegation_id`. A result whose two ids
   point at different delegations is rejected.
3. **Exactly one terminal result per delegated task** (ADR 0007). Delivering a second
   terminal `delegation_result` for the same `task_id` is rejected. Conversely, every
   delegated task that leaves the running state produces one — including on worker crash,
   sandbox loss, timeout, and cancellation.

### Delegation

4. **Depth limit** (ADR 0009, ADR 0012). A Task carrying `delegation` whose
   `parent_task_id` names a Task that *also* carries `delegation` is rejected — maximum
   delegation depth is 1 in v0.
5. **Least authority** (delegation `granted_permissions`). Every granted permission must
   be within the manager's own grants: the `kind` must be held by the manager, and the
   scope must be equal or narrower (paths a subset, egress hosts a subset, budgets no
   larger). A worker grant exceeding the manager's is rejected.

### Execution lifecycle

6. **One execution per durable agent** (ADR 0009). Starting a second concurrent execution
   for the same durable agent is rejected. Ephemeral workers are exempt.
7. **Terminal records are immutable** (ADR 0007). Any write mutating a completed, failed,
   or cancelled execution is rejected; a retry creates a new execution whose `retry_of`
   names the original.
8. **Orphan recovery** (ADR 0007). After a simulated control-plane restart, every
   execution left in `running` becomes `failed` with reason `orphaned` and is
   retry-eligible under policy. No wait condition is lost across the restart.
9. **Wait cancellation** (ADR 0007). When a task reaches a terminal state, its wait
   conditions move to `cancelled`. Every active wait has a timeout; a wait whose timeout
   elapses resolves to `timeout` and wakes its agent.

### Budgets

10. **Per-call budget checks** (ADR 0008). Before and after every model call, execution,
    agent-day, organization, delegation, and token ceilings are checked using accumulated
    provider-reported usage. Pre-call checks include a next-call reservation and remaining
    token authority caps requested provider output; post-call checks persist actual usage
    before allowing response tools or actions. A rejection moves the agent to `BLOCKED` with
    a human-attention flag. This is not a provider billing quota: one completed call may cross
    a USD cap when its estimate was low.
11. **Usage and delegated limits.** Every terminal execution carries actual `usage`.
    Delegation cost/token limits and `model.invoke.max_tokens_per_execution` are checked on
    every turn. A response that crosses one is charged and recorded, but its tools/actions
    are discarded and the execution fails with `budget_exhausted`.
12. **Wake-up is not execution** (ADR 0008). An inbox item that does not match an agent's
    `subscriptions` is delivered but starts no execution and consumes no model budget.

### Events

13. **Causation integrity.** Every `causation_id` names an existing event; a workflow's
    events share one `correlation_id`. The observer's reconstructed timeline for a
    delegation matches the recorded parent/child chain.
14. **Registered types only.** Every emitted `event_type` appears in `EVENT_TYPES.md`.

### Memory

15. **Revision chain.** Applying a proposal increments `revision` by exactly one and writes
    a `MemoryRevision` naming the acting agent and rationale. `supersedes` targets must
    exist, and superseded records move to `superseded`.
16. **Approval gate.** Operations outside the auto-apply set (delete, shared memory, memory
    referenced by another agent) are rejected without a granted `Approval`.

### Security

17. **Local-sandbox path and capability handling** (SECURITY_AND_PERMISSIONS). Readable
    snapshots and utility operands stay within virtual `fs.read` scopes; output writes stay
    within `fs.write` scopes under `/outputs`. Traversal, absolute escapes, unsafe utility
    options, interpreter execution, and mount/command/artifact symlink escapes are rejected.
    Execution roots are removed after outputs move to separate durable storage. These are
    code-level controls, not OS isolation.
18. **Registered provider credentials are redacted.** Values from supported provider
    credential environment variables do not appear in model prompts, model-visible tool
    results, model-generated intent, provider error messages, or persisted tool events. The
    local sandbox does not inherit them, and common
    secret files are omitted from workspace snapshots. This is not universal secret
    detection: an arbitrary value in any other `fs.read`-authorized file may reach the model.
19. **Provenance propagates.** Content derived from untrusted input carries
    `provenance.source = untrusted_content` through the artifacts, inbox items, and memory
    proposals derived from it.

### Model boundary (ADR 0013, 0014)

20. **Tool output reaches the next turn.** Within one execution, the commands a model asks
    for are run in that execution's sandbox and their output is returned to the adapter on
    the following turn, in the order requested. The sandbox outlives a turn: state written
    on one turn is readable on the next.
21. **The model loop is bounded.** An adapter that never returns an action is called at most
    `MAX_TURNS` times and the execution ends with the actions taken so far. Usage is summed
    across every turn, so budgets are charged the whole execution, not its last turn.
22. **No conversation crosses an execution** (Constitution §5). An adapter holding
    within-execution state resets it when a new `execution_id` arrives; the prompt for a new
    execution is the reconstructed context alone, with no history from any earlier one.
23. **The tool surface equals the permission surface.** Model invocation requires
    `model.invoke`; a sandbox command requires `tool.exec` plus `sandbox.create` and at least
    one filesystem grant. Local file operands are checked against their virtual path scopes.
    Permissions passed to a worker are resolved from the manager's grants rather than taken
    from model output (#5). `net.egress` remains unavailable in the local backend.

### Organization shape

24. **Peers collaborate without delegation.** A durable agent may message another durable
    agent it discovered from the context's peer directory; the recipient wakes on that
    message (subject to its subscriptions), may reply, and the exchange stays on the
    correlation of the task that prompted it. No delegation, ephemeral worker, or
    manager/worker relationship is involved, and neither agent needs `agent.delegate`.

### Memory

25. **Unretrieved memory is visible as a count.** When an agent holds more active memories
    than the retrieval window returns, its context states how many were not shown. Memory
    the agent cannot see must not be indistinguishable from memory that does not exist —
    the platform reports the number; consolidating is the agent's own proposal to make.

### Provenance (supersedes the aspiration in #19)

26. **Untrusted reads taint what an execution produces.** When an execution reads sandbox
    output, the memories, artifacts, and messages it produces carry
    `provenance.source = untrusted_content`, on the record and on its immutable revision.
    An execution that read nothing carries no marking, so the absence means something.
27. **Provenance is the platform's determination, not the agent's claim.** An agent that has
    read untrusted content cannot publish an artifact marked `trusted`; the control plane's
    value overrides whatever the action supplied. Artifacts collected from a sandbox are
    untrusted by origin alone, regardless of what else the execution did.

### Permission scopes

28. **`max_concurrent` bounds live ephemeral workers.** A manager whose `agent.create_ephemeral`
    grant carries `max_concurrent: n` is refused an `n+1`th simultaneous worker, with a
    `delegation.failed` event naming the cap rather than a silent drop. The count is per
    manager and covers only *live* workers, so a retired worker frees its slot. A grant with
    no `max_concurrent` scope is unlimited, as the permission model says.

### Model providers (ADR 0016)

29. **A provider swap does not change what an agent may do.** For the same grants, every
    model-backed adapter offers the same set of tool names. The tool table and its permission
    filter live in one module precisely so this cannot drift; a tool added to one adapter and
    not another is the failure this catches. Adding a provider means extending this test, not
    exempting the new adapter from it.

### Per-agent model (ADR 0017)

30. **An agent's declared model is the model it runs on.** `model_config` is part of the
    durable agent definition: it is stored with the record, survives a restart, and changing
    it increments `revision` and emits `agent.updated`, like any other definitional change.
    An agent that declares nothing inherits the organization default; one that declares a
    provider without a model does not inherit the default's model id, which belonged to a
    different provider. Resolution reads the declared field and never the agent id — the
    moment it consults identity, the platform is holding organizational knowledge that
    Constitution §2 says belongs to the operator.
