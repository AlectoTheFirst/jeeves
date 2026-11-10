// Face presets: shape, colors and eye style. All of them are original designs.
import { DEFAULT_SHAPE, type ShapeParams } from "./shape.ts";

export type EyeStyle = {
  /** Half length, half height and half depth of the bright core. */
  length: number;
  height: number;
  /** Outer end up (positive) or down (negative), in radians. */
  tilt: number;
  core: number;
  glow: number;
  glowStrength: number;
  /** Size of the glow plane. */
  glowWidth: number;
  glowHeight: number;
  /** Optional cartoon eye white behind the core. Without it, the eye has a dark slit behind it. */
  white?: { color: number; length: number; height: number };
};

export type Face = {
  id: string;
  name: string;
  shape: ShapeParams;
  colors: {
    base: number;
    highlight: number;
    /** Rim color when the head is idle or speaking. Other states keep their own colors. */
    accent: number;
    sweep: number;
  };
  eyes: EyeStyle;
  /** Colors of a mushroom cap. Only for a shape with a cap. */
  cap?: { base: number; highlight: number; spots: number; spotSize: number };
};

/** Up to this many spots on a cap. The shader has an array of this size. */
export const MAX_SPOTS = 12;

/** Spot centers on the top of the head: a spiral, so the spots do not touch. */
export function spotDirs(count = MAX_SPOTS): [number, number, number][] {
  const dirs: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 0.95 - (i / (count - 1)) * 0.5;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden + 0.6;
    dirs.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return dirs;
}

const SLIT: EyeStyle = {
  length: 0.1,
  height: 0.013,
  tilt: 0.08,
  core: 0xe6fdff,
  glow: 0x3fe6ff,
  glowStrength: 1.2,
  glowWidth: 0.36,
  glowHeight: 0.14,
};

export const FACES: readonly Face[] = [
  {
    id: "host",
    name: "Host",
    shape: DEFAULT_SHAPE,
    colors: { base: 0x0b3c52, highlight: 0x56d8f0, accent: 0xff3df2, sweep: 0xb48cff },
    eyes: SLIT,
  },
  {
    id: "chrome",
    name: "Chrome",
    shape: {
      ...DEFAULT_SHAPE,
      width: 0.7,
      depth: 0.9,
      cranium: 0.05,
      jawTaper: 0.4,
      chinForward: 0.1,
      flatness: 0.5,
      nose: { size: 0.13, width: 0.06, length: 0.12 },
      brow: 0.04,
      sockets: 0.1,
      cheeks: 0.09,
      lips: 0.8,
      chin: 0.06,
      ears: 0.04,
      eyeSpread: 0.34,
    },
    colors: { base: 0x161a24, highlight: 0x9fb0c4, accent: 0x4da3ff, sweep: 0x9ad0ff },
    eyes: { ...SLIT, length: 0.095, height: 0.014, tilt: 0.14, core: 0xffffff, glow: 0x7ccaff, glowStrength: 1.8 },
  },
  {
    id: "bruiser",
    name: "Bruiser",
    shape: {
      ...DEFAULT_SHAPE,
      width: 0.8,
      depth: 0.84,
      cranium: -0.16,
      jawTaper: -0.04,
      chinForward: 0.12,
      flatness: 0.6,
      nose: { size: 0.2, width: 0.12, length: 0.12 },
      brow: 0.11,
      sockets: 0.1,
      lips: 1.3,
      chin: 0.08,
      ears: 0.09,
      eyeSpread: 0.36,
    },
    colors: { base: 0x2a1008, highlight: 0xb8642a, accent: 0xff4a2a, sweep: 0xffc070 },
    eyes: { ...SLIT, length: 0.085, height: 0.011, tilt: 0.2, core: 0xffffff, glow: 0xffc030 },
  },
  {
    id: "sprite",
    name: "Sprite",
    shape: {
      ...DEFAULT_SHAPE,
      width: 0.8,
      depth: 0.82,
      cranium: 0.12,
      jawTaper: 0.45,
      chinForward: 0.04,
      flatness: 0.5,
      nose: { size: 0.09, width: 0.07, length: 0.07 },
      brow: 0.03,
      sockets: 0.06,
      cheeks: 0.07,
      lips: 0.8,
      chin: 0.03,
      ears: 0.1,
      eyeSpread: 0.4,
    },
    colors: { base: 0x082414, highlight: 0x4cc46a, accent: 0xffe14d, sweep: 0xc8ff6a },
    eyes: {
      ...SLIT,
      length: 0.06,
      height: 0.03,
      tilt: 0,
      core: 0xf4fff0,
      glow: 0x5aff8a,
      glowWidth: 0.3,
      glowHeight: 0.2,
    },
  },
  {
    id: "shiitake",
    name: "Shiitake",
    shape: {
      ...DEFAULT_SHAPE,
      width: 0.54,
      depth: 0.54,
      cranium: 0,
      jawTaper: -0.18,
      chinForward: 0,
      flatness: 0.65,
      nose: { size: 0, width: 0.08, length: 0.06 },
      brow: 0.03,
      sockets: 0.02,
      cheeks: 0.03,
      lips: 0.2,
      chin: 0,
      ears: 0,
      eyeSpread: 0.225,
      cap: { base: -0.56, radius: 1.0, depth: 0.88, height: 0.92 },
      tusks: true,
    },
    colors: { base: 0x8a6440, highlight: 0xfce0b4, accent: 0xffc878, sweep: 0xffd27a },
    eyes: {
      ...SLIT,
      length: 0.048,
      height: 0.08,
      tilt: 0.04,
      core: 0x0c0806,
      glow: 0xfff0c0,
      glowStrength: 0.14,
      glowWidth: 0.2,
      glowHeight: 0.22,
      white: { color: 0xfcfaf7, length: 0.145, height: 0.25 },
    },
    cap: { base: 0x522612, highlight: 0xc97b52, spots: 0xd6b88e, spotSize: 0 },
  },
  {
    id: "totoro",
    name: "Totoro",
    shape: {
      ...DEFAULT_SHAPE,
      width: 0.78,
      depth: 0.84,
      cranium: 0,
      jawTaper: 0,
      chinForward: 0,
      flatness: 1,
      nose: { size: 0, width: 0.08, length: 0.06 },
      brow: 0,
      sockets: 0,
      cheeks: 0,
      lips: 0,
      chin: 0,
      ears: 0,
      eyeSpread: 0.31,
      totoro: true,
    },
    colors: { base: 0x38352e, highlight: 0x878174, accent: 0x88e868, sweep: 0xc8ff8a },
    eyes: {
      ...SLIT,
      length: 0.04,
      height: 0.042,
      tilt: 0,
      core: 0x0c0a08,
      glow: 0xd8ff9a,
      glowStrength: 0.12,
      glowWidth: 0.18,
      glowHeight: 0.18,
      white: { color: 0xfcfbf5, length: 0.082, height: 0.086 },
    },
  },
];

export function faceById(id: string | null | undefined): Face {
  return FACES.find((f) => f.id === id) ?? FACES[0];
}
