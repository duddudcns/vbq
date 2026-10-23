import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("PATH membership ignores case, trailing slash, quotes and %VAR%", () => {
  const env = { USERPROFILE: "C:\\Users\\me" };
  const dir = "C:\\Users\\me\\.local\\bin";
  assert.equal(pathHas("C:\\a;c:\\users\\ME\\.local\\bin\\;D:\\b", dir, { env }), true);
  assert.equal(pathHas("%USERPROFILE%\\.local\\bin", dir, { env }), true);
  assert.equal(pathHas('C:\\a;"C:\\Users\\me\\.local\\bin"', dir, { env }), true);
  assert.equal(pathHas("C:\\Users\\me\\.local\\binx", dir, { env }), false);
  assert.equal(pathHas("", "C:\\x", { env }), false);
});

test("a %VAR% entry in a REG_SZ PATH does not count (Windows does not expand it)", () => {
  const env = { USERPROFILE: "C:\\Users\\me" };
  assert.equal(pathHas("%USERPROFILE%\\.local\\bin", "C:\\Users\\me\\.local\\bin", { env, expand: false }), false);
});

test("launcher started through a junction still runs and passes the exit code", { skip: process.platform !== "win32" }, () => {
  const base = tmp();
  try {
    const cfg = join(base, "cfg");
    const dir = plugin(cfg, "m", "1.0.0");
    writeFileSync(join(dir, "vbq.mjs"), 'console.log("ran", process.argv.slice(2).join(" ")); process.exit(7);\n');
    const real = join(base, "real");
    mkdirSync(real);
    copyFileSync(new URL("../bin/vbq-launch.mjs", import.meta.url), join(real, "vbq-launch.mjs"));
    writeFileSync(join(real, "vbq-launch.json"), JSON.stringify({ configDir: cfg }));
    const junc = join(base, "junc");
    symlinkSync(real, junc, "junction");
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [join(junc, "vbq-launch.mjs"), "status", "--json"], { encoding: "utf8", env });
    assert.equal(r.stdout.trim(), "ran status --json");
    assert.equal(r.status, 7);
  } finally { rmSync(base, { recursive: true, force: true }); }
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
    writeFileSync(join(st.dir, "vbq"), "#!/bin/sh\necho other\n");
    rmSync(join(st.dir, "vbq-launch.mjs"));
    assert.throws(() => runSetup({ home, updatePath: false }), /--force/);
    // 검사에서 막히면 아무것도 쓰지 않는다
    assert.equal(launcherStatus(home).have, null);
    runSetup({ home, updatePath: false, force: true });

    // 설정 폴더 저장값은 CLAUDE_CONFIG_DIR 없이 다시 setup 해도 남는다
    writeFileSync(join(st.dir, "vbq-launch.json"), JSON.stringify({ configDir: "D:\\moved\\claude" }, null, 2) + "\n");
    const saved = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try { runSetup({ home, updatePath: false }); }
    finally { if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved; }
    assert.equal(JSON.parse(readFileSync(join(st.dir, "vbq-launch.json"), "utf8")).configDir, "D:\\moved\\claude");
    assert.match(readFileSync(join(st.dir, "vbq.cmd"), "utf8"), /vbq-launch\.mjs/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
