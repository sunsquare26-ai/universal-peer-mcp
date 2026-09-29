# M3 설치 절차 추가분 (초인종)

1. `config.json`(0600): `codexCli`는 app-server와 같은 릴리스의 CLI(`~/.codex/packages/app-server-daemon/current/bin/codex`), `codexVersion`은 그 릴리스, `codexAppServerSocket`은 링크가 아닌 실제 소켓 경로입니다. 데몬만 재시작합니다.
2. `node_modules/ws` 8.21.3을 번들로 넣습니다(해시 19개 대조).
3. 전역 Codex 지침:
   - `~/.codex/AGENTS.md`가 0바이트인지 확인합니다(다르면 멈춤).
   - `docs/codex-global-agents.md`를 그대로 복사합니다.
4. 새 세션 확인: 파일 내용이 아니라 **모델이 받은 첫 문맥**으로 확인합니다.
   - 새 Codex 스레드를 열어 첫 턴을 끝냅니다.
   - 그 rollout에서 첫 `task_complete` 이전의 `response_item` 메시지에 `PEER_DOORBELL v=1 message_id`가 있는지 읽기만 해서 확인합니다.
   - 압축 뒤에는 `compacted` 항목에서 같은 문구를 확인합니다.
5. 들어가지 않은 경우와 운영 중인 세션: 규칙 문구를 피어 자료로 한 번 `post`합니다. 적용 여부는 첫 실제 초인종에서 `inbox-ack`까지 걸린 시간으로 봅니다.
6. 실패 처리: `not_sent`나 30분 넘은 `unknown`은 경보만 한 번 보내고 자동으로 다시 보내지 않습니다. 설정이나 버전을 고친 뒤 사람이 다시 보냅니다.
7. 되돌리기: `: > ~/.codex/AGENTS.md`, 설치 폴더 백업 복원, 데몬 재시작.

**알려진 한계(사장님 승인, 2026-09-29):** 같은 Mac·같은 사용자 안에서 다른 프로세스가 `CODEX_THREAD_ID`를 복사해 Codex 스레드를 사칭하는 경우는 막지 않습니다.
