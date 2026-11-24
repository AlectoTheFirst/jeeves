import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFacePackage } from "./faceLoader.ts";
import { FORMAT, readGlb, withManifest, writeGlb, type Manifest } from "./facePackage.ts";

const manifest: Manifest = {
  format: FORMAT,
  id: "round-trip",
  name: "Round Trip",
  version: "1.0.0",
  author: "Test",
  license: "MIT",
  look: {
    colors: { base: "#102030", highlight: "#405060", accent: "#ff00ff", sweep: "#00ff00" },
    eyes: { length: 0.1, height: 0.02, tilt: 0.1, core: "#ffffff", glow: "#00ffff", glowStrength: 1, glowWidth: 0.3, glowHeight: 0.1 },
    cap: { base: "#110000", highlight: "#220000", spots: "#330000", spotSize: 0.1, y: -0.5 },
    smooth: 0.5,
  },
};

/** The GLTF exporter reads its output with FileReader, which Node does not have. */
beforeAll(() => {
  class NodeFileReader {
    result: unknown = null;
    onloadend: ((e: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((r) => {
        this.result = r;
        this.onloadend?.({});
      });
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader ??= NodeFileReader;
});

async function makePackage(): Promise<ArrayBuffer> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute("aJaw", new THREE.Float32BufferAttribute([0, 1, 0.5], 1));
  geometry.setAttribute("aMouth", new THREE.Float32BufferAttribute([0, -1, 0], 1));
  geometry.setIndex([0, 1, 2]);
  const head = new THREE.Mesh(geometry);
  head.name = "head";
  const scene = new THREE.Scene();
  scene.add(head);
  for (const [i, x] of [-0.3, 0.3].entries()) {
    const eye = new THREE.Object3D();
    eye.name = `eye_${i}`;
    eye.position.set(x, 0.2, 0.9);
    eye.rotation.z = 0.1 * (i === 0 ? -1 : 1);
    scene.add(eye);
  }
  const out = new Uint8Array(await new GLTFExporter().parseAsync(scene, { binary: true }) as ArrayBuffer);
  const data = writeGlb(withManifest(readGlb(out), manifest));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

describe("loadFacePackage", () => {
  it("makes a face with the head, the weights and the eyes of the package", async () => {
    const { face } = await loadFacePackage(await makePackage());
    expect(face.id).toBe("pkg-round-trip");
    expect(face.name).toBe("Round Trip");
    expect(face.colors.base).toBe(0x102030);
    expect(face.smooth).toBe(0.5);
    expect(face.capY).toBe(-0.5);
    const g = face.model!.geometry;
    expect(Array.from(g.getAttribute("aJaw").array)).toEqual([0, 1, 0.5]);
    expect(Array.from(g.getAttribute("aMouth").array)).toEqual([0, -1, 0]);
    // A weight that the package does not have is 0.
    expect(Array.from(g.getAttribute("aBrow").array)).toEqual([0, 0, 0]);
    expect(g.getAttribute("normal")).toBeDefined();
    expect(face.model!.eyes[0].position.x).toBeCloseTo(-0.3);
    expect(face.model!.eyes[1].position.z).toBeCloseTo(0.9);
    expect(face.model!.paint).toBeNull();
  });

  it("refuses a package without a head mesh", async () => {
    const data = writeGlb(withManifest({ json: { asset: { version: "2.0" }, scenes: [{ nodes: [] }], scene: 0 }, bin: null }, manifest));
    await expect(loadFacePackage(data.buffer as ArrayBuffer)).rejects.toThrow(/head/);
  });
});
