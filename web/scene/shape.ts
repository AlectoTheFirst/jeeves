// Procedural head shape. Pure math, no Three.js, so it is easy to unit test.
// Axes: +x is the head's left-to-right, +y is up, +z points out of the face.
// A unit sphere goes in; a stylized head comes out. Only x and z change, so the
// height (y) of every vertex stays the same as on the sphere.

export type Vec3 = { x: number; y: number; z: number };

/** Height of the line between the lips. */
export const MOUTH_Y = -0.46;
/** The jaw turns around this point (on the x axis). */
export const JAW_HINGE: Vec3 = { x: 0, y: -0.1, z: -0.25 };
/** Centers of the eye sockets, as unit-sphere coordinates before shaping. */
export const EYE_DIRS: readonly Vec3[] = [
  normalize({ x: -0.37, y: 0.1, z: 0.92 }),
  normalize({ x: 0.37, y: 0.1, z: 0.92 }),
];

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

export function shapeHead(unit: Vec3): Vec3 {
  const front = frontness(unit);
  const y = unit.y;
  let x = unit.x * 0.76;
  let z = unit.z * 0.86;
  if (z < 0) z *= 1.06; // Fuller back of the skull.

  // The jaw and chin get narrower toward the bottom. The chin comes forward.
  const low = ramp(-0.15, -0.95, y);
  x *= 1 - 0.32 * low;
  z = z * (1 - 0.18 * low) + 0.08 * low * front;

  // A flatter face.
  if (z > 0.45) z = 0.45 + (z - 0.45) * 0.55;

  // Face features. Each one is a bump on the front only.
  const ax = Math.abs(x);
  let dz = 0;
  dz += 0.16 * bump(x, 0, 0.085) * bump(y, -0.14, 0.11); // Nose.
  dz += 0.06 * bump(y, 0.22, 0.05) * bump(x, 0, 0.35); // Brow ridge.
  dz -= 0.08 * bump(ax, 0.28, 0.09) * bump(y, 0.1, 0.07); // Eye sockets.
  dz += 0.05 * bump(ax, 0.4, 0.1) * bump(y, -0.08, 0.08); // Cheekbones.
  dz += 0.04 * bump(x, 0, 0.14) * bump(y, MOUTH_Y + 0.05, 0.03); // Upper lip.
  dz += 0.035 * bump(x, 0, 0.13) * bump(y, MOUTH_Y - 0.05, 0.035); // Lower lip.
  dz += 0.05 * bump(x, 0, 0.15) * bump(y, -0.82, 0.08); // Chin.
  z += dz * front;

  // Ears: small bumps on the sides.
  const side = 1 - front;
  x += Math.sign(x) * 0.07 * bump(y, 0, 0.12) * bump(unit.z, -0.05, 0.12) * side;

  return { x, y, z };
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
  const jawZone = ramp(-0.35, 0.25, unit.z);
  return {
    jaw: belowSeam ? jawZone : 0,
    mouth: atSeam ? bump(shaped.x, 0, 0.11) * front : 0,
    lip: bump(shaped.x, 0, 0.25) * bump(shaped.y, MOUTH_Y, 0.1) * front,
    brow: bump(shaped.y, 0.24, 0.06) * bump(shaped.x, 0, 0.4) * front,
  };
}
