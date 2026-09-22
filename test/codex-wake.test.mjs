import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { CodexWake, codexWakeTools, connectAppServer } from '../src/extensions/codex-wake/index.mjs';
import { createFacade } from '../src/mcp/facade.mjs';

async function fixture(options = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'peer-wake-')));
  const socketPath = path.join(root, 'app.sock');
  const server = net.createServer(); await new Promise((r) => server.listen(socketPath, r)); await fsp.chmod(socketPath, 0o600);
  const threadId = crypto.randomUUID(), turnId = crypto.randomUUID();
  await fsp.writeFile(path.join(root, 'codex-targets.json'), JSON.stringify({ review: { socketPath, threadId, cwd: root } }), { mode: 0o600 });
  const calls = []; let connections = 0;
  const connect = () => {
    connections++;
    return { notify() {}, close() {}, async call(method, params) {
      calls.push({ method, params });
      if (method === 'initialize') return {};
      if (method === 'thread/loaded/list') return { data: options.unloaded ? [] : [threadId] };
      if (method === 'thread/read') return { thread: { id: threadId, cwd: options.wrongCwd ? '/' : root, status: { type: options.state ?? 'idle' }, turns: options.noActive ? [] : [{ id: turnId, status: 'inProgress' }] } };
      if (method === 'turn/start' || method === 'turn/steer') {
        if (options.failTurn) throw new Error('socket disappeared');
        if (options.delay) await new Promise((r) => setTimeout(r, 30));
        return method === 'turn/start' ? { turn: { id: turnId } } : { turnId };
      }
      throw new Error('unexpected method');
    } };
  };
  return { root, calls, turnId, wake: new CodexWake({ root, connect }), connections: () => connections,
    args: { codexAlias: 'review', messageId: crypto.randomUUID(), body: '검증 결과가 도착했습니다.' },
    async close() { await new Promise((r) => server.close(r)); await fsp.rm(root, { recursive: true, force: true }); }
  };
}
async function withFixture(options, run) { const f = await fixture(options); try { await run(f); } finally { await f.close(); } }

test('idle thread starts one turn on same server, without policy/model overrides', () => withFixture({}, async (f) => {
  const result = await f.wake.wake(f.args); assert.equal(result.mode, 'started');
  const call = f.calls.at(-1); assert.equal(call.method, 'turn/start');
  assert.deepEqual(Object.keys(call.params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(f.calls.some((c) => /resume|thread\/start/.test(c.method)), false);
  assert.equal((await f.wake.wake(f.args)).replay, true); assert.equal(f.connections(), 1);
}));
test('active thread steers exactly observed active turn', () => withFixture({ state: 'active' }, async (f) => {
  assert.equal((await f.wake.wake(f.args)).mode, 'steered');
  assert.equal(f.calls.at(-1).params.expectedTurnId, f.turnId);
}));
test('unloaded thread is never resumed elsewhere', () => withFixture({ unloaded: true }, async (f) => {
  await assert.rejects(f.wake.wake(f.args), { code: 'TARGET_UNAVAILABLE' });
  assert.equal(f.calls.some((c) => c.method.startsWith('turn/')), false);
}));
test('wrong working directory and ambiguous active turn refuse delivery', async () => {
  for (const options of [{ wrongCwd: true }, { state: 'active', noActive: true }]) await withFixture(options, async (f) => {
    await assert.rejects(f.wake.wake(f.args), { code: 'TARGET_UNAVAILABLE' });
    assert.equal(f.calls.some((c) => c.method.startsWith('turn/')), false);
  });
});
test('lost turn acknowledgement remains uncertain and cannot be resent', () => withFixture({ failTurn: true }, async (f) => {
  await assert.rejects(f.wake.wake(f.args), { code: 'DELIVERY_UNCERTAIN' });
  await assert.rejects(f.wake.wake(f.args), { code: 'DELIVERY_UNCERTAIN' });
  assert.equal(f.calls.filter((c) => c.method.startsWith('turn/')).length, 1);
}));
test('same message id with different content fails', () => withFixture({}, async (f) => {
  await f.wake.wake(f.args);
  await assert.rejects(f.wake.wake({ ...f.args, body: 'different' }), { code: 'MESSAGE_ID_CONFLICT' });
}));
test('concurrent duplicate dispatch starts only one turn', () => withFixture({ delay: true }, async (f) => {
  const results = await Promise.allSettled([f.wake.wake(f.args), f.wake.wake(f.args)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter((c) => c.method.startsWith('turn/')).length, 1);
}));
test('status is read only and missing target is unavailable', () => withFixture({}, async (f) => {
  assert.deepEqual(await f.wake.status({ codexAlias: 'review' }), { available: true, state: 'idle' });
  assert.deepEqual(await f.wake.status({ codexAlias: 'absent' }), { available: false, state: 'unavailable' });
  assert.equal(f.calls.some((c) => c.method.startsWith('turn/')), false);
}));
test('MCP output schema accepts wake and status without publishing paths', () => withFixture({}, async (f) => {
  const facade = createFacade({ tools: codexWakeTools(), callTool: (name, args) => name === 'codex_wake' ? f.wake.wake(args) : f.wake.status(args) });
  await facade.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const result = await facade.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codex_wake', arguments: f.args } });
  assert.equal(result.result.structuredContent.accepted, true);
  assert.equal(JSON.stringify(result).includes(f.root), false);
}));
test('Node websocket-over-UDS helper works under Bun and does not answer host approvals', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'peer-ws-'));
  const socketPath = path.join(root, 'app.sock');
  const script = `import http from 'node:http'; import { WebSocketServer } from 'ws';
    const server=http.createServer(); const wss=new WebSocketServer({server});
    wss.on('connection',ws=>ws.on('message',data=>{const f=JSON.parse(data);
      if(f.id===987){process.stdout.write('approval-response\\n');return;}
      if(f.id){ws.send(JSON.stringify({id:987,method:'item/commandExecution/requestApproval',params:{}}));ws.send(JSON.stringify({id:f.id,result:{ok:true}}));}
    }));server.listen(process.argv[1],()=>process.stdout.write('ready\\n'));`;
  const server = spawn('node', ['--input-type=module', '-e', script, socketPath], { cwd: path.resolve(import.meta.dir, '..'), stdio: ['ignore','pipe','pipe'] });
  let output=''; server.stdout.on('data',c=>output+=c);
  let rpc;
  try {
    for(let i=0;i<100 && !output.includes('ready');i++) await new Promise(r=>setTimeout(r,10));
    assert.ok(output.includes('ready'));
    rpc = connectAppServer(socketPath);
    assert.deepEqual(await rpc.call('initialize', {}), { ok: true }); rpc.notify('initialized');
    await new Promise(r=>setTimeout(r,30));
    assert.equal(output.includes('approval-response'), false);
  } finally { rpc?.close(); server.kill(); await new Promise(r=>server.once('exit',r)); await fsp.rm(root, { recursive: true, force: true }); }
});
