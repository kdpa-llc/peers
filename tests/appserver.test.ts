/** App servers (ADR 0007, CONTRACT_TESTS #9). Sandbox "off" here; the box checks bubblewrap itself. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VaultServer } from "../src/vault/server.ts";
import { bwrapArgs, serverCommand } from "../src/vault/appserver.ts";
import { BASE_FILES, makeVault, writeFiles, type Fixture } from "./helpers.ts";
import type { SandboxMode } from "../src/vault/appserver.ts";

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

const SERVER = (version: string): string => `
import http from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const version = ${JSON.stringify(version)};
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "set-cookie": "s=1", "content-security-policy": "default-src *" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/pid") return send(200, { pid: process.pid, version });
  if (url.pathname === "/env") return send(200, { keys: Object.keys(process.env).sort(), api: process.env.PEERS_API, data: process.env.PEERS_DATA, app: process.env.PEERS_APP });
  if (url.pathname === "/headers") return send(200, req.headers);
  if (url.pathname === "/read") {
    const r = await fetch(process.env.PEERS_API + "file?path=" + encodeURIComponent(url.searchParams.get("path")));
    return send(200, { status: r.status, text: await r.text() });
  }
  if (url.pathname === "/write" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    writeFileSync(join(process.env.PEERS_DATA, "note.txt"), JSON.parse(body).text);
    return send(201, { ok: true });
  }
  if (url.pathname === "/crash") process.exit(3);
  send(404, { error: "not found" });
}).listen(Number(process.env.PORT), process.env.HOST);
`;

const FILES: Record<string, string> = {
  ...BASE_FILES,
  "Tools/Echo/peers.app.json": JSON.stringify({ name: "Echo", reads: ["Projects/**"], server: "server.mjs" }),
  "Tools/Echo/index.html": "<!doctype html><p>echo</p>",
  "Tools/Echo/server.mjs": SERVER("1"),
};

type Ctx = { port: number; fx: Fixture; json: Record<string, string> };

async function withServer(sandbox: SandboxMode, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const fx = await makeVault({ files: FILES, appSandbox: sandbox });
  const server = new VaultServer(fx.app, { port: 0 });
  const port = await server.listen();
  try {
    const code = server.createPairingCode();
    const r = await call(port, "/api/pair", { method: "POST", headers: { "content-type": "application/json", "x-peers": "1" }, body: JSON.stringify({ code, name: "t" }) });
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    await fn({ port, fx, json: { "content-type": "application/json", "x-peers": "1", cookie } });
  } finally {
    await server.close();
    await fx.close();
  }
}

async function open(c: Ctx): Promise<{ base: string; app: Record<string, any> }> {
  const r = await call(c.port, "/api/apps/open", { method: "POST", headers: c.json, body: JSON.stringify({ path: "Tools/Echo" }) });
  assert.equal(r.status, 200, r.body);
  const out = JSON.parse(r.body);
  return { base: out.url.replace(/index\.html$/, ""), app: out.app };
}

const grant = (c: Ctx, server: boolean): Promise<Res> =>
  call(c.port, "/api/apps/grant", { method: "POST", headers: c.json, body: JSON.stringify({ root: "Tools/Echo", network: [], server }) });

const get = async (c: Ctx, path: string): Promise<any> => {
  const r = await call(c.port, path);
  assert.equal(r.status, 200, `${path}: ${r.status} ${r.body}`);
  return JSON.parse(r.body);
};

test("#9 bubblewrap hides Peers' state: the app folder read-only, data/ writable, no /proc, a clean environment", () => {
  const args = bwrapArgs({ appDir: "/vault/Tools/Echo", dataDir: "/vault/Tools/Echo/data", env: { PORT: "4000" }, command: ["node", "/app/server.mjs"] });
  for (const flag of ["--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv"]) assert.ok(args.includes(flag), flag);
  const pairs = (flag: string): string[][] => args.flatMap((a, i) => (a === flag ? [args.slice(i + 1, i + 3)] : []));
  assert.deepEqual(pairs("--bind"), [["/vault/Tools/Echo/data", "/app/data"]], "the only writable folder");
  const ro = pairs("--ro-bind").map(([from]) => from);
  for (const from of ro) assert.ok(["/usr", "/etc", "/vault/Tools/Echo", "/bin", "/sbin", "/lib", "/lib64"].includes(from!), `read-only ${from}`);
  assert.ok(ro.includes("/vault/Tools/Echo"));
  assert.ok(!args.includes("--proc"), "no /proc: other processes' files would lead back to /state");
  assert.ok(!args.some((a) => a.startsWith("/state")), "never the state folder");
  assert.ok(!args.includes("/vault"), "never the whole vault");
  assert.deepEqual(args.slice(args.indexOf("--setenv"), args.indexOf("--setenv") + 3), ["--setenv", "PORT", "4000"]);
  assert.deepEqual(args.slice(-3), ["--", "node", "/app/server.mjs"]);
  assert.deepEqual(serverCommand("server.py", "/app/server.py", true), ["python3", "-u", "/app/server.py"]);
});

test("#9 without a sandbox, servers do not start, even when allowed", async () => {
  await withServer("none", async (c) => {
    assert.equal((await grant(c, true)).status, 200);
    const { base, app } = await open(c);
    assert.equal(app.server.state, "unavailable");
    const r = await call(c.port, `${base}_api/pid`);
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.body).error, /container/);
  });
});

test("#9 a server runs only once the owner allows it, gets a clean environment, and reads the vault only through the data API", async () => {
  process.env.PEERS_SECRET_TEST = "do-not-pass";
  try {
    await withServer("off", async (c) => {
      let { base, app } = await open(c);
      assert.deepEqual([app.server.file, app.server.allowed, app.server.asks], ["server.mjs", false, true]);
      assert.equal((await call(c.port, `${base}_api/pid`)).status, 403, "not allowed yet");
      assert.equal((await grant(c, true)).status, 200);
      assert.equal((await call(c.port, `${base}_api/pid`)).status, 403, "a token opened before the grant stays without it");
      ({ base, app } = await open(c));
      assert.equal(app.server.allowed, true);

      const first = await get(c, `${base}_api/pid`);
      assert.equal(first.version, "1");
      assert.equal((await get(c, `${base}views/_api/pid`)).pid, first.pid, "_api/ at any depth reaches the same server");

      // A clean environment: nothing from the process that started Peers.
      const env = await get(c, `${base}_api/env`);
      // (macOS adds __CF_USER_TEXT_ENCODING to every process it starts.)
      assert.deepEqual(env.keys.filter((k: string) => !k.startsWith("__CF")), ["HOME", "HOST", "LANG", "PATH", "PEERS_API", "PEERS_APP", "PEERS_DATA", "PORT", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED"]);
      assert.equal(env.app, "Tools/Echo");
      assert.match(env.api, /^http:\/\/127\.0\.0\.1:\d+\/apps\/[\w-]+\/_peers\/$/);

      // Its own reads go through the policy-checked data API.
      assert.equal((await get(c, `${base}_api/read?path=Projects/Alpha/Plan.md`)).status, 200);
      assert.equal((await get(c, `${base}_api/read?path=Areas/Finances/Budget.md`)).status, 403);

      // Peers answers the preflight, sends no cookie on, and keeps its own CSP and CORS headers.
      const pre = await call(c.port, `${base}_api/write`, { method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers["access-control-allow-headers"], "content-type");
      const seen = await call(c.port, `${base}_api/headers`, { headers: { cookie: "peers_session=abc", origin: "null" } });
      const headers = JSON.parse(seen.body);
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.origin, undefined);
      assert.equal(headers["x-peers-app"], encodeURIComponent("Tools/Echo"));
      assert.equal(seen.headers["set-cookie"], undefined);
      assert.match(String(seen.headers["content-security-policy"]), /^sandbox /);
      assert.equal(seen.headers["access-control-allow-origin"], "*");

      // It writes in its data/ folder, and the change is credited to the app.
      const w = await call(c.port, `${base}_api/write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
      assert.equal(w.status, 201);
      assert.equal(readFileSync(join(c.fx.root, "Tools/Echo/data/note.txt"), "utf8"), "hello");
      c.fx.app.scan();
      const file = c.fx.app.readFile("Tools/Echo/data/note.txt");
      assert.equal(file.author, "app:Tools/Echo");
      assert.equal(file.author_name, "the Echo app");
      assert.equal((await get(c, `${base}_api/pid`)).pid, first.pid, "a data change does not restart it");

      // A code change restarts it on the next request.
      writeFiles(c.fx.root, { "Tools/Echo/server.mjs": SERVER("2") });
      c.fx.app.scan();
      const second = await get(c, `${base}_api/pid`);
      assert.equal(second.version, "2");
      assert.notEqual(second.pid, first.pid);
      assert.ok(existsSync(c.fx.app.appServers.logFile("Tools/Echo")));
    });
  } finally {
    delete process.env.PEERS_SECRET_TEST;
  }
});

test("#9 idle servers stop; crashes are counted; taking the grant back stops it and its tokens", async () => {
  await withServer("off", async (c) => {
    await grant(c, true);
    const { base } = await open(c);
    await get(c, `${base}_api/pid`);
    assert.equal(c.fx.app.appServers.status("Tools/Echo").state, "running");
    c.fx.clock.advance(11 * 60_000);
    assert.equal(await c.fx.app.appServers.sweep(), 1);
    assert.equal(c.fx.app.appServers.status("Tools/Echo").state, "stopped");

    for (let i = 0; i < 3; i++) {
      await get(c, `${base}_api/pid`);
      const crash = await call(c.port, `${base}_api/crash`);
      assert.equal(crash.status, 502);
      await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.equal(c.fx.app.appServers.status("Tools/Echo").state, "crashed");
    const refused = await call(c.port, `${base}_api/pid`);
    assert.equal(refused.status, 503);
    assert.match(JSON.parse(refused.body).error, /stopped 3 times/);
    const status = JSON.parse((await call(c.port, "/api/apps/server?root=Tools/Echo", { headers: { cookie: c.json.cookie! } })).body);
    assert.match(status.log, /exited with code 3/);
    assert.equal((await call(c.port, "/api/apps/server/restart", { method: "POST", headers: c.json, body: "{\"root\":\"Tools/Echo\"}" })).status, 200);
    assert.equal(c.fx.app.appServers.status("Tools/Echo").state, "running");

    assert.equal((await call(c.port, "/api/apps/revoke", { method: "POST", headers: c.json, body: "{\"root\":\"Tools/Echo\"}" })).status, 200);
    assert.equal(c.fx.app.appServers.status("Tools/Echo").state, "stopped");
    assert.equal((await call(c.port, `${base}_api/pid`)).status, 404, "its frames' tokens went with the grant");
    assert.equal((await call(c.port, "/api/apps/server/restart", { method: "POST", headers: c.json, body: "{\"root\":\"Tools/Echo\"}" })).status, 403);
  });
});
