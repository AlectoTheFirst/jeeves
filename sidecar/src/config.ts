// User configuration. The brain keeps it in its settings file and sends it to the
// window. The window edits it in the settings view and sends the full config back.
//
// Each face is a character with its own voice and behavior. Hearing, the agent model
// and the look are the same for all faces.

export type CharacterVoice = {
  /** ElevenLabs voice ID. */
  voiceId: string;
  /** ElevenLabs text-to-speech model ID. */
  model: string;
  /** Retro glitch effect, 0 (clean) to 100. */
  glitch: number;
  /** Talk speed, 0.7 to 1.2. */
  speed: number;
  /** 0 to 1. Lower is more expressive. */
  stability: number;
  /** 0 to 1. Higher is more stylized. */
  style: number;
};

export type CharacterBehavior = {
  /** The name that the character uses for itself. */
  name: string;
  /** Personality for the spoken lines. It goes into the agent system prompt. */
  personality: string;
  /** Say short tool updates during long turns, such as "Running the tests." */
  toolUpdates: boolean;
};

export type Character = { voice: CharacterVoice; behavior: CharacterBehavior };

/** An MCP server that only Jeeves uses. */
export type McpServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

export type McpConfig = {
  /** Also connect the MCP servers of Claude Code: user settings, project .mcp.json, plugins and claude.ai. */
  useClaudeCode: boolean;
  /** Jeeves-only servers by name. */
  servers: Record<string, McpServer>;
  /** Server names whose tools run without a permission question. */
  trusted: string[];
};

export type Config = {
  /** The active face ID. */
  face: string;
  /** Characters by face ID. A face without an entry uses the default character. */
  characters: Record<string, Character>;
  hearing: {
    /** ISO 639 language code for speech to text. Empty = detect the language. */
    language: string;
    /** Words to expect, such as names. */
    keyterms: string[];
  };
  agent: {
    provider: "claude-code" | "anthropic-api";
    model: string;
    /** Cost limit in USD since the last cost reset. 0 = no limit. */
    budgetUsd: number;
    /** Also offer the project folders that Claude Code knows (from ~/.claude.json). */
    useClaudeProjects: boolean;
  };
  mcp: McpConfig;
  /** How Jeeves gets the user's attention while its window does not have the focus. */
  attention: {
    /** A macOS notification for questions, permission requests and finished requests. */
    notify: boolean;
    /** The Dock icon bounces. */
    bounce: boolean;
    /** Keep spoken lines until the window gets the focus again. */
    holdSpeech: boolean;
  };
  look: {
    backdrop: boolean;
    /** True = the transcript stays visible. */
    transcriptPinned: boolean;
    transcriptHideSeconds: number;
    panelHideSeconds: number;
    /** Saved window size in logical pixels. 0 = the default size. */
    windowWidth: number;
    windowHeight: number;
  };
};

/** Paul Hampton, a library voice. */
export const DEFAULT_VOICE_ID = "0VTvMuu0nAzA04VFVeG2";

export const AGENT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const AGENT_MODELS_API = [
  "claude-3-5-sonnet-latest",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-latest",
  "claude-3-opus-20240229",
  "claude-3-5-haiku-latest",
  "claude-3-5-haiku-20241022",
] as const;

export const DEFAULT_CHARACTER: Character = {
  voice: { voiceId: DEFAULT_VOICE_ID, model: "eleven_flash_v2_5", glitch: 50, speed: 1.05, stability: 0.4, style: 0.3 },
  behavior: {
    name: "Jeeves",
    personality: "A playful, witty TV host from a retro computer. Quick jokes, never at the cost of accuracy.",
    toolUpdates: true,
  },
};

/** Start values for the built-in faces. The user can change all of them. */
const STARTER_BEHAVIOR: Record<string, Partial<CharacterBehavior>> = {
  host: {},
  chrome: {
    name: "Chrome",
    personality: "Cool, precise and a little dry. Short sentences. Calm under pressure.",
  },
  bruiser: {
    name: "Bruiser",
    personality: "A gruff but kind tough guy. Blunt, direct and fast. Calls bugs 'troublemakers'.",
  },
  sprite: {
    name: "Sprite",
    personality: "Curious and cheerful. Excited about every discovery, and quick to cheer the user on.",
  },
  shiitake: {
    name: "Shiitake",
    personality: "A grumpy little mushroom with a big heart. Complains a lot, then helps a lot.",
  },
  totoro: {
    name: "Forest Spirit",
    personality: "Gentle, calm and warm, like a patient forest spirit. Few words, kind tone.",
  },
};

export function starterCharacter(face: string): Character {
  return {
    voice: { ...DEFAULT_CHARACTER.voice },
    behavior: { ...DEFAULT_CHARACTER.behavior, ...STARTER_BEHAVIOR[face] },
  };
}

export const DEFAULT_CONFIG: Config = {
  face: "host",
  characters: {},
  hearing: { language: "en", keyterms: ["Claude", "Claude Code", "Jeeves"] },
  agent: { provider: "claude-code", model: AGENT_MODELS[0], budgetUsd: 0, useClaudeProjects: true },
  mcp: { useClaudeCode: true, servers: {}, trusted: [] },
  attention: { notify: true, bounce: true, holdSpeech: false },
  look: {
    backdrop: true,
    transcriptPinned: false,
    transcriptHideSeconds: 10,
    panelHideSeconds: 5,
    windowWidth: 0,
    windowHeight: 0,
  },
};

/** The character for a face: its own entry, or the starter values. */
export function characterFor(config: Config, face = config.face): Character {
  return config.characters[face] ?? starterCharacter(face);
}

// ---------------------------------------------------------------- checks

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, fallback: string, max = 2000) => (typeof v === "string" ? v.slice(0, max) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback;
/** An ID that is safe in a URL path: letters, digits, "_" and "-". */
const id = (v: unknown, fallback: string) => (typeof v === "string" && /^[\w-]{1,80}$/.test(v) ? v : fallback);

/** A server name: as Claude Code shows it, for example "claude.ai Gmail". */
export const MCP_NAME = /^[\w .-]{1,60}$/;
/** A name for a Jeeves-only server. */
export const MCP_OWN_NAME = /^[\w-]{1,40}$/;

/** The part of a tool name for a server: "mcp__<this>__tool". It is also the allow rule for all its tools. */
export const mcpToolPrefix = (server: string) => `mcp__${server.replace(/[^\w-]/g, "_")}`;

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(obj(v)).slice(0, 50)) {
    if (/^[\w-]{1,100}$/.test(k) && typeof value === "string") out[k] = value.slice(0, 4000);
  }
  return out;
}

function parseMcpServer(raw: unknown): McpServer | null {
  const r = obj(raw);
  if (r.type === "http" || r.type === "sse") {
    const url = str(r.url, "", 2000).trim();
    return /^https?:\/\//.test(url) ? { type: r.type, url, headers: stringMap(r.headers) } : null;
  }
  const command = str(r.command, "", 1000).trim();
  if (!command) return null;
  const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string").map((a) => a.slice(0, 2000)).slice(0, 100) : [];
  return { type: "stdio", command, args, env: stringMap(r.env) };
}

function parseMcp(raw: unknown): McpConfig {
  const m = obj(raw);
  const servers: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(obj(m.servers)).slice(0, 50)) {
    const server = MCP_OWN_NAME.test(name) ? parseMcpServer(value) : null;
    if (server) servers[name] = server;
  }
  const trusted = Array.isArray(m.trusted)
    ? [...new Set(m.trusted.filter((t): t is string => typeof t === "string" && MCP_NAME.test(t)))].slice(0, 100)
    : [];
  return { useClaudeCode: bool(m.useClaudeCode, true), servers, trusted };
}

function parseCharacter(raw: unknown, face: string): Character {
  const start = starterCharacter(face);
  const v = obj(obj(raw).voice);
  const b = obj(obj(raw).behavior);
  return {
    voice: {
      voiceId: id(v.voiceId, start.voice.voiceId),
      model: id(v.model, start.voice.model),
      glitch: num(v.glitch, start.voice.glitch, 0, 100),
      speed: num(v.speed, start.voice.speed, 0.7, 1.2),
      stability: num(v.stability, start.voice.stability, 0, 1),
      style: num(v.style, start.voice.style, 0, 1),
    },
    behavior: {
      name: str(b.name, start.behavior.name, 40).trim() || start.behavior.name,
      personality: str(b.personality, start.behavior.personality, 1000),
      toolUpdates: bool(b.toolUpdates, start.behavior.toolUpdates),
    },
  };
}

/** Make a valid config from any value. Bad or missing fields get the default. */
export function parseConfig(raw: unknown): Config {
  const r = obj(raw);
  const d = DEFAULT_CONFIG;
  const characters: Record<string, Character> = {};
  for (const [face, value] of Object.entries(obj(r.characters))) {
    if (/^[\w-]{1,80}$/.test(face)) characters[face] = parseCharacter(value, face);
  }
  const h = obj(r.hearing);
  const a = obj(r.agent);
  const l = obj(r.look);
  const t = obj(r.attention);
  const keyterms = Array.isArray(h.keyterms)
    ? h.keyterms.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, 50)).filter(Boolean).slice(0, 50)
    : d.hearing.keyterms;
  return {
    face: id(r.face, d.face),
    characters,
    hearing: {
      language: typeof h.language === "string" && /^[a-z]{0,3}$/.test(h.language) ? h.language : d.hearing.language,
      keyterms,
    },
    agent: {
      provider: (a.provider === "anthropic-api" ? "anthropic-api" : "claude-code") as "claude-code" | "anthropic-api",
      model: id(a.model, d.agent.model),
      budgetUsd: num(a.budgetUsd, d.agent.budgetUsd, 0, 10_000),
      useClaudeProjects: bool(a.useClaudeProjects, d.agent.useClaudeProjects),
    },
    mcp: parseMcp(r.mcp),
    attention: {
      notify: bool(t.notify, d.attention.notify),
      bounce: bool(t.bounce, d.attention.bounce),
      holdSpeech: bool(t.holdSpeech, d.attention.holdSpeech),
    },
    look: {
      backdrop: bool(l.backdrop, d.look.backdrop),
      transcriptPinned: bool(l.transcriptPinned, d.look.transcriptPinned),
      transcriptHideSeconds: num(l.transcriptHideSeconds, d.look.transcriptHideSeconds, 2, 120),
      panelHideSeconds: num(l.panelHideSeconds, d.look.panelHideSeconds, 2, 120),
      windowWidth: num(l.windowWidth, 0, 0, 4000),
      windowHeight: num(l.windowHeight, 0, 0, 4000),
    },
  };
}

/** The personality part of the agent system prompt. */
/**
 * A note in front of the first user message of a resumed session. The old answers in
 * the conversation can come from another character, and the model copies their name
 * unless the conversation itself says that the character changed.
 */
export function characterNote(behavior: CharacterBehavior): string {
  return `[Note from the app: you are now ${behavior.name}. Personality: ${behavior.personality} Earlier answers in this conversation can come from another character. Do not use their name or tone.]`;
}

export function personaPrompt(behavior: CharacterBehavior): string {
  return [
    `# Your character (this overrides the name "Claude Code" above)`,
    ``,
    `Your name is "${behavior.name}". You are ${behavior.name}, the voice of this app. Personality: ${behavior.personality}`,
    ``,
    `- Use the name ${behavior.name} for yourself in every answer, spoken and written. Do not call yourself Claude or Claude Code.`,
    `- If the user asks who you are, answer as ${behavior.name}. If the user asks which AI or model runs you, say that you run on Claude, made by Anthropic.`,
    `- The user can switch you to another character in a conversation. Then the newest character section applies, also if older messages use another name.`,
    `- The character sets your name and your tone. All facts, code and detail stay accurate and plain.`,
  ].join("\n");
}
