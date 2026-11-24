// Face packages: binary glTF files (.glb) with a manifest. A package holds only data,
// no code. This file reads and checks the file and the manifest. It does not use
// Three.js, so the face tools can use it too. Read docs/face-packages.md.

export const FORMAT = "jeeves-face/1";
/** Jeeves refuses a larger package. */
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
/** Jeeves refuses a head mesh with more vertices. */
export const MAX_VERTICES = 400_000;
/** A package id: 1 to 40 lowercase letters, digits or "-". It is also the file name. */
export const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The prefix of a package face in the face list. It keeps package ids apart from built-in ids. */
export const PACKAGE_PREFIX = "pkg-";

export const packageFaceId = (id: string) => `${PACKAGE_PREFIX}${id}`;
export const isPackageFaceId = (faceId: string) => faceId.startsWith(PACKAGE_PREFIX);

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export type Glb = { json: Record<string, unknown>; bin: Uint8Array | null };

export type Rgb = `#${string}`;

export type PackageEyes = {
  length: number;
  height: number;
  tilt: number;
  core: Rgb;
  glow: Rgb;
  glowStrength: number;
  glowWidth: number;
  glowHeight: number;
  white?: { color: Rgb; length: number; height: number };
  /** Pupil offset in the eye white: toward the nose, and down. Parts of the white size. */
  pupil?: { inward: number; down: number };
  /** Scale for the lower half of the eye white. 1 = round. */
  whiteFlat?: number;
};

export type Manifest = {
  format: typeof FORMAT;
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  description?: string;
  look: {
    colors: { base: Rgb; highlight: Rgb; accent: Rgb; sweep: Rgb };
    eyes: PackageEyes;
    /** A mushroom cap: own colors above the height y. */
    cap?: { base: Rgb; highlight: Rgb; spots: Rgb; spotSize: number; y: number };
    /** 0 = flat facets, 1 = smooth surface. */
    smooth?: number;
    /** How dark the closed mouth is, 0 to 1. The default is 0.55. */
    mouthShade?: number;
  };
};

export function readGlb(data: Uint8Array): Glb {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error("not a GLB file");
  if (view.getUint32(4, true) !== 2) throw new Error("only glTF 2 is supported");
  const length = view.getUint32(8, true);
  if (length !== data.byteLength) throw new Error("the GLB length does not agree with the file size");
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= length) {
    const size = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > length) throw new Error("a GLB chunk is longer than the file");
    const chunk = data.subarray(start, start + size);
    if (type === CHUNK_JSON && json === null) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === CHUNK_BIN && bin === null) bin = chunk;
    offset = start + size;
  }
  if (json === null || typeof json !== "object") throw new Error("the GLB file has no JSON chunk");
  return { json, bin };
}

const RGB = /^#[0-9a-f]{6}$/i;
const isText = (v: unknown, max = 200) => typeof v === "string" && v.trim() !== "" && v.length <= max;
const isRgb = (v: unknown): v is Rgb => typeof v === "string" && RGB.test(v);
const isNum = (v: unknown, min = -10, max = 10) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The faults in a manifest. An empty list means that the manifest is good. */
export function manifestFaults(raw: unknown): string[] {
  const faults: string[] = [];
  if (!isObj(raw)) return ["the manifest is missing"];
  const m = raw;
  if (m.format !== FORMAT) faults.push(`format must be "${FORMAT}"`);
  if (typeof m.id !== "string" || !PACKAGE_ID.test(m.id)) faults.push("id must be 1 to 40 lowercase letters, digits or -");
  for (const key of ["name", "version", "author", "license"]) {
    if (!isText(m[key])) faults.push(`${key} must be a text of 1 to 200 characters`);
  }
  if (m.description !== undefined && !isText(m.description, 1000)) faults.push("description must be a text of up to 1000 characters");
  const look = m.look;
  if (!isObj(look)) return [...faults, "look is missing"];

  const colors = isObj(look.colors) ? look.colors : {};
  for (const key of ["base", "highlight", "accent", "sweep"]) {
    if (!isRgb(colors[key])) faults.push(`look.colors.${key} must be a color like #12ab34`);
  }

  if (!isObj(look.eyes)) faults.push("look.eyes is missing");
  else {
    const e = look.eyes;
    for (const key of ["length", "height", "tilt", "glowStrength", "glowWidth", "glowHeight"]) {
      if (!isNum(e[key])) faults.push(`look.eyes.${key} must be a number from -10 to 10`);
    }
    for (const key of ["core", "glow"]) {
      if (!isRgb(e[key])) faults.push(`look.eyes.${key} must be a color like #12ab34`);
    }
    if (e.white !== undefined && !(isObj(e.white) && isRgb(e.white.color) && isNum(e.white.length) && isNum(e.white.height))) {
      faults.push("look.eyes.white must have a color, a length and a height");
    }
    if (e.pupil !== undefined && !(isObj(e.pupil) && isNum(e.pupil.inward) && isNum(e.pupil.down))) {
      faults.push("look.eyes.pupil must have the numbers inward and down");
    }
    if (e.whiteFlat !== undefined && !isNum(e.whiteFlat, 0, 2)) faults.push("look.eyes.whiteFlat must be a number from 0 to 2");
  }

  if (look.cap !== undefined) {
    const c = look.cap;
    if (!(isObj(c) && isRgb(c.base) && isRgb(c.highlight) && isRgb(c.spots) && isNum(c.spotSize, 0, 2) && isNum(c.y, -2, 2))) {
      faults.push("look.cap must have the colors base, highlight and spots, and the numbers spotSize and y");
    }
  }
  if (look.smooth !== undefined && !isNum(look.smooth, 0, 1)) faults.push("look.smooth must be a number from 0 to 1");
  if (look.mouthShade !== undefined && !isNum(look.mouthShade, 0, 1)) faults.push("look.mouthShade must be a number from 0 to 1");
  return faults;
}

/**
 * A package must be 1 closed file: no buffer and no image may point to a URI. The GLTF
 * loader would fetch such a URI, also from the internet or from a local file.
 */
export function externalUris(json: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of ["buffers", "images"]) {
    const list = json[key];
    if (!Array.isArray(list)) continue;
    for (const [i, item] of list.entries()) {
      if (isObj(item) && item.uri !== undefined) found.push(`${key}[${i}]`);
    }
  }
  return found;
}

/** The manifest of a package. Throws if the file or the manifest is bad. */
export function readManifest(data: Uint8Array): Manifest {
  if (data.byteLength > MAX_PACKAGE_BYTES) throw new Error(`the package is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`);
  const { json } = readGlb(data);
  const uris = externalUris(json);
  if (uris.length > 0) throw new Error(`the package points to outside data (${uris.join(", ")}). All data must be in the file.`);
  const asset = isObj(json.asset) ? json.asset : {};
  const manifest = isObj(asset.extras) ? asset.extras.jeevesFace : undefined;
  const faults = manifestFaults(manifest);
  if (faults.length > 0) throw new Error(`bad manifest: ${faults.join("; ")}`);
  return manifest as Manifest;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** Write a GLB file. For tools that make packages. */
export function writeGlb({ json, bin }: Glb): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = text.byteLength + pad4(text.byteLength);
  const binSize = bin ? bin.byteLength + pad4(bin.byteLength) : 0;
  const total = 12 + 8 + jsonSize + (bin ? 8 + binSize : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonSize, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.byteLength, 20 + jsonSize); // The JSON chunk pads with spaces.
  if (bin) {
    const at = 20 + jsonSize;
    view.setUint32(at, binSize, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

/** Put the manifest in the glTF JSON. For tools that make packages. */
export function withManifest(glb: Glb, manifest: Manifest): Glb {
  const asset = { ...(isObj(glb.json.asset) ? glb.json.asset : {}) };
  asset.extras = { ...(isObj(asset.extras) ? asset.extras : {}), jeevesFace: manifest };
  return { ...glb, json: { ...glb.json, asset } };
}

/** The number 0x12ab34 as "#12ab34". */
export const rgb = (color: number): Rgb => `#${color.toString(16).padStart(6, "0")}`;

/** "#12ab34" as the number 0x12ab34. */
export const colorNumber = (rgb: Rgb) => Number.parseInt(rgb.slice(1), 16);
