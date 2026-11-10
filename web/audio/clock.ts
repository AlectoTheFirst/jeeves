// Converts playback time to speech time.
// Speech time: seconds in the audio that ElevenLabs sent (the character times use it).
// Playback time: seconds since the speech started to play. It is longer, because
// stutter repeats and network gaps add time.

export type Insert = {
  /** Speech time where the insert starts. */
  at: number;
  /** Total playback seconds that the insert adds. */
  total: number;
  /** "repeat": the slice [at, at + slice) plays again. "gap": silence. */
  kind: "repeat" | "gap";
  /** Length of 1 repeated slice. Not used for a gap. */
  slice: number;
};

export type SpeechTime = { t: number; silent: boolean };

/** `inserts` must be in order of `at`. */
export function toSpeechTime(inserts: readonly Insert[], playback: number): SpeechTime {
  let shift = 0;
  for (const ins of inserts) {
    const start = ins.at + shift;
    if (playback < start) break;
    if (playback < start + ins.total) {
      if (ins.kind === "gap") return { t: ins.at, silent: true };
      return { t: ins.at + ((playback - start) % ins.slice), silent: false };
    }
    shift += ins.total;
  }
  return { t: playback - shift, silent: false };
}

/** Playback time at which a new insert at speech time `at` starts. */
export function playbackStartOf(inserts: readonly Insert[], at: number): number {
  let shift = 0;
  for (const ins of inserts) {
    if (ins.at > at) break;
    shift += ins.total;
  }
  return at + shift;
}
