#!/usr/bin/env node
// vbq-first — PreToolUse hook (Grep|Glob|Read + Bash|PowerShell)
// Bash/PowerShell 도 보아야 한다: bypass 모드에서는 파일 읽기·검색이 cat/grep/sed 로
// 나가므로 Grep|Glob|Read 만 걸면 훅이 한 번도 발동하지 않는다(2026-08-21).
// Replaces the old serena-first.js (2026-07-16, serena retired). Only job now:
// when the Read/Grep/Glob target looks like VB.NET (.vb/.xaml), remind the
// agent to use vbq (semantic LSP queries) BEFORE grep/Read for usage/refs/def
// intent. Non-VB targets get no message — grep/Read are already the default
// there, nothing to nudge toward.
//
// Deliberately NOT gated by the orchestrator master off-switch
// (~/.claude/.orchestrator-off): unlike the old serena-first.js (which was),
// this hook exists specifically to stay at parity with wiki-graphify-read-first.js,
// which also fires unconditionally regardless of orchestrator-mode. vbq-vs-grep
// is a tool-choice nudge, not a subagent-delegation mandate, so it shouldn't be
// suspended by orchestrator-mode OFF. Always exits 0 — never blocks a tool call.

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    let toolName = '';
    let ti = {};
    try {
      const data = JSON.parse(input || '{}');
      toolName = data.tool_name || '';
      ti = data.tool_input || {};
    } catch (_) {
      process.exit(0);
    }

    // Collect the path-ish fields to sniff the target file type.
    // (Grep's `pattern` is a content regex, so it is intentionally excluded.)
    let hay = '';
    if (toolName === 'Read') hay = ti.file_path || '';
    else if (toolName === 'Glob') hay = `${ti.pattern || ''} ${ti.path || ''}`;
    else if (toolName === 'Grep') hay = `${ti.glob || ''} ${ti.path || ''}`;
    else hay = JSON.stringify(ti || {});

    const isVbTarget = /\.(vb|xaml)\b/i.test(hay);
    if (!isVbTarget) process.exit(0);
    // 이미 vbq 를 쓰고 있으면 다시 권하지 않는다(Bash/PowerShell 경유).
    if (/vbq/i.test(hay)) process.exit(0);

    const msg = '[vbq-first] .vb/.xaml 대상 - 사용여부/참조/정의는 추측 말고 먼저 확정: '
      + 'vbq sym|refs|def|doc-sym|hover --sln <solution> (PowerShell·Bash 모두 가능). 단순 문자열 검색이면 grep 그대로.';

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: msg
      }
    }));
  } catch (e) {
    // Silent fail
  }
});
