// The one place the strength order between two kinds of evidence is written down.
//
// A peer that answered a message necessarily received it, so a reply is strictly stronger evidence
// than an ACK and a caller waiting for the weaker one is already satisfied. Measured on
// 2026-09-10T07:20:06Z: message a93dde78-… had a `verdict=pass` reply sitting in the ledger while a
// `require: "ack"` wait ran its full 30 s and expired, because the wait asked for one event type by
// name and a reply is not that name. The ledger had the answer and the caller was told there was
// none.
//
// The promotion is one-directional and that direction is the whole point. `require: "reply"` is not
// satisfied by an ACK: an ACK says the message was taken and says nothing about whether an answer
// will ever come, so reading one as the other would report an answer that does not exist.
//
// `idle`, `delivery` and `terminal` are deliberately not on this chain. They are different facts
// about a message rather than weaker forms of the same fact — an idle notice is about the peer's
// state, a terminal failure is about the message being refused — and promoting between them would
// answer a question the caller did not ask. Every reader of this order imports it from here; it is
// not restated anywhere else.
const ACK = Object.freeze({ type: "peer_ack" });
const REPLY = Object.freeze({ type: "peer_reply" });

export const WAIT_EVIDENCE = Object.freeze({
  ack: Object.freeze([ACK, REPLY]),
  reply: Object.freeze([REPLY]),
  idle: Object.freeze([Object.freeze({ type: "peer_idle_notice" })]),
  delivery: Object.freeze([Object.freeze({ type: "peer_message_status", status: "delivered" })]),
  terminal: Object.freeze([Object.freeze({ type: "peer_terminal_failure" })])
});

// A requirement this build does not know is not silently widened to one it does. `hasOwnProperty`
// rather than a bare lookup, because `require: "constructor"` is a string a caller can send.
export function waitEvidence(requirement) {
  return Object.prototype.hasOwnProperty.call(WAIT_EVIDENCE, requirement) ? WAIT_EVIDENCE[requirement] : null;
}

// Does this ledger row satisfy one of the accepted kinds of evidence? A kind with a `status` names
// both the event type and the one status on it that counts; a kind without one is satisfied by the
// type alone.
export function satisfies(accepted, event) {
  return accepted.some((kind) => kind.type === event?.type && (kind.status === undefined || event?.status === kind.status));
}
