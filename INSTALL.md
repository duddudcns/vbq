# vbq 설치 가이드 (다른 PC 이식용)

> `vbq` 는 VB.NET 솔루션에 대해 LSP 시맨틱 쿼리(references / definition / symbol / hover / outline)를
> 실행하는 CLI 다. Roslyn 기반 언어 서버 `vbnet-ls` 를 솔루션 루트별 데몬으로 감싸 동작한다.
> 이 문서는 현재 동작 중인 PC와 동일한 환경을 **새 PC에 재현**하기 위한 절차다.

---

## 0. 한눈에 보는 구성

```
사용자 입력 ──> vbq.cmd ──> vbq.mjs (Node CLI)
                                 │  named pipe \\.\pipe\vbnet-ls-<hash>
                                 ▼
                          daemon.mjs (Node, 루트별 1개)
                                 │  stdio (LSP, Content-Length 프레이밍)
                                 ▼
                          vbnet-ls --stdio  (DotnetTool, net10.0)
                                 │  Roslyn MSBuildWorkspace
                                 ▼
                          .NET SDK 의 MSBuild 로 .sln 로드
```

이식 대상은 **두 덩어리**다.

| 덩어리 | 정체 | 이식 방법 |
|---|---|---|
| `vbq` CLI | 순수 Node.js ESM 스크립트 묶음 (외부 npm 의존성 **0개**) | 폴더 복사 |
| `vbnet-ls` | nuget.org 공개 dotnet 전역 도구 (`DNAKode.VbNet.Lsp`) | `dotnet tool install` |

상태 파일(`%TEMP%\vbnet-ls-daemons\`)과 데몬 프로세스는 **이식 대상이 아니다** — 첫 실행 시 자동 생성된다.

---

## 1. 사전 요구사항

| 항목 | 요구 버전 | 현재 동작 PC | 확인 명령 | 비고 |
|---|---|---|---|---|
| OS | **Windows** | Windows 11 | — | named pipe + `.cmd` shim 사용. macOS/Linux 미지원(§8 참고) |
| Node.js | 18 LTS 이상 (22 LTS 권장) | v22.14.0 | `node --version` | ESM + `node:` 빌트인만 사용. PATH 에 `node` 필요 |
| .NET **SDK** | **10.x** | 10.0.300 | `dotnet --version` | 런타임만으론 부족 — MSBuildWorkspace 가 SDK 의 MSBuild 를 사용 |
| Visual Studio | **불필요** | (미설치) | — | `vbnet-ls` 가 MSBuild BuildHost(net472/netcore)를 자체 번들 |

> **.NET 버전 주의**: `vbnet-ls` 0.1.9 는 `net10.0` 타겟이다. .NET 10 SDK 가 없으면 도구 실행 자체가 안 된다.
> .NET 9 등 하위 SDK만 있는 PC라면 .NET 10 SDK 를 먼저 설치할 것.
> (https://dotnet.microsoft.com/download/dotnet/10.0 → SDK x64)

---

## 2. 설치 절차

### Step 1 — Node.js / .NET 10 SDK 설치

대상 PC에 없으면 먼저 설치한다.

```powershell
# 설치 후 확인 (둘 다 버전이 찍혀야 함)
node --version        # v18+ (권장 v22.x)
dotnet --version      # 10.x
```

### Step 2 — vbnet-ls 전역 도구 설치 (nuget.org)

```powershell
dotnet tool install -g dnakode.vbnet.lsp
```

- `dnakode.vbnet.lsp` 는 nuget.org 에 공개돼 있다(0.1.9 ~ 0.1.14+ 존재). 사내 피드 설정 불필요.
- **반드시 0.1.10 이상**이어야 한다 — 0.1.9 이하는 쿼리(doc-sym/refs/sym/def/hover)만 해도 대상 `.vb`가 디스크에 재기록되며 단일 BOM→이중 BOM+CRLF로 손상되는 확정된 버그가 있다(상세: wiki `_shared/rules/vbq-vbnet-ls-write-on-open-bom.md`). **`--version` 없이 최신을 받는 게 기본이다** — 절대 `--version 0.1.9`로 고정하지 말 것. 현재(이 PC) 검증된 버전은 **0.1.14**.
- 설치 후 `vbnet-ls.exe` 는 `%USERPROFILE%\.dotnet\tools\` 에 놓인다.

**PATH 확인**: `dotnet tool` 전역 설치 경로(`%USERPROFILE%\.dotnet\tools`)가 PATH 에 있어야 한다.
보통 첫 dotnet 도구 설치 시 자동 추가되지만, 안 됐으면 수동 추가:

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\.dotnet\tools",
  "User")
```

확인:

```powershell
(Get-Command vbnet-ls).Source   # → %USERPROFILE%\.dotnet\tools\vbnet-ls.exe
```

### Step 3 — vbq 파일 복사

`vbq` 폴더 전체를 대상 PC로 복사한다. 위치는 어디든 무방하다(외부 의존성이 없어 자기완결적).
권장 위치는 현 PC와 동일한 `%USERPROFILE%\vbq` 다.

복사해야 할 파일(이게 전부다):

```
vbq\
├── package.json
├── vbq.mjs            ← CLI 진입점
├── daemon.mjs         ← 루트별 데몬
├── bin\
│   └── vbq.cmd        ← PATH shim (node vbq.mjs 호출)
└── lib\
    ├── registry.mjs   ← 데몬 상태/네임드파이프 레지스트리
    └── lsp-frame.mjs  ← LSP Content-Length 프레이밍
```

> `node_modules` 도, `npm install` 도 필요 없다. `package.json` 에 `dependencies` 가 없다.

복사 예시(USB/공유폴더에서 받은 경우):

```powershell
Copy-Item -Recurse "<원본 경로>\vbq" "$env:USERPROFILE\vbq"
```

### Step 4 — vbq 를 PATH 에 등록

`bin` 폴더(= `vbq.cmd` 위치)를 사용자 PATH 에 추가한다.

```powershell
$vbqBin = "$env:USERPROFILE\vbq\bin"
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path","User") + ";$vbqBin",
  "User")
```

> 새 PowerShell/터미널을 열어야 PATH 변경이 반영된다.

### Step 5 — (선택) 기본 솔루션 루트 / 편의 함수

매 호출마다 `--root`/`--sln` 을 쓰기 싫으면 `VBQ_ROOT` 환경변수에 기본 솔루션 폴더를 박을 수 있다.

```powershell
[Environment]::SetEnvironmentVariable("VBQ_ROOT", "C:\path\to\solution-folder", "User")
```

루트 해석 우선순위: `--sln` > `--root` > `$VBQ_ROOT` > cwd 에서 위로 올라가며 `.sln` 자동 탐색.

(선택) 현 PC 문서에 언급되는 `vbsln <path>` 는 셸에서 `VBQ_ROOT` 를 빠르게 바꾸는 **사용자 정의 헬퍼**다.
원하면 PowerShell 프로파일(`$PROFILE`)에 추가:

```powershell
function vbsln { param([string]$Path) $env:VBQ_ROOT = (Resolve-Path $Path).Path; "VBQ_ROOT = $env:VBQ_ROOT" }
```

---

## 3. 설치 검증

새 터미널에서 순서대로 실행한다.

```powershell
# 1) 구성요소가 PATH 에 잡히는가
node --version
dotnet --version
(Get-Command vbnet-ls).Source
(Get-Command vbq).Source

# 2) vbq CLI 자체 동작 (도움말 출력되면 OK)
vbq --help

# 3) 데몬 레지스트리 동작 (처음엔 "(no daemons)")
vbq status

# 4) 실제 솔루션에 대한 스모크 테스트
#    첫 호출은 Roslyn 솔루션 로드로 10~30초 소요(정상).
vbq sym <아무_심볼_이름> --sln "C:\path\to\Your.sln"

# 5) 데몬이 떴는지 재확인
vbq status        # ✓ pid=... ready=True root=... 한 줄 보이면 성공
```

4번에서 `file:line:col` 형태 결과가 나오면 이식 성공이다.

---

## 4. 트러블슈팅 (이식 직후 흔한 문제)

| 증상 | 원인 | 해결 |
|---|---|---|
| `'vbq' 은 명령으로 인식되지 않습니다` | PATH 미반영 | 새 터미널 열기 / Step 4 재확인 |
| `'node' ... 인식되지 않습니다` 가 vbq 내부에서 발생 | Node 미설치 또는 PATH 누락 | Node 설치, `node --version` 확인 |
| 첫 쿼리가 `daemon not ready within 180000ms` 로 죽음 | `vbnet-ls` 미설치/실행불가, 또는 .NET 10 SDK 부재 | `vbnet-ls --help` 직접 실행해 확인; `dotnet tool list -g` 에 `dnakode.vbnet.lsp` 있는지; .NET 10 SDK 설치 여부 |
| `vbnet-ls` 가 PATH 에 없음 | dotnet tools 경로 미등록 | Step 2 의 PATH 추가 |
| `no .sln file in root: ...` | 루트에 `.sln` 없음 | `.sln` 이 든 폴더를 `--root`, 또는 `--sln <파일>` 직접 지정 |
| `pipe timeout` (캐시 호출인데 실패) | 데몬이 조용히 죽음 | `vbq kill <root>` 후 재실행(자동 재기동) |
| 솔루션 로드 중 MSBuild 스택 트레이스 | SDK/MSBuild 문제 | `vbq logs <root> --tail 200` 로 로그 확인; .NET 10 SDK 정상 설치 재확인 |
| 쿼리(read)만 했는데 `.vb`가 이중 BOM+CRLF로 바뀜 | `vbnet-ls` **0.1.9 이하** 설치됨 | `dotnet tool list -g`로 버전 확인 → `dotnet tool update -g dnakode.vbnet.lsp`로 0.1.10+ 갱신 |

진단용 명령:

```powershell
vbnet-ls --help                 # 언어서버 단독 실행 확인
dotnet tool list -g             # dnakode.vbnet.lsp 0.1.9 가 보여야 함
vbq logs <root|hash> --tail 100 # 데몬 stderr + 수명 로그
```

데몬 상태/로그 위치: `%TEMP%\vbnet-ls-daemons\<hash>.{json,ready,log}` (자동 생성).

---

## 5. 업데이트 / 제거

```powershell
# vbnet-ls 업데이트 (동작 보장은 0.1.9 기준 — 올린 뒤엔 §3 검증 재실행 권장)
dotnet tool update -g dnakode.vbnet.lsp

# vbnet-ls 제거
dotnet tool uninstall -g dnakode.vbnet.lsp

# vbq 제거: PATH 에서 ...\vbq\bin 제거 후 폴더 삭제
Remove-Item -Recurse -Force "$env:USERPROFILE\vbq"
```

---

## 6. 빠른 이식 체크리스트

- [ ] Windows PC
- [ ] `node --version` → 18+ (권장 22)
- [ ] `dotnet --version` → 10.x (SDK)
- [ ] `dotnet tool install -g dnakode.vbnet.lsp` (버전 고정 금지 — 0.1.9 이하는 .vb 이중 BOM 손상 버그 있음, 0.1.10+ 필수)
- [ ] `%USERPROFILE%\.dotnet\tools` 가 PATH 에 있음 → `(Get-Command vbnet-ls).Source` 확인
- [ ] `vbq` 폴더 복사 (npm install 불필요)
- [ ] `...\vbq\bin` 을 PATH 에 추가 → `(Get-Command vbq).Source` 확인
- [ ] (선택) `VBQ_ROOT` / `vbsln` 헬퍼
- [ ] `vbq --help`, `vbq status`, 실제 `.sln` 으로 `vbq sym` 스모크 테스트

---

## 7. 동작/성능 메모

- **첫 호출**(루트별): 10~30초 — Roslyn `MSBuildWorkspace.OpenSolutionAsync`. Bash/스크립트 timeout 은 180s 로.
- **캐시 호출**: 200ms~2s.
- **메모리**: 솔루션당 약 250MB.
- **데몬 수명**: 30분 idle 시 자동 종료. 동시 최대 3개 루트(초과 시 가장 오래된 idle 데몬 LRU 제거).
- 한 폴더 = `.sln` 1개 가정. 여러 개면 `--sln <파일>` 로 명시.

---

## 8. 다른 OS(macOS/Linux)로 옮길 때 (참고)

현재 `vbq` 는 Windows 전용 가정이 두 곳에 박혀 있다 — 단순 폴더 복사로는 비-Windows 에서 동작하지 않는다.

1. **PATH shim**: `bin/vbq.cmd` 는 Windows 배치파일. POSIX 에선 `vbq` 래퍼 셸 스크립트(또는 `npm link` / `chmod +x vbq.mjs` + symlink)로 대체 필요.
2. **named pipe**: `lib/registry.mjs` 의 `pipeName()` 이 `\\.\pipe\vbnet-ls-<hash>` 형식 — Windows 전용. POSIX 에선 Unix 도메인 소켓 경로(예: `/tmp/...sock`)로 바꿔야 한다.

`vbnet-ls` 자체는 크로스플랫폼(dotnet tool)이라 OS 무관하게 설치된다. 위 2개만 손보면 된다(별도 작업 필요).
