// The visible states of the head and the look of each state.

export type HeadState = "idle" | "listening" | "thinking" | "speaking" | "permission";

export const HEAD_STATES: readonly HeadState[] = ["idle", "listening", "thinking", "speaking", "permission"];

export type StateStyle = {
  rim: number; // Rim light color.
  rimPower: number;
  sweep: number; // Strength of the moving band (thinking).
  pulse: number; // Rim pulse speed in Hz. 0 = no pulse.
  lookX: number; // Eye direction, -1 to 1.
  lookY: number;
  tilt: number; // Head tilt in radians.
  brow: number; // Brow raise, 0 to 1.
};

export const STATE_STYLES: Record<HeadState, StateStyle> = {
  idle: { rim: 0xff3df2, rimPower: 0.9, sweep: 0, pulse: 0, lookX: 0, lookY: 0, tilt: 0, brow: 0 },
  listening: { rim: 0x7cf8ff, rimPower: 1.4, sweep: 0, pulse: 0, lookX: 0, lookY: 0, tilt: 0.12, brow: 0.3 },
  thinking: { rim: 0xb48cff, rimPower: 1.1, sweep: 0.9, pulse: 0, lookX: -0.7, lookY: 0.8, tilt: -0.05, brow: 0.5 },
  speaking: { rim: 0xff3df2, rimPower: 1.0, sweep: 0, pulse: 0, lookX: 0, lookY: 0, tilt: 0, brow: 0.15 },
  permission: { rim: 0xffb000, rimPower: 1.6, sweep: 0, pulse: 1.5, lookX: 0, lookY: 0.1, tilt: 0.08, brow: 1 },
};
