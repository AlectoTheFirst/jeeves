// Splits a text stream into complete top-level JSON objects.
// The ElevenLabs timestamp stream is "a stream of JSONs". The docs do not say
// whether there is a newline between objects, so this parser does not need one.

export class JsonObjectStream {
  private buffer = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private start = -1;
  private scanned = 0;

  /** Add text. Returns the complete objects found so far, as raw JSON text. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (let i = this.scanned; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (c === "{") {
        if (this.depth === 0) this.start = i;
        this.depth++;
      } else if (c === "}" && this.depth > 0) {
        this.depth--;
        if (this.depth === 0) out.push(this.buffer.slice(this.start, i + 1));
      }
    }
    // Drop the text that is complete. Keep a part object for the next push.
    if (this.depth === 0) {
      this.buffer = "";
      this.scanned = 0;
    } else {
      this.buffer = this.buffer.slice(this.start);
      this.start = 0;
      this.scanned = this.buffer.length;
    }
    return out;
  }
}
