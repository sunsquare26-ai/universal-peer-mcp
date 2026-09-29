import { expect, test } from "bun:test";
import { protocolHeader } from "../../src/core/protocol-header.mjs";

const ID = "d7e3473e-c0bf-42ba-9fd2-f1aa9c50a216"; const TH = "9f9f218b-7474-40df-a166-e37d9bcf1a84";

test("a protocol first line keeps only allowlisted fields with id-shaped values", () => {
  expect(protocolHeader(`PEER_REPLY v=1 message_id=${ID} thread_id=${TH} reply_to=${ID} verdict=PASS\n본문`)).toEqual({ verb: "PEER_REPLY", v: "1", messageId: ID, threadId: TH, replyTo: ID, verdict: "pass" });
  expect(protocolHeader("PEER_ACK re=14e6f292 thread=9f9f218b")).toEqual({ verb: "PEER_ACK", replyTo: "14e6f292", threadId: "9f9f218b" });
  expect(protocolHeader(`PEER_DOORBELL v=1 message_id=${ID}`)).toEqual({ verb: "PEER_DOORBELL", v: "1", messageId: ID });
});

// Counterexamples: free text in any position leaves nothing but the verb and ids.
const LEAKS = ["김서연", "481927", "서울시 강남구 테헤란로 123", "010-1234-5678", "760124-1234567", "a.b@example.com", "비밀번호", "hello"];
test("names, OTPs, addresses, phone numbers and free text never survive", () => {
  const bodies = [
    "김서연 직원 인사 기록 확인 부탁",
    "OTP 481927 입력해 주세요",
    "주소: 서울시 강남구 테헤란로 123",
    "hello 010-1234-5678 a.b@example.com",
    `PEER_ACK re=14e6f292 note=김서연 otp=481927 addr=서울시 강남구 테헤란로 123`,
    `PEER_REPLY re=14e6f292 verdict=김서연 kind=otp-481927 | 760124-1234567 비밀번호`,
    `PEER_POST message_id=481927 thread=김서연 re=hello`,
    `김서연 PEER_ACK re=14e6f292`
  ];
  for (const body of bodies) {
    const text = JSON.stringify(protocolHeader(body));
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  }
  expect(protocolHeader("김서연 직원 인사 기록 확인 부탁")).toBeNull();
  expect(protocolHeader("PEER_POST message_id=481927 thread=김서연 re=hello")).toEqual({ verb: "PEER_POST" });
  expect(protocolHeader("")).toBeNull();
});

test("a second line is never read", () => {
  expect(protocolHeader(`plain first line\nPEER_ACK re=14e6f292`)).toBeNull();
});
