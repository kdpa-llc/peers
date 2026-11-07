import { rm } from "node:fs/promises";

// Keep package builds reproducible when a source module was renamed or removed.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
