# 여러 세션 등록과 주고받기 (M4)

한 Mac에서 Claude 세션 여럿과 Codex 세션 여럿을 별칭(alias)으로 등록하고, 별칭으로 주고받습니다.

## 등록은 그 세션 안에서

등록할 세션에게 아래 명령을 **그 세션의 셸에서** 실행하게 합니다(Claude는 Bash 도구나 `!`, Codex는 셸 도구).
데몬이 커널 기록으로 누가 실행했는지 확인합니다. Claude는 `~/.claude/sessions/<pid>.json`, Codex는 실행 환경의
`CODEX_THREAD_ID`와 rollout 파일로 확인합니다. 별칭 말고는 아무것도 적지 않습니다. JSON은 손대지 않습니다.

```sh
universal-peer-mcp register --alias test-claude-1        # 등록
universal-peer-mcp whoami                                # 확인: {"authenticated":true,"alias":"test-claude-1",...}
```

사장님 터미널에서:

```sh
universal-peer-mcp peers                                 # 목록
universal-peer-mcp unregister --alias test-claude-1      # 삭제
```

- 별칭: 영문 소문자로 시작, 소문자·숫자·`-`, 2~48자.
- 한 별칭은 한 세션, 한 세션은 한 별칭입니다. 이미 쓰는 별칭이거나 이미 등록된 세션이면 거부합니다. 옮기려면 `--replace`.
- Claude 세션은 `--permission-mode <mode>`를 붙여 절대경로로 시작한 세션만 등록됩니다(`permission_mode_unproven`).

## 주고받기

```sh
universal-peer-mcp post --to test-codex-1 --body-file msg.txt          # 한 명
universal-peer-mcp post --to test-codex-1,test-claude-2 --body-file m  # 여러 명: 받는 사람마다 id 따로(UUIDv5)
universal-peer-mcp inbox                                               # 내 받은편지함(내 별칭 것만)
universal-peer-mcp inbox-ack --message-id <id>                         # 처리 표시(id당 한 번)
```

- 등록 안 된 이름이 하나라도 있으면 전체를 보내지 않습니다(`UNKNOWN_RECIPIENT`).
- 남의 받은편지함은 읽거나 처리 표시할 수 없습니다(`RECIPIENT_MISMATCH`, `NOT_RECIPIENT`).
- 순서는 (보낸 사람, 받는 사람) 한 쌍 안에서만 보장합니다.
- 같은 `--group-id`로 다시 보내면 받는 사람마다 중복으로 처리되고 새 메시지가 생기지 않습니다.

## 재시작

- Claude: `claude --resume <원래 세션 ID> --permission-mode …`로 다시 켜면, 그 세션의 첫 호출에서 별칭이 새 세션으로 옮겨지고
  기다리던 메시지를 그대로 받습니다.
- 자동으로 넘겨받지 않는 경우(이름 있는 거부): `/clear`·선택기(같은 프로세스, 새 ID: `rebind_same_process`),
  `--fork-session`(`rebind_fork_refused`), 옛 ID를 다시 이어받기(`rebind_chain_unsupported`), Codex 새 스레드.
  이때는 새 세션에서 `register --alias <원래 별칭> --replace`를 실행합니다. 처리 안 된 메시지는 그대로 넘어갑니다.
