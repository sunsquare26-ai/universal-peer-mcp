import { expect, test } from "bun:test";
import os from "node:os";
import { FIRST_LINE_MAX_CHARS, maskFirstLine } from "../../src/core/mask.mjs";

test("only the first line is kept", () => {
  expect(maskFirstLine("PEER_ACK re=14e6f292\n두 번째 줄의 본문은 남지 않습니다")).toBe("PEER_ACK re=14e6f292");
  expect(maskFirstLine("\n")).toBeNull();
  expect(maskFirstLine("")).toBeNull();
});

test("personal and secret values are masked", () => {
  const line = `김민희 760124-1234567 010-1234-5678 a.b@example.com 계좌 110-123-456789 api_key=abcdef123456 ${os.homedir()}/x.txt sk-abcdefghijk`;
  const masked = maskFirstLine(line);
  for (const leak of ["760124-1234567", "010-1234-5678", "a.b@example.com", "110-123-456789", "abcdef123456", os.homedir(), "sk-abcdefghijk"]) expect(masked).not.toContain(leak);
  expect(masked).toContain("[rrn]"); expect(masked).toContain("[phone]"); expect(masked).toContain("[email]"); expect(masked).toContain("[number]");
});

test("already-masked registration numbers are masked too, dates and ids are kept", () => {
  expect(maskFirstLine("주민번호 760124-1******")).not.toContain("760124");
  const kept = maskFirstLine("2026-09-29 배포 34f59f3e d7e3473e-c0bf-42ba-9fd2-f1aa9c50a216");
  expect(kept).toContain("2026-09-29"); expect(kept).toContain("34f59f3e"); expect(kept).toContain("d7e3473e-c0bf-42ba-9fd2-f1aa9c50a216");
});

test("the line is capped", () => {
  const masked = maskFirstLine("가".repeat(500));
  expect([...masked].length).toBe(FIRST_LINE_MAX_CHARS + 1);
  expect(masked.endsWith("…")).toBe(true);
});
