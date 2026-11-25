#!/usr/bin/env node
// Make and sign a Jeeves face catalog. Read docs/face-packages.md.
//
//   node scripts/face-catalog.mjs keygen          make a signing key and print the public key
//   node scripts/face-catalog.mjs pubkey          print the public key of the signing key
//   node scripts/face-catalog.mjs build <folder>  write <folder>/index.json from the .glb files, and sign it
//   node scripts/face-catalog.mjs sign <index>    write <index>.sig
//
// The private key is a PKCS 8 PEM file at $JEEVES_CATALOG_KEY, else ~/.config/jeeves/catalog-sign.key.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG_FORMAT = "jeeves-face-catalog/1";
const PACKAGE_FORMAT = "jeeves-face/1";
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

export function keyPath() {
  return process.env.JEEVES_CATALOG_KEY || join(homedir(), ".config", "jeeves", "catalog-sign.key");
}

/** Make a new key file. Refuses to replace a key file. Returns the public key as hex. */
export function keygen(path = keyPath()) {
  if (existsSync(path)) throw new Error(`a key file is already at ${path}`);
  const { privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  return publicKeyHex(privateKey);
}

function readKey(path = keyPath()) {
  return createPrivateKey(readFileSync(path));
}

export function publicKeyHex(privateKey = readKey()) {
  return Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url").toString("hex");
}

/** The ed25519 signature of the exact bytes, as hex. */
export function signBytes(bytes, privateKey = readKey()) {
  return sign(null, bytes, privateKey).toString("hex");
}

/** The manifest of a GLB file. Throws with the cause if the file is not a face package. */
export function readManifest(bytes) {
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error("the package is larger than 20 MB");
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) {
    throw new Error("the file is not a glTF 2 GLB file");
  }
  const size = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + size > bytes.length) throw new Error("the GLB file has no JSON chunk");
  const manifest = JSON.parse(bytes.subarray(20, 20 + size).toString("utf8"))?.asset?.extras?.jeevesFace;
  if (manifest?.format !== PACKAGE_FORMAT) throw new Error(`the file is not a Jeeves face package (format ${PACKAGE_FORMAT})`);
  if (typeof manifest.id !== "string" || !PACKAGE_ID.test(manifest.id)) throw new Error("bad package id");
  return manifest;
}

/** The catalog index for the .glb files in a folder, sorted by id. */
export function buildIndex(folder) {
  const faces = [];
  for (const file of readdirSync(folder).filter((f) => f.endsWith(".glb")).sort()) {
    const bytes = readFileSync(join(folder, file));
    let m;
    try {
      m = readManifest(bytes);
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
    if (faces.some((f) => f.id === m.id)) throw new Error(`${file}: the id ${m.id} is used twice`);
    const text = (v) => (typeof v === "string" ? v : "");
    faces.push({
      id: m.id,
      name: text(m.name),
      version: text(m.version),
      author: text(m.author),
      license: text(m.license),
      description: text(m.description),
      url: encodeURIComponent(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }
  faces.sort((a, b) => a.id.localeCompare(b.id));
  return { format: CATALOG_FORMAT, faces };
}

function main(args) {
  const [command, target] = args;
  switch (command) {
    case "keygen":
      console.log(`key file: ${keyPath()}`);
      console.log(`public key: ${keygen()}`);
      return;
    case "pubkey":
      console.log(publicKeyHex());
      return;
    case "build": {
      if (!target) throw new Error("give the folder with the .glb files");
      const index = Buffer.from(`${JSON.stringify(buildIndex(target), null, 2)}\n`);
      const out = join(target, "index.json");
      writeFileSync(out, index);
      console.log(`${out}: ${JSON.parse(index).faces.length} faces`);
      if (existsSync(keyPath())) {
        writeFileSync(`${out}.sig`, `${signBytes(index)}\n`);
        console.log(`${out}.sig: signed with ${publicKeyHex()}`);
      } else {
        rmSync(`${out}.sig`, { force: true });
        console.log(`not signed: no key file at ${keyPath()}`);
      }
      return;
    }
    case "sign": {
      if (!target) throw new Error("give the index.json file");
      writeFileSync(`${target}.sig`, `${signBytes(readFileSync(target))}\n`);
      console.log(`${basename(target)}.sig: signed with ${publicKeyHex()}`);
      return;
    }
    default:
      console.log("commands: keygen, pubkey, build <folder>, sign <index.json>");
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`face-catalog: ${err.message}`);
    process.exitCode = 1;
  }
}
