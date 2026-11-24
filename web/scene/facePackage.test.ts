import { describe, expect, it } from "vitest";
import {
  colorNumber,
  FORMAT,
  isPackageFaceId,
  manifestFaults,
  packageFaceId,
  readGlb,
  readManifest,
  rgb,
  withManifest,
  writeGlb,
  type Manifest,
} from "./facePackage.ts";

const TEST_MANIFEST: Manifest = {
  format: FORMAT,
  id: "test-face",
  name: "Test",
  version: "1.0.0",
  author: "Someone",
  license: "MIT",
  look: {
    colors: { base: "#000000", highlight: "#ffffff", accent: "#ff0000", sweep: "#00ff00" },
    eyes: {
      length: 0.1,
      height: 0.02,
      tilt: 0.1,
      core: "#ffffff",
      glow: "#00ffff",
      glowStrength: 1,
      glowWidth: 0.3,
      glowHeight: 0.1,
      white: { color: "#fafafa", length: 0.1, height: 0.2 },
      pupil: { inward: 0.1, down: 0 },
    },
    smooth: 0.5,
  },
};

describe("GLB", () => {
  it("writes and reads a file with JSON and binary chunks", () => {
    const glb = readGlb(writeGlb({ json: { asset: { version: "2.0" } }, bin: new Uint8Array([1, 2, 3, 4, 5]) }));
    expect(glb.json).toEqual({ asset: { version: "2.0" } });
    expect([...glb.bin!.subarray(0, 5)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the file on a 4-byte boundary", () => {
    expect(writeGlb({ json: { a: 1 }, bin: new Uint8Array(3) }).byteLength % 4).toBe(0);
  });

  it("refuses a file that is not GLB", () => {
    expect(() => readGlb(new TextEncoder().encode("hello, this is not a glb file"))).toThrow(/not a GLB/);
  });

  it("refuses a file with a wrong length", () => {
    const data = writeGlb({ json: {}, bin: null });
    expect(() => readGlb(data.subarray(0, data.byteLength - 4))).toThrow(/length/);
  });
});

describe("manifest", () => {
  it("stores and reads the manifest, and keeps the other asset fields", () => {
    const glb = withManifest({ json: { asset: { version: "2.0", generator: "x" } }, bin: null }, TEST_MANIFEST);
    expect(readManifest(writeGlb(glb))).toEqual(TEST_MANIFEST);
    expect((glb.json.asset as { generator: string }).generator).toBe("x");
  });

  it("refuses a package without a manifest", () => {
    expect(() => readManifest(writeGlb({ json: { asset: { version: "2.0" } }, bin: null }))).toThrow(/bad manifest/);
  });

  it("refuses a package that points to outside data", () => {
    const json = { asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri: "https://example.com/x.bin" }], images: [{ uri: "file:///etc/passwd" }] };
    expect(() => readManifest(writeGlb(withManifest({ json, bin: null }, TEST_MANIFEST)))).toThrow(/buffers\[0\], images\[0\]/);
  });

  it("accepts a buffer without a URI, as in each GLB file", () => {
    const json = { asset: { version: "2.0" }, buffers: [{ byteLength: 4 }], images: [{ bufferView: 0, mimeType: "image/png" }] };
    expect(readManifest(writeGlb(withManifest({ json, bin: new Uint8Array(4) }, TEST_MANIFEST)))).toEqual(TEST_MANIFEST);
  });

  it("accepts a good manifest", () => {
    expect(manifestFaults(TEST_MANIFEST)).toEqual([]);
  });

  it("finds each bad field", () => {
    const faults = manifestFaults({
      ...TEST_MANIFEST,
      id: "../evil",
      name: "",
      look: {
        ...TEST_MANIFEST.look,
        colors: { ...TEST_MANIFEST.look.colors, base: "red" },
        eyes: { ...TEST_MANIFEST.look.eyes, core: "nope", length: 1e9 },
        smooth: 2,
      },
    });
    expect(faults).toHaveLength(6);
  });
});

describe("ids and colors", () => {
  it("keeps package faces apart from built-in faces", () => {
    expect(packageFaceId("owl")).toBe("pkg-owl");
    expect(isPackageFaceId("pkg-owl")).toBe(true);
    expect(isPackageFaceId("host")).toBe(false);
  });

  it("converts colors both ways", () => {
    expect(rgb(0x0a0b0c)).toBe("#0a0b0c");
    expect(colorNumber("#0a0b0c")).toBe(0x0a0b0c);
  });
});
