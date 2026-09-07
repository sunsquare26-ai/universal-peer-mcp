# 세션을 열고 붙이는 법

영문 [README](../README.md) 와 같은 내용을 한국어 독자용으로 정리한 문서다. 명령은 그대로 복사해 쓸 수 있다.

`universal-peer-mcp` 는 같은 Mac, 같은 사용자 계정 안에서만 도는 로컬 MCP 서버다. Codex 나 다른 Claude Code 가, **이미 실행 중이고 사용자가 허용 목록에 직접 넣은** Claude Code 세션에 말을 걸게 해 준다. 세션을 대신 띄우지 않고, 네트워크 포트를 열지 않는다.

## 신뢰 경계 넷

설치 전에 이 넷을 먼저 읽는다. 설정이 아니라 설계의 성질이다.

1. **같은 Mac, 같은 사용자 계정 안에서만 동작한다.** 접근은 같은 uid 확인과 `0600` 제어 토큰으로 막는다. 같은 uid 로 실행되는 다른 프로그램은 이 서버를 쓸 수 있다.
2. **관리 모드는 데몬을 띄울 때의 환경에서만 정해진다.** 나중에 오는 요청·도구 인자·설정 파일은 관리 모드를 켤 수 없다.
3. **`SIGTERM` 으로 내려도 소켓·식별 파일·잠금·토큰을 지우고 나간다.**
4. **대상 설정을 바꾸면 데몬을 다시 띄워야 반영된다.**

## 준비물

| 항목 | 조건 |
|---|---|
| 운영체제 | macOS. 패키지가 `"os": ["darwin"]` 로 선언돼 있다 |
| 아키텍처 | arm64 실측. x64 는 미검증이다 |
| 런타임 | Bun 1.3.0 이상. Node 로는 뜨지 않는다 |
| 대상 세션 | `~/.claude/sessions/` 에 레지스트리를 발표하는 실행 중인 Claude Code. `peerProtocol` 이 `1` 이고 `notify_idle`·`reply_across_default_dirs` 를 갖춰야 한다 |
| 대상 실행 방법 | 대상 세션은 `--permission-mode` 를 **명시해서** 띄운 것이어야 한다 |
| MCP 클라이언트 | stdio 로 MCP `2026-07-28` 또는 `2025-06-18` 을 쓰는 클라이언트 |

## 1. 설치하고 확인한다

설치 경로는 셋이고, 검증된 정도가 다르다.

| 경로 | 상태 |
|---|---|
| `npm install -g universal-peer-mcp` | **아직 안 된다.** 레지스트리 공개 전이라 이 명령은 실패한다. `npx -y universal-peer-mcp` 도 같다 |
| `npm install -g "github:sunsquare26-ai/universal-peer-mcp#<tag>"` | **저장소가 공개된 뒤 된다.** `<tag>` 는 Releases 의 태그로 바꾼다. 저장소가 아직 공개 전이라 여기서 실측하지 않았다 |
| 직접 pack 한 tarball 을 설치 | **실측했다.** `test/install.test.mjs` 가 pack → 빈 prefix 에 설치 → 설치된 bin 실행 → 제거까지 네트워크 없이 돌린다 |

clone 에서 시작한다면 검증된 경로는 두 줄이다.

```sh
npm pack
npm install -g "./universal-peer-mcp-$(node -p "require('./package.json').version").tgz"
universal-peer-mcp doctor
```

`doctor` 는 읽기만 한다. 토큰·프로세스 인자를 출력하지 않고, 내 홈을 가리키는 `~` 말고는 절대경로를 찍지 않는다.

요약 필드는 이렇게 나온다.

```json
{
  "ok": true,
  "platform": "darwin",
  "arch": "arm64",
  "runtime": "Bun 1.3.11",
  "stateDirectory": "~/Library/Application Support/claude-peer-mcp",
  "stateDirectorySource": "default",
  "note": "doctor does not print tokens or process arguments",
  "writes": "none — doctor never creates the state directory or any file"
}
```

전체 출력에는 `system`·`runtimes`·`state`·`targets`·`claudeRegistry`·`codexWake` 가 더 붙는다. 그 전부가 만족돼야 `ok` 가 `true` 다. 항목별 읽는 법은 [troubleshooting.md](troubleshooting.md) 에 있다.

## 2. 대상이 될 Claude Code 세션을 사람이 직접 연다

이 도구는 세션을 띄우지 않는다. 사람이 직접 열고, 그때 고른 권한이 그대로 상한이 된다.

**PATH 의 이름만으로 띄우면 안 된다.** 권한 증명은 커널이 준 argv 를 읽는데, 이름만으로 띄운 프로세스는 `argv[0]` 과 실행 파일 경로가 달라 `target argv executable mismatch` 로 닫힌다([troubleshooting.md](troubleshooting.md) 참고). 절대경로로 띄운다.

```sh
"$(command -v claude)" --permission-mode acceptEdits
```

- **우회 권한(`bypassPermissions`)을 권장하지 않는다.** 사용자가 고른 권한을 그대로 증명할 뿐이며, 이 도구에는 권한을 올리는 명령이 없다.
- Claude Code 2.1.260 의 `--permission-mode` 는 `acceptEdits`·`auto`·`bypassPermissions`·`manual`·`dontAsk`·`plan` 을 받는다(2026-09-07 실측). 이 중 지금 증명되는 값은 `acceptEdits`·`auto`·`plan`(→ `prompting`)과 `bypassPermissions`(→ `bypass`) 다. `manual`·`dontAsk` 로 띄운 세션은 증명이 안 돼 전송이 막힌다.
- 플래그를 아예 빼면 `permission mode argv cannot be proven` 으로 실패한다. 재보지 않은 기본값을 가정하지 않기 때문이다.

## 3. session UUID 와 cwd 를 확인한다

실행 중인 세션마다 `~/.claude/sessions/<pid>.json` 이라는 `0600` 파일이 있고 그 안에 `sessionId`·`pid`·`procStart`·`cwd`·`peerProtocol`·`peerFeatures` 가 들어 있다. 붙이려는 세션의 파일에서 `sessionId` 와 `cwd` 를 읽는다. Claude Code 의 비공개 인터페이스이며 문서화된 API 가 아니다 — 판이 올라가면 모양이 바뀔 수 있다.

화면에 보이는 세션 이름은 주소가 아니다. 주소로 쓰는 값은 언제나 `sessionId` 뿐이다.

## 4. 허용 목록에 넣는다

상태는 패키지 밖 사용자 전용 경로에 둔다. 디렉터리는 `0700`, 파일은 `0600` 이라야 데몬이 뜬다.

```sh
mkdir -p ~/Library/Application\ Support/claude-peer-mcp
chmod 700 ~/Library/Application\ Support/claude-peer-mcp
cp "$(npm root -g)/universal-peer-mcp/targets.example.json" ~/Library/Application\ Support/claude-peer-mcp/targets.json
chmod 600 ~/Library/Application\ Support/claude-peer-mcp/targets.json
```

`npm root -g` 는 전역 패키지가 설치된 자리를 찍는다. clone 에서 쓰고 있다면 체크아웃 안의 `targets.example.json` 을 복사한다.

```json
{
  "frontend-review": {
    "sessionId": "10000000-0000-4000-8000-000000000001",
    "cwd": "/path/to/project",
    "expectedDisplayName": "Frontend review",
    "permissionMode": "prompting"
  }
}
```

- 별칭은 `^[a-z][a-z0-9-]{1,47}$` 를 만족해야 한다. 내 설정 안에서만 쓰는 이름이다.
- `cwd` 는 절대경로를 글자 그대로 적는다. 심볼릭 링크를 푼 결과가 세션의 작업 폴더와 같아야 한다. 변수 확장은 없다 — `~` 나 `${HOME}` 은 글자로 읽혀 경로를 찾지 못한다.
- `permissionMode` 는 `prompting` 또는 `bypass` 다. 2단계에서 실제로 띄운 권한과 같아야 한다.
- `expectedDisplayName` 은 선택이고 진단용이다. 이름이 달라져도 전송을 막지 않는다.

예제의 `cwd` 는 존재하지 않는 자리표시자 `/path/to/project` 다. 실제 절대경로로 바꾸기 전까지 `doctor` 는 `targets.schemaValid: false` 로 나온다. 설치가 깨진 것이 아니라 파일을 읽고 있다는 뜻이다.

자세한 스키마와 환경변수는 [configuration.md](configuration.md) 에 있다.

## 5. MCP 클라이언트에 등록한다

```sh
codex mcp add claude-peer -- universal-peer-mcp serve
claude mcp add claude-peer -- universal-peer-mcp serve
```

설정 파일로 넣으려면 [../examples/codex-config.toml](../examples/codex-config.toml) 과 [../examples/claude-mcp.json](../examples/claude-mcp.json) 을 쓴다. 선택 확장은 기본 꺼짐이고 데몬을 띄울 때만 켜진다.

```sh
universal-peer-mcp serve --enable milestone --enable code-review
```

## 6. 데몬을 다시 띄운다

`targets.json` 은 데몬이 뜰 때 한 번(`src/daemon.mjs:21`), stdio 입구가 뜰 때 한 번(`src/server.mjs:7`) 읽는다. 아무도 파일을 감시하지 않는다. 설정을 고쳤으면 반드시 내렸다 올린다.

```sh
kill "$(plutil -extract pid raw -- ~/Library/Application\ Support/claude-peer-mcp/daemon.json)"
```

다음 도구 호출이 새 데몬을 띄운다. 새 별칭이 도구 목록에 보이려면 MCP 클라이언트도 다시 시작해야 한다.

## 7. 상태를 보고, 보내고, 기다린다

메시지용 CLI 는 없다. 아래는 전부 MCP 클라이언트가 부르는 도구다.

| 도구 | 하는 일 |
|---|---|
| `peer_targets` | 별칭과 설정된 권한·연결 상태를 본다 |
| `peer_status` | 전송 없이 대상 신원과 권한 증명을 다시 한다 |
| `peer_send` | 한 번 보낸다. `alias`·`messageId`·`threadId`·`kind`·`body` 가 필요하다 |
| `peer_wait` | 그 `messageId` 의 `ack`·`reply`·`idle` 을 기다린다 |
| `peer_list_events` | 커서 이후의 사건을 읽는다 |
| `daemon_status` | 가려진 데몬 상태와 사건 커서를 읽는다 |

`daemon_shutdown` 은 관리 모드로 띄운 데몬에서만 목록에 나온다.

- `messageId` 는 호출자가 만드는 값이고 그대로 멱등 키다. 같은 ID·같은 내용은 앞 결과를 돌려주고 다시 보내지 않는다. 같은 ID·다른 내용은 `MESSAGE_ID_CONFLICT` 로 거부한다.
- `body` 는 UTF-8 **바이트**로 1~65,536 이다(`src/core/limits.mjs:1`). 공개 JSON Schema 의 `maxLength: 65536` 은 글자 수라서, 한글처럼 여러 바이트를 쓰는 글은 더 일찍 한도에 닿는다. `kind` 는 `^[a-z][a-z0-9_-]{1,63}$` 를 만족하는 2~64자다.
- `peer_wait` 의 기본값은 `require: "reply"`, 30,000ms 이고 상한은 300,000ms 다. 기다림은 재전송이 아니다.
- ACK 는 「상대가 동의했다」가 아니라 정의된 표식을 받았다는 뜻이다. 결과의 `evidence` 가 `message_status`·`idle_notice`·`application_ack` 를 가른다.
- 전송이 실패하면 `DELIVERY_UNCERTAIN` 이다. 전달 여부를 모르는 상태이고 자동 재전송은 없다.

## 답할 때 — ACK/REPLY 형식

받은 쪽 세션은 `<cross-session-message ...>` 로 감싼 메시지를 본다. 열린 태그에는 보낸 쪽 주소와 표시 이름만 들어 있다 — 권한 등급은 들어 있지 않고, 그 이유와 대가는 [known-issues.md](known-issues.md) §10 에 있다. 감싼 안쪽은 사람 말이 아니라 `alias`·`messageId`·`threadId`·`replyTo`·`kind`·`body` 여섯 칸을 담은 JSON 한 줄이다. 사람이 쓴 지시는 그 `body` 에 들어 있다. 실제로 오가는 바이트는 [demo-ack.md](demo-ack.md) 2절에 그대로 있다.

답을 표식으로 인식시키려면 **메시지의 첫 줄**이 아래 형태여야 한다. 첫 줄이 아니면 표식으로 잡히지 않는다.

```text
PEER_ACK v=1 message_id=<새 UUID> thread_id=<받은 thread_id> reply_to=<받은 message_id>
```

```text
PEER_REPLY v=1 message_id=<새 UUID> thread_id=<받은 thread_id> reply_to=<받은 message_id> verdict=pass
```

- `reply_to` 에는 받은 메시지의 `messageId` 를 그대로 넣는다. 이 값으로 짝을 맞춘다.
- `PEER_ACK` 에는 `verdict` 를 붙이지 않는다. 붙이면 표식으로 인정되지 않는다.
- `PEER_REPLY` 에는 `verdict=pass` 또는 `verdict=fail` 이 반드시 있어야 한다.
- 세 UUID 는 모두 정규 UUID 형식이어야 한다.
- 본문은 둘째 줄부터 쓴다.

작업을 받자마자 `PEER_ACK` 를 한 줄 보내고, 끝났을 때 `PEER_REPLY` 를 보내는 것이 기본 흐름이다. 보낸 쪽은 `peer_wait` 로 그것을 기다린다.

보내는 인자부터 받는 답까지 한 번의 왕복 전체는 [demo-ack.md](demo-ack.md) 에 있다.

## 세션을 오케스트레이터로 쓸 때

받는 세션에게 매번 규칙을 설명하지 않으려면, 그 세션의 작업 폴더에 `AGENTS.md` 를 두고 세션을 열자마자 읽히면 된다. 첫 지시에 「`AGENTS.md` 를 읽고 그대로 따르라」 한 줄이면 충분하다.

`AGENTS.md` 에는 위 ACK/REPLY 형식, 그 저장소의 시험 명령, 보고 형식처럼 **매번 같은 것**만 적는다. 회사 고유 규칙은 이 저장소가 아니라 그 폴더의 `AGENTS.md` 쪽에 둔다.

`cwd` 는 허용 목록에 적은 그 폴더여야 한다. 세션이 다른 폴더에서 돌고 있으면 `target cwd mismatch` 로 막힌다.

## 제거

```sh
kill "$(plutil -extract pid raw -- ~/Library/Application\ Support/claude-peer-mcp/daemon.json)"
codex mcp remove claude-peer
claude mcp remove claude-peer
npm uninstall -g universal-peer-mcp
rm -rf ~/Library/Application\ Support/claude-peer-mcp
```

마지막 줄은 허용 목록과 사건 기록을 지운다. 그 디렉터리 밖은 건드리지 않는다.

## 막혔을 때

증상별 대응은 [troubleshooting.md](troubleshooting.md) 에 있다. 여기서 실패는 전부 「확인이 안 되면 보내지 않는다」쪽으로 닫힌다. 검사를 푸는 것이 아니라 사실을 맞추는 것이 해결이다.

## 라이선스와 상표

Apache-2.0. Copyright 이형석. Anthropic·Claude·OpenAI·Codex 상표는 각 소유자에게 있다. Anthropic 이나 OpenAI 의 공식 프로젝트가 아니다. [TRADEMARKS.md](../TRADEMARKS.md) 를 참고한다.
