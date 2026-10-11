// Daemon registry. State files at %TEMP%\vbnet-ls-daemons\<hash>.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

export const STATE_DIR = join(tmpdir(), "vbnet-ls-daemons");
mkdirSync(STATE_DIR, { recursive: true });

export function rootHash(root) {
  const norm = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

export function pipeName(hash) {
  return `\\\\.\\pipe\\vbnet-ls-${hash}`;
}

export function stateFile(hash) {
  return join(STATE_DIR, `${hash}.json`);
}

export function readyFile(hash) {
  return join(STATE_DIR, `${hash}.ready`);
}

export function logFile(hash) {
  return join(STATE_DIR, `${hash}.log`);
}

export function readState(hash) {
  const p = stateFile(hash);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function writeState(hash, obj) {
  writeFileSync(stateFile(hash), JSON.stringify(obj, null, 2), "utf8");
}

export function removeState(hash) {
  for (const p of [stateFile(hash), readyFile(hash)]) {
    try { unlinkSync(p); } catch {}
  }
}

export function listStates() {
  const files = readdirSync(STATE_DIR).filter(f => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8"));
      out.push({ ...s, alive: isPidAlive(s.pid) });
    } catch {}
  }
  return out;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    return e.code === "EPERM";
  }
}

export function touchActivity(hash) {
  const s = readState(hash);
  if (!s) return;
  s.lastActivity = new Date().toISOString();
  writeState(hash, s);
}

export function ageMs(iso) {
  return Date.now() - new Date(iso).getTime();
}
