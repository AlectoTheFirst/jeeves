// ElevenLabs speech to text (batch). API: POST /v1/speech-to-text, multipart form.

export const STT_MODEL = "scribe_v2";

export class SttError extends Error {}

export type SttResult = { text: string; language: string; probability: number };

export type SttOptions = {
  /** ISO-639 code, such as "en". Empty = detect. Detection is weak on short speech. */
  languageCode: string;
  /** Words to expect, such as names. Costs 20% more per request. */
  keyterms: string[];
};

/** `pcmBase64`: 16-bit little-endian mono PCM at 16 kHz. */
export async function transcribe(
  apiKey: string,
  pcmBase64: string,
  options: SttOptions,
  signal?: AbortSignal,
): Promise<SttResult> {
  const form = new FormData();
  form.append("model_id", STT_MODEL);
  form.append("file_format", "pcm_s16le_16");
  form.append("tag_audio_events", "false");
  if (options.languageCode) form.append("language_code", options.languageCode);
  for (const term of options.keyterms) form.append("keyterms", term);
  form.append("file", new Blob([Buffer.from(pcmBase64, "base64")]), "speech.pcm");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SttError(`ElevenLabs STT failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await response.json()) as { text?: unknown; language_code?: unknown; language_probability?: unknown };
  return {
    text: typeof json.text === "string" ? json.text.trim() : "",
    language: typeof json.language_code === "string" ? json.language_code : "",
    probability: typeof json.language_probability === "number" ? json.language_probability : 0,
  };
}

/** A WAV file of 16 kHz mono 16-bit PCM, to listen to or analyse a recording. */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
