/** Settings: theme, your name, the bots' default model and their T3, paired devices. */
import { h, replace } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { api } from "../lib/api.ts";
import { ago } from "../lib/time.ts";
import { fail, loadState, loadTree, setTheme, store, toast, type Theme } from "../state.ts";
import type { Layout, ModelChoice } from "../types.ts";
import { confirmDialog } from "./common.ts";

export function renderSettings(): Node {
  const s = store.get();
  const theme = h("div", { class: "seg", role: "radiogroup", "aria-label": "Theme" },
    (["system", "day", "night"] as Theme[]).map((t) => h("button", {
      role: "radio", "aria-checked": s.theme === t ? "true" : "false", class: s.theme === t ? "on" : undefined,
      onclick: () => setTheme(t),
    }, t === "system" ? "System" : t === "day" ? "Day" : "Night")));

  // The default model for bots: what the bots' T3 offers (ADR 0003).
  const dm = s.defaultModel ?? {};
  const provider = h("select", { "aria-label": "Default provider" },
    [["claude", "Claude (Claude Code)"], ["codex", "Codex (ChatGPT)"]].map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  provider.value = dm.provider ?? "claude";
  const model = h("select", { "aria-label": "Default model" }) as HTMLSelectElement;
  const thinking = h("select", { "aria-label": "Default effort" }) as HTMLSelectElement;
  let models: ModelChoice[] = [];
  const fill = (): void => {
    const list = models.filter((m) => m.provider === provider.value);
    replace(model, h("option", { value: "" }, "Provider default"), list.map((m) => h("option", { value: m.model }, m.label)));
    model.value = dm.provider === provider.value && list.some((m) => m.model === dm.model) ? dm.model! : "";
    const chosen = list.find((m) => m.model === model.value) ?? list.find((m) => m.isDefault) ?? list[0];
    const efforts = chosen?.efforts.length ? chosen.efforts : ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }));
    replace(thinking, h("option", { value: "" }, "Default effort"), efforts.map((e) => h("option", { value: e.id }, e.label)));
    thinking.value = efforts.some((e) => e.id === dm.thinking) ? dm.thinking! : "";
  };
  void api.get<{ models: ModelChoice[] }>("/api/models").then((r) => { models = r.models; fill(); }).catch(() => fill());
  const saveModel = async (): Promise<void> => {
    try {
      await api.patch("/api/settings", { default_model: { provider: provider.value, ...(model.value ? { model: model.value } : {}), ...(thinking.value ? { thinking: thinking.value } : {}) } });
      dm.provider = provider.value; dm.model = model.value || undefined; dm.thinking = thinking.value || undefined;
      await loadState();
      toast("Default model saved");
    } catch (err) { fail(err); }
  };
  provider.addEventListener("change", () => { fill(); void saveModel(); });
  for (const el of [model, thinking]) el.addEventListener("change", () => void saveModel());
  const engineLine = s.engine?.kind === "demo"
    ? h("p", { class: "muted" }, "Demo mode: bots are scripted and nothing leaves this computer. Start Peers without --scripted to run them on T3.")
    : signInView();

  const owner = h("input", { value: s.vault?.owner ?? "", "aria-label": "Your name" }) as HTMLInputElement;
  owner.addEventListener("change", () => void api.patch("/api/settings", { owner: owner.value }).then(() => loadState()).catch(fail));

  const devices = h("div", null, h("p", { class: "muted" }, "Loading…"));
  const code = h("div");
  const loadDevices = async (): Promise<void> => {
    try {
      const r = await api.get<{ devices: any[]; current: string }>("/api/devices");
      replace(devices, r.devices.filter((d) => !d.revoked_at).map((d) => h("div", { class: "device" },
        icon(/iPhone|Android/.test(d.name) ? "bot" : "eye", 16),
        h("span", { class: "n" }, `${d.name}${d.device_id === r.current ? " (this device)" : ""}`),
        h("span", { class: "muted" }, d.last_seen_at ? `seen ${ago(d.last_seen_at)}` : ""),
        d.device_id === r.current ? null : h("button", {
          class: "btn small danger", onclick: async () => {
            if (!(await confirmDialog("Remove this device?", `${d.name} will need a new pairing code.`, "Remove", true))) return;
            await api.del(`/api/devices/${d.device_id}`).catch(fail);
            void loadDevices();
          },
        }, "Remove"))));
    } catch (err) { fail(err); }
  };
  void loadDevices();

  return h("div", { class: "settings" },
    h("h1", null, "Settings"),
    h("section", null, h("h2", null, "Appearance"), theme),
    h("section", null, h("h2", null, "You"), h("div", { class: "field" }, h("label", null, "Your name, as bots address you"), owner)),
    h("section", null, h("h2", null, "Bots"),
      h("p", { class: "muted" }, "Bots run on a T3 built into Peers, with their own Claude Code and Codex sign-ins, so their conversations stay out of your own apps."),
      engineLine,
      h("div", { class: "field" }, h("label", null, "Default provider"), provider),
      h("div", { class: "field-row" }, h("div", { class: "field" }, h("label", null, "Model"), model), h("div", { class: "field" }, h("label", null, "Effort"), thinking))),
    h("section", null, h("h2", null, "Layout"),
      h("p", { class: "muted" }, "Which folders and pages have their own agent. Paths can use * (one level) and ** (any depth); paths ending in .md or .org mean pages. Kept in .peers/layout.json in the vault."),
      layoutView()),
    h("section", null, h("h2", null, "Devices"),
      h("p", { class: "muted" }, "Pair your phone: run `tailscale serve --bg 4777` on the computer running Peers once, start it with `peers up --origin` set to that HTTPS address, open that address on the phone and type a code."),
      devices,
      h("button", {
        class: "btn", style: { marginTop: "10px" }, onclick: async () => {
          try {
            const r = await api.post<{ code: string; minutes: number }>("/api/pairing-codes");
            replace(code, h("div", { class: "code-box" }, r.code), h("p", { class: "muted" }, `Valid once, for ${r.minutes} minutes.`));
          } catch (err) { fail(err); }
        },
      }, icon("plus", 14), "Pair a device"),
      code));
}

// ------------------------------------------------------------------ the bots' sign-ins

type Agent = {
  provider: "claude" | "codex";
  signed_in: boolean;
  login?: { status: string; url?: string; code?: string; needs_code?: boolean; message?: string };
};

const AGENT_NAME: Record<string, string> = { claude: "Claude (Claude Code)", codex: "Codex (ChatGPT)" };

/**
 * Sign the bots' own Claude Code and Codex in from here, so a container install never needs a
 * terminal (ADR 0004). The login runs where the bots run; this view relays its link and code.
 */
function signInView(): HTMLElement {
  const host = h("div", { class: "signins" }, h("p", { class: "muted" }, "Checking sign-ins…"));
  let timer: number | undefined;
  const load = async (): Promise<void> => {
    clearTimeout(timer);
    if (!host.isConnected && timer !== undefined) return;
    try {
      const r = await api.get<{ providers: Agent[] }>("/api/providers");
      replace(host, r.providers.map(row));
      // While a sign-in waits, look again; it finishes on another device or tab.
      if (r.providers.some((a) => a.login?.status === "waiting" || a.login?.status === "starting")) timer = window.setTimeout(() => void load(), 2000);
    } catch (err) { fail(err); }
  };
  const start = async (p: Agent["provider"]): Promise<void> => {
    try {
      await api.post(`/api/providers/${p}/login`);
      await load();
    } catch (err) { fail(err); }
  };
  const row = (a: Agent): HTMLElement => {
    const l = a.login;
    const waiting = l?.status === "waiting" || l?.status === "starting";
    const body: Node[] = [];
    if (waiting && l?.url) {
      body.push(h("p", null, "1. Open ", h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, a.provider === "claude" ? "the Claude sign-in page" : "the OpenAI device page"),
        a.provider === "claude" ? " and sign in with the account the bots should use." : " and sign in."));
      if (a.provider === "codex" && l.code) {
        body.push(h("p", null, "2. Enter this code there:"), h("div", { class: "code-box" }, l.code),
          h("p", { class: "muted" }, "This page updates when the sign-in finishes."));
      } else if (l.needs_code) {
        const input = h("input", { placeholder: "Paste the code from the page", "aria-label": "Sign-in code", autocomplete: "off" }) as HTMLInputElement;
        const submit = async (): Promise<void> => {
          if (!input.value.trim()) return;
          try {
            await api.post(`/api/providers/${a.provider}/code`, { code: input.value.trim() });
            input.value = "";
            toast("Checking the code…");
            await load();
          } catch (err) { fail(err); }
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } });
        body.push(h("p", null, "2. Copy the code it shows and paste it here:"),
          h("div", { class: "field-row" }, input, h("button", { class: "btn primary", onclick: () => void submit() }, "Sign in")));
      } else {
        body.push(h("p", { class: "muted" }, l.message ?? "Checking…"));
      }
      body.push(h("button", { class: "btn small", onclick: () => void api.post(`/api/providers/${a.provider}/cancel`).then(load).catch(fail) }, "Cancel"));
    } else if (waiting) {
      body.push(h("p", { class: "muted" }, "Starting the sign-in…"));
    } else if (l?.status === "failed" && !a.signed_in) {
      body.push(h("p", { class: "muted" }, `The last sign-in did not finish: ${l.message ?? "unknown error"}.`));
    }
    return h("div", { class: "signin-row" },
      h("div", { class: "perm-line" },
        h("span", { class: ["dot", a.signed_in ? "working" : "paused"] }),
        h("span", { style: { flex: "1" } }, `${AGENT_NAME[a.provider]}: ${a.signed_in ? "signed in" : "not signed in"}`),
        waiting ? null : h("button", { class: "btn small", onclick: () => void start(a.provider) }, a.signed_in ? "Sign in again" : "Sign in")),
      body.length ? h("div", { class: "signin-steps" }, body) : null);
  };
  void load();
  return host;
}

// ------------------------------------------------------------------ layout (ADR 0005)

const LAYOUT_FIELDS: { key: "agents" | "exclude" | "paused" | "readonly" | "hidden" | "rules"; label: string; hint: string }[] = [
  { key: "agents", label: "Have their own agent", hint: "Projects/*  ·  Areas/*.org" },
  { key: "paused", label: "Paused (an archive)", hint: "Archive/**" },
  { key: "readonly", label: "Generated, never edited by agents", hint: "views/**" },
  { key: "hidden", label: "Hidden from the tree", hint: "raw  ·  scripts" },
  { key: "rules", label: "Rules every agent follows", hint: "AGENTS.md" },
  { key: "exclude", label: "No agent, even if a pattern matches", hint: "Projects/Someday" },
];

function layoutView(): HTMLElement {
  const host = h("div", { class: "layout-edit" }, h("p", { class: "muted" }, "Loading…"));
  void (async () => {
    try {
      const r = await api.get<{ layout: Layout; error: string | null }>("/api/layout");
      const l = r.layout;
      const areas = new Map<string, HTMLTextAreaElement>();
      const fields = LAYOUT_FIELDS.map((f) => {
        const area = h("textarea", { rows: Math.max(2, Math.min(8, l[f.key].length + 1)), placeholder: f.hint, "aria-label": f.label }) as HTMLTextAreaElement;
        area.value = l[f.key].join("\n");
        areas.set(f.key, area);
        return h("div", { class: "field" }, h("label", null, f.label), area);
      });
      const inbox = h("input", { value: l.inbox ?? "", placeholder: "Inbox  ·  inbox.org", "aria-label": "Inbox" }) as HTMLInputElement;
      const archive = h("input", { value: l.archive ?? "", placeholder: "Archive", "aria-label": "Archive folder" }) as HTMLInputElement;
      const save = async (): Promise<void> => {
        const lines = (k: string): string[] => (areas.get(k)?.value ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
        const next: Layout = {
          preset: "custom", agents: lines("agents"), exclude: lines("exclude"), paused: lines("paused"),
          readonly: lines("readonly"), hidden: lines("hidden"), rules: lines("rules"),
          ...(inbox.value.trim() ? { inbox: inbox.value.trim() } : {}),
          ...(archive.value.trim() ? { archive: archive.value.trim() } : {}),
        };
        try {
          await api.put("/api/layout", { layout: next });
          await Promise.all([loadState(), loadTree()]);
          toast("Layout saved");
        } catch (err) { fail(err); }
      };
      replace(host,
        r.error ? h("p", { class: "warn-tag" }, r.error) : null,
        h("p", { class: "muted" }, `Preset: ${l.preset ?? "custom"}`),
        ...fields,
        h("div", { class: "field-row" },
          h("div", { class: "field" }, h("label", null, "Inbox (a folder or page)"), inbox),
          h("div", { class: "field" }, h("label", null, "Archive folder"), archive)),
        h("button", { class: "btn primary", onclick: () => void save() }, "Save layout"));
    } catch (err) { fail(err); }
  })();
  return host;
}
