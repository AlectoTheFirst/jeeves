// ElevenLabs text to speech with character timestamps, as a stream.
// API: POST /v1/text-to-speech/{voice_id}/stream/with-timestamps
import { JsonObjectStream } from "./jsonStream.ts";

export const SAMPLE_RATE = 24000;

export type VoiceConfig = {
  apiKey: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
};

export type TtsChunk = {
  /** Base64 of 16-bit little-endian mono PCM at SAMPLE_RATE. */
  audio: string;
  chars: string[];
  starts: number[];
  ends: number[];
};

type Alignment = {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
};

type RawChunk = { audio_base64?: string; alignment?: Alignment | null };

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type VoiceInfo = { id: string; name: string; category: string };

/** The voices in the user's ElevenLabs account: own voices and added library voices. */
export async function listVoices(apiKey: string, signal?: AbortSignal): Promise<VoiceInfo[]> {
  const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey }, signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new TtsError(`ElevenLabs voice list failed (${response.status}): ${detail.slice(0, 300)}`, response.status);
  }
  const body = (await response.json()) as { voices?: { voice_id?: unknown; name?: unknown; category?: unknown }[] };
  return (body.voices ?? [])
    .filter((v) => typeof v.voice_id === "string" && typeof v.name === "string")
    .map((v) => ({ id: v.voice_id as string, name: v.name as string, category: typeof v.category === "string" ? v.category : "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function* streamSpeech(config: VoiceConfig, text: string, signal: AbortSignal): AsyncGenerator<TtsChunk> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}` +
    `/stream/with-timestamps?output_format=pcm_${SAMPLE_RATE}`;
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "xi-api-key": config.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: config.modelId,
      voice_settings: {
        stability: config.stability,
        similarity_boost: config.similarityBoost,
        style: config.style,
        speed: config.speed,
      },
    }),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new TtsError(`ElevenLabs TTS failed (${response.status}): ${detail.slice(0, 300)}`, response.status);
  }

  const parser = new JsonObjectStream();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
      const chunk = JSON.parse(raw) as RawChunk;
      if (!chunk.audio_base64) continue;
      const a = chunk.alignment ?? {};
      yield {
        audio: chunk.audio_base64,
        chars: a.characters ?? [],
        starts: a.character_start_times_seconds ?? [],
        ends: a.character_end_times_seconds ?? [],
      };
    }
  }
}
