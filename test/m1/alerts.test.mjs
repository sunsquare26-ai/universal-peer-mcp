import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import { AlertSink } from "../../src/core/alerts.mjs";
import { tempRoot } from "./helpers.mjs";

const roots = [];
afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }); });

test("one line per incident key, 0600, closed fields; bridge runs with a fixed argv", async () => {
  const root = await tempRoot(); roots.push(root);
  const bridge = path.join(root, "bridge"); const out = path.join(root, "bridge.out");
  await fsp.writeFile(bridge, `#!/bin/sh\necho "$@" >> ${out}\n`, { mode: 0o700 });
  const sink = new AlertSink({ file: path.join(root, "alerts.jsonl"), command: bridge });
  expect((await sink.raise({ kind: "ledger_poisoned", key: "ledger_poisoned:gen1", code: "EACCES" })).raised).toBe(true);
  expect((await sink.raise({ kind: "ledger_poisoned", key: "ledger_poisoned:gen1", code: "EACCES" })).duplicate).toBe(true);
  // A new process reads the file and still dedupes.
  expect((await new AlertSink({ file: path.join(root, "alerts.jsonl") }).raise({ kind: "ledger_poisoned", key: "ledger_poisoned:gen1" })).duplicate).toBe(true);
  const lines = (await fsp.readFile(path.join(root, "alerts.jsonl"), "utf8")).trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(["at", "code", "key", "kind", "pid", "schema"]);
  expect((await fsp.stat(path.join(root, "alerts.jsonl"))).mode & 0o777).toBe(0o600);
  expect((await fsp.readFile(out, "utf8")).trim()).toBe("universal-peer ledger_poisoned ledger_poisoned:gen1 EACCES");
});

test("free text cannot be an alert", async () => {
  const root = await tempRoot(); roots.push(root);
  const sink = new AlertSink({ file: path.join(root, "alerts.jsonl") });
  await expect(sink.raise({ kind: "ledger_poisoned", key: "사장님 승인 필요" })).rejects.toThrow();
  await expect(sink.raise({ kind: "anything", key: "k" })).rejects.toThrow();
  await expect(sink.raise({ kind: "backup_failed", key: "k", code: "rm -rf /" })).rejects.toThrow();
});

test("a bridge that others can write is not run", async () => {
  const root = await tempRoot(); roots.push(root);
  const bridge = path.join(root, "bridge"); await fsp.writeFile(bridge, "#!/bin/sh\nexit 0\n", { mode: 0o777 }); await fsp.chmod(bridge, 0o777);
  const r = await new AlertSink({ file: path.join(root, "alerts.jsonl"), command: bridge }).raise({ kind: "backup_failed", key: "backup_failed:2026-09-29" });
  expect(r.bridge).toEqual({ configured: true, ran: false, reason: "command_not_private" });
});
