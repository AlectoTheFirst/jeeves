import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error The script is plain JavaScript with no type file.
import { buildIndex, keygen, publicKeyHex, signBytes } from "./face-catalog.mjs";

const root = mkdtempSync(join(tmpdir(), "jeeves-catalog-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function glb(manifest: object): Buffer {
  let json = Buffer.from(JSON.stringify({ asset: { version: "2.0", extras: { jeevesFace: manifest } } }));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, json]);
}

describe("face catalog script", () => {
  it("builds an index from the packages in a folder", () => {
    const dir = join(root, "faces");
    mkdirSync(dir);
    writeFileSync(join(dir, "b owl.glb"), glb({ format: "jeeves-face/1", id: "owl", name: "Owl", version: "1", author: "Ann", license: "MIT" }));
    writeFileSync(join(dir, "fox.glb"), glb({ format: "jeeves-face/1", id: "fox", name: "Fox" }));
    writeFileSync(join(dir, "notes.txt"), "x");
    const index = buildIndex(dir);
    expect(index.format).toBe("jeeves-face-catalog/1");
    expect(index.faces.map((f: { id: string }) => f.id)).toEqual(["fox", "owl"]);
    expect(index.faces[1]).toMatchObject({ url: "b%20owl.glb", author: "Ann", size: readFileSync(join(dir, "b owl.glb")).length });
    expect(index.faces[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dir, "bad.glb"), glb({ format: "other", id: "bad" }));
    expect(() => buildIndex(dir)).toThrow("bad.glb");
  });

  it("makes a key file once and signs bytes that the public key checks", () => {
    const path = join(root, "keys", "catalog.key");
    const publicHex = keygen(path);
    expect(publicHex).toMatch(/^[0-9a-f]{64}$/);
    const fd = openSync(path, "r");
    expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    const key = createPrivateKey(readFileSync(fd));
    closeSync(fd);
    expect(() => keygen(path)).toThrow("already");
    expect(publicKeyHex(key)).toBe(publicHex);
    const data = Buffer.from('{"format":"jeeves-face-catalog/1","faces":[]}');
    const signature = Buffer.from(signBytes(data, key), "hex");
    expect(verify(null, data, createPublicKey(key), signature)).toBe(true);
    expect(verify(null, Buffer.from("other"), createPublicKey(key), signature)).toBe(false);
  });
});
