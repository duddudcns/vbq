#!/usr/bin/env node
// SessionStart: vbnet-ls 가 없거나 너무 낮은 버전이면 AI 에게 사용자에게 설치를 제안하라고 알린다.
// 설치를 직접 하지는 않는다(PC 에 프로그램을 들이는 일은 사용자 확인 뒤에). 문제가 없으면 아무것도 출력하지 않는다.
import { checkServer, problemMessage, findOnPath } from "../lib/server-check.mjs";

try {
  const lines = [];
  const r = checkServer();
  if (!r.ok) {
    lines.push(`[vbq] ${problemMessage(r)}`);
    lines.push("[vbq] VB.NET 코드 질의(vbq)가 필요해지면 사용자에게 위 명령 실행을 제안하고, 승인받으면 실행한 뒤 `vbq status` 로 확인하세요.");
  }
  if (process.platform === "win32" && !findOnPath(["vbq.cmd"])) {
    lines.push("[vbq] PowerShell 도구에서는 `vbq` 를 못 찾습니다(Bash 도구는 됨). PowerShell 에서도 쓰려면 플러그인 bin 폴더를 사용자 PATH 에 넣는 것을 사용자에게 제안하세요(INSTALL.md).");
  }
  if (lines.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
  }
} catch {
  // 확인 실패로 세션 시작을 막지 않는다
}
