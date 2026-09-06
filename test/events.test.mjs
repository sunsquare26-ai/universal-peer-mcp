import { afterEach, describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/events.mjs";
import { statePaths } from "../src/core/state-paths.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });
async function store() { const made = await fsp.mkdtemp(path.join(os.tmpdir(), "peer-events-")); roots.push(made); await fsp.chmod(made, 0o700); const root = await fsp.realpath(made); const value = new EventStore(statePaths(root)); await value.init(); return value; }

describe("durable events", () => {
  test("serializes concurrent appends", async () => { const value = await store(); await Promise.all(Array.from({ length: 20 }, (_, i) => value.append("sample", { value: i }))); expect(value.events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); });
  test("rejects oversized event before append", async () => { const value = await store(); await expect(value.append("large", { body: "x".repeat(70_000) })).rejects.toThrow(); expect(value.events).toHaveLength(0); });
  test("recovers only a torn final line", async () => { const value = await store(); await value.append("first"); await fsp.appendFile(value.paths.events, '{"seq":2'); const restored = new EventStore(value.paths); await restored.init(); expect(restored.events).toHaveLength(1); });
  test("recovers a final line torn inside a multibyte character", async () => { const value = await store(); await value.append("first"); await fsp.appendFile(value.paths.events, Buffer.from([0xe2, 0x82])); const restored = new EventStore(value.paths); await restored.init(); expect(restored.events).toHaveLength(1); });
  test("fails on damaged middle line", async () => { const value = await store(); await value.append("first"); await fsp.appendFile(value.paths.events, "not-json\n"); const restored = new EventStore(value.paths); await expect(restored.init()).rejects.toThrow("middle"); });
  test("fails on blank, invalid UTF-8, and invalid-schema middle records", async () => {
    let value = await store(); await value.append("first"); await fsp.appendFile(value.paths.events, "\n"); await expect(new EventStore(value.paths).init()).rejects.toThrow("middle");
    value = await store(); await value.append("first"); await fsp.appendFile(value.paths.events, Buffer.from([0xff, 0x0a])); await expect(new EventStore(value.paths).init()).rejects.toThrow("UTF-8");
    value = await store(); await value.append("first"); await fsp.appendFile(value.paths.events, `${JSON.stringify({ seq: 2, at: new Date().toISOString() })}\n`); await expect(new EventStore(value.paths).init()).rejects.toThrow("schema");
  });
});
