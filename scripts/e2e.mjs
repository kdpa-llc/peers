#!/usr/bin/env node
/**
 * Browser journey for Peers (TECHNICAL.md §15). Starts a vault server on a temporary
 * copy of the demo vault with the demo engine (no T3, no model), then drives it in desktop
 * Chromium and phone WebKit: select and ask, changes marked until you have looked, pen marks,
 * batch send, memory, several conversations and an @mention, night theme, PDF, search,
 * Today, and the phone layout. Fails with a non-zero exit code on the first broken step.
 *
 *   npm run test:e2e                      # needs playwright-core (see below)
 *   PEERS_PLAYWRIGHT=/path/with/node_modules npm run test:e2e
 *   npm run test:e2e -- --shots /tmp/peers-shots
 *
 * Playwright is not a dependency of this repository. Install `playwright-core` (and its
 * browsers) anywhere and point PEERS_PLAYWRIGHT at that folder, or install it here.
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const shotsArg = args.indexOf("--shots");
const SHOTS = resolve(shotsArg >= 0 ? args[shotsArg + 1] : join(ROOT, ".e2e-shots"));
mkdirSync(SHOTS, { recursive: true });

let pw;
for (const base of [process.env.PEERS_PLAYWRIGHT, ROOT].filter(Boolean)) {
  try { pw = createRequire(join(base, "noop.js"))("playwright-core"); break; } catch { /* next */ }
}
if (!pw) {
  console.error("playwright-core not found. Install it and set PEERS_PLAYWRIGHT to its folder.");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "peers-e2e-"));
const vault = join(work, "vault");
const state = join(work, "state");
cpSync(join(ROOT, "examples", "vault"), vault, { recursive: true });
const port = 4800 + Math.floor(Math.random() * 400);
const cli = ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli", "main.ts"), "serve"];
const server = spawn(process.execPath, [...cli, vault, "--scripted", "--port", String(port), "--state-dir", state], {
  // A fixed owner name, so screenshots never carry the name of whoever runs the journey.
  // App servers run unsandboxed here: bubblewrap exists only in the container (ADR 0007).
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, USER: "sam", PEERS_APP_SANDBOX: "off" },
});
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });

const failures = [];
let step = "";
const t0 = Date.now();
function ok(cond, what) {
  if (!cond) throw new Error(`${step}: ${what}`);
}
async function stage(name, fn) {
  step = name;
  const started = Date.now();
  try {
    await fn();
    console.log(`  ✔ ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    console.log(`  ✖ ${name}: ${err.message}`);
    failures.push(name);
    throw err;
  }
}

function pairingCode() {
  const r = spawnSync(process.execPath, [...cli.slice(0, -1), "pair", vault, "--local", "--state-dir", state], { cwd: ROOT, encoding: "utf8" });
  const m = /Pairing code: (\w{6})/.exec(r.stdout);
  if (!m) throw new Error(`could not mint a pairing code: ${r.stdout}${r.stderr}`);
  return m[1];
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    const m = /\?pair=(\w{6})/.exec(log);
    if (m) return `http://127.0.0.1:${port}/?pair=${m[1]}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}

async function textRect(page, needle) {
  return page.evaluate((needle) => {
    const body = document.querySelector(".page-body");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    return null;
  }, needle);
}

async function blockRect(page, startsWith) {
  return page.evaluate((s) => {
    const el = [...document.querySelectorAll(".page-body [data-line]")].find((e) => e.textContent.trim().startsWith(s));
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, startsWith);
}

async function drawEllipse(page, r) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = r.w / 2 + 14, ry = r.h / 2 + 12;
  await page.mouse.move(cx + rx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2.08;
    await page.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a), { steps: 1 });
  }
  await page.mouse.up();
}

const errors = [];
let probing = false;
function watch(page, label) {
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Expected: the pairing screen's first request is unauthorised by design.
    if (/status of 401/.test(text)) return;
    // Playwright's WebKit screenshots inject a <style>; the app's strict CSP refuses it.
    // Verified separately: the app logs nothing until a screenshot is taken.
    if (label === "phone" && /Refused to apply a stylesheet/.test(text)) return;
    // The app step probes the sandbox on purpose: what it refuses is the point.
    if (probing) return;
    errors.push(`${label} console: ${text}`);
  });
}

let browser;
try {
  const url = await waitForServer();
  console.log(`Peers e2e on ${url.replace(/\?pair=.*/, "")}`);
  browser = await pw.chromium.launch();
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await desktop.newPage();
  watch(page, "desktop");

  await stage("pair with the one-time link and load Today", async () => {
    await page.goto(url);
    await page.waitForSelector(".today h1");
    ok((await page.locator(".bot-tile").count()) >= 8, "expected a tile per bot");
    ok(!(await page.url()).includes("pair="), "pairing token stays out of the URL");
    await page.screenshot({ path: join(SHOTS, "desktop-today-day.png") });
  });

  await stage("open a page from the tree; its bot follows", async () => {
    await page.locator(".tree-row", { hasText: "Website Relaunch" }).first().click();
    await page.locator(".tree-row", { hasText: "Launch plan" }).click();
    await page.waitForFunction(() => document.querySelector(".page-title")?.textContent === "Launch plan");
    await page.waitForSelector(".page-body .md-block");
    await page.waitForFunction(() => document.querySelector(".bot-id .name")?.textContent?.includes("Website Relaunch"));
    await page.screenshot({ path: join(SHOTS, "desktop-page-day.png") });
  });

  await stage("select text, ask, and see the bot's edit with a change bar", async () => {
    const r = await textRect(page, "Finish mobile QA");
    ok(r, "found the task text");
    await page.mouse.move(r.x + 1, r.y + r.h / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.w - 1, r.y + r.h / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector(".ask-bubble textarea");
    await page.fill(".ask-bubble textarea", "make this bold");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".page-body strong", { timeout: 15000 });
    await page.waitForSelector(".md-block.changed");
    await page.waitForSelector(".change-chip");
    await page.waitForSelector(".pin.applied, .pin.done", { timeout: 10000 });
    await page.waitForSelector(".msg .bot-text >> text=Done (demo mode)", { timeout: 10000 });
    const chip = await page.locator(".change-chip").textContent();
    ok(/since you last looked · by Website Relaunch/.test(chip), `the chip says who changed it (${chip})`);
    ok(!(await page.locator(".change-chip button", { hasText: "Undo" }).count()), "no Undo");
    await page.screenshot({ path: join(SHOTS, "desktop-changed-day.png") });
  });

  await stage("opening the page again shows no marks: you have seen it", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/today`);
    await page.waitForSelector(".today h1");
    await page.goto(`http://127.0.0.1:${port}/#/p/${encodeURI("Projects/Website Relaunch/Launch plan.md")}`);
    await page.waitForSelector(".page-body .md-block");
    await page.waitForSelector(".page-body strong");
    ok(!(await page.locator(".change-chip").count()), "no change chip after looking");
    ok(!(await page.locator(".md-block.changed").count()), "no changed blocks after looking");
  });

  await stage("circle a paragraph with the pen, see the target, send", async () => {
    await page.keyboard.press("p");
    ok(await page.locator(".tool.active[aria-label^='Pen']").count(), "pen is active");
    const r = await blockRect(page, "Content locks on March 6");
    ok(r, "found the paragraph");
    await drawEllipse(page, r);
    await page.waitForSelector(".popover textarea", { timeout: 5000 });
    const target = await page.locator(".popover .target").textContent();
    ok(/Line/.test(target), `popover shows the resolved target (${target})`);
    await page.screenshot({ path: join(SHOTS, "desktop-marking-day.png") });
    await page.fill(".popover textarea", "turn into a table with owners");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".page-body table >> text=Maya", { timeout: 15000 });
    await page.waitForSelector(".md-block.changed");
  });

  await stage("batch two notes and send them together", async () => {
    await page.keyboard.press("p");
    const a = await textRect(page, "Redirect old blog URLs");
    await drawEllipse(page, { ...a, w: a.w, h: a.h });
    await page.waitForSelector(".popover textarea");
    await page.fill(".popover textarea", "delete this");
    await page.keyboard.press("Alt+Enter");
    await page.waitForSelector(".tool-pill .send");
    await page.keyboard.press("p");
    const b = await textRect(page, "Set up analytics goals");
    await drawEllipse(page, b);
    await page.waitForSelector(".popover textarea");
    await page.fill(".popover textarea", "make this bold");
    await page.locator(".popover button", { hasText: "Add to batch" }).click();
    const label = await page.locator(".tool-pill .send").textContent();
    ok(/Send 2/.test(label), `pill shows two queued notes (${label})`);
    await page.screenshot({ path: join(SHOTS, "desktop-batch-day.png") });
    await page.locator(".tool-pill .send").click();
    await page.waitForFunction(() => !document.body.innerText.includes("Redirect old blog URLs"), null, { timeout: 15000 });
    await page.waitForSelector(".page-body strong >> text=Set up analytics goals");
  });

  await stage("conversations: notes started their own; a new one; @mention reaches another bot", async () => {
    await page.locator(".conv-current").click();
    await page.waitForSelector(".conv-list .conv-open");
    const n = await page.locator(".conv-list .conv-open").count();
    ok(n >= 3, `each notes send is its own conversation (${n})`);
    await page.screenshot({ path: join(SHOTS, "desktop-conversations-day.png") });
    await page.locator(".conv-row.new").click();
    await page.waitForSelector(".composer textarea");
    await page.fill(".composer textarea", "@Finances can we afford a launch party?");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".msg .bot-text >> text=Demo mode", { timeout: 15000 });
    const title = await page.locator(".conv-current .conv-title").textContent();
    ok(/@Finances can we afford/.test(title), `the new conversation is titled from its first message (${title})`);
    await page.waitForSelector(".toast >> text=Also sent to Finances");
    await page.locator(".toast button", { hasText: "Open" }).click();
    await page.waitForFunction(() => document.querySelector(".bot-id .name")?.textContent?.includes("Finances"));
    await page.waitForSelector(".msg.mine .bubble >> text=can we afford a launch party");
    const ctx = await page.locator(".msg.mine .ctx").first().textContent();
    ok(/from Website Relaunch/.test(ctx), `the mention says where it came from (${ctx})`);
    await page.waitForSelector(".thread .card.peer >> text=Open that conversation");
    await page.screenshot({ path: join(SHOTS, "desktop-mention-day.png") });
  });

  await stage("chat: remember a preference; it shows in Memory", async () => {
    await page.fill(".composer textarea", "Please remember that I like summaries under five bullets");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".msg .bot-text >> text=I will remember", { timeout: 15000 });
    ok(!(await page.locator(".bot-pane .tabs").count()), "the bot pane is chat only");
    await page.locator(".bot-head [aria-label='Bot settings']").click();
    await page.waitForSelector(".bot-settings #bot-memory >> text=summaries under five bullets");
    ok(await page.locator(".bot-settings #bot-triggers").count(), "triggers are on the settings page");
    ok(await page.locator(".bot-settings #bot-setup").count(), "instructions and model are on the settings page");
    await page.screenshot({ path: join(SHOTS, "desktop-bot-settings-day.png") });
  });

  await stage("an Org page with its own agent: task states, planning, drawers", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/p/${encodeURI("Projects/Garden beds.org")}`);
    await page.waitForFunction(() => document.querySelector(".page-title")?.textContent === "Garden beds");
    await page.waitForSelector(".todo-kw.todo-next >> text=NEXT");
    await page.waitForSelector(".planning .plan-deadline");
    await page.waitForSelector(".page-body details.org-drawer summary >> text=Properties");
    const box = await page.locator(".page-body details.org-drawer").boundingBox();
    const body = await page.locator(".page-body").boundingBox();
    ok(box && body && box.x >= body.x && box.x < body.x + body.width, "the drawer sits in the page, not over it");
    await page.waitForSelector(".page-body table >> text=Tomatoes, basil");
    await page.waitForFunction(() => document.querySelector(".bot-id .name")?.textContent?.includes("Garden beds"));
    const status = await page.locator(".bot-id .status").textContent();
    ok(/Page agent/.test(status), `a single page can have its own agent (${status})`);
    await page.screenshot({ path: join(SHOTS, "desktop-org-day.png") });
  });

  await stage("give any folder an agent from its menu", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/today`);
    await page.waitForSelector(".today h1");
    await page.locator(".tree-row", { hasText: "Reading Notes" }).first().click({ button: "right" });
    await page.locator(".menu button", { hasText: "Give this folder an agent" }).click();
    await page.waitForSelector(".toast >> text=now looks after Resources/Reading Notes");
    await page.waitForFunction(() => document.querySelector(".bot-id .name")?.textContent?.includes("Reading notes") ||
      document.querySelector(".bot-id .name")?.textContent?.includes("Reading Notes"));
    const row = page.locator(".tree-row", { hasText: "Reading Notes" }).first();
    ok(await row.locator(".avatar").count(), "the folder shows its agent in the tree");
    await page.locator(".tree-row", { hasText: "Reading Notes" }).first().click({ button: "right" });
    await page.locator(".menu button", { hasText: "Remove agent" }).click();
    await page.locator(".modal .actions button", { hasText: "Remove" }).click();
    await page.waitForSelector(".toast >> text=removed");
  });

  await stage("night theme", async () => {
    await page.goto(new URL("/#/settings", url).href.replace(/\?pair=\w+/, ""));
    await page.locator(".seg button", { hasText: "Night" }).click();
    ok(await page.evaluate(() => document.documentElement.dataset.theme === "night"), "night tokens applied");
    await page.goto(`http://127.0.0.1:${port}/#/p/${encodeURI("Projects/Website Relaunch/Launch plan.md")}`);
    await page.waitForSelector(".page-body .md-block");
    await page.screenshot({ path: join(SHOTS, "desktop-page-night.png") });
    await page.keyboard.press("p");
    const r = await blockRect(page, "Launch the new website");
    await drawEllipse(page, r);
    await page.waitForSelector(".popover textarea");
    await page.fill(".popover textarea", "shorten this");
    await page.screenshot({ path: join(SHOTS, "desktop-marking-night.png") });
    await page.keyboard.press("Escape");
  });

  await stage("open a PDF and mark a region", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/p/${encodeURI("Projects/Q1 Tax Filing/Income summary revised.pdf")}`);
    await page.waitForFunction(() => {
      const c = document.querySelector(".pdf-page canvas");
      return c && c.width > 0;
    }, null, { timeout: 20000 });
    const box = await page.locator(".pdf-page").first().boundingBox();
    await page.keyboard.press("p");
    await drawEllipse(page, { x: box.x + 40, y: box.y + 120, w: 300, h: 60 });
    await page.waitForSelector(".popover");
    const target = await page.locator(".popover .target").textContent();
    ok(/Page 1/.test(target), `PDF mark resolves to a page (${target})`);
    await page.fill(".popover textarea", "Extract to notes");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".pin.answered, .pin.applied, .pin.done", { timeout: 15000 });
    await page.screenshot({ path: join(SHOTS, "desktop-pdf-night.png") });
  });

  await stage("search with ⌘K", async () => {
    await page.keyboard.press("Meta+k");
    await page.waitForSelector(".palette input");
    await page.keyboard.type("budget");
    await page.waitForSelector(".palette .item.active");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash.includes("Budget"));
    await page.waitForSelector(".page-body table");
  });

  await stage("Today lists what changed since you looked", async () => {
    // An edit from outside Peers (an editor, a sync): Today and the tree show it.
    appendFileSync(join(vault, "Areas/Family/Birthdays.md"), "\n- Grandma: 3 May\n");
    await page.goto(`http://127.0.0.1:${port}/#/today`);
    await page.waitForSelector(".today h2 >> text=Changed since you looked");
    await page.waitForSelector(".row-card >> text=Birthdays", { timeout: 10000 });
    const by = await page.locator(".row-card", { hasText: "Birthdays" }).textContent();
    ok(/by outside Peers/.test(by), `credited to outside Peers (${by})`);
    await page.screenshot({ path: join(SHOTS, "desktop-today-night.png") });
  });

  await stage("an app: the projects board reads the vault in a sandbox and cannot act as you", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/p/${encodeURI("Dashboards/Projects board/index.html")}`);
    await page.waitForSelector(".app-view .app-frame");
    const board = page.frameLocator(".app-frame");
    await board.locator(".card").first().waitFor({ timeout: 10000 });
    const cards = await board.locator(".card").count();
    ok(cards === 4, `a card per project (${cards})`);
    ok(await board.locator(".card li", { hasText: "Order soil" }).count() === 1, "the Org project's NEXT task is on the board");
    ok(await page.locator(".app-chip.offline").count() === 1, "offline until the owner allows more");
    ok(await page.locator(".tool-pill:not(.hidden)").count() === 0, "no pen tools on an app");
    const frame = page.frames().find((f) => f.url().includes("/apps/"));
    ok(frame, "the app frame");
    probing = true;
    const probe = await frame.evaluate(async () => {
      const out = {};
      try { out.cookie = document.cookie; } catch { out.cookie = "blocked"; }
      try { out.storage = localStorage.length; } catch { out.storage = "blocked"; }
      try { out.parent = parent.document.title; } catch { out.parent = "blocked"; }
      try { out.api = (await fetch("/api/state")).status; } catch { out.api = "blocked"; }
      try { out.internet = (await fetch("https://example.com/")).status; } catch { out.internet = "blocked"; }
      out.theme = document.documentElement.dataset.theme;
      return out;
    });
    await page.waitForTimeout(200);
    probing = false;
    ok(probe.cookie === "blocked" && probe.storage === "blocked" && probe.parent === "blocked", `an opaque origin (${JSON.stringify(probe)})`);
    ok(probe.api === "blocked" && probe.internet === "blocked", `no API and no internet (${JSON.stringify(probe)})`);
    ok(probe.theme === "night", `the app follows Peers' theme (${probe.theme})`);
    await page.screenshot({ path: join(SHOTS, "desktop-app-night.png") });
    // Asking the agent goes through you.
    await board.locator(".card .ask").first().click();
    await page.waitForSelector(".modal >> text=Send this to");
    await page.locator(".modal .actions button.primary").click();
    await page.waitForSelector(".bot-pane >> text=What should happen next", { timeout: 10000 });
    // A card opens its project in Peers.
    await board.locator(".card h2 a").first().click();
    await page.waitForFunction(() => decodeURI(location.hash).includes("/p/Projects/"));
    await page.waitForSelector(".page-body .md-block, .page-body .org-drawer, .page-body h2");
  });

  await stage("an app with a server: allow it, add an expense, find it in the vault", async () => {
    // Until it is allowed, the app's calls to its server are refused: that is the point.
    probing = true;
    await page.goto(`http://127.0.0.1:${port}/#/p/${encodeURI("Areas/Finances/Expense log/index.html")}`);
    await page.waitForSelector(".app-ask >> text=run its server");
    const log = page.frameLocator(".app-frame");
    await log.locator("#status").waitFor({ state: "attached" });
    await page.locator(".app-ask button", { hasText: "Allow" }).click();
    await page.waitForSelector(".app-ask.hidden", { state: "attached" });
    await page.waitForTimeout(300);
    probing = false;
    await log.locator("#totals", { hasText: "Nothing logged yet" }).waitFor({ timeout: 15000 });
    await log.locator("input[name=amount]").fill("42.50");
    await log.locator("input[name=category]").fill("groceries");
    await log.locator("input[name=note]").fill("market");
    await log.locator("button[type=submit]").click();
    await log.locator("#rows td", { hasText: "groceries" }).waitFor({ timeout: 10000 });
    const csv = readFileSync(join(vault, "Areas/Finances/Expense log/data/expenses.csv"), "utf8");
    ok(/groceries/.test(csv) && /42\.50/.test(csv), `saved in the app's data folder (${csv.trim()})`);
    await page.waitForSelector(".app-chip.server.running");
    await page.screenshot({ path: join(SHOTS, "desktop-app-server-night.png") });
    await page.locator(".app-chip.server").click();
    await page.waitForSelector(".modal .app-log >> text=expense log on port");
    await page.locator(".modal .actions button", { hasText: "Close" }).click();
  });

  await stage("API refuses requests without a session or the CSRF header", async () => {
    const r1 = await fetch(`http://127.0.0.1:${port}/api/state`);
    ok(r1.status === 401, `no cookie gives 401 (${r1.status})`);
    const cookies = await desktop.cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const r2 = await fetch(`http://127.0.0.1:${port}/api/bots/x/run`, { method: "POST", headers: { cookie } });
    ok(r2.status === 403, `write without X-Peers gives 403 (${r2.status})`);
    // fetch() drops a custom Host header, so DNS rebinding is checked with a raw request.
    const status = await new Promise((done, fail) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/state", headers: { cookie, host: `evil.example:${port}` } }, (res) => { res.resume(); done(res.statusCode); });
      req.on("error", fail);
      req.end();
    });
    ok(status === 421, `unknown Host gives 421 (${status})`);
    const r4 = await fetch(`http://127.0.0.1:${port}/api/raw?path=${encodeURIComponent(".peers/vault.json")}`, { headers: { cookie } });
    ok(r4.status === 403, `dot paths are refused (${r4.status})`);
  });

  // ------------------------------------------------------------ phone
  const webkit = await pw.webkit.launch();
  const phone = await webkit.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
  });
  const mobile = await phone.newPage();
  const shot = (name) => mobile.screenshot({ path: join(SHOTS, name), caret: "initial" });
  watch(mobile, "phone");

  await stage("phone: pair with a code on the pairing screen", async () => {
    await mobile.goto(`http://127.0.0.1:${port}/`);
    await mobile.waitForSelector(".pair-screen input");
    await shot("phone-pair.png");
    await mobile.fill(".pair-screen input", pairingCode());
    await mobile.locator(".pair-screen button").click();
    await mobile.waitForSelector(".tabbar");
  });

  await stage("phone: vault tab, page tab with the bot sheet, bot tab", async () => {
    await mobile.locator(".tabbar button").nth(0).click();
    await mobile.waitForSelector(".tree-pane .tree-row");
    await shot("phone-vault.png");
    await mobile.locator(".tree-row", { hasText: "Health" }).first().click();
    await mobile.locator(".tree-row", { hasText: "Weekly review" }).click();
    await mobile.waitForSelector(".page-body .md-block");
    await mobile.waitForSelector(".peek input");
    await shot("phone-page.png");
    await mobile.locator(".tool-pill .tool[aria-label^='Pen']").click();
    const r = await mobile.evaluate(() => {
      const el = [...document.querySelectorAll(".page-body [data-line]")].find((e) => e.textContent.includes("Kept a regular bedtime") && e.tagName === "SPAN");
      const b = (el ?? document.body).getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    });
    await drawEllipse(mobile, r);
    await mobile.waitForSelector(".popover textarea");
    await mobile.fill(".popover textarea", "make this bold");
    await shot("phone-marking.png");
    await mobile.keyboard.press("Enter");
    await mobile.waitForSelector(".page-body strong", { timeout: 15000 });
    await mobile.locator(".tabbar button").nth(2).click();
    await mobile.waitForSelector(".bot-pane .thread");
    await mobile.locator(".bot-head [aria-label='Bot settings']").click();
    await mobile.waitForSelector(".bot-settings #bot-memory");
    await shot("phone-bot-settings.png");
    await mobile.locator(".bot-settings-head button", { hasText: "Chat" }).click();
    await mobile.waitForSelector(".bot-pane .thread");
    await shot("phone-bot.png");
  });
  await stage("phone: an app fills the page", async () => {
    await mobile.goto(`http://127.0.0.1:${port}/#/p/${encodeURI("Dashboards/Projects board/index.html")}`);
    await mobile.frameLocator(".app-frame").locator(".card").first().waitFor({ timeout: 10000 });
    await shot("phone-app.png");
  });
  await webkit.close();

  ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  console.log(`\nAll steps passed in ${((Date.now() - t0) / 1000).toFixed(1)} s. Screenshots: ${SHOTS}`);
} catch (err) {
  if (!failures.length) console.log(`  ✖ ${step}: ${err.message}`);
  if (errors.length) console.log(`Browser errors:\n  ${errors.join("\n  ")}`);
  console.log(`\nServer log:\n${log.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  setTimeout(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } }, 500);
}
void readFileSync;
