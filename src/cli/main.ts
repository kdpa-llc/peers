#!/usr/bin/env node
/**
 * `peers`: a notes vault where any folder can have its own agent.
 *
 * On your computer, everything runs in one container (ADR 0004):
 *
 *   peers up [dir] [--demo] [--scripted] [--origin URL] [--port 4777] [--build]
 *   peers down | status | logs | build
 *   peers pair                     a one-time code to pair a phone or another browser
 *   peers login claude|codex       sign the agents in from a terminal (Settings does it too)
 *
 * Inside the container, and for development:
 *
 *   peers serve [dir] [--scripted] [--demo] [--host] [--port] [--origin] [--state-dir] [--no-watch]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runBoxCli } from "../vault/box.ts";
import { login, pair, serve } from "../vault/cli.ts";
import { PACKAGE_ROOT } from "../vault/server.ts";

const HELP = `peers — a notes vault where any folder can have its own agent

Usage:
  peers up [dir]               Start Peers in a container for this vault folder (default ~/Peers Vault)
      --demo                     Copy the demo vault into an empty folder first
      --scripted                 Scripted demo agents: no T3, no sign-in, no model
      --origin <https-url>       The address phones use (for example a Tailscale Serve name)
      --port <n>                 Port on this computer (default 4777)
      --build                    Rebuild the container image first
  peers down                   Stop the container (the vault and its state stay)
  peers status | logs | build  What the container is doing, its output, rebuild its image
  peers pair                   A one-time code to pair a phone or another browser
  peers login claude|codex     Sign the agents in from a terminal (or use Settings)

  peers serve [dir]            Run the server in this process (inside the container, development)
      --scripted --demo --host --port --origin --state-dir --no-watch
  peers pair [dir] --local     A pairing code for a server you run with peers serve

  -h, --help                   Show this help
  -v, --version                Show the version`;

const [command, ...rest] = process.argv.slice(2);
const inContainer = process.env.PEERS_IN_CONTAINER === "1";

async function main(): Promise<number> {
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    console.log((JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version);
    return 0;
  }
  switch (command) {
    case "serve":
      return serve(rest);
    // Inside the container these act on the vault there; on the host they reach into the box.
    case "pair":
      // --local: a vault this process serves (development), not the container's.
      return inContainer || rest.includes("--local") ? pair(rest.filter((a) => a !== "--local")) : runBoxCli(["pair", ...rest], PACKAGE_ROOT);
    case "login":
      return inContainer ? login(rest) : runBoxCli(["login", ...rest], PACKAGE_ROOT);
    case "up":
    case "down":
    case "status":
    case "logs":
    case "build":
      return runBoxCli([command, ...rest], PACKAGE_ROOT);
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

process.exit(await main());
