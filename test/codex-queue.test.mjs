import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CodexWake, enqueueCodex, codexWakeTools } from '../src/extensions/codex-wake/index.mjs';
import { createFacade } from '../src/mcp/facade.mjs';
async function fixture(run) {
 const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'peer-queue-')));
 const threadId = crypto.randomUUID(); const calls=[];
 const target={transport:'cli-queue',cliPath:process.execPath,threadId,cwd:root};
 await fs.writeFile(path.join(root,'codex-targets.json'),JSON.stringify({review:target}),{mode:0o600});
 const args={codexAlias:'review',messageId:crypto.randomUUID(),body:'Wake only this session; $(do not execute)'};
 const wake=new CodexWake({root,enqueue:async (...a)=>{calls.push(a);}});
 try {await run({root,target,args,wake,calls});}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('CLI queue reports queued, passes exact thread, and deduplicates UUID case',()=>fixture(async f=>{
 assert.deepEqual(await f.wake.status(f.args),{available:true,state:'queue_configured'});
 assert.equal(f.calls.length,0);
 assert.deepEqual(await f.wake.wake(f.args),{accepted:true,mode:'queued',turnId:null,replay:false});
 assert.equal((await f.wake.wake({...f.args,messageId:f.args.messageId.toUpperCase()})).replay,true);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][0].threadId,f.target.threadId);
 assert.ok(f.calls[0][1].endsWith(f.args.body));
 await assert.rejects(f.wake.wake({...f.args,body:'different'}),{code:'MESSAGE_ID_CONFLICT'});
}));
test('CLI uncertain enqueue is never resent, including after restart',()=>fixture(async f=>{
 let count=0;const wake=new CodexWake({root:f.root,enqueue:async()=>{count++;throw Error('lost response');}});
 await assert.rejects(wake.wake(f.args),{code:'DELIVERY_UNCERTAIN'});
 await assert.rejects(f.wake.wake(f.args),{code:'DELIVERY_UNCERTAIN'});
 assert.equal(count,1);assert.equal(f.calls.length,0);
}));
test('concurrent CLI requests enqueue once',()=>fixture(async f=>{
 const r=await Promise.allSettled([f.wake.wake(f.args),f.wake.wake(f.args)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.length,1);
}));
test('queued result satisfies MCP schema without invented turn id',()=>fixture(async f=>{
 const facade=createFacade({tools:codexWakeTools(),callTool:(_,args)=>f.wake.wake(args)});
 await facade.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}});
 const r=await facade.handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'codex_wake',arguments:f.args}});
 assert.equal(r.result.structuredContent.mode,'queued');assert.equal(r.result.structuredContent.turnId,null);
}));
test('real child transport preserves arguments without shell evaluation',()=>fixture(async f=>{
 const cli=path.join(f.root,'codex-fixture');
 await fs.writeFile(cli,`#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));console.log('Queued message fixture for thread '+process.argv[4]+'.');`,{mode:0o700});
 await enqueueCodex({...f.target,cliPath:cli},f.args.body);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'argv.json'))),['queue','--thread',f.target.threadId,'--message',f.args.body]);
 await fs.writeFile(cli,'#!/usr/bin/env node\nconsole.log("unrecognized response");',{mode:0o700});
 await assert.rejects(enqueueCodex({...f.target,cliPath:cli},'hello'),{code:'DELIVERY_UNCERTAIN'});
}));
