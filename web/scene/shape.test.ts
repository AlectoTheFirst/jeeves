import { describe, expect, it } from "vitest";
import { faceWeights, MOUTH_Y, normalize, shapeHead } from "./shape.ts";

const onSphere = (x: number, y: number) => normalize({ x, y, z: Math.sqrt(Math.max(1 - x * x - y * y, 0)) });

describe("shapeHead", () => {
  it("keeps the height of each vertex", () => {
    const p = onSphere(0.2, 0.3);
    expect(shapeHead(p).y).toBeCloseTo(p.y);
  });

  it("puts the nose tip in front of the cheeks", () => {
    const nose = shapeHead(onSphere(0, -0.12));
    const cheek = shapeHead(onSphere(0.4, -0.12));
    expect(nose.z).toBeGreaterThan(cheek.z + 0.1);
  });

  it("makes the jaw narrower than the temples", () => {
    const temple = shapeHead(normalize({ x: 1, y: 0.2, z: 0 }));
    const jaw = shapeHead(normalize({ x: 1, y: -0.7, z: 0 }));
    expect(Math.abs(jaw.x)).toBeLessThan(Math.abs(temple.x) * 0.85);
  });

  it("is symmetric", () => {
    const l = shapeHead(onSphere(-0.3, 0.1));
    const r = shapeHead(onSphere(0.3, 0.1));
    expect(l.x).toBeCloseTo(-r.x);
    expect(l.z).toBeCloseTo(r.z);
  });
});

describe("faceWeights", () => {
  it("moves only rows below the lip line with the jaw", () => {
    const chin = onSphere(0, -0.8);
    expect(faceWeights(chin, shapeHead(chin), true, false).jaw).toBeGreaterThan(0.9);
    const nose = onSphere(0, -0.1);
    expect(faceWeights(nose, shapeHead(nose), false, false).jaw).toBe(0);
  });

  it("keeps the back of the head still", () => {
    const back = normalize({ x: 0, y: -0.8, z: -0.6 });
    expect(faceWeights(back, shapeHead(back), true, false).jaw).toBe(0);
  });

  it("marks the mouth inside only at the lip line, center of the face", () => {
    const center = onSphere(0, MOUTH_Y);
    const corner = onSphere(0.6, MOUTH_Y);
    expect(faceWeights(center, shapeHead(center), false, true).mouth).toBeGreaterThan(0.8);
    expect(faceWeights(corner, shapeHead(corner), false, true).mouth).toBeLessThan(0.05);
    expect(faceWeights(center, shapeHead(center), false, false).mouth).toBe(0);
  });
});

describe("face presets", () => {
  it("give every face a nose, a narrow jaw and symmetry", async () => {
    const { FACES } = await import("./faces.ts");
    for (const face of FACES) {
      const nose = shapeHead(onSphere(0, -0.12), face.shape);
      const cheek = shapeHead(onSphere(0.4, -0.12), face.shape);
      expect(nose.z, face.id).toBeGreaterThan(cheek.z);
      const l = shapeHead(onSphere(-0.3, 0.1), face.shape);
      const r = shapeHead(onSphere(0.3, 0.1), face.shape);
      expect(l.x, face.id).toBeCloseTo(-r.x);
    }
  });

  it("shapes the mushroom face with a wide lower cap over a narrow stem", async () => {
    const { faceById } = await import("./faces.ts");
    const { shape } = faceById("shiitake");
    const sideAt = (y: number) => ({ x: Math.sqrt(1 - y * y), y, z: 0 });
    const crown = shapeHead(sideAt(0.55), shape);
    const brim = shapeHead(sideAt(-0.2), shape);
    const stem = shapeHead(sideAt(-0.8), shape);
    expect(brim.x).toBeGreaterThan(crown.x * 1.3);
    expect(brim.x).toBeGreaterThan(stem.x * 1.8);
  });

  it("falls back to the first face for an unknown id", async () => {
    const { faceById, FACES } = await import("./faces.ts");
    expect(faceById("nope")).toBe(FACES[0]);
    expect(faceById("sprite").name).toBe("Sprite");
  });
});
