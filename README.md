# Claude MCP

Claude Code는 같은 컴퓨터에서 다른 Claude 세션으로 일을 넘길 수 있습니다. Claude MCP는 Codex 같은 로컬 MCP 클라이언트도 그 대화에 참여하게 해줍니다. 이미 실행 중이고 사용자가 허용 목록에 넣은 세션에만 연결합니다.

지금 공개 준비 중인 초기판입니다. macOS와 Bun에서 동작하며 Claude Code의 비공개 로컬 연결 형식을 사용합니다. Anthropic, Claude, OpenAI, Codex 상표는 각 소유자에게 있습니다. Anthropic이나 OpenAI의 공식 프로젝트가 아닙니다.

사용자 상태는 패키지 바깥 `~/Library/Application Support/claude-peer-mcp/`에 둡니다. 같은 Mac의 같은 사용자 계정이 신뢰 경계입니다. 대상 설정을 바꾼 뒤에는 데몬을 다시 시작해야 합니다.
