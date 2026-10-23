import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathHas, pathAppend, launcherVersionOf, runSetup, launcherStatus } from "../lib/setup.mjs";
import { resolvePluginRoot } from "../bin/vbq-launch.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "vbqsetup-")); }

function plugin(cfg, market, ver) {
  const dir = join(cfg, "plugins", "cache", market, "vbq", ver);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vbq.mjs"), "");
  return dir;
}

test("PATH membership ignores case, trailing slash and %VAR%", () => {
  const env = { USERPROFILE: "C:\\Users\\me" };
  assert.equal(pathHas("C:\\a;c:\\users\\ME\\.local\\bin\\;D:\\b", "C:\\Users\\me\\.local\\bin", env), true);
  assert.equal(pathHas("%USERPROFILE%\\.local\\bin", "C:\\Users\\me\\.local\\bin", env), true);
  assert.equal(pathHas("C:\\Users\\me\\.local\\binx", "C:\\Users\\me\\.local\\bin", env), false);
  assert.equal(pathHas("", "C:\\x", env), false);
});

test("PATH append does not leave double semicolons", () => {
  assert.equal(pathAppend("C:\\a;", "C:\\b"), "C:\\a;C:\\b");
  assert.equal(pathAppend("", "C:\\b"), "C:\\b");
});

test("launcher version is read from the file text", () => {
  assert.equal(launcherVersionOf("export const LAUNCHER_VERSION = 3;"), 3);
  assert.equal(launcherVersionOf("nothing"), null);
});

test("launcher follows installed_plugins.json, not a leftover old cache dir", () => {
  const cfg = tmp();
  try {
    const cur = plugin(cfg, "duddudcns", "0.3.0");
    plugin(cfg, "duddudcns", "0.9.0"); // 지워지지 않은 다른 버전 폴더
    writeFileSync(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "vbq@duddudcns": [{ installPath: cur, lastUpdated: "2026-10-23" }], "other@x": [{ installPath: "nope" }] },
    }));
    assert.equal(resolvePluginRoot({ configDir: cfg }), cur);
  } finally { rmSync(cfg, { recursive: true, force: true }); }
});

test("launcher falls back to the highest cached version when the list is missing or stale", () => {
  const cfg = tmp();
  try {
    plugin(cfg, "a", "0.2.2");
    const hi = plugin(cfg, "b", "0.10.0");
    assert.equal(resolvePluginRoot({ configDir: cfg }), hi);
    writeFileSync(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "vbq@a": [{ installPath: join(cfg, "gone") }] },
    }));
    assert.equal(resolvePluginRoot({ configDir: cfg }), hi);
  } finally { rmSync(cfg, { recursive: true, force: true }); }
});

test("launcher reports nothing when vbq is not installed", () => {
  const cfg = tmp();
  try { assert.equal(resolvePluginRoot({ configDir: cfg }), null); }
  finally { rmSync(cfg, { recursive: true, force: true }); }
});

test("setup writes launcher and shims, is idempotent, and refuses a foreign vbq.cmd", () => {
  const home = tmp();
  try {
    runSetup({ home, updatePath: false });
    const st = launcherStatus(home);
    assert.equal(st.ok, true);
    assert.match(readFileSync(join(st.dir, "vbq.cmd"), "utf8"), /vbq-launch\.mjs/);
    const again = runSetup({ home, updatePath: false });
    assert.ok(again.every((l) => l.startsWith("=")), again.join("\n"));

    writeFileSync(join(st.dir, "vbq.cmd"), "@echo other tool\r\n");
    assert.throws(() => runSetup({ home, updatePath: false }), /--force/);
    runSetup({ home, updatePath: false, force: true });
    assert.match(readFileSync(join(st.dir, "vbq.cmd"), "utf8"), /vbq-launch\.mjs/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
