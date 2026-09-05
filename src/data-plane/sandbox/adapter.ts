/**
 * Sandbox boundary (ADR 0005). Backends are interchangeable: local process, Docker, VM,
 * microVM, remote executor. The agent model must not depend on any one of them.
 */
import type { Artifact, Permission } from "../../domain/types.ts";

export type SandboxSpec = {
  execution_id: string;
  agent_id: string;
  /** Inputs mounted read-only; every path is confined to the execution root. */
  mounts: { source: string; target: string }[];
  grants: Permission[];
  timeout_seconds: number;
};

export type SandboxHandle = {
  id: string;
  root: string;
  /** Artifacts written here are the only ones collected. */
  outputDir: string;
};

export type ExecResult = { code: number; stdout: string; stderr: string };

export interface Sandbox {
  readonly name: string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: string[]): Promise<ExecResult>;
  collectArtifacts(handle: SandboxHandle): Promise<Artifact[]>;
  destroy(handle: SandboxHandle): Promise<void>;
}

/**
 * Path confinement (SECURITY_AND_PERMISSIONS: sandbox path rules; CONTRACT_TESTS #17).
 * Every backend inherits this — resolve, then verify containment. Rejects `..` traversal,
 * absolute escapes, and (via realpath at call sites) symlink escapes.
 */
export class PathEscape extends Error {
  constructor(path: string, root: string) {
    super(`path '${path}' resolves outside the execution root '${root}'`);
    this.name = "PathEscape";
  }
}
