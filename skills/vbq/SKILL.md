---
name: vbq
description: VB.NET semantic code queries (references, definitions, symbols, hover, document outline) across a full .sln. Use INSTEAD OF grep/Read whenever the target is a .vb file or a .vbproj in a Roslyn-loadable solution. First call per solution takes ~10–30s (MSBuild load); subsequent calls <1s. Per-root persistent daemon, 30min idle auto-shutdown, max 3 concurrent solutions (LRU). Also use it when the user asks how to install, update, run or troubleshoot vbq itself (vbq setup / vbq doctor, PATH for PowerShell·Codex, daemon management).
---

# vbq — VB.NET LSP CLI

## What it is

A CLI wrapper around `vbnet-ls` (DNAKode VB.NET language server, Roslyn-based) with a per-solution-root daemon model. Lets Claude run real LSP queries (`workspace/symbol`, `textDocument/references`, etc.) against any VB.NET solution without owning a Claude Code plugin lifecycle.

## Execution environment (IMPORTANT — read before running)

- **Language server missing**: `vbq` exits with code 3 and prints the install command (`dotnet tool install -g DNAKode.VbNet.Lsp`) instead of waiting for the daemon timeout. A SessionStart hook also reports a missing or pre-0.1.10 `vbnet-ls`. Offer the command to the user and run it only after they approve; then `vbq status`.
- **Bash tool**: works as plain `vbq` — Claude Code puts this plugin's `bin/` (with the `vbq` sh shim) on the Bash tool PATH (verified 2026-10-12).
- **PowerShell tool, Codex, plain terminals**: these do not get the plugin `bin/` on PATH. `vbq setup` (run once via the Bash tool, after the user agrees) installs a fixed-path launcher in `~/.local/bin` and adds that folder to the user PATH if it is missing. The launcher finds the installed plugin on every call, so plugin updates never break it. Do **not** put the versioned plugin folder (`…\plugins\cache\…\vbq\<version>\bin`) on PATH — it disappears on the next update. Terminals and Codex opened before `setup` must be reopened.
- Sanity check with `vbq doctor` (checks everything and prints the fix command for each problem) or `vbq status` before a batch of queries. The first query to a *new* solution still pays the 10–30s Roslyn load regardless of shell.
- **`vbq logs … --tail N` trips the main-agent code-gate** (`block-main-code-reads.js` reads `--tail` + a project path as a "code-output command" — false positive). Don't fight it: run `logs` from a **subagent** (codebase-explorer/error-investigator have Bash), calling vbq by full path. `status`/`kill`/`sym`/`refs`/… have no output-token and run fine from the main agent. See Gotchas #5.

## 운영 가이드 (설치·업데이트·데몬 관리)

사용자가 vbq 설치·업데이트·문제를 물으면 이 표대로 안내한다. PC 에 무언가를 설치하거나 PATH 를 바꾸는 명령은 사용자 승인 뒤에 실행한다.

| 상황 | 할 일 |
|---|---|
| 새 PC / 처음 설치 | 1) `dotnet tool install -g DNAKode.VbNet.Lsp` (.NET 10 SDK 필요) 2) `claude plugin install vbq@duddudcns` 3) `vbq setup` 4) `vbq doctor` 가 "모두 정상" |
| 뭔가 안 될 때 첫 단계 | `vbq doctor` — ✗ 줄마다 고칠 명령(→)을 알려 준다. 고친 뒤 다시 `vbq doctor` |
| vbq 플러그인 업데이트 뒤 | 할 일 없음. 런처가 새 버전을 스스로 찾는다. `doctor` 가 "런처가 오래됨"이라 하면 `vbq setup` 한 번 |
| vbnet-ls 업데이트 | `dotnet tool update -g DNAKode.VbNet.Lsp` → `vbq kill all` (떠 있던 데몬은 옛 서버를 쥐고 있음). 다음 질의는 10–30초 걸려 새로 뜬다 |
| PowerShell·Codex·터미널에서 `vbq` 를 못 찾음 | `vbq setup` 후 그 창을 다시 연다. `doctor` 의 "새 셸의 vbq →" 줄이 `~/.local/bin\vbq.cmd` 여야 한다 |
| 질의가 `pipe timeout` / 응답 없음 | `vbq kill <root>` 후 다시 질의(자동 재기동). 반복되면 서브에이전트로 `vbq logs <root> --tail 200` |
| 솔루션 구성을 바꿨는데(프로젝트 추가 등) 결과가 옛것 | `vbq kill <root>` — 데몬은 뜰 때 한 번 솔루션을 읽는다 |
| 메모리가 아까움 | 그냥 둔다. 30분 쉬면 스스로 끝나고, 4번째 솔루션을 열면 가장 오래 쉰 것을 내린다(최대 3개, 각 약 250MB) |
| 제거 | `claude plugin uninstall vbq@duddudcns`, `~/.local/bin` 의 `vbq.cmd`·`vbq`·`vbq-launch.mjs`·`vbq-launch.json` 삭제, 필요하면 `dotnet tool uninstall -g DNAKode.VbNet.Lsp`. `~/.local/bin` PATH 항목은 다른 도구도 쓰는 폴더라 그대로 둔다 |
| Claude 설정 폴더를 옮긴 PC(`CLAUDE_CONFIG_DIR`) | 그 환경을 잡은 상태에서 `vbq setup` — 설정 폴더 위치를 `~/.local/bin\vbq-launch.json` 에 적어 두어 Claude 밖에서도 찾는다 |

- `vbq kill` 은 위 경우에만 쓴다. 습관적으로 죽이면 다음 질의마다 10–30초 콜드 로드를 다시 한다.
- 다른 `vbq.cmd` 가 PATH 앞쪽에 있으면(예: 예전에 복사해 둔 `%USERPROFILE%\vbq\bin`) `doctor` 가 알려 준다. 그 항목을 PATH 에서 빼야 런처가 쓰인다.

## When to invoke this skill

**Auto-prefer vbq over `Read` / `Grep`** when:

- The target is a `.vb`, `.vbproj`, `.vb~`, or anything inside a folder reachable upward to a `.sln`.
- The intent is **semantic** — finding a symbol, its definition, its references, its type, or a file's structural outline.

**Skip vbq and use grep/Read** when:

- The query is a literal text/string match (e.g., "find the string 'ErrorCode'").
- The target file is not VB.NET (C#, TypeScript, JSON, XML, markdown).
- The repo has no `.sln` and no `VBQ_ROOT` is set.

## Commands

```
vbq sym <query>            # workspace/symbol — fuzzy name search
vbq def <symbol>           # show all definition locations matching a name
vbq refs <symbol>          # find all references to a symbol (auto sym → refs)
vbq refs-at <file> <L> <C> # references at a specific 0-based position
vbq doc-sym <file>         # documentSymbol tree for one file
vbq hover <file> <L> <C>   # hover info (type, signature)
vbq status                 # list live daemons (pid, root, idle time, ready)
vbq doctor                 # check Node/.NET SDK/vbnet-ls/launcher/PATH/daemons, print fixes
vbq setup [--force]        # install the fixed-path launcher in ~/.local/bin (+ user PATH)
vbq kill <root|hash|all>   # stop daemon(s)
vbq logs <root> --tail 100 # daemon stderr + lifecycle log

  --root <dir>   solution folder. Must contain a .sln (verified up-front).
                 Defaults: $VBQ_ROOT → auto-detect upward .sln
  --sln  <file>  .sln file path. Internally uses dirname(sln) as root.
                 Use this when the .sln path is known — skips folder math.
  --json         raw LSP JSON (0-based line/col)
  --limit N      cap matches for `sym`
```

## 상황별 — 어떤 명령을 쓰나 (situation → command)

| 알고 싶은 것 (한국어 의도) | 명령 | 메모 |
|---|---|---|
| "X가 **어디 정의**됐어?" | `vbq def X` | 정의 위치만. 동명이인 있으면 여러 줄. |
| "X **누가 호출**해 / 어디서 써?" | `vbq refs X` | 이름 기반, 솔루션 전체. 동명이인이면 **첫 후보만** 보여줌 → 전부는 `--json`. |
| "오버로드/동명이인 중 **바로 이** 심볼의 참조만" | `vbq refs-at <file> <L> <C>` | 위치(커서) 기반이라 정확히 한 심볼로 고정. **L/C는 0-based**. |
| "이름이 가물가물 — X **비슷한** 거 찾아줘" | `vbq sym <부분문자열>` | 퍼지/부분일치 검색(발견용). 너무 많으면 `--limit N`. |
| "이 **파일에 뭐** 들어있어 / 메서드 목록" | `vbq doc-sym <file>` | 파일 구조 아웃라인(클래스→멤버), 1-based 표시. |
| "이 위치 심볼 **타입/시그니처**가 뭐야?" | `vbq hover <file> <L> <C>` | 선언/시그니처 한 줄. 파라미터명 확인에 유용. **L/C는 0-based**. |
| 데몬 살아있나 / 디버그 | `vbq status` · `vbq logs <root>` · `vbq kill <root>` | logs는 메인 게이트에 막힘 → 서브에이전트로(Gotchas #5). |

**고르는 요령**: 이름을 **정확히 알면** `def`/`refs`. **가물가물하면** `sym`으로 먼저 후보 확인 → 정확한 이름 잡고 `def`/`refs`. **동명이인 때문에 `refs`가 엉뚱한 후보**를 고르면 `doc-sym`/`sym`으로 원하는 정의의 정확한 위치(file, line)를 찾은 뒤 그 위치로 `refs-at`.

## Decision tree

```
Is the task about VB.NET code?
├─ No → use grep
└─ Yes
   ├─ Pure text match? → use grep
   ├─ Semantic intent (refs/def/sym/outline/hover)?
   │  ├─ .sln resolvable (--sln, --root, $VBQ_ROOT, auto)? → use vbq
   │  └─ No .sln found → fall back to grep + Read
   └─ Editing/writing code? → vbq is read-only; use Edit/Write
```

## Worked examples

**Preference**: when the `.sln` path is known, pass `--sln <file>` rather than `--root <folder>`. Removes guesswork; vbq computes `dirname(sln)` internally.

### "Where is `CreateSaveFile_Index` used?"

```
vbq refs CreateSaveFile_Index --sln "C:\src\App\App.sln"
```
→ Prints definition + every call site as `file:line:col`.

### "Where is `GridSplitterPosition` used?" (app project, .sln known)

```
vbq refs GridSplitterPosition --sln "C:\src\apps\Grid\Grid.sln"
```

### "What classes are in `LibMain.vb`?"

```
vbq doc-sym "C:\src\Lib\LibMain.vb" --sln "C:\src\App\App.sln"
```

### "What does `MyExporter` refer to in this codebase?"

```
vbq sym MyExporter --sln "<path to .sln>"
```
→ All symbols (class/method/property) whose name fuzzy-matches.

### "What's the type of `result` at LibMain.vb line 230, col 12?"

```
vbq hover "C:\...\LibMain.vb" 229 11 --sln "<path to .sln>"
```
Note: line/col are **0-based** for `hover`/`refs-at`. The `refs` command (symbol-name based) is 1-indexed for display only.

### `--root` is still valid when you have the folder

```
vbq refs CreateSaveFile_Index --root "C:\src\App"
```
Useful when iterating in a shell where you've already `cd`'d to the solution folder. The folder must contain a `.sln` (verified up-front).

## Gotchas — 헷갈리기 쉬운 부분 (2026-06-29 전기능 테스트로 검증)

### 1. 0-based vs 1-based — 제일 많이 틀린다
- **표시(출력)는 1-based**: `sym`/`def`/`refs`/`refs-at`/`doc-sym`이 찍는 `file:line:col`은 1-based (에디터 줄번호와 일치).
- **입력(인자)은 0-based**: `hover`/`refs-at`에 넘기는 `<L> <C>`는 **0-based**.
- 변환: 출력에서 본 `141:17`의 그 심볼을 `hover`/`refs-at`로 찍으려면 **각각 -1 → `140 16`**.
- 검증례: `ViewerMain.FileOpen`이 `refs`에선 `141:17` → `vbq hover … 140 16` → `Private Sub FileOpen(path As String, …)` 정상.

### 2. `refs` vs `refs-at`
- `refs X` = **이름 기반**. 같은 이름이 여러 클래스에 있으면(예: `FileOpen`이 3개 클래스) **첫 후보만** 골라 그 참조를 보여주고 `--json`을 안내한다. 빠르지만 동명이인에 약함.
- `refs-at <file> <L> <C>` = **위치 기반**. 커서가 놓인 **정확히 그 심볼**의 참조만 — 오버로드/동명이인을 확실히 가른다. 단 L/C는 0-based.
- 동명이인일 때: `sym`/`doc-sym`으로 원하는 정의의 정확한 위치를 찾고 → 그 위치로 `refs-at`.

### 3. `sym` vs `def`
- `sym <q>` = **퍼지/부분일치 발견**. `sym Update` → `UpdateStatus`, `CreateOrUpdate`, `UpdateRemotePattern`처럼 substring까지 다 긁는다. 이름이 불확실할 때 1순위. 너무 많으면 `--limit N`.
- `def <name>` = **정의 위치 조회**. 이름을 정확히 알 때. 동명이인이면 정의를 다 보여준다.
- 워크플로: 모르면 `sym` → 정확한 이름 확보 → `def`/`refs`.

### 4. `--json`은 "전부 보기" 스위치
- `refs`가 다중후보 중 하나만 보여줄 때 `--json`을 주면 **모든 후보/위치**가 나온다(0-based 좌표). 기계 파싱에도 사용.

### 5. `logs`는 메인 에이전트 게이트에 막힌다
- `vbq logs … --tail N`은 `block-main-code-reads.js`가 "출력 명령 + 프로젝트 경로"로 오인해 막는다(false-positive).
- 우회하지 말고 **서브에이전트(codebase-explorer 등, Bash 보유)에 위임**해서 실행 — 훅이 권장하는 정석. git-bash에서 `vbq`를 못 찾으면 **풀패스**(플러그인 `bin/vbq.cmd`)로 `logs <root> --tail N`.
- `status`/`kill`/`sym`/`refs`/… 는 출력 토큰이 없어 메인에서 그대로 된다.

### 6. 첫 호출은 콜드 10–30s
- 새 root(또는 `kill` 직후 재호출)는 Roslyn 재로딩으로 10–30초. PowerShell `timeout` 넉넉히(60–90s). 이후 <1s.

### 7. 한 폴더에 .sln 여러 개면 `--sln`으로 못박기
- vbnet-ls가 비결정적으로 하나 고른다. `--root`(폴더) 대신 `--sln <file>`로 명시.

## Root selection

Order of resolution inside `vbq`:

1. `--sln <file>` — explicit .sln file path. Convenience for skipping folder math when the .sln is known. Internally resolved to `dirname(sln)` as root.
2. `--root <folder>` — explicit folder, must contain a .sln.
3. `$env:VBQ_ROOT` — usually set via `vbsln <path>` in the user's shell.
4. Auto: starting at cwd, walk upward looking for any `.sln`.

**Up-front .sln verification.** After resolution, vbq immediately checks the root folder contains at least one `.sln`. If absent → dies with `no .sln file in root: <root>` rather than waiting 180s for daemon timeout. If multiple `.sln` files coexist in the same folder → warning printed (vbnet-ls selects one non-deterministically); pass `--sln <file>` to disambiguate at the UX level.

Assumption: one folder = one `.sln`. If your repo has multiple, organize them in subfolders or use `--sln` to be explicit.

If none → vbq dies with "no --root/--sln given, VBQ_ROOT unset, and no .sln found upward from cwd". Recover by passing `--root` or `--sln` explicitly.

## Daemon model

- One detached Node.js daemon **per solution root**, communicating with `vbq` over a Windows named pipe (`\\.\pipe\vbnet-ls-<hash>`).
- Daemon spawns `vbnet-ls --stdio` with `cwd = root`, sends LSP `initialize`, then watches stderr for `"Solution loaded: N VB.NET projects"` to mark ready.
- State at `%TEMP%\vbnet-ls-daemons\<hash>.{json,ready,log}`.
- **Idle timeout: 30 min** — daemon shuts itself down and cleans state.
- **Max 3 daemons** — when starting a 4th, the oldest-idle one is LRU-evicted.

## Performance expectations

- **First call per root:** 10–30 seconds (Roslyn `MSBuildWorkspace.OpenSolutionAsync`).
- **Cached call:** typically 200ms–2s depending on query.
- **Memory:** ~250 MB per loaded solution.

Set realistic Bash `timeout` (e.g. 180000ms) for the first call to a new root.

## Pitfalls and recovery

| Symptom | Cause | Fix |
|---|---|---|
| `daemon not ready (timeout)` | Solution load >180s or MSBuild crash | `vbq logs <root> --tail 200`; if stack trace → check VS install (VS18 must be hidden, VS2022 17.x present) |
| `pipe timeout` on cached call | Daemon died silently | `vbq kill <root>`, then re-run query (it will respawn) |
| `(no matches)` on a name you know exists | Symbol filtered by accessibility/case | Try `vbq sym <Lowercase>` or `--limit 0` and look at full match list |
| `references` returns only the definition | File didn't get `didOpen`'d, or symbol genuinely unused | Pass `--json` and check; for whole-solution refs use `vbq refs` (name-based, not position-based) |

## Doing NOT — anti-patterns

- ❌ Spawning vbq for non-VB files.
- ❌ Calling vbq on a folder with no `.sln` — fail-fast immediately (`no .sln file in root`). Pass the folder containing the `.sln`, or use `--sln <file>`.
- ❌ **Guessing a parent folder as `--root` when cwd is unrelated to the code** (e.g. cwd is `Documents\` but target is in `apps\Grid\`). Always anchor on a known `.sln` path. When in doubt, prefer `--sln <file>`.
- ❌ Editing files via vbq — it's read-only. Use Read + Edit.
- ❌ Killing daemons "just in case" — the 30min auto-timeout handles it. Killing forces a 10–30s reload next time.
- ❌ Adding `--root` for every call when `$VBQ_ROOT` is already set in the shell.
- ❌ Passing a folder with multiple `.sln` files to `--root` without `--sln` disambiguation — vbnet-ls selects one non-deterministically.

## Implementation

Paths are relative to the plugin root (GitHub `duddudcns/vbq`):

- CLI: `vbq.mjs`
- Daemon: `daemon.mjs`
- Registry helpers: `lib/registry.mjs`
- LSP framer: `lib/lsp-frame.mjs`
- PATH shims: `bin/vbq.cmd` (PowerShell/cmd), `bin/vbq` (git-bash) — used inside Claude Code
- Fixed-path launcher: `bin/vbq-launch.mjs`, copied with its own shims to `~/.local/bin` by `vbq setup` (`lib/setup.mjs`) — used everywhere else
- Reminder hook: `hooks/vbq-first.js` (PreToolUse on Read/Grep/Glob/Bash/PowerShell with a `.vb`/`.xaml` target)

The underlying language server is `vbnet-ls` (DNAKode.VbNet.Lsp, 0.1.10 or later; 0.1.16 verified 2026-10-12), installed as a global dotnet tool. 0.1.9 and earlier rewrite queried files with a double BOM.

**Do not modify** these files in the course of normal VB.NET search tasks. If vbq itself is broken, fix it in a separate, explicit session.
