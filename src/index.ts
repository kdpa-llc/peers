/**
 * Supported programmatic entry point.
 *
 * Keep this list intentional: package consumers should not have to import implementation
 * paths, and adding an export here is a compatibility commitment.
 */
export { ControlPlane, type ControlPlaneOptions, type EligibleReason } from "./control-plane/controlPlane.ts";
export { EventLog, EVENT_TYPES, redactForAudience, type EmitInput } from "./control-plane/events.ts";
export {
  fixedClock, randomIds, sequentialIds, systemClock, type Clock, type Ids,
} from "./control-plane/runtime-env.ts";
export {
  Scheduler, type SchedulerCycle, type SchedulerOptions, type SchedulerResult,
  type SchedulerTarget,
} from "./control-plane/scheduler.ts";
export { Store } from "./control-plane/store.ts";
export {
  AgentRuntime, type ModelSource, type RunArgs, type RuntimeOutcome,
} from "./data-plane/runtime.ts";
export {
  type ModelAdapter, type ModelRequest, type ModelResponse, type ToolResult,
} from "./data-plane/model/adapter.ts";
export { ClaudeModelAdapter, type ClaudeModelAdapterOptions } from "./data-plane/model/claude.ts";
export {
  OpenAIModelAdapter, PRESETS, type ChatTransport, type OpenAIAdapterOptions,
} from "./data-plane/model/openai.ts";
export { ScriptedModelAdapter, type ScriptStep } from "./data-plane/model/scripted.ts";
export {
  ModelResolver, PROVIDERS, THINKING_LEVELS, buildAdapter, isProvider, isThinkingLevel,
  keyEnvFor, missingCredential, type ModelDefaults, type ProviderName, type ThinkingLevel,
} from "./data-plane/model/select.ts";
export {
  type ExecResult, PathEscape, type Sandbox, type SandboxHandle, type SandboxSpec,
} from "./data-plane/sandbox/adapter.ts";
export { LocalSandbox } from "./data-plane/sandbox/local.ts";
export { Observer, type AgentDetail, type OrgRow, type TimelineEntry } from "./observer/observer.ts";
export * from "./domain/types.ts";
