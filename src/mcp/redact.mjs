import os from "node:os";

const SENSITIVE_KEYS = new Set(["token", "secret", "password", "passwd", "credential", "authorization", "apikey", "privatekey", "secretkey", "key", "argv", "socket", "socketpath"]);
const SOCKET_PATH = /\/(?:[^/\s"'`]+\/)*[^/\s"'`]+\.sock\b/g;
const AUTH_VALUE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const NAMED_VALUE = /\b(?:api[_-]?key|access[_-]?token|control[_-]?token|secret|password)=[^\s&]+/gi;
const TOKEN_VALUE = /\b(?:sk|pk|rk|gh[pousr]|xox[baprs])[-_A-Za-z0-9]{8,}\b/g;
const ABSOLUTE_PATH = /(?<![A-Za-z0-9._~+/\-])(?:\/(?!\/)|(?<!:)\/{2,}(?!\/))(?:[^/\s"'`]+\/)*[^/\s"'`]*/g;

function sensitiveKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || /^(?:access|refresh|control|session|auth|bearer)(?:token|secret)$/.test(normalized);
}

export function redactPublic(value) {
  if (Array.isArray(value)) return value.map(redactPublic);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveKey(key)).map(([key, item]) => [key, redactPublic(item)]));
  if (typeof value !== "string") return value;
  return value
    .replaceAll(os.homedir(), "[home]")
    .replace(SOCKET_PATH, "[socket]")
    .replace(AUTH_VALUE, "[credential]")
    .replace(NAMED_VALUE, "[credential]")
    .replace(TOKEN_VALUE, "[credential]")
    .replace(ABSOLUTE_PATH, "[path]");
}

export function publicToolFailure(cause) {
  return ({
    INVALID_PUBLIC_RESULT: { reason: "invalid_public_result" },
    MESSAGE_ID_CONFLICT: { reason: "message_id_conflict" },
    DELIVERY_UNCERTAIN: { reason: "delivery_uncertain" },
    TARGET_UNAVAILABLE: { reason: "target_unavailable" }
  })[cause?.code] ?? { reason: "internal_failure" };
}

export function publicToolError(reason) {
  return ({
    invalid_public_result: "도구 결과가 공개 계약과 맞지 않습니다.",
    message_id_conflict: "같은 messageId에 다른 내용이 사용됐습니다. 새 messageId를 사용하세요.",
    delivery_uncertain: "전송 완료 여부를 확인할 수 없습니다. 자동 재전송하지 않았습니다.",
    target_unavailable: "대상 세션을 확인할 수 없습니다.",
    internal_failure: "로컬 도구 실행에 실패했습니다."
  })[reason];
}
