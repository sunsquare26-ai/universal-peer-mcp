import fs from "node:fs";
import readline from "node:readline";
import { dailyStats, traceMessage } from "./core/trace.mjs";
import { dayOf } from "./core/days.mjs";
import { sendDoorbell } from "./core/doorbell.mjs";

// `universal-peer-mcp trace <messageId> [--ledger <events.jsonl>]`
// `universal-peer-mcp stats [--days N] [--ledger <events.jsonl>]`
// `universal-peer-mcp doorbell --thread <uuid> --message-id <uuid> [--alias <alias>]`
// `universal-peer-mcp body-dispose --seq <n> --disposition processed|discard`
// `universal-peer-mcp post --to a[,b] --body-file f [--group-id uuid] [--expect-reply]` | `inbox --recipient a` | `inbox-ack --message-id id`
// `universal-peer-mcp register --alias <name> [--replace]` | `unregister --alias <name>` | `peers` | `whoami` | `link --post <id>`   (M4)
// `universal-peer-mcp link --seq <n> --message-id <request id> --as ack|reply [--verdict pass|fail]`
//
// With --ledger the file is read directly, read-only, and no daemon is contacted — the way to read
// a copied ledger days later. Without it the running daemon answers. Output is JSON with ids,
// stages, times, codes and masked first lines; never a body.
// operator(interactive-tty): the phrase is asked only at an interactive terminal; anywhere else the
// command is sent without it and the daemon decides (own items pass, others are refused).
async function operatorArgs(target) {
  const { askOperator } = await import("./core/operator.mjs");
  const confirm = await askOperator(target);
  return confirm === null ? {} : { operator: { confirm } };
}
function option(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

async function readLedger(file) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { flags: "r" }), crlfDelay: Infinity });
  for await (const line of rl) if (line) rows.push(JSON.parse(line));
  return rows;
}

export async function observeCommand(command, args) {
  const ledger = option(args, "--ledger");
  if (command === "trace") {
    const messageId = args.find((a) => /^[0-9a-f-]{36}$/i.test(a));
    if (!messageId) throw new Error("usage: trace <messageId> [--ledger <events.jsonl>]");
    if (ledger) return traceMessage(await readLedger(ledger), messageId);
    const { controlCall } = await import("./core/control.mjs");
    return controlCall("trace_message", { messageId });
  }
  if (command === "stats") {
    const days = Number(option(args, "--days") ?? 30);
    if (ledger) return { days: dailyStats(await readLedger(ledger), { sinceDay: dayOf(Date.now() - (days - 1) * 86_400_000) }) };
    const { controlCall } = await import("./core/control.mjs");
    return controlCall("ledger_daily_stats", { days });
  }
  if (command === "doorbell") {
    const { controlCall } = await import("./core/control.mjs");
    const result = await sendDoorbell({
      threadId: option(args, "--thread"), messageId: option(args, "--message-id"), alias: option(args, "--alias") ?? null,
      cliPath: process.env.UNIVERSAL_PEER_CODEX_CLI || "/opt/homebrew/bin/codex",
      trace: (attempt) => controlCall("trace_attempt", attempt)
    });
    if (result.state === "not_sent") process.exitCode = 3;
    else if (result.state !== "queued") process.exitCode = 4;
    return result;
  }
  if (command === "body-dispose") {
    // The explicit way a kept body leaves: recorded first, then (for discard) deleted.
    const sourceSeq = Number(option(args, "--seq")); const disposition = option(args, "--disposition");
    const { controlCall } = await import("./core/control.mjs");
    return controlCall("inbound_body_dispose", { sourceSeq, disposition, ...(await operatorArgs(String(sourceSeq))) });
  }
  if (command === "post") {
    // The sender writes only the text. Ids and the first line are the tool's (M2).
    const to = (option(args, "--to") ?? "").split(",").filter(Boolean);
    const bodyFile = option(args, "--body-file"); const replyTo = option(args, "--reply-to");
    if (!bodyFile || (!replyTo && to.length === 0)) throw new Error("usage: post --to a[,b] --body-file f [--group-id uuid] | post --reply-to <messageId> --body-file f [--group-id uuid: send the same text again as a new message]");
    const body = fs.readFileSync(bodyFile, "utf8");
    const { controlCall } = await import("./core/control.mjs");
    return controlCall("peer_post", { ...(to.length ? { to } : {}), body, ...(replyTo ? { replyTo } : {}), ...(option(args, "--group-id") ? { groupId: option(args, "--group-id") } : {}), ...(args.includes("--expect-reply") && !replyTo ? { expectReply: true } : {}) });
  }
  if (command === "inbox") { const { controlCall } = await import("./core/control.mjs"); const recipient = option(args, "--recipient"); const messageId = option(args, "--message-id"); return controlCall("peer_inbox", { ...(recipient ? { recipient } : {}), ...(messageId ? { messageId } : {}) }); }
  // M4 onboarding. `register` is run by the session being registered (its own shell), which is what
  // proves it; the alias is the only thing it says about itself.
  if (command === "register") {
    const alias = option(args, "--alias");
    if (!alias) throw new Error("usage: register --alias <name> [--replace]");
    const { controlCall } = await import("./core/control.mjs");
    return controlCall("peer_register", { alias, ...(args.includes("--replace") ? { replace: true } : {}) });
  }
  if (command === "unregister") {
    const alias = option(args, "--alias");
    if (!alias) throw new Error("usage: unregister --alias <name>");
    const { controlCall } = await import("./core/control.mjs");
    return controlCall("peer_unregister", { alias, ...(await operatorArgs(alias)) });
  }
  if (command === "peers") { const { controlCall } = await import("./core/control.mjs"); return controlCall("peer_directory", {}); }
  if (command === "whoami") { const { controlCall } = await import("./core/control.mjs"); return controlCall("peer_whoami", {}); }
  if (command === "inbox-ack") { const { controlCall } = await import("./core/control.mjs"); return controlCall("peer_inbox_ack", { messageId: option(args, "--message-id") }); }
  if (command === "link") {
    const { controlCall } = await import("./core/control.mjs");
    // M4: `link --post <messageId>` re-addresses a held post to its alias's current session (Owner only).
    if (option(args, "--post")) return controlCall("peer_post_relink", { messageId: option(args, "--post"), ...(await operatorArgs(String(option(args, "--post")).toLowerCase())) });
    return controlCall("peer_link_unmatched", { ...(await operatorArgs(String(Number(option(args, "--seq"))))), sourceSeq: Number(option(args, "--seq")), messageId: option(args, "--message-id"), as: option(args, "--as"), ...(option(args, "--verdict") ? { verdict: option(args, "--verdict") } : {}) });
  }
  throw new Error("unknown command");
}
