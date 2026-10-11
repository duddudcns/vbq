import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkServer, versionLess, installedVersion } from "../lib/server-check.mjs";

const EXE = process.platform === "win32" ? "vbnet-ls.exe" : "vbnet-ls";

function fixture({ onPath, versions = [] }) {
  const root = mkdtempSync(join(tmpdir(), "vbqchk-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (onPath) writeFileSync(join(bin, EXE), "");
  for (const v of versions) mkdirSync(join(root, "home", ".dotnet", "tools", ".store", "dnakode.vbnet.lsp", v), { recursive: true });
  return { root, env: { PATH: bin }, home: join(root, "home") };
}

test("versions compare numerically, not as text", () => {
  assert.equal(versionLess("0.1.9", "0.1.10"), true);
  assert.equal(versionLess("0.1.16", "0.1.10"), false);
  assert.equal(versionLess("0.1.10", "0.1.10"), false);
});

test("server not on PATH is reported as missing", () => {
  const f = fixture({ onPath: false });
  try { assert.equal(checkServer(f.env, f.home).problem, "missing"); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("server older than 0.1.10 is reported as old", () => {
  const f = fixture({ onPath: true, versions: ["0.1.9"] });
  try {
    const r = checkServer(f.env, f.home);
    assert.equal(r.problem, "old");
    assert.equal(r.version, "0.1.9");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("highest installed version wins when several are in the tool store", () => {
  const f = fixture({ onPath: true, versions: ["0.1.9", "0.1.16", "0.1.10"] });
  try {
    assert.equal(installedVersion(f.home), "0.1.16");
    assert.equal(checkServer(f.env, f.home).ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("server on PATH with unknown version is accepted", () => {
  const f = fixture({ onPath: true });
  try { assert.equal(checkServer(f.env, f.home).ok, true); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});
