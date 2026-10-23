#!/usr/bin/env node
// SessionStart: vbnet-ls 가 없거나 너무 낮은 버전이면 AI 에게 사용자에게 설치를 제안하라고 알린다.
// 설치를 직접 하지는 않는다(PC 에 프로그램을 들이는 일은 사용자 확인 뒤에). 문제가 없으면 아무것도 출력하지 않는다.
import { checkServer, problemMessage } from "../lib/server-check.mjs";
import { launcherStatus, pathHas } from "../lib/setup.mjs";

try {
  const lines = [];
  const r = checkServer();
  if (!r.ok) {
    lines.push(`[vbq] ${problemMessage(r)}`);
    lines.push("[vbq] VB.NET 코드 질의(vbq)가 필요해지면 사용자에게 위 명령 실행을 제안하고, 승인받으면 실행한 뒤 `vbq status` 로 확인하세요.");
  }
  if (process.platform === "win32") {
    // 버전 폴더(…\plugins\cache\…\vbq\<버전>\bin)를 PATH 에 넣으면 플러그인 업데이트 때 끊긴다 - 고정 런처를 권한다
    const ls = launcherStatus();
    const onPath = pathHas(process.env.PATH || process.env.Path || "", ls.dir);
    if (!ls.ok || !onPath) {
      const why = ls.have === null ? "고정 런처가 없어" : !ls.ok ? "고정 런처가 오래돼" : "런처 폴더가 PATH 에 없어";
      lines.push(`[vbq] ${why} PowerShell 도구·Codex·일반 터미널에서는 \`vbq\` 를 못 찾습니다(Bash 도구는 됨). 그쪽에서도 쓰려면 사용자에게 \`vbq setup\`(~/.local/bin 에 런처 설치, 필요하면 사용자 PATH 에 추가) 실행을 제안하고, 승인받으면 Bash 도구로 실행한 뒤 \`vbq doctor\` 로 확인하세요.`);
    }
  }
  if (lines.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
  }
} catch {
  // 확인 실패로 세션 시작을 막지 않는다
}
