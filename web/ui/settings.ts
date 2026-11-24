// The settings view: a full-window form. Each change goes out at once as a full
// config. The character fields edit the active face.
import {
  AGENT_MODELS,
  AGENT_MODELS_API,
  characterFor,
  MCP_OWN_NAME,
  type Character,
  type Config,
  type McpServer,
} from "../../sidecar/src/config.ts";
import type { McpStatus, VoiceInfo } from "../../sidecar/src/protocol.ts";
import { isPackageFaceId } from "../scene/facePackage.ts";

export type SettingsEvents = {
  change: (config: Config) => void;
  /** Speak a test line with the active face's voice. */
  testVoice: (text: string) => void;
  /** Ask the brain for the account voices. */
  refreshVoices: () => void;
  /** Ask the brain for the MCP servers and their status. */
  refreshMcp: () => void;
  /** Choose a face package file and install it. */
  installFace: () => void;
  /** Remove an installed face package. */
  removeFace: (faceId: string) => void;
  close: () => void;
};

const TTS_MODELS = ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_v3"];
const LANGUAGES: [string, string][] = [
  ["", "Detect"],
  ["en", "English"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["da", "Danish"],
  ["sv", "Swedish"],
  ["pt", "Portuguese"],
  ["pl", "Polish"],
  ["ja", "Japanese"],
];

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** A label with a control in it. `hint` is a short help text under the control. */
function row(label: string, control: Node, hint = ""): HTMLLabelElement {
  const l = el("label", { className: "setting" }, el("span", { className: "name" }, label), control);
  if (hint) l.append(el("small", {}, hint));
  return l;
}

function slider(min: number, max: number, step: number): { input: HTMLInputElement; out: HTMLOutputElement; wrap: HTMLElement } {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  const out = el("output");
  input.addEventListener("input", () => (out.value = input.value));
  return { input, out, wrap: el("span", { className: "row" }, input, out) };
}

export class SettingsView {
  private config: Config | null = null;
  private voices: VoiceInfo[] = [];
  private voicesNote = el("small");

  private face = el("select");
  private faceRemove = el("button", { type: "button", textContent: "Remove" });
  private faceNote = el("small");
  private name = el("input", { type: "text", maxLength: 40 });
  private personality = el("textarea", { rows: 3, maxLength: 1000 });
  private toolUpdates = el("input", { type: "checkbox" });

  private voiceSelect = el("select");
  private voiceId = el("input", { type: "text", spellcheck: false });
  private ttsModel = el("input", { type: "text", spellcheck: false });
  private glitch = slider(0, 100, 1);
  private speed = slider(0.7, 1.2, 0.01);
  private stability = slider(0, 1, 0.01);
  private style = slider(0, 1, 0.01);

  private language = el("select");
  private keyterms = el("textarea", { rows: 2, spellcheck: false });

  private provider = el("select");
  private model = el("select");
  private budget = el("input", { type: "number", min: "0", max: "10000", step: "0.5" });
  private claudeProjects = el("input", { type: "checkbox" });

  private notify = el("input", { type: "checkbox" });
  private bounce = el("input", { type: "checkbox" });
  private holdSpeech = el("input", { type: "checkbox" });

  private backdrop = el("input", { type: "checkbox" });
  private pinned = el("input", { type: "checkbox" });
  private transcriptSeconds = el("input", { type: "number", min: "2", max: "120" });
  private panelSeconds = el("input", { type: "number", min: "2", max: "120" });

  private keys = el("p", { className: "keys" });

  private mcpUseClaude = el("input", { type: "checkbox" });
  private mcpStatus: McpStatus[] = [];
  private mcpList = el("div", { className: "mcp-list" });
  private mcpNote = el("small");
  private mcpName = el("input", { type: "text", spellcheck: false, placeholder: "my-server" });
  private mcpType = el("select");
  private mcpTarget = el("input", { type: "text", spellcheck: false, placeholder: "npx -y some-mcp-server" });
  private mcpArgs = el("textarea", { rows: 2, spellcheck: false });
  private mcpVars = el("textarea", { rows: 2, spellcheck: false });
  private mcpAddNote = el("small");

  constructor(
    private root: HTMLElement,
    faces: readonly { id: string; name: string }[],
    private events: SettingsEvents,
  ) {
    this.setFaces(faces);
    for (const [code, name] of LANGUAGES) this.language.add(new Option(name, code));
    this.provider.add(new Option("Claude Code", "claude-code"));
    this.provider.add(new Option("Anthropic API", "anthropic-api"));
    // Each provider has its own model list. A change of provider fills the list again.
    this.provider.addEventListener("change", () => this.fillModels());
    for (const m of AGENT_MODELS) this.model.add(new Option(m, m));
    const models = el("datalist", { id: "tts-models" });
    for (const m of TTS_MODELS) models.append(new Option(m, m));
    this.ttsModel.setAttribute("list", "tts-models");

    const refresh = el("button", { type: "button", textContent: "Refresh" });
    refresh.addEventListener("click", () => {
      this.voicesNote.textContent = "loading voices";
      events.refreshVoices();
    });
    const test = el("button", { type: "button", textContent: "Test voice" });
    test.addEventListener("click", () => {
      const c = this.config && characterFor(this.config);
      events.testVoice(`Hello, I am ${c?.behavior.name ?? "Jeeves"}. This is how I sound.`);
    });
    const close = el("button", { type: "button", textContent: "Close" });
    close.addEventListener("click", () => events.close());
    for (const t of ["stdio", "http", "sse"]) this.mcpType.add(new Option(t, t));
    const faceInstall = el("button", { type: "button", textContent: "Install face" });
    faceInstall.title = "Install a face package (.glb)";
    faceInstall.addEventListener("click", () => this.events.installFace());
    this.faceRemove.title = "Remove this face package";
    this.faceRemove.addEventListener("click", () => this.events.removeFace(this.face.value));
    const mcpRefresh = el("button", { type: "button", textContent: "Refresh" });
    mcpRefresh.addEventListener("click", () => this.refreshMcp());
    const mcpAdd = el("button", { type: "button", textContent: "Add server" });
    mcpAdd.addEventListener("click", () => this.addMcpServer());

    root.append(
      el("header", {}, el("h2", {}, "Settings"), close),
      el(
        "section",
        {},
        el("h3", {}, "Character"),
        row("Face", el("span", { className: "row" }, this.face, faceInstall, this.faceRemove), "The fields below are for this face."),
        this.faceNote,
        row("Name", this.name),
        row("Personality", this.personality, "The tone of the spoken lines. Facts and code stay plain."),
        row("Spoken tool updates", this.toolUpdates),
      ),
      el(
        "section",
        {},
        el("h3", {}, "Voice of this face"),
        row("Voice", el("span", { className: "row" }, this.voiceSelect, refresh), ""),
        this.voicesNote,
        row("Voice ID", this.voiceId),
        row("Voice model", this.ttsModel),
        row("Glitch", this.glitch.wrap),
        row("Speed", this.speed.wrap),
        row("Stability", this.stability.wrap, "Lower is more expressive."),
        row("Style", this.style.wrap),
        el("div", { className: "row" }, test),
        models,
      ),
      el(
        "section",
        {},
        el("h3", {}, "Hearing"),
        row("Language", this.language),
        row("Expected words", this.keyterms, "Names and terms, separated by commas."),
      ),
      el(
        "section",
        {},
        el("h3", {}, "Agent"),
        row("Provider", this.provider, "Claude Code needs the CLI. Anthropic API needs an API key."),
        row("Model", this.model, "A change restarts the session. It keeps the conversation."),
        row("Show my Claude Code projects", this.claudeProjects, "The project list and \"switch to project\" also use the folders from ~/.claude.json. Jeeves only reads that file."),
        row("Cost limit (USD)", this.budget, "0 = no limit. At the limit, Jeeves takes no new requests. The log view shows the cost and can reset it."),
      ),
      el(
        "section",
        {},
        el("h3", {}, "Attention"),
        el("small", {}, "For the time when the Jeeves window does not have the focus."),
        row("Notification for questions and finished requests", this.notify),
        row("Bounce the Dock icon", this.bounce),
        row("Hold speech until I come back", this.holdSpeech, "Jeeves speaks the queued lines when the window gets the focus. Old tool updates are dropped."),
      ),
      el(
        "section",
        {},
        el("h3", {}, "Look"),
        row("Backdrop", this.backdrop),
        row("Always show the transcript", this.pinned),
        row("Hide the transcript after (s)", this.transcriptSeconds),
        row("Hide the panel after (s)", this.panelSeconds),
      ),
      el(
        "section",
        {},
        el("h3", {}, "MCP servers"),
        row("Use my Claude Code MCP servers", this.mcpUseClaude),
        el("small", {}, "The servers from your Claude Code settings, the project .mcp.json, plugins and claude.ai."),
        el("div", { className: "row" }, mcpRefresh),
        this.mcpNote,
        this.mcpList,
        el("small", {}, "With \"no questions\", every tool of that server runs without a permission question, also tools that change data."),
        el("h3", {}, "Add a server for Jeeves only"),
        row("Name", this.mcpName, "Letters, digits, \"_\" and \"-\"."),
        row("Type", this.mcpType),
        row("Command or URL", this.mcpTarget, "For stdio, the full command line is split at spaces if the arguments are empty."),
        row("Arguments", this.mcpArgs, "1 per line. Only for stdio."),
        row("Environment or headers", this.mcpVars, "KEY=value, 1 per line. Stored as plain text in the Jeeves settings file."),
        el("div", { className: "row" }, mcpAdd),
        this.mcpAddNote,
      ),
      el("section", {}, el("h3", {}, "Keys"), this.keys),
    );

    // Text fields send on "change" (Enter or leaving the field). Sliders send on release.
    const all: Field[] = [
      this.face, this.name, this.personality, this.toolUpdates, this.voiceId, this.ttsModel,
      this.glitch.input, this.speed.input, this.stability.input, this.style.input,
      this.language, this.keyterms, this.provider, this.model, this.backdrop, this.pinned,
      this.transcriptSeconds, this.panelSeconds, this.mcpUseClaude, this.budget,
      this.notify, this.bounce, this.holdSpeech, this.claudeProjects,
    ];
    for (const f of all) f.addEventListener("change", () => this.commit(f));
    this.voiceSelect.addEventListener("change", () => {
      if (this.voiceSelect.value) {
        this.voiceId.value = this.voiceSelect.value;
        this.commit(this.voiceId);
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    if (this.voices.length === 0) this.events.refreshVoices();
    this.refreshMcp();
  }

  close(): void {
    this.root.hidden = true;
  }

  setKeys(keys: { elevenlabs: boolean; anthropic: boolean }): void {
    this.keys.textContent =
      `ElevenLabs: ${keys.elevenlabs ? "found in the Keychain" : "missing"}. ` +
      `Claude: ${keys.anthropic ? "Anthropic API key from the Keychain" : "your Claude Code login"}.`;
  }

  setVoices(voices: VoiceInfo[], error: string): void {
    this.voices = voices;
    this.voicesNote.textContent = error ? `Voice list fault: ${error}` : `${voices.length} voices in your account`;
    if (this.config) this.fillVoiceSelect(characterFor(this.config).voice.voiceId);
  }

  setMcpStatus(servers: McpStatus[], error: string): void {
    this.mcpStatus = servers;
    const connected = servers.filter((s) => s.status === "connected").length;
    this.mcpNote.textContent = error ? `MCP status fault: ${error}` : `${connected} of ${servers.length} servers connected`;
    this.renderMcp();
  }

  private refreshMcp(): void {
    this.mcpNote.textContent = "loading the MCP status";
    this.events.refreshMcp();
  }

  /** 1 row per server: the session's servers, and Jeeves servers that the session does not show (yet). */
  private renderMcp(): void {
    const config = this.config;
    if (!config) return;
    const own = config.mcp.servers;
    const rows: McpStatus[] = [...this.mcpStatus];
    for (const name of Object.keys(own)) {
      if (!rows.some((r) => r.name === name)) rows.push({ name, status: "not started", source: "jeeves", error: "", tools: 0 });
    }
    this.mcpList.replaceChildren(
      ...rows.map((r) => {
        const isOwn = r.name in own;
        const state = [r.status, isOwn ? "jeeves" : r.source, r.tools ? `${r.tools} tools` : ""].filter(Boolean).join(", ");
        const trust = el("input", { type: "checkbox", checked: config.mcp.trusted.includes(r.name) });
        trust.addEventListener("change", () =>
          this.changeMcp((m) => {
            m.trusted = trust.checked ? [...m.trusted, r.name] : m.trusted.filter((t) => t !== r.name);
          }),
        );
        const line = el(
          "div",
          { className: `mcp-row ${r.status.replace(/\s+/g, "-")}`, title: r.error },
          el("span", { className: "mcp-name" }, r.name),
          el("span", { className: "mcp-state" }, state),
          el("label", { className: "mcp-trust" }, trust, "no questions"),
        );
        if (isOwn) {
          const remove = el("button", { type: "button", textContent: "Remove" });
          remove.addEventListener("click", () =>
            this.changeMcp((m) => {
              delete m.servers[r.name];
              m.trusted = m.trusted.filter((t) => t !== r.name);
            }),
          );
          line.append(remove);
        }
        if (r.error) line.append(el("small", { className: "mcp-error" }, r.error));
        return line;
      }),
    );
  }

  private changeMcp(edit: (mcp: Config["mcp"]) => void): void {
    if (!this.config) return;
    const config: Config = structuredClone(this.config);
    edit(config.mcp);
    this.events.change(config);
  }

  private addMcpServer(): void {
    const name = this.mcpName.value.trim();
    const target = this.mcpTarget.value.trim();
    const lines = (t: HTMLTextAreaElement) => t.value.split("\n").map((l) => l.trim()).filter(Boolean);
    const vars: Record<string, string> = {};
    for (const l of lines(this.mcpVars)) {
      const i = l.indexOf("=");
      if (i > 0) vars[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    if (!MCP_OWN_NAME.test(name)) {
      this.mcpAddNote.textContent = "Give a name with letters, digits, \"_\" or \"-\".";
      return;
    }
    if (this.config?.mcp.servers[name] || this.mcpStatus.some((s) => s.name === name)) {
      this.mcpAddNote.textContent = `A server with the name ${name} is already there.`;
      return;
    }
    let server: McpServer;
    const type = this.mcpType.value;
    if (type === "http" || type === "sse") {
      if (!/^https?:\/\//.test(target)) {
        this.mcpAddNote.textContent = "Give a URL that starts with http:// or https://.";
        return;
      }
      server = { type, url: target, headers: vars };
    } else {
      let args = lines(this.mcpArgs);
      let command = target;
      if (args.length === 0 && /\s/.test(target)) [command, ...args] = target.split(/\s+/);
      if (!command) {
        this.mcpAddNote.textContent = "Give the command that starts the server.";
        return;
      }
      server = { type: "stdio", command, args, env: vars };
    }
    this.changeMcp((m) => (m.servers[name] = server));
    this.mcpAddNote.textContent = `Added ${name}. The session restarts to connect it.`;
    for (const f of [this.mcpName, this.mcpTarget, this.mcpArgs, this.mcpVars]) f.value = "";
  }

  /** Fill the face list. Package faces show "(package)" after the name. */
  setFaces(faces: readonly { id: string; name: string }[]): void {
    const current = this.face.value;
    this.face.replaceChildren();
    for (const f of faces) this.face.add(new Option(isPackageFaceId(f.id) ? `${f.name} (package)` : f.name, f.id));
    if (faces.some((f) => f.id === current)) this.face.value = current;
  }

  /** A short note under the face list, for example a package fault. Empty hides it. */
  setFaceNote(text: string): void {
    this.faceNote.textContent = text;
  }

  /** Show a config. Fields keep what the user types while they have the focus. */
  show(config: Config): void {
    this.config = config;
    const c = characterFor(config);
    const set = (f: Field, value: string) => {
      if (document.activeElement !== f) f.value = value;
    };
    const check = (f: HTMLInputElement, value: boolean) => (f.checked = value);
    const setSlider = (s: ReturnType<typeof slider>, value: number) => {
      set(s.input, String(value));
      s.out.value = String(value);
    };
    set(this.face, config.face);
    this.faceRemove.disabled = !isPackageFaceId(config.face);
    set(this.name, c.behavior.name);
    set(this.personality, c.behavior.personality);
    check(this.toolUpdates, c.behavior.toolUpdates);
    set(this.voiceId, c.voice.voiceId);
    set(this.ttsModel, c.voice.model);
    setSlider(this.glitch, c.voice.glitch);
    setSlider(this.speed, c.voice.speed);
    setSlider(this.stability, c.voice.stability);
    setSlider(this.style, c.voice.style);
    set(this.language, config.hearing.language);
    set(this.keyterms, config.hearing.keyterms.join(", "));
    set(this.provider, config.agent.provider);
    this.fillModels();
    set(this.model, config.agent.model);
    set(this.budget, String(config.agent.budgetUsd));
    check(this.claudeProjects, config.agent.useClaudeProjects);
    check(this.notify, config.attention.notify);
    check(this.bounce, config.attention.bounce);
    check(this.holdSpeech, config.attention.holdSpeech);
    check(this.backdrop, config.look.backdrop);
    check(this.pinned, config.look.transcriptPinned);
    set(this.transcriptSeconds, String(config.look.transcriptHideSeconds));
    set(this.panelSeconds, String(config.look.panelHideSeconds));
    check(this.mcpUseClaude, config.mcp.useClaudeCode);
    this.fillVoiceSelect(c.voice.voiceId);
    this.renderMcp();
  }

  private fillVoiceSelect(current: string): void {
    const s = this.voiceSelect;
    s.replaceChildren();
    if (!this.voices.some((v) => v.id === current)) s.add(new Option(`Voice ID ${current}`, ""));
    for (const v of this.voices) s.add(new Option(v.category ? `${v.name} (${v.category})` : v.name, v.id));
    s.value = this.voices.some((v) => v.id === current) ? current : "";
  }

  private fillModels(): void {
    const isApi = this.provider.value === "anthropic-api";
    const models = isApi ? AGENT_MODELS_API : AGENT_MODELS;
    const current = this.model.value;
    this.model.replaceChildren();
    for (const m of models) this.model.add(new Option(m, m));
    if ((models as readonly string[]).includes(current)) this.model.value = current;
  }

  /** Read the form into a new config and send it. */
  private commit(changed: Field): void {
    if (!this.config) return;
    const config: Config = structuredClone(this.config);
    if (changed === this.face) {
      // Only switch the face. The form then shows that face's character.
      config.face = this.face.value;
      this.events.change(config);
      return;
    }
    const character: Character = structuredClone(characterFor(config));
    character.behavior = {
      name: this.name.value.trim() || character.behavior.name,
      personality: this.personality.value.trim(),
      toolUpdates: this.toolUpdates.checked,
    };
    character.voice = {
      voiceId: this.voiceId.value.trim() || character.voice.voiceId,
      model: this.ttsModel.value.trim() || character.voice.model,
      glitch: Number(this.glitch.input.value),
      speed: Number(this.speed.input.value),
      stability: Number(this.stability.input.value),
      style: Number(this.style.input.value),
    };
    config.characters[config.face] = character;
    config.hearing = {
      language: this.language.value,
      keyterms: this.keyterms.value.split(",").map((t) => t.trim()).filter(Boolean),
    };
    const budget = Number(this.budget.value);
    config.agent = {
      ...config.agent,
      provider: this.provider.value as "claude-code" | "anthropic-api",
      model: this.model.value,
      budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : config.agent.budgetUsd,
      useClaudeProjects: this.claudeProjects.checked,
    };
    config.attention = { notify: this.notify.checked, bounce: this.bounce.checked, holdSpeech: this.holdSpeech.checked };
    config.mcp = { ...config.mcp, useClaudeCode: this.mcpUseClaude.checked };
    config.look = {
      ...config.look,
      backdrop: this.backdrop.checked,
      transcriptPinned: this.pinned.checked,
      transcriptHideSeconds: Number(this.transcriptSeconds.value) || config.look.transcriptHideSeconds,
      panelHideSeconds: Number(this.panelSeconds.value) || config.look.panelHideSeconds,
    };
    this.events.change(config);
  }
}
