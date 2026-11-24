import { describe, expect, it } from "vitest";
import { characterFor, characterNote, DEFAULT_CONFIG, DEFAULT_VOICE_ID, mcpToolPrefix, parseConfig, personaPrompt } from "./config.ts";

describe("parseConfig", () => {
  it("gives the defaults for an empty value", () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("nonsense")).toEqual(DEFAULT_CONFIG);
  });

  it("keeps good values and clamps numbers", () => {
    const c = parseConfig({
      face: "bruiser",
      characters: { bruiser: { voice: { voiceId: "abc123", glitch: 250, speed: 3 }, behavior: { name: "Bob" } } },
      look: { transcriptHideSeconds: 1 },
    });
    expect(c.face).toBe("bruiser");
    const b = c.characters.bruiser;
    expect(b.voice.voiceId).toBe("abc123");
    expect(b.voice.glitch).toBe(100);
    expect(b.voice.speed).toBe(1.2);
    expect(b.behavior.name).toBe("Bob");
    // A missing field gets the starter value for that face.
    expect(b.behavior.personality).toContain("tough guy");
    expect(c.look.transcriptHideSeconds).toBe(2);
  });

  it("keeps the cost limit and the attention options", () => {
    const c = parseConfig({ agent: { budgetUsd: -3 }, attention: { notify: false, holdSpeech: true } });
    expect(c.agent.budgetUsd).toBe(0);
    expect(parseConfig({ agent: { budgetUsd: 12.5 } }).agent.budgetUsd).toBe(12.5);
    expect(c.attention).toEqual({ notify: false, bounce: true, holdSpeech: true });
    expect(c.agent.useClaudeProjects).toBe(true);
    expect(parseConfig({ agent: { useClaudeProjects: false } }).agent.useClaudeProjects).toBe(false);
  });

  it("rejects a voice ID that could change the API path", () => {
    const c = parseConfig({ characters: { host: { voice: { voiceId: "../../v1/user" } } } });
    expect(c.characters.host.voice.voiceId).toBe(DEFAULT_VOICE_ID);
  });

  it("keeps only clean keyterms", () => {
    const c = parseConfig({ hearing: { language: "de", keyterms: [" Claude ", 4, "", "Jeeves"] } });
    expect(c.hearing).toEqual({ language: "de", keyterms: ["Claude", "Jeeves"] });
  });
});

describe("characterFor", () => {
  it("gives each built-in face its own starter character", () => {
    expect(characterFor(DEFAULT_CONFIG, "chrome").behavior.name).toBe("Chrome");
    expect(characterFor(DEFAULT_CONFIG, "unknown").behavior.name).toBe("Jeeves");
  });

  it("does not take a face ID from the object prototype", () => {
    expect(characterFor(DEFAULT_CONFIG, "constructor").behavior.name).toBe("Jeeves");
    expect(characterFor(DEFAULT_CONFIG, "toString").voice.voiceId).toBe(DEFAULT_VOICE_ID);
    const c = parseConfig(JSON.parse('{"face":"voice","characters":{"__proto__":{"behavior":{"name":"Evil"}}}}'));
    expect(Object.keys(c.characters)).toEqual([]);
    expect(characterFor(c).behavior.name).toBe("Jeeves");
    const m = parseConfig(JSON.parse('{"mcp":{"servers":{"__proto__":{"command":"x"}}}}'));
    expect(Object.keys(m.mcp.servers)).toEqual([]);
  });

  it("puts the name and personality in the prompt", () => {
    const prompt = personaPrompt(characterFor(DEFAULT_CONFIG, "shiitake").behavior);
    expect(prompt).toContain('"Shiitake"');
    expect(prompt).toContain("mushroom");
  });
});

describe("mcp config", () => {
  it("keeps good servers and drops bad ones", () => {
    const c = parseConfig({
      mcp: {
        useClaudeCode: false,
        servers: {
          files: { type: "stdio", command: "npx", args: ["-y", "server", 3], env: { TOKEN: "x" } },
          web: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer y" } },
          "bad name/../": { type: "stdio", command: "x" },
          nourl: { type: "http", url: "file:///etc/passwd" },
          empty: { type: "stdio", command: " " },
        },
        trusted: ["files", "claude.ai Gmail", "x/../y", "files"],
      },
    });
    expect(c.mcp.useClaudeCode).toBe(false);
    expect(Object.keys(c.mcp.servers)).toEqual(["files", "web"]);
    expect(c.mcp.servers.files).toEqual({ type: "stdio", command: "npx", args: ["-y", "server"], env: { TOKEN: "x" } });
    expect(c.mcp.trusted).toEqual(["files", "claude.ai Gmail"]);
  });

  it("makes the tool prefix that Claude Code uses", () => {
    expect(mcpToolPrefix("claude.ai Claude Docs")).toBe("mcp__claude_ai_Claude_Docs");
    expect(mcpToolPrefix("home-assistant")).toBe("mcp__home-assistant");
  });
});

describe("characterNote", () => {
  it("names the new character and its personality", () => {
    const note = characterNote({ name: "Bruiser", personality: "Blunt.", toolUpdates: "some" } as never);
    expect(note).toContain("you are now Bruiser");
    expect(note).toContain("Personality: Blunt.");
  });
});
