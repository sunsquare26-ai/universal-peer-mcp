# 자동 깨우기 재개 — 2026-09-22

## 이번 확인

- 기준 커밋: `56a670d`. 메시지 수신·회신 복구는 이번 작업 대상이 아니다.
- `bun test test/codex-wake.test.mjs test/codex-wake-bridge.test.mjs`: 18 pass, 0 fail. 모델 호출 없음.
- 현재 ChatGPT 번들 Codex PID 7938은 `app-server`를 stdio로 실행 중이다. `lsof -a -p 7938 -U -n -P`에는 연결된 익명 소켓만 있고 이름 있는 app-server 수신 소켓이 없다. PID는 관측값이며 다음 실행 때 재발견해야 한다.
- 기존 Claude의 `codex-control-relay-app`, `codex-app-identity-relay` 기록도 연결 성공 증거가 아니다. 각각 수신 승인 만료와 세션 주소 해석 실패로 끝났다.
- 기존 실행본 변경·재시작, 유료 API 호출, 자동 깨우기 활성화는 하지 않았다.
- 완료되지 않은 것은 **현재 ChatGPT 앱의 기존 대화에 외부 이벤트를 주입할 호스트 연결**이다. Claude 사용량 제한 해제만으로 이 연결이 생기지는 않는다.

## Claude Code에 전달할 프롬프트

```text
유니버설 피어의 자동 깨우기 패치를 이어서 마무리해 주세요.
메시지 수신·회신 복구는 이미 적용된 별도 작업이므로 다시 하지 마세요.

기준 작업본: /Users/hyungseoklee/peer-codex-wake
브랜치: session/peer/20260921-codex-wake, 기준 커밋 56a670d
재개 기록: /Users/hyungseoklee/peer-codex-wake-finish/docs/claude-wake-handoff-20260922.md
먼저 기준 작업본의 docs/codex-wake.md를 읽으세요.

목표는 Claude의 검증된 회신 또는 완료 이벤트가 도착했을 때 현재 ChatGPT 앱의 기존 Codex 대화가 자동으로 다음 턴을 시작하는 것입니다.
기존 wake dispatcher, WebSocket-over-UDS transport, 이벤트 bridge는 구현되어 있고 2026-09-22 관련 시험 18개가 통과했습니다.
남은 문제는 ChatGPT 앱 내부 app-server가 stdio로 실행되어 외부 수신 endpoint가 없다는 점입니다.

1. 현재 앱 프로세스와 호스트가 실제 제공하는 기존 대화 연결 수단을 읽기 전용으로 확인하세요. 이전 PID·소켓·세션 주소는 재사용하지 말고 현재 식별자를 확인하세요. 공개된 연결 수단이 없다면 없다고 보고하세요.
2. 지원되는 연결 수단이 확인되면 별도 브랜치/워크트리에서 어댑터를 완성하세요. 임의의 새 codex exec/resume 또는 별도 app-server를 띄운 것을 현재 앱 대화 깨우기 성공으로 보고하지 마세요. 연결된 익명 소켓을 수신 endpoint로 취급하거나 앱의 IPC·프로토콜을 추정해 주입하지 마세요.
3. 기존 설치본 /Users/hyungseoklee/friday-mini/var/tools/universal-peer-mcp/0.1.0-r1/ 에는 rebind/spool/wait 복구 등 독립 변경이 있습니다. 구버전 기준의 wake 패키지로 덮어쓰지 말고, 통합이 필요하면 정확한 차이를 보존하세요. 현재 정상 통신 데몬과 앱을 임의 종료하지 마세요.
4. 동일 messageId 중복 방지, 요청과 회신의 상관관계, 기존 권한/모델 유지, 불명확한 전송의 자동 재시도 금지를 지키세요. 승인 요청을 대신 승인하지 마세요.
5. 먼저 관련 시험과 무모델 연결 검증을 하세요. 실제 모델 호출에 비용 승인이 필요한 경우 목적·횟수·상한을 제시하세요. 현재 앱의 동일 threadId가 실제 새 턴을 시작하고 화면에 결과가 나타나는 것까지 확인해야 실사용 완료입니다. 보조 연결 종료 후 실행 지속 및 승인 UI 전달도 확인하세요.

가성비를 위해 단일 에이전트로 진행하고 기존 구현을 재작성하지 마세요. 소스 탐색은 AGENTS.md/graft를 따르세요. 지원되는 호스트 연결이 없다면 반복 탐색·무효한 재설치로 시간을 쓰지 말고, 확인한 근거와 필요한 호스트 기능을 남기세요.
최종 보고는 변경 커밋, 시험 결과, 실제 앱 깨우기 성공 여부, 미결만 적어 주세요.
```

## 완료 기준

현재 앱의 동일 대화 식별자를 검증한 뒤 실제 새 턴의 수신 및 UI 표시가 관찰되어야 완료이다. fixture 시험 통과, 패키지 설치, 다른 CLI 대화 실행만으로는 완료가 아니다. 현재 상태는 구현·관련 시험 통과 / 호스트 연결 및 실제 앱 깨우기 미완료이다.
