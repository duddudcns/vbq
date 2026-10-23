#!/usr/bin/env node
// vbq — CLI for VB.NET LSP queries via per-root daemon.
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rootHash, pipeName, readState, readyFile, listStates,
  isPidAlive, removeState, touchActivity, logFile, STATE_DIR
} from "./lib/registry.mjs";
import { checkServer, problemMessage, INSTALL_CMD, UPDATE_CMD } from "./lib/server-check.mjs";
import { runSetup, launcherStatus, freshShellVbq, launchDir } from "./lib/setup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = join(__dirname, "daemon.mjs");
const MAX_DAEMONS = 3;
const READY_WAIT_MS = 180 * 1000;

function usage(code = 0) {
  const lines = [
    "vbq — VB.NET LSP CLI (per-root daemon)",
    "",
    "Usage:",
    "  vbq sym <query>           [--root <dir> | --sln <file>] [--limit N] [--json]",
    "  vbq refs <symbol>         [--root <dir> | --sln <file>] [--json]",
    "  vbq refs-at <file> <L> <C>[--root <dir> | --sln <file>] [--json]",
    "  vbq def <symbol>          [--root <dir> | --sln <file>] [--json]",
    "  vbq doc-sym <file>        [--root <dir> | --sln <file>] [--json]",
    "  vbq hover <file> <L> <C>  [--root <dir> | --sln <file>] [--json]",
    "  vbq status                [--json]",
    "  vbq kill <root|hash|all>",
    "  vbq logs <root|hash>      [--tail N]",
    "  vbq setup                 [--force]   PowerShell·Codex·터미널용 고정 런처 설치(~/.local/bin) + PATH",
    "  vbq doctor                            설치·런처·PATH·데몬 점검, 문제마다 고칠 명령 안내",
    "",
    "  --root <dir>   solution folder. Must contain exactly one .sln (verified up-front).",
    "                 Default: VBQ_ROOT env, then auto-detect .sln upward from cwd.",
    "  --sln  <file>  .sln file path. Internally uses dirname(sln) as root.",
    "                 Convenience for skipping folder math when the .sln path is known.",
    "  Positions (L=line, C=col) are 0-based.",
  ];
  console.log(lines.join("\n"));
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--root") flags.root = argv[++i];
    else if (a === "--sln") flags.sln = argv[++i];
    else if (a === "--limit") flags.limit = parseInt(argv[++i], 10);
    else if (a === "--tail") flags.tail = parseInt(argv[++i], 10);
    else if (a === "--force") flags.force = true;
    else pos.push(a);
  }
  return { flags, pos };
}

function findSlnInDir(dir) {
  try {
    return readdirSync(dir).filter((e) => e.toLowerCase().endsWith(".sln"));
  } catch {
    return [];
  }
}

function findSlnUpward(start) {
  let dir = resolvePath(start);
  for (;;) {
    try {
      const entries = readdirSync(dir);
      if (entries.some((e) => e.toLowerCase().endsWith(".sln"))) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveRoot(flagRoot, flagSln) {
  let root;
  if (flagSln) {
    const sln = resolvePath(flagSln);
    if (!existsSync(sln)) die(`--sln file does not exist: ${sln}`);
    if (!statSync(sln).isFile()) die(`--sln is not a file: ${sln}`);
    if (!sln.toLowerCase().endsWith(".sln")) die(`--sln must point to a .sln file: ${sln}`);
    root = dirname(sln);
  } else {
    root = flagRoot || process.env.VBQ_ROOT || findSlnUpward(process.cwd());
    if (!root) die("no --root/--sln given, VBQ_ROOT unset, and no .sln found upward from cwd");
    root = resolvePath(root);
    if (!existsSync(root)) die(`root does not exist: ${root}`);
    if (!statSync(root).isDirectory()) die(`root is not a directory: ${root}`);
  }
  // Up-front .sln verification — fail fast instead of waiting 180s for daemon timeout.
  const slns = findSlnInDir(root);
  if (slns.length === 0) {
    die(`no .sln file in root: ${root}\n  root must be the folder containing the .sln, or pass --sln <file>`);
  }
  if (slns.length > 1) {
    console.error(`vbq: warning — ${slns.length} .sln files in ${root} (${slns.join(", ")}); vbnet-ls selects one non-deterministically. Use --sln <file> if this matters.`);
  }
  return root;
}

function die(msg, code = 2) {
  console.error(`vbq: ${msg}`);
  process.exit(code);
}

// ---- daemon lifecycle ----

function ensureDaemon(root) {
  const hash = rootHash(root);
  const st = readState(hash);
  if (st && isPidAlive(st.pid)) return { hash, pipe: pipeName(hash), spawned: false };

  // Stale; clean
  if (st) removeState(hash);

  // 언어 서버가 없으면 데몬이 조용히 죽고 준비 대기 180초를 다 쓴다 - 띄우기 전에 바로 알린다
  const server = checkServer();
  if (server.problem === "missing") {
    console.error(`vbq: ${problemMessage(server)}`);
    process.exit(3);
  }
  if (server.problem === "old") console.error(`vbq: 경고 - ${problemMessage(server)}`);

  // LRU evict if max reached
  evictIfNeeded();

  // Spawn detached
  const node = process.execPath;
  const proc = spawn(node, [DAEMON_SCRIPT, root], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  proc.unref();
  return { hash, pipe: pipeName(hash), spawned: true, pid: proc.pid };
}

function evictIfNeeded() {
  const states = listStates().filter((s) => s.alive);
  if (states.length < MAX_DAEMONS) return;
  // Kill the oldest by lastActivity
  states.sort((a, b) => new Date(a.lastActivity) - new Date(b.lastActivity));
  const victim = states[0];
  console.error(`vbq: evicting LRU daemon (root=${victim.root}, pid=${victim.pid})`);
  killDaemon(victim);
}

async function killDaemon(state) {
  try {
    await sendOnce(state.pipe, { op: "shutdown" }, 2000);
  } catch {
    try { process.kill(state.pid); } catch {}
  }
  removeState(state.hash);
}

// ---- pipe IO ----

function sendOnce(pipe, req, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const sock = connect(pipe);
    let buf = "";
    const t = setTimeout(() => { sock.destroy(); reject(new Error("pipe timeout")); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(t);
        const line = buf.slice(0, nl);
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
        sock.end();
      }
    });
    sock.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function waitPipeReady(pipe, hash, timeoutMs = READY_WAIT_MS) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await sendOnce(pipe, { op: "ping" }, 3000);
      if (r?.result?.ready) return true;
    } catch (e) { lastErr = e; }
    await sleep(500);
  }
  throw new Error(`daemon not ready within ${timeoutMs}ms (last: ${lastErr?.message || "n/a"})`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- commands ----

async function callDaemon(root, req, timeoutMs = 120000) {
  const { hash, pipe, spawned } = ensureDaemon(root);
  if (spawned) {
    // Wait for daemon pipe up + ready
    await waitPipeReady(pipe, hash, READY_WAIT_MS);
  }
  const r = await sendOnce(pipe, req, timeoutMs);
  touchActivity(hash);
  if (!r.ok) throw new Error(r.error || "daemon error");
  return r.result;
}

async function cmdSym({ pos, flags }) {
  if (pos.length < 1) usage(2);
  const query = pos[0];
  const root = resolveRoot(flags.root, flags.sln);
  const res = (await callDaemon(root, { op: "sym", query })) || [];
  const out = flags.limit ? res.slice(0, flags.limit) : res;
  if (flags.json) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const s of out) {
    const loc = s.location || {};
    const uri = loc.uri || "";
    const start = loc.range?.start || {};
    console.log(`${s.name}\t${s.containerName || ""}\t${uriToPath(uri)}:${(start.line ?? 0)+1}:${(start.character ?? 0)+1}\t${kindName(s.kind)}`);
  }
  if (!out.length) console.error("(no matches)");
}

async function cmdRefs({ pos, flags }) {
  if (pos.length < 1) usage(2);
  const symbol = pos[0];
  const root = resolveRoot(flags.root, flags.sln);
  // Find symbol first
  const matches = (await callDaemon(root, { op: "sym", query: symbol })) || [];
  const exact = matches.filter(m => m.name === symbol);
  const pick = exact.length ? exact : matches;
  if (!pick.length) { console.error(`vbq: no symbol matches '${symbol}'`); process.exit(1); }
  if (pick.length > 1 && !flags.json) {
    console.error(`vbq: ${pick.length} candidates for '${symbol}' - references are grouped per candidate below (# name [defined …]). Use refs-at to pin one.`);
  }
  const all = [];
  for (const m of pick) {
    const loc = m.location;
    const file = uriToPath(loc.uri);
    const { line, character } = loc.range.start;
    const refs = (await callDaemon(root, { op: "refs", file, line, col: character, includeDeclaration: true })) || [];
    all.push({ from: { name: m.name, container: m.containerName, file, line: line+1, col: character+1 }, refs });
  }
  if (flags.json) { console.log(JSON.stringify(all, null, 2)); return; }
  for (const g of all) {
    console.log(`# ${g.from.name}  [defined ${g.from.file}:${g.from.line}:${g.from.col}]`);
    for (const r of g.refs) {
      const s = r.range.start;
      console.log(`  ${uriToPath(r.uri)}:${s.line+1}:${s.character+1}`);
    }
    console.log(`  (${g.refs.length} reference${g.refs.length === 1 ? "" : "s"})`);
  }
}

async function cmdRefsAt({ pos, flags }) {
  if (pos.length < 3) usage(2);
  const [file, lineStr, colStr] = pos;
  const root = resolveRoot(flags.root, flags.sln);
  const refs = (await callDaemon(root, {
    op: "refs",
    file: resolvePath(file),
    line: parseInt(lineStr, 10),
    col: parseInt(colStr, 10),
    includeDeclaration: true,
  })) || [];
  if (flags.json) { console.log(JSON.stringify(refs, null, 2)); return; }
  for (const r of refs) {
    const s = r.range.start;
    console.log(`${uriToPath(r.uri)}:${s.line+1}:${s.character+1}`);
  }
  console.error(`(${refs.length} reference${refs.length === 1 ? "" : "s"})`);
}

async function cmdDef({ pos, flags }) {
  if (pos.length < 1) usage(2);
  const symbol = pos[0];
  const root = resolveRoot(flags.root, flags.sln);
  const matches = (await callDaemon(root, { op: "sym", query: symbol })) || [];
  if (flags.json) { console.log(JSON.stringify(matches, null, 2)); return; }
  if (!matches.length) { console.error(`(no matches)`); return; }
  for (const m of matches) {
    const s = m.location.range.start;
    console.log(`${m.name}\t${m.containerName || ""}\t${uriToPath(m.location.uri)}:${s.line+1}:${s.character+1}\t${kindName(m.kind)}`);
  }
}

async function cmdDocSym({ pos, flags }) {
  if (pos.length < 1) usage(2);
  const root = resolveRoot(flags.root, flags.sln);
  const file = resolvePath(pos[0]);
  const syms = (await callDaemon(root, { op: "doc-sym", file })) || [];
  if (flags.json) { console.log(JSON.stringify(syms, null, 2)); return; }
  printDocSyms(syms, 0);
}

function printDocSyms(syms, depth) {
  for (const s of syms) {
    const r = s.range?.start || s.location?.range?.start || {};
    console.log(`${"  ".repeat(depth)}${s.name}\t${kindName(s.kind)}\t${(r.line ?? 0)+1}:${(r.character ?? 0)+1}`);
    if (s.children?.length) printDocSyms(s.children, depth + 1);
  }
}

async function cmdHover({ pos, flags }) {
  if (pos.length < 3) usage(2);
  const root = resolveRoot(flags.root, flags.sln);
  const [file, lineStr, colStr] = pos;
  const h = await callDaemon(root, {
    op: "hover",
    file: resolvePath(file),
    line: parseInt(lineStr, 10),
    col: parseInt(colStr, 10),
  });
  if (flags.json) { console.log(JSON.stringify(h, null, 2)); return; }
  const contents = h?.contents;
  if (!contents) { console.error("(no hover)"); return; }
  if (typeof contents === "string") console.log(contents);
  else if (Array.isArray(contents)) for (const c of contents) console.log(typeof c === "string" ? c : c.value);
  else if (contents.value) console.log(contents.value);
}

function cmdStatus({ flags }) {
  const states = listStates();
  if (flags.json) { console.log(JSON.stringify(states, null, 2)); return; }
  if (!states.length) { console.log("(no daemons)"); return; }
  for (const s of states) {
    const idleMs = Date.now() - new Date(s.lastActivity).getTime();
    const idleMin = (idleMs / 60000).toFixed(1);
    console.log(`${s.alive ? "✓" : "✗"} pid=${s.pid}  idle=${idleMin}min  ready=${s.ready}  root=${s.root}`);
  }
}

async function cmdKill({ pos }) {
  if (pos.length < 1) usage(2);
  const target = pos[0];
  const states = listStates();
  const victims = target === "all"
    ? states
    : states.filter(s => s.hash === target || resolvePath(s.root).toLowerCase() === resolvePath(target).toLowerCase());
  if (!victims.length) { console.error(`(no daemon for '${target}')`); return; }
  for (const v of victims) {
    console.log(`killing pid=${v.pid} root=${v.root}`);
    await killDaemon(v);
  }
}

function cmdLogs({ pos, flags }) {
  if (pos.length < 1) usage(2);
  const target = pos[0];
  const states = listStates();
  const match = states.find(s => s.hash === target || resolvePath(s.root).toLowerCase() === resolvePath(target).toLowerCase());
  const hash = match ? match.hash : rootHash(resolvePath(target));
  const f = logFile(hash);
  if (!existsSync(f)) { console.error(`(no log at ${f})`); return; }
  const text = readFileSync(f, "utf8");
  const lines = text.split(/\r?\n/);
  const tail = flags.tail || 100;
  console.log(lines.slice(-tail).join("\n"));
  console.error(`# log: ${f}`);
}

function cmdSetup({ flags }) {
  for (const line of runSetup({ force: !!flags.force })) console.log(line);
  console.log("확인: vbq doctor");
}

function cmdDoctor() {
  let bad = 0;
  const ok = (msg) => console.log(`✓ ${msg}`);
  const fail = (msg, fix) => { bad++; console.log(`✗ ${msg}`); if (fix) console.log(`    → ${fix}`); };

  const major = parseInt(process.versions.node, 10);
  if (major >= 18) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} (18 이상 필요)`, "Node.js 22 LTS 설치");

  const sdk = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  const sdks = (sdk.stdout || "").split(/\r?\n/).map((l) => l.split(" ")[0]).filter(Boolean);
  if (sdks.some((v) => parseInt(v, 10) >= 10)) ok(`.NET SDK ${sdks.filter((v) => parseInt(v, 10) >= 10).join(", ")}`);
  else fail(".NET 10 SDK 없음 (vbnet-ls 실행에 필요)", "https://dotnet.microsoft.com/download/dotnet/10.0 에서 SDK x64 설치");

  const server = checkServer();
  if (server.ok) ok(`vbnet-ls ${server.version || "(버전 모름)"}  ${server.path}`);
  else fail(problemMessage(server), server.problem === "old" ? UPDATE_CMD : INSTALL_CMD);

  const ls = launcherStatus();
  if (ls.ok) ok(`고정 런처 v${ls.have}  ${ls.dir}`);
  else if (ls.have === null) fail(`고정 런처 없음 (${ls.dir}) - Claude 밖(PowerShell·Codex·터미널)에서 vbq 를 못 씀`, "vbq setup");
  else fail(`고정 런처가 오래됨 또는 셰임 누락 (v${ls.have}, 필요 v${ls.want}${ls.missingShims.length ? `, 없음: ${ls.missingShims.join(", ")}` : ""})`, "vbq setup");

  try {
    const fresh = freshShellVbq();
    if (fresh) {
      const want = launchDir().toLowerCase();
      const got = fresh.found;
      if (got && dirname(got).toLowerCase() === want) ok(`새 셸의 vbq → ${got}`);
      else if (got) fail(`새 셸의 vbq 가 런처가 아닌 ${got} 로 잡힘 (버전 폴더면 업데이트 때 끊김)`, `PATH 에서 ${dirname(got)} 를 빼고 vbq setup`);
      else fail("새 셸에서 vbq 를 찾지 못함", "vbq setup (뒤에 터미널·Codex 다시 열기)");
    }
  } catch (e) {
    fail(`PATH 를 읽지 못함: ${e.message}`);
  }

  const states = listStates();
  const alive = states.filter((s) => s.alive);
  ok(`데몬 ${alive.length}개 실행 중 (최대 ${MAX_DAEMONS}, 30분 쉬면 자동 종료)${states.length > alive.length ? ` - 죽은 상태 파일 ${states.length - alive.length}개: vbq kill all 로 정리 가능` : ""}`);

  console.log(bad ? `\n문제 ${bad}개. 위 → 명령을 실행한 뒤 vbq doctor 로 다시 확인하세요.` : "\n모두 정상.");
  process.exit(bad ? 1 : 0);
}

function uriToPath(uri) {
  if (!uri) return "";
  try { return fileURLToPath(uri); } catch { return uri; }
}

function kindName(k) {
  const kinds = ["", "File","Module","Namespace","Package","Class","Method","Property","Field","Constructor","Enum","Interface","Function","Variable","Constant","String","Number","Boolean","Array","Object","Key","Null","EnumMember","Struct","Event","Operator","TypeParameter"];
  return kinds[k] || `kind${k}`;
}

// ---- main ----

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "-h" || argv[0] === "--help") usage(0);
const cmd = argv[0];
const { flags, pos } = parseArgs(argv.slice(1));

const handlers = {
  sym: cmdSym, refs: cmdRefs, "refs-at": cmdRefsAt, def: cmdDef,
  "doc-sym": cmdDocSym, hover: cmdHover, status: (a) => cmdStatus(a),
  kill: cmdKill, logs: cmdLogs, setup: cmdSetup, doctor: cmdDoctor,
};

const h = handlers[cmd];
if (!h) { console.error(`vbq: unknown command '${cmd}'`); usage(2); }

Promise.resolve(h({ pos, flags })).then(
  () => process.exit(0),
  (e) => { console.error(`vbq: ${e?.message || e}`); process.exit(1); }
);
