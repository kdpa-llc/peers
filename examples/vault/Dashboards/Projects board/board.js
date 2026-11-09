// A board of every project under Projects/: open tasks, what is due next, and a link to
// each project's front page. It reads the vault through the Peers helper (window.peers).
const board = document.getElementById("board");
const summary = document.getElementById("summary");
const FRONT = /^(overview|readme|index|main)\.(md|markdown|org)$/i;
const PAGE = /\.(md|markdown|org)$/i;

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

// Org dates look like "2026-11-14 Sat"; Markdown tasks have none.
const day = (d) => (d ? d.slice(0, 10) : "");
const due = (t) => day(t.deadline) || day(t.scheduled);

async function projects() {
  const entries = await peers.list("Projects");
  const out = [];
  for (const e of entries) {
    if (e.type === "dir") {
      const files = await peers.list(e.path);
      const front = files.find((f) => f.type === "file" && FRONT.test(f.name));
      out.push({ name: e.name, path: e.path, front: front ? front.path : undefined });
    } else if (PAGE.test(e.name)) {
      out.push({ name: e.name.replace(PAGE, ""), path: e.path, front: e.path });
    }
  }
  return out;
}

async function card(p) {
  const tasks = await peers.tasks(p.path);
  let title = p.name;
  if (p.front) {
    try { title = (await peers.page(p.front)).title || title; } catch { /* keep the folder's name */ }
  }
  const open = tasks.filter((t) => !t.done);
  const next = open.filter(due).sort((a, b) => due(a).localeCompare(due(b)))[0];
  const done = tasks.length - open.length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return {
    due: next ? due(next) : "9999",
    node: el("article", { class: "card" },
      el("h2", null, el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); if (p.front) peers.open(p.front); } }, title)),
      el("div", { class: "bar", title: `${done} of ${tasks.length} done` }, el("span", { style: `width:${pct}%` })),
      el("p", { class: "meta" }, `${open.length} open · ${done} done`, next ? el("span", { class: "due" }, ` · next: ${next.title} by ${due(next)}`) : null),
      el("ul", null, open.slice(0, 4).map((t) =>
        el("li", null, t.todo ? el("b", null, `${t.todo} `) : null, t.title || "(untitled)", due(t) ? el("time", null, due(t)) : null))),
      el("button", { class: "ask", onclick: () => peers.ask(`What should happen next on "${title}" (${p.path})?`) }, "Ask for next steps")),
  };
}

async function render() {
  try {
    const list = await projects();
    const cards = await Promise.all(list.map(card));
    cards.sort((a, b) => a.due.localeCompare(b.due));
    board.replaceChildren(...cards.map((c) => c.node));
    summary.textContent = `${list.length} projects, soonest deadline first.`;
  } catch (err) {
    summary.textContent = `Could not read the projects: ${err.message}`;
  }
}

let timer;
peers.onChange(() => { clearTimeout(timer); timer = setTimeout(render, 300); });
render();
