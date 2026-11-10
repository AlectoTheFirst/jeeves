// Compile the brain to 1 binary with the name that Tauri expects for an externalBin:
// src-tauri/binaries/jeeves-brain-<rust target triple>
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

function findTool(name, fallback) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return name;
  } catch {
    return fallback;
  }
}

const rustc = findTool("rustc", join(homedir(), ".cargo", "bin", "rustc"));
const bun = findTool("bun", join(homedir(), ".bun", "bin", "bun"));

const triple = execFileSync(rustc, ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `jeeves-brain-${triple}`);

execFileSync(bun, ["build", "--compile", join(root, "sidecar", "src", "main.ts"), "--outfile", outFile], {
  stdio: "inherit",
});
console.log(`sidecar built: ${outFile}`);
