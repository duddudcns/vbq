// `vbq setup` / `vbq doctor` 의 바탕. 플러그인 밖(PowerShell·Codex·일반 터미널)에서도 vbq 를 쓰도록
// 버전이 바뀌지 않는 폴더(~/.local/bin)에 런처를 두고, 그 폴더가 사용자 PATH 에 없으면 넣는다.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { findOnPath } from "./server-check.mjs";

const PLUGIN_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
export const LAUNCHER_SRC = join(PLUGIN_BIN, "vbq-launch.mjs");

export function launchDir(home = homedir()) {
  return join(home, ".local", "bin");
}

const SHIMS = {
  "vbq.cmd": '@echo off\r\nnode "%~dp0vbq-launch.mjs" %*\r\n',
  vbq: '#!/bin/sh\n# vbq 런처 셰임 (vbq setup 이 만듦)\nexec node "$(dirname "$0")/vbq-launch.mjs" "$@"\n',
};

// 런처 파일 안의 `LAUNCHER_VERSION = N` 을 읽는다. 없으면 null.
export function launcherVersionOf(text) {
  const m = /LAUNCHER_VERSION\s*=\s*(\d+)/.exec(text || "");
  return m ? parseInt(m[1], 10) : null;
}

const norm = (p, env) =>
  p.replace(/%([^%]+)%/g, (all, name) => env[name] ?? env[name.toUpperCase()] ?? all)
    .replace(/[\\/]+$/, "")
    .toLowerCase();

// PATH 문자열(; 구분)에 dir 이 들어 있나. 대소문자·끝 \ ·%VAR% 를 무시하고 비교한다.
export function pathHas(pathStr, dir, env = process.env) {
  const want = norm(dir, env);
  return (pathStr || "").split(";").some((e) => e.trim() && norm(e.trim(), env) === want);
}

export function pathAppend(pathStr, dir) {
  const s = (pathStr || "").replace(/;+$/, "");
  return s ? `${s};${dir}` : dir;
}

// ---- Windows 레지스트리의 PATH (새로 여는 셸이 받는 값) ----

function ps(script, env = {}) {
  const r = spawnSync("powershell.exe", ["-NoLogo", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...process.env, ...env },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || "").trim() || `powershell exit ${r.status}`);
  return r.stdout;
}

// { user, userKind, machine } - user 는 %VAR% 를 펼치지 않은 원문
export function readRegistryPath() {
  const out = ps([
    "$o=[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
    "$u=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
    "$uv=$u.GetValue('Path','',$o); $uk=if($u.GetValueNames() -contains 'Path'){[string]$u.GetValueKind('Path')}else{'ExpandString'}",
    "$m=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')",
    "$mv=[Environment]::ExpandEnvironmentVariables($m.GetValue('Path','',$o))",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "@{user=$uv;userKind=$uk;machine=$mv} | ConvertTo-Json -Compress",
  ].join("; "));
  return JSON.parse(out.trim());
}

// 사용자 PATH 를 값 종류(REG_SZ/REG_EXPAND_SZ)를 그대로 두고 쓴 뒤, 열려 있는 탐색기 등에 변경을 알린다.
function writeUserPath(value, kind) {
  ps([
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
    "$k.SetValue('Path',$env:VBQ_NEW_PATH,[Microsoft.Win32.RegistryValueKind]::$env:VBQ_PATH_KIND)",
    "$k.Close()",
    "Add-Type -Namespace VbqSetup -Name Native -MemberDefinition '[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h,uint m,System.UIntPtr w,string l,uint f,uint t,out System.UIntPtr r);'",
    "$r=[UIntPtr]::Zero; [void][VbqSetup.Native]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)",
  ].join("; "), { VBQ_NEW_PATH: value, VBQ_PATH_KIND: kind === "String" ? "String" : "ExpandString" });
}

// ---- 상태 ----

export function launcherStatus(home = homedir()) {
  const dir = launchDir(home);
  const file = join(dir, "vbq-launch.mjs");
  const have = existsSync(file) ? launcherVersionOf(readFileSync(file, "utf8")) : null;
  const want = launcherVersionOf(readFileSync(LAUNCHER_SRC, "utf8"));
  const shims = Object.keys(SHIMS).filter((n) => !existsSync(join(dir, n)));
  return { dir, file, have, want, missingShims: shims, ok: have !== null && have >= want && !shims.length };
}

// ---- setup ----

// 반환: 사람이 읽을 결과 줄 목록. 쓰기 실패는 throw.
export function runSetup({ home = homedir(), force = false, updatePath = true } = {}) {
  const out = [];
  const dir = launchDir(home);
  mkdirSync(dir, { recursive: true });

  for (const [name, body] of Object.entries(SHIMS)) {
    const p = join(dir, name);
    const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (cur === body) { out.push(`= ${p} (그대로)`); continue; }
    if (cur !== null && !cur.includes("vbq-launch.mjs") && !force) {
      throw new Error(`${p} 이(가) 이미 있고 vbq 런처가 아닙니다. 확인 뒤 덮어쓰려면 vbq setup --force`);
    }
    writeFileSync(p, body);
    out.push(`+ ${p}`);
  }
  const launcher = readFileSync(LAUNCHER_SRC, "utf8");
  const dest = join(dir, "vbq-launch.mjs");
  if (existsSync(dest) && readFileSync(dest, "utf8") === launcher) out.push(`= ${dest} (그대로)`);
  else { writeFileSync(dest, launcher); out.push(`+ ${dest}`); }

  if (!updatePath) return out;
  if (process.platform !== "win32") {
    out.push(`! PATH 는 직접 확인하세요: ${dir} 가 셸 PATH 에 있어야 합니다.`);
    return out;
  }
  const reg = readRegistryPath();
  if (pathHas(reg.user, dir) || pathHas(reg.machine, dir)) {
    out.push(`= PATH 에 이미 있음: ${dir}`);
  } else {
    writeUserPath(pathAppend(reg.user, dir), reg.userKind);
    out.push(`+ 사용자 PATH 에 추가: ${dir} (이미 열린 터미널·Codex 는 다시 열어야 반영)`);
  }
  return out;
}

// 새로 여는 셸에서 `vbq` 가 무엇으로 잡히는지(레지스트리 PATH 기준). Windows 가 아니면 null.
export function freshShellVbq() {
  if (process.platform !== "win32") return null;
  const reg = readRegistryPath();
  const userExpanded = (reg.user || "").replace(/%([^%]+)%/g, (all, n) => process.env[n] ?? all);
  // Windows 는 시스템 PATH 를 사용자 PATH 앞에 붙인다
  return { found: findOnPath(["vbq.cmd", "vbq.exe", "vbq.bat"], `${reg.machine};${userExpanded}`), reg };
}
