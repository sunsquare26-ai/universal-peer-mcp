# Claude Code → Codex 깨우기 설치 기록

- 구현 커밋: `55bc859` (원격 `session/peer/20260922-wake-finish`).
- 관련 시험: 23 pass, 0 fail. 구문 검사와 빌드 통과.
- 설치 위치: `~/.local/share/universal-peer-mcp/releases/55bc859/runtime/`.
- Claude에서 쓰는 고정 진입점: `~/.local/bin/universal-peer-wake`.
- 입력: stdin JSON `{"codexAlias":"review","messageId":"새 UUID","body":"전달할 내용"}`.
- 상태 확인: 같은 명령에 `wake-status` 인자를 주고 `{"codexAlias":"review"}` 입력.
- 개인 설정·중복 방지 영수증: `~/.local/share/universal-peer-mcp/queue-wake-state/` (디렉터리 0700, 설정 0600).
- `review`는 이번 테스트를 받는 기존 CLI Codex 세션에 결박했다. 다른 세션으로 바꿀 때는 수신 세션의 UUID를 확인해 개인 설정을 변경한다. 프로세스 argv의 이전 resume UUID를 사용하지 않는다.
- 설치본 상태 결과: `available:true, state:queue_configured`.
- 기존 `0.1.0-r1` 메시지 송수신 데몬과 설정은 변경·재시작하지 않았다. MCP 도구 목록 갱신 없이 현재 Claude 세션이 CLI 진입점을 쓸 수 있다.
- 자동 이벤트 bridge는 이번 설치에서 켜지 않았다. Claude가 명시적으로 wake를 호출하는 경로이다. 모든 회신이 무조건 상대 턴을 생성하는 무한 왕복은 만들지 않는다.
- 이전 직접 `codex queue` 실측은 수신 새 턴 및 universal-peer 회신까지 확인했다.
- 설치본 최종 실측 요청: `573b74b5-2123-4aba-a9fb-a7a421156ec4`, wake ID `494c6243-9268-4eb4-9722-42ab8d7866d4`. 큐 등록과 실제 수신은 구분하며, 최종 수신 결과는 후속 기록으로 남긴다.

코드를 되돌려야 할 경우 개인 wrapper의 실행 경로를 이전 검증 설치본으로 바꾸면 된다. 중복 방지 영수증과 기존 메시지 원장은 삭제하지 않는다.

## 최종 설치본 실측 성공

Claude가 설치된 `universal-peer-wake`를 통해 위 wake ID를 전송했다. 설치본 영수증은 `accepted:true, mode:queued, replay:false`였다. 기존 Codex 턴 종료 후 **같은 대상 세션에서 새 턴으로 해당 messageId와 본문을 수신**했다. 수신 측은 universal-peer로 `PEER_REPLY WAKE-INSTALLED-55bc859-OK`를 회신했다(회신 messageId `6d563b8c-1e4a-49f7-96de-a8047c96e178`). 이로써 직접 CLI 명령만의 시험이 아니라 **설치본 → native queue → 기존 Codex 세션 새 턴 → 피어 회신 전송**까지 확인했다. 상대의 회신 읽기 여부와 큐 소비 성공은 별개이다.
