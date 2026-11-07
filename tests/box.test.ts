/** The container box (ADR 0004): what it can reach, and relaying the bots' sign-ins. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runArgs } from "../src/vault/box.ts";
import { parseLoginOutput } from "../src/vault/signin.ts";

test("the box sees only the vault and its state, and listens on this Mac's loopback only", () => {
  const args = runArgs({ name: "peers-vault", image: "peers-vault:0.1.0", vault: "/home/me/Vault", state: "/home/me/state", port: 4777 });
  const volumes = args.flatMap((a, i) => (args[i - 1] === "--volume" ? [a] : []));
  assert.deepEqual(volumes, ["/home/me/Vault:/vault", "/home/me/state:/state"]);
  const published = args.flatMap((a, i) => (args[i - 1] === "--publish" ? [a] : []));
  assert.deepEqual(published, ["127.0.0.1:4777:4777"]);
  assert.ok(!args.includes("--ssh") && !args.includes("--virtualization") && !args.includes("--publish-socket"),
    "no SSH agent, nested virtualization or host sockets");
  const withOrigin = runArgs({ name: "n", image: "i", vault: "/v", state: "/s", port: 5000, origin: "https://mac.ts.net", scripted: true });
  assert.deepEqual(withOrigin.slice(-7), ["--host", "0.0.0.0", "--port", "5000", "--origin", "https://mac.ts.net", "--scripted"]);
  assert.ok(withOrigin.includes("127.0.0.1:5000:5000"), "same port inside and out: the server checks the Host port");
});

test("sign-in links and device codes are found in the CLIs' output", () => {
  const claude = "\x1b[2mOpening browser to sign in…\x1b[0m\nBrowser didn't open? Use the url below to sign in (c to copy)\n\n" +
    "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\n\nPaste code here if prompted > ";
  assert.deepEqual(parseLoginOutput("claude", claude), { url: "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz" });
  const codex = "Welcome to Codex\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
    "2. Enter this one-time code (expires in 15 minutes)\n   \x1b[94mABCD-12EF5\x1b[0m\n";
  assert.deepEqual(parseLoginOutput("codex", codex), { url: "https://auth.openai.com/codex/device", code: "ABCD-12EF5" });
  assert.deepEqual(parseLoginOutput("codex", "starting…"), {});
});
