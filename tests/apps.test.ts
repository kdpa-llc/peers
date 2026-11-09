/** App pages in a sandboxed frame (ADR 0006, CONTRACT_TESTS #6–#8). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VaultServer } from "../src/vault/server.ts";
import { findApp, pageTasks, validateManifest } from "../src/vault/apps.ts";
import { parseOrg } from "../src/vault/org.ts";
import { brief } from "../src/vault/messages.ts";
import { BASE_FILES, makeVault, writeFiles, type Fixture } from "./helpers.ts";

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

const APP_FILES: Record<string, string> = {
  ...BASE_FILES,
  "Dashboards/Board/peers.app.json": JSON.stringify({ name: "Board", reads: ["Projects/**"] }),
  "Dashboards/Board/index.html": "<!doctype html><script src=\"_peers/peers.js\"></script><h1>Board</h1>",
  "Dashboards/Board/app.js": "console.log('board')",
  "Dashboards/Board/views/week.html": "<!doctype html><p>week</p>",
  "Inbox/report.html": "<!doctype html><p>report</p>",
  "Projects/Garden.org": "#+TITLE: Garden\n* NEXT [#A] Order soil :shop:\nDEADLINE: <2026-11-14 Sat> SCHEDULED: <2026-11-09 Mon>\n* DONE Measure\n- [ ] Build frames\n",
};

type Ctx = { port: number; server: VaultServer; fx: Fixture; cookie: string; json: Record<string, string> };

async function withApps(fn: (c: Ctx) => Promise<void>, opts: { origin?: string } = {}): Promise<void> {
  const fx = await makeVault({ files: APP_FILES });
  const server = new VaultServer(fx.app, { port: 0, ...(opts.origin ? { origin: opts.origin } : {}) });
  const port = await server.listen();
  try {
    const code = server.createPairingCode();
    const r = await call(port, "/api/pair", {
      method: "POST", headers: { "content-type": "application/json", "x-peers": "1" }, body: JSON.stringify({ code, name: "test" }),
    });
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    await fn({ port, server, fx, cookie, json: { "content-type": "application/json", "x-peers": "1", cookie } });
  } finally {
    await server.close();
    await fx.close();
  }
}

async function open(c: Ctx, path: string): Promise<{ url: string; app: Record<string, any>; owner: string; token: string }> {
  const r = await call(c.port, "/api/apps/open", { method: "POST", headers: c.json, body: JSON.stringify({ path }) });
  assert.equal(r.status, 200, r.body);
  const out = JSON.parse(r.body);
  out.token = /^\/apps\/([^/]+)\//.exec(out.url)![1];
  return out;
}

const csp = (r: Res): string => String(r.headers["content-security-policy"] ?? "");

test("#6 an app frame is sandboxed without same-origin, needs no session, and is framed only by Peers", async () => {
  await withApps(async (c) => {
    const o = await open(c, "Dashboards/Board");
    assert.equal(o.url, `/apps/${o.token}/index.html`);
    assert.equal(o.app.name, "Board");

    // No cookie: the token is the capability.
    const page = await call(c.port, o.url);
    assert.equal(page.status, 200);
    assert.match(page.body, /<h1>Board<\/h1>/);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    const policy = csp(page);
    assert.match(policy, /^sandbox allow-scripts allow-forms allow-modals allow-downloads;/);
    assert.doesNotMatch(policy, /allow-same-origin|allow-top-navigation|allow-popups/);
    const self = `http://127.0.0.1:${c.port}/apps/${o.token}/`;
    assert.match(policy, new RegExp(`default-src ${self.replace(/[/.]/g, "\\$&")};`));
    assert.match(policy, new RegExp(`connect-src ${self.replace(/[/.]/g, "\\$&")};`), "connect only within its own token path");
    assert.match(policy, new RegExp(`frame-ancestors http://127\\.0\\.0\\.1:${c.port}$`));
    assert.doesNotMatch(policy, /'self'/, "WebKit does not match 'self' in a sandboxed document");
    assert.equal(page.headers["x-frame-options"], undefined);
    assert.equal(page.headers["access-control-allow-origin"], "*");
    assert.equal(page.headers["set-cookie"], undefined);

    // Read-only, and an unknown token gets nothing.
    assert.equal((await call(c.port, o.url, { method: "POST" })).status, 405);
    const unknown = await call(c.port, `/apps/${"x".repeat(32)}/index.html`);
    assert.equal(unknown.status, 404);
    assert.match(csp(unknown), /^sandbox;/);

    // The API refuses an opaque-origin frame and other sites even with the cookie.
    assert.equal((await call(c.port, "/api/state", { headers: { cookie: c.cookie } })).status, 200);
    assert.equal((await call(c.port, "/api/state", { headers: { cookie: c.cookie, origin: "null" } })).status, 403);
    assert.equal((await call(c.port, "/api/state", { headers: { cookie: c.cookie, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await call(c.port, "/api/state", { headers: { cookie: c.cookie, "sec-fetch-site": "same-site" } })).status, 403);
    assert.equal((await call(c.port, "/api/state", { headers: { cookie: c.cookie, "sec-fetch-site": "same-origin" } })).status, 200);

    // Opening an app needs the session.
    assert.equal((await call(c.port, "/api/apps/open", { method: "POST", headers: { "content-type": "application/json", "x-peers": "1" }, body: "{\"path\":\"Dashboards/Board\"}" })).status, 401);
  });
});

test("#6 the policy names the origin the browser used, through the HTTPS proxy too", async () => {
  await withApps(async (c) => {
    const o = await open(c, "Dashboards/Board");
    const r = await call(c.port, o.url, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "mac.example.ts.net" } });
    assert.equal(r.status, 200);
    assert.match(csp(r), new RegExp(`default-src https://mac\\.example\\.ts\\.net/apps/${o.token}/;`));
    assert.match(csp(r), /frame-ancestors https:\/\/mac\.example\.ts\.net$/);
  }, { origin: "https://mac.example.ts.net" });
});

test("#7 an app reads its own folder and its reads, through the path policy, and nothing else", async () => {
  await withApps(async (c) => {
    const o = await open(c, "Dashboards/Board");
    const base = `/apps/${o.token}`;
    const data = (name: string, q = ""): Promise<Res> => call(c.port, `${base}/_peers/${name}${q}`);

    assert.equal((await call(c.port, `${base}/app.js`)).body, "console.log('board')");
    assert.match(String((await call(c.port, `${base}/app.js`)).headers["content-type"]), /text\/javascript/);
    assert.equal((await call(c.port, `${base}/views/`)).status, 404, "a folder without index.html");
    assert.match((await call(c.port, `${base}/views/week.html`)).body, /week/);

    const plan = await data("file", "?path=Projects/Alpha/Plan.md");
    assert.equal(plan.status, 200);
    assert.match(plan.body, /Ship on March 14/);
    assert.equal((await data("file", "?path=Areas/Finances/Budget.md")).status, 403, "not in its reads");
    assert.equal((await data("file", "?path=Welcome.md")).status, 403);
    assert.equal((await data("file", "?path=.peers/layout.json")).status, 403, "dot paths never");
    assert.equal((await data("file", "?path=Projects/../Areas/Finances/Budget.md")).status, 403);
    // Encoded traversal in the app's own file path is refused by the path policy.
    const sneaky = await call(c.port, `${base}/views%2F..%2F..%2F..%2FAreas%2FFinances%2FBudget.md`);
    assert.notEqual(sneaky.status, 200);
    assert.doesNotMatch(sneaky.body, /Kitchen fund/);

    // Listings show what it may read and the folders on the way there.
    const root = JSON.parse((await data("list", "?path=")).body).entries.map((e: { path: string }) => e.path);
    assert.deepEqual(root.sort(), ["Dashboards", "Projects"]);
    const all = JSON.parse((await data("list", "?path=Projects&recursive=1")).body).entries.map((e: { path: string }) => e.path);
    assert.ok(all.includes("Projects/Alpha/Plan.md") && all.includes("Projects/Garden.org"));
    assert.equal((await data("list", "?path=Areas")).status, 403);

    const page = JSON.parse((await data("page", "?path=Projects/Garden.org")).body);
    assert.equal(page.title, "Garden");
    assert.equal(page.format, "org");
    const tasks = JSON.parse((await data("tasks", "?path=Projects")).body).tasks as Record<string, unknown>[];
    const soil = tasks.find((t) => t.title === "Order soil")!;
    assert.deepEqual({ todo: soil.todo, done: soil.done, priority: soil.priority, deadline: soil.deadline, scheduled: soil.scheduled, tags: soil.tags },
      { todo: "NEXT", done: false, priority: "A", deadline: "2026-11-14 Sat", scheduled: "2026-11-09 Mon", tags: ["shop"] });
    assert.ok(tasks.some((t) => t.title === "Write copy" && t.done === false && t.path === "Projects/Alpha/Plan.md"));
    assert.ok(tasks.some((t) => t.title === "Measure" && t.done === true));

    const info = JSON.parse((await data("app")).body);
    assert.deepEqual(info, { name: "Board", root: "Dashboards/Board", entry: "index.html", reads: ["Projects/**"], network: [] });
    // The helper answers at any depth, so nested pages can load it with a relative URL.
    const helper = await call(c.port, `${base}/views/_peers/peers.js`);
    assert.equal(helper.status, 200);
    assert.match(helper.body, /window\.peers = \{/);
  });
});

test("#7 a single .html page reads its folder; a page inside an app opens that app", async () => {
  await withApps(async (c) => {
    const report = await open(c, "Inbox/report.html");
    assert.deepEqual([report.app.root, report.app.entry, report.app.manifest], ["Inbox", "report.html", false]);
    const base = `/apps/${report.token}/_peers`;
    assert.equal((await call(c.port, `${base}/file?path=Inbox/Clip.md`)).status, 200);
    assert.equal((await call(c.port, `${base}/file?path=Projects/Alpha/Plan.md`)).status, 403);

    const week = await open(c, "Dashboards/Board/views/week.html");
    assert.equal(week.app.root, "Dashboards/Board");
    assert.equal(week.url, `/apps/${week.token}/views/week.html`);
    assert.equal((await call(c.port, "/api/apps/open", { method: "POST", headers: c.json, body: JSON.stringify({ path: "Welcome.md" }) })).status, 404);
  });
});

test("#7 a token dies with its device and after twelve hours", async () => {
  await withApps(async (c) => {
    const a = await open(c, "Dashboards/Board");
    assert.equal((await call(c.port, a.url)).status, 200);
    c.fx.clock.advance(12 * 3600_000 + 1);
    assert.equal((await call(c.port, a.url)).status, 404, "expired");

    const b = await open(c, "Dashboards/Board");
    const devices = JSON.parse((await call(c.port, "/api/devices", { headers: { cookie: c.cookie } })).body);
    assert.equal((await call(c.port, `/api/devices/${devices.current}`, { method: "DELETE", headers: c.json })).status, 200);
    assert.equal((await call(c.port, b.url)).status, 404, "revoked with its device");
  });
});

test("#8 internet access waits for the owner, only for what was asked, and stays out of the vault", async () => {
  await withApps(async (c) => {
    writeFiles(c.fx.root, { "Dashboards/Board/peers.app.json": JSON.stringify({ name: "Board", reads: ["Projects/**"], network: ["https://cdn.example.com"] }) });
    let o = await open(c, "Dashboards/Board");
    assert.deepEqual([o.app.network, o.app.asks], [[], ["https://cdn.example.com"]]);
    assert.doesNotMatch(csp(await call(c.port, o.url)), /cdn\.example\.com/);

    const grant = (network: string[]): Promise<Res> =>
      call(c.port, "/api/apps/grant", { method: "POST", headers: c.json, body: JSON.stringify({ root: "Dashboards/Board", network }) });
    assert.equal((await grant(["https://evil.example.com"])).status, 400, "only what the manifest asks for");
    assert.equal((await call(c.port, "/api/apps/grant", { method: "POST", headers: c.json, body: JSON.stringify({ root: "Inbox", network: [] }) })).status, 400);
    assert.equal((await grant(["https://cdn.example.com"])).status, 200);
    o = await open(c, "Dashboards/Board");
    assert.deepEqual([o.app.network, o.app.asks], [["https://cdn.example.com"], []]);
    assert.match(csp(await call(c.port, o.url)), /connect-src \S+ https:\/\/cdn\.example\.com;/);

    // A manifest edit cannot grant itself more.
    writeFiles(c.fx.root, { "Dashboards/Board/peers.app.json": JSON.stringify({ reads: ["Projects/**"], network: ["https://cdn.example.com", "https://api.example.com"] }) });
    o = await open(c, "Dashboards/Board");
    assert.deepEqual([o.app.network, o.app.asks], [["https://cdn.example.com"], ["https://api.example.com"]]);
    assert.doesNotMatch(csp(await call(c.port, o.url)), /api\.example\.com/);
    // The grant is in Peers' state, never in the vault.
    const row = c.fx.app.db.prepare("SELECT grant_json FROM vault_app_grants WHERE root = ?").get("Dashboards/Board") as { grant_json: string };
    assert.deepEqual(JSON.parse(row.grant_json), { network: ["https://cdn.example.com"] });
    assert.ok(!existsSync(join(c.fx.root, ".peers")) || !readdirSync(join(c.fx.root, ".peers")).some((f) => /grant/i.test(f)));

    assert.equal((await call(c.port, "/api/apps/revoke", { method: "POST", headers: c.json, body: JSON.stringify({ root: "Dashboards/Board" }) })).status, 200);
    o = await open(c, "Dashboards/Board");
    assert.deepEqual(o.app.network, []);
  });
});

test("app change events carry only what the app may read", async () => {
  await withApps(async (c) => {
    const o = await open(c, "Dashboards/Board");
    const got: string[] = [];
    await new Promise<void>((done, fail) => {
      const req = request({ host: "127.0.0.1", port: c.port, path: `/apps/${o.token}/_peers/events`, headers: { host: `127.0.0.1:${c.port}` } }, (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
        res.on("data", (d) => {
          got.push(String(d));
          if (got.join("").includes("Projects/Alpha/Plan.md")) { req.destroy(); done(); }
        });
        c.fx.app.bus.publish("file.changed", { paths: ["Areas/Finances/Budget.md"] });
        c.fx.app.bus.publish("file.changed", { paths: ["Projects/Alpha/Plan.md", "Inbox/Clip.md"] });
      });
      req.on("error", (e) => { if (!got.length) fail(e); });
      req.end();
    });
    const text = got.join("");
    assert.match(text, /event: change\ndata: \{"paths":\["Projects\/Alpha\/Plan\.md"\]\}/);
    assert.doesNotMatch(text, /Budget|Clip/);
  });
});

test("the tree marks app folders and opens their entry; a broken manifest says why", async () => {
  await withApps(async (c) => {
    const tree = c.fx.app.treeView() as { apps: string[]; fronts: Record<string, string> };
    assert.deepEqual(tree.apps, ["Dashboards/Board"]);
    assert.equal(tree.fronts["Dashboards/Board"], "Dashboards/Board/index.html");
    writeFiles(c.fx.root, { "Dashboards/Board/peers.app.json": "{\"reads\": [\".peers\"]}" });
    const r = await call(c.port, "/api/apps/open", { method: "POST", headers: c.json, body: JSON.stringify({ path: "Dashboards/Board" }) });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.body).error, /reads/);
  });
});

test("manifests follow docs/specs/app.schema.json", () => {
  assert.deepEqual(validateManifest({ name: "X", reads: ["Projects/**"], network: ["https://*.example.com:8443"] }),
    { name: "X", reads: ["Projects/**"], network: ["https://*.example.com:8443"] });
  for (const bad of [
    [], { extra: 1 }, { reads: ["../x"] }, { reads: [".git"] }, { reads: ["/abs"] }, { network: ["http://example.com"] },
    { network: ["https://example.com/path"] }, { entry: "app.js" }, { entry: "/index.html" }, { entry: "a/.hidden/x.html" }, { name: "" },
  ]) {
    assert.throws(() => validateManifest(bad), { name: "AppError" }, JSON.stringify(bad));
  }
});

test("findApp: the vault root folder is never an app; pages are not apps", async () => {
  const fx = await makeVault({ files: { ...BASE_FILES, "peers.app.json": "{}", "index.html": "<p>x</p>" } });
  try {
    const app = findApp(fx.root, "index.html")!;
    assert.equal(app.manifest, false, "a root peers.app.json is ignored");
    assert.equal(findApp(fx.root, "Welcome.md"), undefined);
  } finally {
    await fx.close();
  }
});

test("tasks: Org headings with keywords and planning, and checkboxes under their heading", () => {
  const tasks = pageTasks("x.org", parseOrg("* Plan\n- [X] Pick the spot\n- [ ] Build\n* TODO Call :phone:\nDEADLINE: <2026-12-01 Tue>\n").blocks);
  assert.deepEqual(tasks.map((t) => [t.title, t.done, t.section ?? t.todo, t.deadline ?? null]), [
    ["Pick the spot", true, "Plan", null],
    ["Build", false, "Plan", null],
    ["Call", false, "TODO", "2026-12-01 Tue"],
  ]);
});

test("the brief tells agents how to build an app", () => {
  const text = brief({
    botName: "Vault", kind: "vault", home: "", vaultRoot: "/vault", owner: "Sam", date: "2026-11-08",
    writeHint: "", memoryPath: ".peers/agents/v.memory.md", otherBots: [],
  });
  assert.match(text, /peers\.app\.json/);
  assert.match(text, /_peers\/peers\.js/);
  assert.match(text, /Never put raw HTML in a page/);
});
