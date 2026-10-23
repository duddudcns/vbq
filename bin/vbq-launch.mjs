#!/usr/bin/env node
// 고정 경로 런처. `vbq setup` 이 이 파일을 ~/.local/bin 에 복사한다.
// 플러그인 경로에는 버전이 들어 있어(…\cache\<마켓>\vbq\<버전>) 업데이트마다 바뀌므로,
// 실행할 때마다 설치된 vbq 플러그인을 찾아 그 vbq.mjs 를 띄운다. 이 파일은 플러그인에 의존하지 않는다.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const LAUNCHER_VERSION = 1;

const parts = (v) => v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
function versionLess(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

// 설치된 vbq 플러그인 폴더(vbq.mjs 가 있는 곳)를 찾는다. 없으면 null.
// 1) installed_plugins.json 의 vbq@<마켓> installPath  2) cache/*/vbq/* 중 가장 높은 버전
export function resolvePluginRoot({
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  exists = existsSync,
  readText = (p) => readFileSync(p, "utf8"),
  listDir = (p) => readdirSync(p),
} = {}) {
  const plugins = join(configDir, "plugins");
  try {
    const data = JSON.parse(readText(join(plugins, "installed_plugins.json")));
    const hits = [];
    for (const [key, entries] of Object.entries(data.plugins || {})) {
      if (!/^vbq@/.test(key) || !Array.isArray(entries)) continue;
      for (const e of entries) {
        if (e && e.installPath && exists(join(e.installPath, "vbq.mjs"))) hits.push(e);
      }
    }
    hits.sort((a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")));
    if (hits.length) return hits[0].installPath;
  } catch {
    // 목록 파일이 없거나 깨졌으면 아래 캐시 폴더 탐색으로 넘어간다
  }

  let best = null;
  try {
    for (const market of listDir(join(plugins, "cache"))) {
      const base = join(plugins, "cache", market, "vbq");
      let vers;
      try { vers = listDir(base); } catch { continue; }
      for (const v of vers) {
        const dir = join(base, v);
        if (!exists(join(dir, "vbq.mjs"))) continue;
        if (!best || versionLess(best.v, v)) best = { v, dir };
      }
    }
  } catch {
    // 캐시 폴더가 없으면 설치된 플러그인이 없는 것 - 아래에서 null
  }
  return best ? best.dir : null;
}

function main() {
  const root = resolvePluginRoot();
  if (!root) {
    console.error("vbq: 설치된 vbq 플러그인을 찾지 못했습니다. 설치: claude plugin install vbq@duddudcns");
    process.exit(4);
  }
  const r = spawnSync(process.execPath, [join(root, "vbq.mjs"), ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.error) { console.error(`vbq: ${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
