// vbnet-ls(언어 서버) 설치 확인. 프로세스를 띄우지 않고 PATH 와 dotnet 도구 저장소만 본다(세션 시작 훅에서도 빠르게).
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

export const MIN_VERSION = "0.1.10"; // 0.1.9 이하는 질의한 .vb 를 이중 BOM 으로 다시 쓴다
export const INSTALL_CMD = "dotnet tool install -g DNAKode.VbNet.Lsp";
export const UPDATE_CMD = "dotnet tool update -g DNAKode.VbNet.Lsp";

const EXE_NAMES = process.platform === "win32" ? ["vbnet-ls.exe", "vbnet-ls.cmd", "vbnet-ls"] : ["vbnet-ls"];

export function findOnPath(names, pathVar = process.env.PATH || process.env.Path || "") {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const parts = (v) => v.split(".").map((x) => parseInt(x, 10) || 0);
export function versionLess(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

// dotnet 전역 도구 저장소의 설치 버전(여럿이면 가장 높은 것). 모르면 null.
export function installedVersion(home = homedir()) {
  const store = join(home, ".dotnet", "tools", ".store", "dnakode.vbnet.lsp");
  let vs;
  try { vs = readdirSync(store).filter((d) => /^\d+(\.\d+)*$/.test(d)); } catch { return null; }
  if (!vs.length) return null;
  return vs.sort((a, b) => (versionLess(a, b) ? -1 : 1)).pop();
}

// { ok, path, version, problem } - problem: "missing" | "old" | null
export function checkServer(env = process.env, home = homedir()) {
  const path = findOnPath(EXE_NAMES, env.PATH || env.Path || "");
  if (!path) return { ok: false, path: null, version: null, problem: "missing" };
  const version = installedVersion(home);
  if (version && versionLess(version, MIN_VERSION)) return { ok: false, path, version, problem: "old" };
  return { ok: true, path, version, problem: null };
}

export function problemMessage(r) {
  if (r.problem === "missing") {
    return `vbnet-ls(VB.NET 언어 서버)가 PATH 에 없습니다. 설치: ${INSTALL_CMD} (.NET SDK 필요, 설치 뒤 새 셸에서 PATH 에 ~/.dotnet/tools 가 잡혀야 함)`;
  }
  if (r.problem === "old") {
    return `vbnet-ls ${r.version} 은 ${MIN_VERSION} 미만입니다(질의한 .vb 를 이중 BOM 으로 다시 쓰는 버그). 업데이트: ${UPDATE_CMD}`;
  }
  return "";
}
