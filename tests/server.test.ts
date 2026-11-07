/** The vault HTTP server's guards (TECHNICAL.md §13). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultServer } from "../src/vault/server.ts";
import { makeVault, type Fixture } from "./helpers.ts";

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function withServer(fn: (port: number, server: VaultServer, root: string, fx: Fixture) => Promise<void>): Promise<void> {
  const fx = await makeVault();
  const server = new VaultServer(fx.app, { port: 0 });
  const port = await server.listen();
  try {
    await fn(port, server, fx.root, fx);
  } finally {
    await server.close();
    await fx.close();
  }
}

async function pair(port: number, server: VaultServer): Promise<string> {
  const code = server.createPairingCode();
  const r = await call(port, "/api/pair", {
    method: "POST", headers: { "content-type": "application/json", "x-peers": "1" }, body: JSON.stringify({ code, name: "test" }),
  });
  assert.equal(r.status, 200);
  const cookie = String(r.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return cookie.split(";")[0]!;
}

test("no session means 401; a pairing code works once", async () => {
  await withServer(async (port, server) => {
    assert.equal((await call(port, "/api/state")).status, 401);
    const code = server.createPairingCode();
    const body = JSON.stringify({ code, name: "phone" });
    const headers = { "content-type": "application/json", "x-peers": "1" };
    assert.equal((await call(port, "/api/pair", { method: "POST", headers, body })).status, 200);
    assert.equal((await call(port, "/api/pair", { method: "POST", headers, body })).status, 403, "single use");
    assert.equal((await call(port, "/api/pair", { method: "POST", headers, body: JSON.stringify({ code: "ZZZZZZ" }) })).status, 403);
  });
});

test("writes need X-Peers and a matching Origin; unknown hosts are refused", async () => {
  await withServer(async (port, server) => {
    const cookie = await pair(port, server);
    const json = { cookie, "content-type": "application/json" };
    assert.equal((await call(port, "/api/bots/x/run", { method: "POST", headers: json, body: "{}" })).status, 403);
    assert.equal((await call(port, "/api/settings", { method: "PATCH", headers: { ...json, "x-peers": "1", origin: "https://evil.example" }, body: "{}" })).status, 403);
    assert.equal((await call(port, "/api/settings", { method: "PATCH", headers: { ...json, "x-peers": "1", origin: `http://127.0.0.1:${port}` }, body: "{}" })).status, 200);
    assert.equal((await call(port, "/api/state", { headers: { cookie, host: "evil.example" } })).status, 421, "DNS rebinding");
  });
});

test("raw files: allowlisted types inline and sandboxed; everything else downloads; dot paths refused", async () => {
  await withServer(async (port, server, root) => {
    const cookie = await pair(port, server);
    writeFileSync(join(root, "Inbox/page.html"), "<script>alert(1)</script>");
    writeFileSync(join(root, "Inbox/fake.png"), "<html>not a png</html>");
    const html = await call(port, `/api/raw?path=${encodeURIComponent("Inbox/page.html")}`, { headers: { cookie } });
    assert.equal(html.headers["content-type"], "application/octet-stream");
    assert.match(String(html.headers["content-disposition"]), /attachment/);
    assert.match(String(html.headers["content-security-policy"]), /sandbox/);
    assert.equal(html.headers["x-content-type-options"], "nosniff");
    const fake = await call(port, `/api/raw?path=${encodeURIComponent("Inbox/fake.png")}`, { headers: { cookie } });
    assert.equal(fake.headers["content-type"], "application/octet-stream", "magic bytes must match the extension");
    for (const bad of [".peers/vault.json", "Projects/Alpha/.bot.json", "../outside.txt"]) {
      const r = await call(port, `/api/raw?path=${encodeURIComponent(bad)}`, { headers: { cookie } });
      assert.equal(r.status, 403, bad);
    }
  });
});

test("client modules are served as JavaScript under a strict CSP", async () => {
  await withServer(async (port) => {
    const r = await call(port, "/web/app.ts");
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /text\/javascript/);
    assert.doesNotMatch(r.body, /: (string|number|boolean)\b(?=[,)])/, "types are stripped");
    assert.match(String(r.headers["content-security-policy"]), /script-src 'self'/);
    assert.doesNotMatch(String(r.headers["content-security-policy"]), /unsafe-inline|unsafe-eval/);
    assert.equal((await call(port, "/web/../package.json")).status, 404);
    assert.equal((await call(port, "/src/vault/app.ts")).status, 404, "only the shared parser is served from src/");
  });
});

test("events resync a client from another epoch", async () => {
  await withServer(async (port, server) => {
    const cookie = await pair(port, server);
    const body = await new Promise<string>((done) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}`, cookie, "last-event-id": "oldepoch:5" } }, (res) => {
        let text = "";
        res.on("data", (d) => {
          text += d;
          if (text.includes("event: hello")) { req.destroy(); done(text); }
        });
      });
      req.end();
    });
    assert.match(body, /event: resync/);
  });
});

test("conversations over the API: start, read, @mention, and mark a page seen", async () => {
  await withServer(async (port, server, root, fx) => {
    const cookie = await pair(port, server);
    const headers = { cookie, "content-type": "application/json", "x-peers": "1" };
    const post = async (path: string, body: unknown): Promise<any> => {
      const r = await call(port, path, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(r.status, 200, `${path}: ${r.body}`);
      return JSON.parse(r.body);
    };
    const get = async (path: string): Promise<any> => JSON.parse((await call(port, path, { headers: { cookie } })).body);
    const alpha = fx.app.registry.byPath("Projects/Alpha")!.def.id;
    const sent = await post(`/api/bots/${alpha}/messages`, { text: "@Finances can we afford it?", client_key: "k-1" });
    assert.equal(sent.mentioned.length, 1);
    const again = await post(`/api/bots/${alpha}/messages`, { text: "@Finances can we afford it?", client_key: "k-1" });
    assert.equal(again.thread_id, sent.thread_id, "a retried send is not sent twice");
    await fx.settle();
    const list = await get(`/api/bots/${alpha}/threads`);
    assert.equal(list.threads.length, 1);
    const view = await get(`/api/threads/${sent.thread_id}`);
    assert.deepEqual(view.messages.map((m: { role: string }) => m.role), ["owner", "bot"]);
    await post(`/api/threads/${sent.thread_id}/read`, {});
    assert.equal((await get(`/api/threads/${sent.thread_id}`)).thread.unread, false);
    const models = await get("/api/models");
    assert.ok(models.models.some((m: { provider: string }) => m.provider === "codex"));

    writeFileSync(join(root, "Projects/Alpha/Plan.md"), "# Plan\n\nChanged.\n");
    fx.watcher.emit("Projects/Alpha/Plan.md");
    const file = await get(`/api/file?path=${encodeURIComponent("Projects/Alpha/Plan.md")}`);
    assert.ok(file.change, "changed since last looked");
    assert.deepEqual((await get("/api/tree")).changed, ["Projects/Alpha/Plan.md"]);
    assert.equal((await post("/api/seen", { path: "Projects/Alpha/Plan.md", hash: file.hash })).ok, true);
    assert.equal((await get(`/api/file?path=${encodeURIComponent("Projects/Alpha/Plan.md")}`)).change, undefined);
    const bad = await call(port, `/api/bots/${alpha}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "" }) });
    assert.equal(bad.status, 400);
  });
});
