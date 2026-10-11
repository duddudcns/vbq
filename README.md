# vbq

VB.NET 솔루션에 시맨틱 질의(정의·참조·심볼·hover·문서 개요)를 하는 CLI 입니다. Roslyn 기반 언어 서버 `vbnet-ls`(NuGet `DNAKode.VbNet.Lsp`)를 솔루션마다 데몬으로 띄워 두고 명령줄에서 물어봅니다. Claude Code 플러그인으로도 쓸 수 있습니다(스킬 `vbq` + `.vb`/`.xaml` 대상 grep/Read 때 vbq 를 먼저 권하는 훅).

## 설치

1. 언어 서버: `dotnet tool install -g DNAKode.VbNet.Lsp` (0.1.10 이상)
2. 플러그인: `/plugin install vbq@duddudcns`
3. PowerShell 에서 `vbq` 를 쓰려면 플러그인(또는 이 저장소)의 `bin` 폴더를 사용자 PATH 에 넣습니다. 자세한 것은 [INSTALL.md](INSTALL.md).

## 사용

```
vbq sym NodeBase --sln C:\path\to\App.sln
vbq def NodeBase --sln ...
vbq refs NodeBase --sln ...
vbq doc-sym C:\path\to\File.vb --sln ...
vbq hover C:\path\to\File.vb 18 24 --sln ...
vbq status | kill <root|all> | logs <root> --tail 100
```

솔루션당 첫 호출은 10~30초(솔루션 로드), 이후는 1초 미만입니다. 데몬은 30분 쉬면 스스로 끝나고, 동시에 3개까지 띄웁니다.

## 왜 Claude Code 내장 LSP 가 아니라 CLI 인가

2026-10-12 에 `vbnet-ls` 를 내장 LSP 플러그인으로도 시험했습니다. 동작은 했지만 Claude Code 가 세션 작업 폴더 저장소의 `.gitignore` 에 걸리는 파일을 가리키는 정의·참조 결과를 버려서, 코드 폴더가 별도 저장소로 무시되는 작업 환경에서는 쓸 수 없었습니다. CLI 는 이 필터를 거치지 않습니다.
