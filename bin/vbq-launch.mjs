#!/usr/bin/env node
// 고정 경로 런처. `vbq setup` 이 이 파일을 ~/.local/bin 에 복사한다.
// 플러그인 경로에는 버전이 들어 있어(…\cache\<마켓>\vbq\<버전>) 업데이트마다 바뀌므로,
// 실행할 때마다 설치된 vbq 플러그인을 찾아 그 vbq.mjs 를 띄운다. 이 파일은 플러그인에 의존하지 않는다.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const LAUNCHER_VERSION = 2;

const parts = (v) => v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
function versionLess(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

// Claude 설정 폴더: 환경변수 > setup 이 런처 옆에 적어 둔 값 > ~/.claude
// (CLAUDE_CONFIG_DIR 은 Claude Code 안에서만 잡혀 있어서, 밖에서 쓰도록 setup 때 저장해 둔다)
export function defaultConfigDir(here = dirname(fileURLToPath(import.meta.url))) {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  try {
    const saved = JSON.parse(readFileSync(join(here, "vbq-launch.json"), "utf8")).configDir;
    if (saved) return saved;
  } catch {
    // 저장된 값이 없으면 기본 위치
  }
  return join(homedir(), ".claude");
}

// 설치된 vbq 플러그인 폴더(vbq.mjs 가 있는 곳)를 찾는다. 없으면 null.
// 1) installed_plugins.json 의 vbq@<마켓> installPath (user 범위 우선)  2) cache/*/vbq/* 중 가장 높은 버전
export function resolvePluginRoot({
  configDir = defaultConfigDir(),
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
    // 다른 프로젝트의 project/local 범위 설치보다 user 범위를 먼저, 그 안에서는 최근 것
    const rank = (e) => (e.scope === "user" ? 0 : 1);
    hits.sort((a, b) => rank(a) - rank(b) || String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")));
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
  const configDir = defaultConfigDir();
  const root = resolvePluginRoot({ configDir });
  if (!root) {
    console.error(`vbq: 설치된 vbq 플러그인을 찾지 못했습니다(설정 폴더 ${configDir}). 설치: claude plugin install vbq@duddudcns`);
    process.exit(4);
  }
  // 찾은 설정 폴더를 넘겨, 그 아래에서 vbq setup 을 다시 해도 저장된 위치가 ~/.claude 로 바뀌지 않게 한다
  const r = spawnSync(process.execPath, [join(root, "vbq.mjs"), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  if (r.error) { console.error(`vbq: ${r.error.message}`); process.exit(1); }
  process.exit(r.status ?? 1);
}

// 직접 실행됐을 때만 main. Node 는 메인 모듈 경로를 실제 경로로 바꾸므로(junction·symlink 를 거친 경우)
// 양쪽을 realpath 로 맞춰 비교한다 - 안 그러면 아무것도 안 하고 exit 0 으로 끝난다.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
}
if (isMain()) main();
