# 옆으로 설치하기 — 돌고 있는 데몬을 죽이지 않고 새 판 올리기

이 문서는 **이미 데몬이 돌고 있는 기계**에 새 판을 올리는 절차다. 처음 설치하는 기계라면
`README.md` 를 따르면 된다.

전제는 하나다. **돌고 있는 옛 데몬을 죽이지 않는다.** 죽일 필요도 없다.

데몬은 **state 디렉터리 하나당 하나**다. 소켓·원장·대상 표·잠금이 전부 그 디렉터리 안에 있고,
디렉터리가 다르면 두 데몬은 서로를 모른다. 그래서 새 판은 **새 state 디렉터리**에 올린다.
제자리 업그레이드 경로는 이 판에 없다 — `daemon_shutdown` 은 `admin` 뒤에 있어 보통은 도구
목록에 나오지도 않는다(`known-issues.md` §7).

이 문서의 경로·id 는 전부 **자리표시자**다. **베끼지 말고 각자 재라.**

---

## 어느 파일을 까는가 — 꾸러미에 든 tarball 이 여럿이다

꾸러미에는 지난 판이 함께 들어 있다. **지운 것이 아니라 남긴 것이므로, 어느 것을 까는지 먼저
확인한다.**

| tarball | 상태 |
|---|---|
| `universal-peer-mcp-0.1.0-20260907-r1.tgz` | **이 판을 깐다** |
| `claude-peer-mcp-0.1.0-20260907-p4-closed.tgz` | 상위 판 있음. 위 판으로 대체됐다 — 개명뿐이다 |
| `claude-peer-mcp-0.1.0-20260907-p3-closed.tgz` | 상위 판 있음. 위 판으로 대체됐다 |
| `claude-peer-mcp-0.1.0-20260907-p2-closed.tgz` | 상위 판 있음. 위 판으로 대체됐다 |
| `claude-peer-mcp-0.1.0-20260907-p1-closed.tgz` | 상위 판 있음. 위 판으로 대체됐다 |
| `claude-peer-mcp-0.1.0-20260907-294a8769.tgz` | **설치 금지.** 감수 P1 두 건이 막고 있는 판이다 |
| `claude-peer-mcp-0.1.0.tgz` | 그 이전 판. 참고용 |

`294a8769` 판(SHA-256 `294a876972f413f745451146f1ed1d14d1750faf9a5ac2df2a75d5f118296831`)이 막힌
이유는 둘이고, 둘 다 `p1-closed` 에서 닫혔다 — 나가는 봉투가 **받는 쪽의 권한 등급을 보내는 쪽
등급이라고 선언**했고, **본문이 봉투를 닫고 두 번째 봉투를 열 수 있었다.** 경위는
`known-issues.md` §10 에 있다. **이 판은 설치 금지가 아니라 그냥 낡은 판이다.**

`p1-closed` 판이 대체된 이유는 셋이다. 경위는 `known-issues.md` §11 에 있다.

- **본문의 봉투 방패를 이미 만들어진 JSON 줄에 걸고 있었다.** 닫는 태그를 흉내 낸 글자가 본문에
  있으면 그 줄이 **아예 파싱이 안 되거나**, 더 나쁘게는 **받는 쪽 본문이 조용히 달라졌다.**
- **대상 표를 건수로만 비교했다.** 같은 별칭을 A 세션에서 B 세션으로 옮겨도 건수가 같아서 어긋난
  줄 모르고, 데몬은 계속 A 로 보냈다. 이제는 **내용으로 비교**하고, 어긋나면 별칭을 쓰는 호출을
  **막는다.**
- **`peer_targets` 가 배열로 답했다.** 2025-06-18 규격은 `structuredContent` 를 객체로 못박고
  있어서, 엄격한 클라이언트는 그 호출을 거부했다. 이제 `{"targets": [...]}` 로 답한다.
  **위치 0 을 읽던 호출자는 고쳐야 한다.**

`p2-closed` 판이 대체된 이유는 넷이다. 경위는 `known-issues.md` §12 에 있다.

- **표를 검사한 요청과 그 표로 실행하는 요청이 서로 다른 요청이었다.** 그 사이에 데몬이 바뀌거나
  표가 다시 써지면, 검사한 표가 아닌 다른 표로 실행됐다. 실기계 재현: A 세션으로 검사한 별칭이
  한 요청 뒤에 B 세션을 가리키는 표를 든 데몬에게 답을 받았다. 이제 **명령이 검사한 데몬·표를
  같이 지고 가고, 데몬이 디스패치 전에 대조해 어긋나면 거부한다.**
- **`milestone_recover_ack` 은 별칭을 인자로 받지 않아 별칭 검문을 통째로 지나갔다.** 표에서
  대상을 빼도 복구는 나갔다. 이제 같은 검문을 지나고, **지금 표에 없으면 아무것도 적기 전에
  거부한다.**
- **대상 표를 못 읽으면 마지막으로 읽은 표를 계속 썼다.** 읽기 실패는 사본이지 판독이 아니다.
  이제 **읽기에 실패하면 다음 성공까지 모든 별칭을 내린다.**
- **복구 전송이 인코딩 안 된 본문을 썼다.** §11 이 첫 전송에서 닫은 결함이 옆 함수에 살아
  있었다. 두 전송 모두 인코딩한다.

`p3-closed` 판이 대체된 이유는 여섯이다. 경위는 `known-issues.md` §13 에 있다.

- **받은 ACK·회신이 아무것에도 상관되지 않았다.** 상대는 봉투에 싸서 답하는데 core 가 봉투를
  벗기지 않고 마커를 찾았다. 마커는 첫 줄 첫 바이트에 걸려 있고 싸인 메시지의 첫 바이트는 `<`
  다. 그래서 **`peer_ack`·`peer_reply` 가 원장에 한 건도 없었고**, `acknowledged`·`replied`
  상태에 도달할 방법이 없었다. 실기계 원장 셋에서 0건으로 확인했다. 봉투를 벗기는 자리는 이제
  한 곳이고 core 와 확장 둘이 그것을 쓴다. **`peer_wait` 이 답을 못 받고 타임아웃하던 것이 이
  결함이다.**
- **인증·상관에 성공한 회신에만 불리는 훅이 없었다.** 프레임 관찰자는 모든 프레임에 불려서
  회신 경로를 그 위에 세울 수 없다. `onCorrelatedReply` 가 그 자리다. 계약은
  `docs/correlated-reply-hook.md` — **저장소 밖 구현이 이 문서에 붙는다.**
- **대상 하나의 작업 폴더가 없으면 대상 표 전체가 조용히 사라졌다.** 그 상태에서는 수신 소켓도
  안 열려 **인바운드가 원천 차단**됐고, `daemon_status` 는 갓 설치한 기계와 똑같이 답했다.
  README 대로 `cp targets.example.json` 하고 고치기 전에 켜면 첫 기동이 이 상태다. 이제 표
  자체가 없는 것과 대상 하나가 잘못된 것을 가르고, 후자면 **데몬이 그 폴더 이름을 말하며 안
  뜬다.**
- **실패한 소켓 쓰기가 성공으로 기록됐다.** 쓰기 콜백의 오류 인자를 버리고 있었다. 상대가
  거절하며 연결을 끊은 뒤의 쓰기는 한 바이트도 안 나갔는데 `socket_write_complete` 가 남고
  상태는 `written` 이 됐다. 이제 오류 인자와 소켓이 실제로 실어 보낸 바이트 수를 함께 보고,
  둘 중 하나라도 어긋나면 실패다. **원장의 바이트 수는 의도한 길이가 아니라 실측값이다.**
- **UUID 6·7·8 판을 공개 결과 검증기가 거부했다.** 상대가 v7 id 로 답하면 그 messageId 의
  도구가 영구히 `invalid_public_result` 로 죽었다. 입구(`requireUuid`)는 이미 받고 있었다.
- **우리가 쓴 값이 우리 공개 계약을 어기던 세 자리.** 유휴 알림의 `state` 무검증, 코드리뷰
  영수증의 `transportMessageId: null`, 초과 프레임 거절의 서수 `0`. 앞의 둘은 그 메시지의 읽기
  도구를 죽였다.

**보내는 쪽 이름이 바뀐다** — 봉투의 `from-name` 이 `Claude MCP` 에서 `claude-peer-mcp` 로
바뀌었다. 코덱스가 보내도 「Claude MCP」로 뜨던 것을 고친 것이다. 데몬은 어느 클라이언트가
불렀는지 인증하지 못하므로 「코덱스」라고 적을 수도 없고, 증명할 수 있는 이름은 봉투를 쓴
프로그램 이름뿐이다. **받는 쪽 화면의 표시 이름이 달라진다.**

`p4-closed` 판이 대체된 이유는 **개명 하나뿐이다. 기능·계약·시험의 의미는 그대로다.**

| 무엇 | 옛것 | 새것 |
|---|---|---|
| 패키지·바이너리 | `claude-peer-mcp` | `universal-peer-mcp` |
| 환경변수 | `CLAUDE_PEER_MCP_STATE_DIR` | `UNIVERSAL_PEER_MCP_STATE_DIR` |
| 저장소 | `sunsquare26-ai/claude-peer-mcp` | `sunsquare26-ai/universal-peer-mcp` |
| 봉투의 `from-name` | `claude-peer-mcp` | `universal-peer-mcp` |
| 데몬 자신의 세션 이름 | `Claude MCP` | `universal-peer-mcp` |

**바뀌지 않는 것도 적어 둔다.**

- **어댑터 이름 `claude-native-v1` 은 그대로다.** 그건 진짜로 Claude 전용 프로토콜이고, 개명의
  이유가 바로 **제품 이름을 위로 올리고 벤더별 어댑터를 그 아래 두는 것**이다.
- **MCP 클라이언트에 등록한 서버 키(`claude-peer`)는 그대로다.** 그건 클라이언트 소유자가 정한
  이름이라 이 꾸러미가 바꾸지 않는다. 도구 이름도 그대로다.
- **state 기본 디렉터리는 `~/Library/Application Support/claude-peer-mcp` 그대로다.** 환경변수는
  두 이름으로 동시에 읽을 수 있지만 디렉터리는 두 곳에 동시에 있을 수 없다. 옮기면 이미 쌓인
  원장이 아무도 안 보는 자리에 남고 새 자리는 갓 설치한 것처럼 뜬다 — 조용히 틀리는 쪽이다.
- **`onCorrelatedReply/v1` 훅 이름과 필드는 그대로다.** 저장소 밖 구현이 이미 그 계약에 붙는다.
- **`CLAUDE_PEER_MCP_ADMIN`·`CLAUDE_PEER_MCP_EXTENSIONS` 는 그대로다.** 이번 개명은 state
  디렉터리 변수 하나만 옮겼다.

### 옛 환경변수를 쓰던 설치가 고칠 것 — 자리 셋

> **옛 바이너리를 가리키는 설정은 환경변수만 바꾸지 마십시오.**
> 이전 판의 바이너리는 새 환경변수 이름을 모릅니다. 그 설정에서 이름만 새것으로 바꾸면
> 옛 바이너리가 상태 디렉터리를 못 찾아 기본 자리로 조용히 떨어집니다 — 바꾸기 전보다 나쁩니다.
> 그런 설정은 **고치지 말고 새 설정을 따로 만들어 대체**하고, 옛것은 되돌릴 자리로 남겨 두십시오.
> 환경변수만 바꿔도 되는 것은 **새 바이너리를 이미 가리키는 설정**뿐입니다.

**당장 깨지지는 않는다.** 새 판은 `UNIVERSAL_PEER_MCP_STATE_DIR` 를 먼저 읽고, 없고 옛 이름만
있으면 **그 값을 쓰되 stderr 에 한 줄 경고**를 낸다. 그러니 고치는 것은 급한 일이 아니라
**남아 있으면 언젠가 조용히 깨질 일**이다 — 옛 이름은 다음 판들 중 하나에서 읽히지 않게 된다.

**둘 다 넣고 값이 다르면 프로세스가 안 뜬다.** 하나를 골라 주지 않는다 — 고른 쪽이 아닌
디렉터리에 설치의 나머지 절반이 있게 되기 때문이다. 값이 같으면 아무 말도 하지 않는다.

이 기계에서 옛 이름을 물고 있는 자리는 **셋**이다. 경로는 자리표시자이니 각자 자기 것을 연다.

| 자리 | 무엇을 고치나 |
|---|---|
| `mcp-config-v2.json` | `env` 의 키 이름과 `command` 의 bin 경로 |
| `mcp-config-v3.json` | 같음 |
| `.codex/config.toml` | `env = { … }` 의 키 이름과 `command` 의 bin 경로 |

```jsonc
// 옛것
{"mcpServers":{"claude-peer":{"command":"…/bin/claude-peer-mcp","args":["serve"],
  "env":{"CLAUDE_PEER_MCP_STATE_DIR":"…"}}}}

// 새것 — 서버 키 `claude-peer` 는 그대로 둔다
{"mcpServers":{"claude-peer":{"command":"…/bin/universal-peer-mcp","args":["serve"],
  "env":{"UNIVERSAL_PEER_MCP_STATE_DIR":"…"}}}}
```

어느 이름으로 읽혔는지는 `doctor` 가 말한다.

```sh
… doctor | grep stateDirectorySource
# "stateDirectorySource": "UNIVERSAL_PEER_MCP_STATE_DIR"   ← 다 고친 상태
# "stateDirectorySource": "CLAUDE_PEER_MCP_STATE_DIR"      ← 아직 옛 이름을 물고 있다
```

**운영에서 달라지는 것 하나** — 검사와 명령 사이에 데몬을 다시 띄우면 그 명령은 한 번
`target_unavailable` 로 거부된다. `daemon_status` 를 다시 읽고 다시 부르면 된다.

이 판의 파일명에는 해시가 없다. 자기 자신의 해시를 자기 안에 적을 수 없기 때문이고, 그래서
**해시는 꾸러미의 `SHA256SUMS.txt` 한 곳에만 있다.** 깔기 전에 맞춘다.

```sh
shasum -a 256 -c SHA256SUMS.txt
```

---

## 먼저 알아야 할 함정 둘 — 여기서 틀리면 데몬이 조용히 안 뜬다

### 1. state 디렉터리 경로는 **90바이트 이하**

유닉스 소켓 경로는 104바이트가 상한이다. 데몬은 `<state 디렉터리>/control.sock` 을 열기
때문에 예산은 `state 디렉터리 + 13` 이다.

2026-09-07 실측:

| `control.sock` 전체 길이 | 결과 |
|---|---|
| 103바이트 | 뜬다 |
| 104바이트 | **안 뜬다** — `daemon readiness timed out` 하나만 남는다 |

**긴 경로가 이유라고 알려주는 메시지는 없다.** 그러니 짧은 경로를 쓴다.

```sh
STATE=/Users/example/.cpm2          # 자리표시자. 자기 홈으로 바꾼다
[ ${#STATE} -le 90 ] && echo ok || echo "too long: ${#STATE}"
```

### 2. macOS 에서 `/tmp` 는 심볼릭 링크다

`/tmp` 는 `/private/tmp` 를 가리키는 링크다. state 디렉터리는 심볼릭 링크를 거치면 거부된다
(`state directory must not traverse a symbolic link`). 실경로를 쓴다.

```sh
STATE=/private/tmp/cpm2             # O
STATE=/tmp/cpm2                     # X — 링크를 지난다
```

---

## 순서 — ① 디렉터리 ② 대상 표 ③ 설치·기동 ④ 세션 재개

**이 순서를 지킨다.** 데몬은 **기동 시점에 대상 표를 한 번만 읽는다**(`src/daemon.mjs:22`).
대상이 0건이면 receiver 자체가 뜨지 않아 아무것도 받지 못한다. 표를 나중에 써도 그 데몬은
모른다 — 다시 띄워야 한다(`known-issues.md` §5).

### ① state 디렉터리 — 0700

```sh
STATE=/Users/example/.cpm2          # 자리표시자
mkdir -p "$STATE" && chmod 700 "$STATE"
ls -ld "$STATE"                     # drwx------ 인지 눈으로 본다
```

### ② `targets.json` — 0600, 데몬을 띄우기 전에

`sessionId`·`cwd` 는 대상 세션의 `~/.claude/sessions/<pid>.json` 에서 그대로 옮긴다.
`permissionMode` 는 대상의 `--permission-mode` 값을 매핑한 값이다(`bypassPermissions` → `bypass`,
`default`·`plan`·`acceptEdits`·`auto` → `prompting`).

```sh
umask 077
cat > "$STATE/targets.json" <<'JSON'
{
  "peer": {
    "sessionId": "10000000-0000-4000-8000-000000000001",
    "cwd": "/Users/example/project",
    "permissionMode": "bypass"
  }
}
JSON
chmod 600 "$STATE/targets.json"
```

`sessionId` 와 `cwd` 는 **자리표시자다. 자기 기계에서 직접 읽어 채운다.**

```sh
cat ~/.claude/sessions/<대상 pid>.json     # sessionId·cwd 를 여기서 읽는다
```

대상 세션이 만족해야 하는 조건은 `known-issues.md` §9 에 있다. 요약하면 **절대경로로 뜬 세션**이고
**`--permission-mode` 가 인자에 있어야** 한다. 둘 중 하나라도 아니면 붙지 않는다.

### ③ 설치하고 기동

```sh
npm install -g --prefix /Users/example/.cpm2-prefix ./universal-peer-mcp-0.1.0-20260907-r1.tgz
```

전역 prefix 를 쓰기 싫으면 아무 prefix 나 잡고 그 안의 `bin/universal-peer-mcp` 를 직접 부르면 된다.
**옛 판을 덮어쓰지 않는 prefix 를 쓴다.**

기동은 MCP 클라이언트가 서버를 처음 부를 때 자동으로 된다. 그 프로세스에 **`UNIVERSAL_PEER_MCP_STATE_DIR`
가 반드시 붙어 있어야 한다.** 안 붙으면 기본 경로(`~/Library/Application Support/claude-peer-mcp`)로
가고, 그건 옛 데몬의 자리일 수 있다.

```sh
export UNIVERSAL_PEER_MCP_STATE_DIR="$STATE"
```

클라이언트 등록은 클라이언트 소유자의 결정이다. 이 패키지는 아무 설정도 쓰지 않는다.
등록 명령과 그에 해당하는 설정 블록은 `README.md` 의 「Register the server with your MCP client」에
있다. 등록할 때 그 서버의 환경변수에 `UNIVERSAL_PEER_MCP_STATE_DIR` 를 같이 넣는다.

### ④ 세션을 다시 열 때 — 재개 명령어에 `--mcp-config` 를 직접 붙인다

**세션 종료 화면이 알려주는 재개 명령어에는 `--mcp-config` 가 없다.** 그대로 베껴서 붙이면
MCP 없이 재개되고, 도구가 통째로 사라진다. 서버가 죽은 것도 데몬이 죽은 것도 아니라서 아무 오류도
안 나온다 — 도구 목록만 비어 있다. 2026-09-07 실기계에서 겪은 것이다.

**안내 문구를 베끼지 말고 `--mcp-config` 를 반드시 붙인다.**

```sh
# 화면이 알려주는 그대로 — 도구가 사라진다
claude --resume <세션 id>

# 이렇게 재개한다
claude --mcp-config /Users/example/.cpm2-mcp.json --resume <세션 id>
```

붙었는지 확인하는 방법은 아래 「확인」과 같다. 도구 목록에 `peer_status` 가 보이면 붙은 것이다.

---

## 확인 — `doctor` 먼저, 그다음 `peer_status`

### `doctor` — 아무것도 쓰지 않고 읽기만 한다

```sh
UNIVERSAL_PEER_MCP_STATE_DIR="$STATE" /Users/example/.cpm2-prefix/bin/universal-peer-mcp doctor
```

볼 곳 넷:

| 필드 | 통과 |
|---|---|
| `ok` | `true` |
| `stateDirectorySource` | `"UNIVERSAL_PEER_MCP_STATE_DIR"` — 옛 이름이 뜨면 설정을 아직 안 고친 것이다 |
| `state.mode` | `"0700"` |
| `state.files[].mode` (`targets.json`) | `"0600"` |
| `targets.count` | 방금 쓴 건수와 같다 |

`targets.count` 가 0 이면 ② 를 안 했거나 다른 디렉터리를 보고 있는 것이다. 그 상태로 기동하면
receiver 가 안 뜬다.

### `peer_status` — 실제로 붙는지

MCP 클라이언트에서 `peer_status` 를 alias 하나로 부른다. 답에 `connected: true` 와
`permission.verifiedBy: "kern_procargs2"` 가 있으면 붙은 것이다.

같이 볼 것 — `daemon_status` 의 `targetTableMismatch`. `true` 면 **데몬이 들고 있는 표와 지금
디스크에 있는 표가 다른 줄을 담고 있다는 뜻이고, 그동안 별칭을 쓰는 호출은 전부 거부된다.**
건수가 같아도 별칭 하나가 다른 세션을 가리키면 이 값이 `true` 다. 데몬을 다시 띄운다.

`targetCountMismatch` 는 **건수**만 비교한 값이다. 막는 것은 `targetTableMismatch` 쪽이다.

데몬을 다시 띄운 직후 첫 호출이 한 번 `target_unavailable` 로 떨어질 수 있다. 명령이 **검사한
데몬**을 지고 가는데 그 데몬이 방금 바뀌었기 때문이고, 다시 부르면 된다(`known-issues.md` §12).

---

## 두 데몬이 같이 도는 동안

- **옛 데몬은 건드리지 않는다.** 소켓도 원장도 대상 표도 공유하지 않는다.
- 어느 쪽이 어느 것인지는 state 디렉터리로 가른다:

```sh
ps -eo pid,command | grep -E "[c]laude-peer-mcp|[u]niversal-peer-mcp"
```

- 새 판이 마음에 안 들면 **새 데몬만** 죽이고 새 state 디렉터리를 지운다. 옛 데몬은 그대로 산다.

```sh
# 새 state 디렉터리 하나만 지운다. 옛 것 근처에 가지 않는다
rm -rf "$STATE"
```

---

## 자리표시자 정리

| 이 문서에 나오는 값 | 무엇으로 바꾸나 |
|---|---|
| `/Users/example/...` | 자기 홈 경로 |
| `10000000-0000-4000-8000-000000000001` | 대상 세션의 `sessionId` |
| `<대상 pid>` | 대상 세션의 pid |
| `universal-peer-mcp-0.1.0-20260907-r1.tgz` | 이 판의 파일명 그대로 쓴다 — 바꾸지 않는다 |

**베끼지 말고 각자 재라.** 이 문서의 길이·모드·경로는 전부 이 문서를 쓴 기계에서 잰 값이고,
바뀌는 것은 경로뿐이지만 그 경로가 위 함정 둘을 만든다.
