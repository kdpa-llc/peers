/** Shapes the server returns (src/vault/app.ts, server.ts). */

export type BotStatus = {
  id: string;
  name: string;
  color: string;
  /** The vault agent at the root, a folder's agent, or a single page's (ADR 0005). */
  kind: "vault" | "folder" | "page";
  /** The folder or page it looks after; "" for the vault agent. */
  path: string;
  /** Its front page: the folder's index, README or folder note, or the page itself. */
  front?: string;
  /** Inside a paused part of the layout, like an archive. */
  archived: boolean;
  paused: boolean;
  needs_review: boolean;
  /** working, waiting (for an approval in T3), idle or paused */
  state: string;
  unread: number;
  conversations: number;
  last_error?: string;
  next_run?: { at: string; label: string };
  model: { provider?: string; model?: string; thinking?: string };
};

export type Trigger =
  | { id: string; kind: "schedule"; every: "minutes" | "hours" | "day" | "weekday" | "week"; n?: number; at?: string; day?: string; heartbeat?: boolean; prompt: string; enabled?: boolean }
  | { id: string; kind: "file_change"; path: string; prompt: string; enabled?: boolean };

export type BotDef = {
  id: string;
  name: string;
  color?: string;
  instructions?: string;
  model?: { provider?: string; model?: string; thinking?: string };
  write_scope?: "folder" | "folder+resources" | "vault";
  paused?: boolean;
  needs_review?: boolean;
  archived_from?: string | null;
  path?: string;
  triggers?: Trigger[];
};

export type BotDetail = BotStatus & { def: BotDef; write_scope: string; writable: string[] };

export type Layout = {
  preset?: "para" | "folders" | "wiki" | "custom";
  agents: string[];
  exclude: string[];
  paused: string[];
  inbox?: string;
  archive?: string;
  readonly: string[];
  hidden: string[];
  rules: string[];
};

export type TreeNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  kind?: "page" | "image" | "svg" | "pdf" | "text" | "app" | "other";
  size?: number;
  mtime?: number;
  root?: "inbox" | "projects" | "areas" | "resources" | "archive";
  children?: TreeNode[];
};

export type Hunk = { aStart: number; aEnd: number; bStart: number; bEnd: number };

export type PageData = {
  path: string;
  kind: TreeNode["kind"];
  hash: string | null;
  author: string;
  author_name: string;
  updated_at: string;
  owner: string;
  /** Generated content the layout marks read-only. */
  readonly?: boolean;
  content?: string;
  /** How the page differs from what you last saw; absent when you have seen it as it is. */
  change?: { created: boolean; author: string; author_name: string; at: string; hunks: Hunk[]; outside_scope: boolean };
};

/** An app opened for this device (ADR 0006): where its frame loads, and what it asks for. */
export type AppOpen = {
  url: string;
  owner: string;
  app: {
    name: string;
    root: string;
    entry: string;
    manifest: boolean;
    description?: string;
    reads: string[];
    /** Origins it may reach now. */
    network: string[];
    /** Origins it asks for that the owner has not allowed. */
    asks: string[];
    /** Its server (ADR 0007): whether it is allowed or asked for, and its state. */
    server?: AppServerInfo;
  };
};

export type AppServerInfo = {
  file: string;
  allowed: boolean;
  asks: boolean;
  state: "stopped" | "starting" | "running" | "crashed" | "unavailable";
  message?: string;
};

export type Quote = { exact: string; prefix?: string; suffix?: string };
export type Target = { lines?: [number, number]; quote?: Quote; label?: string };

export type Note = {
  annotation_id: string;
  client_key: string;
  path: string;
  doc_blob?: string | null;
  tool: "select" | "pen" | "arrow";
  anchor?: Target & { to?: Target; page?: number; region?: [number, number, number, number] };
  ink?: { paths: string[]; frame: { width: number; height: number } } | null;
  instruction?: string;
  attachment_id?: string | null;
  status: "draft" | "sent" | "working" | "applied" | "answered" | "declined" | "done" | "unresolved" | "failed";
  reason?: string | null;
  thread_id?: string | null;
  bot_id?: string | null;
  sent_at?: string | null;
  created_at: string;
  updated_at?: string;
};

export type ThreadView = {
  id: string;
  bot_id: string;
  title: string;
  origin: "chat" | "notes" | "trigger" | "mention" | "manual" | "setup";
  state: "working" | "idle" | "failed" | "waiting";
  error?: string;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
  unread: boolean;
  archived: boolean;
  trigger_id?: string;
  from_thread?: string;
  model?: { provider: string; model: string };
};

export type Message = {
  id: string;
  role: "owner" | "bot" | "trigger" | "system";
  text: string;
  at: string;
  streaming: boolean;
  notes?: { path: string; count: number };
  context?: string;
  pending?: boolean;
};

export type Conversation = { thread: ThreadView; messages: Message[]; notes: Note[] };

export type Mentioned = { bot_id: string; name: string; thread_id: string };

export type ModelChoice = { provider: "claude" | "codex"; model: string; label: string; isDefault: boolean; efforts: { id: string; label: string }[] };

export type Route =
  | { view: "today" }
  | { view: "page"; path: string }
  | { view: "settings" }
  | { view: "bot"; id: string };
