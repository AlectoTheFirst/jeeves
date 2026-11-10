// Procedural head shape. Pure math, no Three.js, so it is easy to unit test.
// Axes: +x is the head's left-to-right, +y is up, +z points out of the face.
// A unit sphere goes in; a stylized head comes out. Only x and z change, so the
// height (y) of every vertex stays the same as on the sphere. A mushroom cap is
// the only exception: it can make the top of the head lower.

export type Vec3 = { x: number; y: number; z: number };

/** Height of the line between the lips. */
export const MOUTH_Y = -0.46;
/** The jaw turns around this point (on the x axis). */
export const JAW_HINGE: Vec3 = { x: 0, y: -0.1, z: -0.25 };
/** The numbers that make 1 face. Each face preset has its own values. */
export type ShapeParams = {
  /** Head width and depth, as scales of the sphere. */
  width: number;
  depth: number;
  /** Extra width at the top of the skull. Negative gives a narrower top. */
  cranium: number;
  /** How much narrower the jaw gets. 0 = no taper. */
  jawTaper: number;
  /** How far the chin comes forward. */
  chinForward: number;
  /** Scale for the front of the face beyond the flat plane. Lower is flatter. */
  flatness: number;
  nose: { size: number; width: number; length: number };
  brow: number;
  sockets: number;
  cheeks: number;
  /** Scale for both lips. */
  lips: number;
  chin: number;
  ears: number;
  /** Eye distance from the center line, on the unit sphere. */
  eyeSpread: number;
  /**
   * Optional mushroom cap: a dome from height `base` to the top, with an overhang.
   * `height` scales the dome height (1 = to the top of the sphere).
   */
  cap?: { base: number; radius: number; depth: number; height: number };
  /** Optional lower-jaw tusks/fangs and thick scowling brows for a Goomba-like mushroom face. */
  tusks?: boolean;
};

/** The first face. The other presets are in faces.ts. */
export const DEFAULT_SHAPE: ShapeParams = {
  width: 0.76,
  depth: 0.86,
  cranium: 0,
  jawTaper: 0.32,
  chinForward: 0.08,
  flatness: 0.55,
  nose: { size: 0.16, width: 0.085, length: 0.11 },
  brow: 0.06,
  sockets: 0.08,
  cheeks: 0.05,
  lips: 1,
  chin: 0.05,
  ears: 0.07,
  eyeSpread: 0.37,
};

/** Centers of the eye sockets, as unit-sphere coordinates before shaping. */
export function eyeDirs(shape: ShapeParams = DEFAULT_SHAPE): Vec3[] {
  const y = shape.tusks ? 0.15 : 0.1;
  return [-1, 1].map((side) => normalize({ x: side * shape.eyeSpread, y, z: 0.92 }));
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Smooth 0 to 1 ramp. Works for a falling ramp too (edge0 > edge1). */
export function ramp(edge0: number, edge1: number, v: number): number {
  const t = Math.min(Math.max((v - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Gaussian bump: 1 at center, about 0.6 at 1 sigma. */
export function bump(v: number, center: number, sigma: number): number {
  const d = (v - center) / sigma;
  return Math.exp(-0.5 * d * d);
}

/** How much a unit-sphere point is on the face side (0 at the back, 1 at the face). */
export function frontness(unit: Vec3): number {
  return ramp(0.1, 0.8, unit.z);
}

export function shapeHead(unit: Vec3, shape: ShapeParams = DEFAULT_SHAPE): Vec3 {
  const front = frontness(unit);
  const y = unit.y;
  let x = unit.x * shape.width * (1 + shape.cranium * ramp(0.1, 0.9, y));
  let z = unit.z * shape.depth;
  let outY = y;
  if (z < 0) z *= 1.06; // Fuller back of the skull.

  // The jaw and chin get narrower toward the bottom. The chin comes forward.
  const low = ramp(-0.15, -0.95, y);
  x *= 1 - shape.jawTaper * low;
  z = z * (1 - 0.18 * low) + shape.chinForward * low * front;

  // Mushroom cap and stem body: above `base`, a chestnut-shaped dome that is wider at
  // the lower cheeks and tapers toward a round top; below `base`, a plump stalk body.
  if (shape.cap) {
    const { base, radius, depth, height } = shape.cap;
    const around = Math.hypot(unit.x, unit.z) || 1;
    if (y <= base + 0.04) {
      const s = Math.min(Math.max((base - y) / (1 + base), 0), 1);
      const end = Math.max(0, (s - 0.6) / 0.4);
      // Plump pear-shaped tan torso tucked directly under the cap.
      const stem = (0.35 + 0.13 * Math.sin(s * Math.PI * 0.82)) * Math.sqrt(Math.max(1 - end * end, 0));
      x = (unit.x / around) * stem;
      z = (unit.z / around) * stem * (depth * 0.95);
      outY = base - s * 0.45;
    }
    if (y > base - 0.04) {
      const t = Math.min(Math.max((y - base) / (1 - base), 0), 1);
      // Plump rounded lower cheeks, subtle bell waist, and a broad rounded dome crown.
      const bottom = 0.34 + 0.66 * (1 - Math.pow(Math.max(1 - t / 0.22, 0), 2.3));
      const bell = 1.05 - 0.17 * ramp(0.2, 0.7, t);
      const dome = Math.pow(Math.max(1 - t * t, 0), 0.44);
      const target = radius * bottom * bell * dome;
      const w = ramp(base - 0.04, base + 0.03, y);
      x += ((unit.x / around) * target - x) * w;
      z += ((unit.z / around) * target * depth - z) * w;
      if (y > base) outY = base + (y - base) * height;
    }
  }

  // A flatter face on humanoid heads; a mushroom cap keeps its smooth round dome.
  if (!shape.cap && z > 0.45) z = 0.45 + (z - 0.45) * shape.flatness;

  // Face features. Each one is a bump on the front only.
  const ax = Math.abs(x);
  const socketX = shape.eyeSpread * shape.width;
  const n = shape.nose;
  let dz = 0;
  if (shape.tusks) {
    // Goomba facial contours: recessed eye sockets, furrowed glabella bump, gentle frown crease, and puffy lower chin roll.
    const frownY = -0.22 - 0.65 * x * x;
    dz -= 0.055 * bump(ax, 0.2, 0.14) * bump(outY, 0.15, 0.2); // Eye sockets.
    dz += 0.04 * bump(x, 0, 0.042) * bump(outY, 0.26, 0.07); // Center brow furrow bump.
    dz -= 0.018 * bump(ax, 0.055, 0.022) * bump(outY, 0.26, 0.07); // Furrow creases.
    dz -= 0.042 * bump(outY, frownY, 0.032) * ramp(0.44, 0.3, ax); // Frown crease.
    dz -= 0.038 * bump(ax, 0.35, 0.05) * bump(outY, -0.3, 0.055); // Tusk corner pockets.
    dz += 0.09 * bump(outY, frownY - 0.14, 0.12) * bump(x, 0, 0.46); // Puffy lower lip/chin roll.
  } else {
    dz += n.size * bump(x, 0, n.width) * bump(y, -0.14, n.length); // Nose.
    dz += shape.brow * bump(y, 0.22, 0.05) * bump(x, 0, 0.35); // Brow ridge.
    dz -= shape.sockets * bump(ax, socketX, 0.09) * bump(y, 0.1, 0.07); // Eye sockets.
    dz += shape.cheeks * bump(ax, socketX + 0.12, 0.1) * bump(y, -0.08, 0.08); // Cheekbones.
    dz += 0.04 * shape.lips * bump(x, 0, 0.14) * bump(y, MOUTH_Y + 0.05, 0.03); // Upper lip.
    dz += 0.035 * shape.lips * bump(x, 0, 0.13) * bump(y, MOUTH_Y - 0.05, 0.035); // Lower lip.
    dz += shape.chin * bump(x, 0, 0.15) * bump(y, -0.82, 0.08); // Chin.
  }
  z += dz * front;

  // Ears: small bumps on the sides.
  const side = 1 - front;
  x += Math.sign(x) * shape.ears * bump(y, 0, 0.12) * bump(unit.z, -0.05, 0.12) * side;

  return { x, y: outY, z };
}

/** Per-vertex weights that the vertex shader uses to move the face. */
export type FaceWeights = {
  /** 1 = moves fully with the jaw. */
  jaw: number;
  /** 1 = inside of the mouth (dark when the jaw opens). */
  mouth: number;
  /** 1 = the lip area that gets wide or round. */
  lip: number;
  /** 1 = moves with the brows. */
  brow: number;
};

/**
 * Weights for 1 vertex.
 * `belowSeam` is true for sphere rows under the lip line. `atSeam` is true for the
 * 2 rows next to the lip line. Row data comes from the mesh builder, because the
 * lip line must fall between 2 rows to give a clean cut.
 */
export function faceWeights(unit: Vec3, shaped: Vec3, belowSeam: boolean, atSeam: boolean): FaceWeights {
  const front = frontness(unit);
  const jawZone = ramp(-0.35, 0.25, unit.z) * (1 - ramp(0.26, 0.44, Math.abs(shaped.x)));
  return {
    jaw: belowSeam ? jawZone : 0,
    mouth: atSeam ? bump(shaped.x, 0, 0.15) * front : 0,
    lip: bump(shaped.x, 0, 0.25) * bump(shaped.y, MOUTH_Y, 0.1) * front,
    brow: bump(shaped.y, 0.24, 0.06) * bump(shaped.x, 0, 0.4) * front,
  };
}
