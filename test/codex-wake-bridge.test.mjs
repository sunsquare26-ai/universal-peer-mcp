import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventStore } from '../src/core/events.mjs';
import { statePaths } from '../src/core/state-paths.mjs';
import { CodexWake } from '../src/extensions/codex-wake/index.mjs';
import { CodexWakeBridge, loadBridgeConfig, bridgeMessageId } from '../src/extensions/codex-wake/bridge.mjs';

async function fixture({ unavailable = false, lostAck = false, historical = true } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'peer-bridge-')));
  const store = new EventStore(statePaths(root)); await store.init();
  const socketPath = path.join(root,'app.sock');
  const server = net.createServer(); await new Promise(r=>server.listen(socketPath,r)); await fsp.chmod(socketPath,0o600);
  const threadId = crypto.randomUUID(), turnId = crypto.randomUUID();
  await fsp.writeFile(path.join(root,'codex-targets.json'), JSON.stringify({ review: { socketPath,threadId,cwd:root } }),{mode:0o600});
  const calls=[];
  const wake = new CodexWake({root, connect:()=>({notify(){},close(){},async call(method,params){
    calls.push({method,params});
    if(method==='initialize')return {};
    if(method==='thread/loaded/list')return {data:unavailable?[]:[threadId]};
    if(method==='thread/read')return {thread:{id:threadId,cwd:root,status:{type:'idle'},turns:[]}};
    if(method==='turn/start'){if(lostAck)throw new Error('lost');return {turn:{id:turnId}};}
    throw new Error('unexpected method');
  }})});
  const config={...(historical?{afterSeq:0}:{}),routes:[{peerAlias:'worker',codexAlias:'review',events:['peer_reply','milestone_completion_accepted']}]};
  const bridges=[];
  async function bridge(){const b=new CodexWakeBridge({root,store,config,wake});await b.init();bridges.push(b);return b;}
  async function reply({type='peer_reply',responseId=crypto.randomUUID(),alias='worker',requestId=crypto.randomUUID(),payload={}}={}){
    const sourceThread=crypto.randomUUID();
    await store.append('send_requested',{messageId:requestId,targetAlias:alias,threadId:sourceThread});
    return store.append(type,type==='peer_reply'?{messageId:requestId,responseMessageId:responseId,threadId:sourceThread,...payload}:{instructionId:requestId,completionMessageId:responseId,targetAlias:alias,threadId:sourceThread,payload});
  }
  return {root,store,calls,wake,config,bridge,reply,async close(){for(const b of bridges)await b.close();await store.close();await new Promise(r=>server.close(r));await fsp.rm(root,{recursive:true,force:true});}};
}
async function withFixture(opts,run){const f=await fixture(opts);try{await run(f);}finally{await f.close();}}
const sends=f=>f.calls.filter(c=>c.method==='turn/start');

test('durable peer reply and milestone events reach actual CodexWake dispatch',()=>withFixture({},async f=>{
  const bridge=await f.bridge();
  await f.reply();await f.reply({type:'milestone_completion_accepted'});
  await bridge.kick();
  assert.equal(sends(f).length,2);
  assert.equal(bridge.cursor,4);
  assert.equal(bridge.lastDelivery.state,'accepted');
  const restarted=await f.bridge();await restarted.kick();assert.equal(sends(f).length,2);
}));
test('same reply duplicated at a new sequence starts only one turn',()=>withFixture({},async f=>{
  const b=await f.bridge();const event=await f.reply();await b.kick();
  const {seq,at,...copy}=event;await f.store.append('peer_reply',copy);await b.kick();
  assert.equal(sends(f).length,1);assert.equal(b.cursor,3);
}));
test('unavailable host is recorded once without startup or event-driven retry',()=>withFixture({unavailable:true},async f=>{
  const event=await f.reply();const b=await f.bridge();await b.kick();
  assert.equal(b.lastDelivery.state,'unavailable');assert.equal(sends(f).length,0);
  const count=f.calls.length;
  const restarted=await f.bridge();await restarted.kick();
  const {seq,at,...copy}=event;await f.store.append('peer_reply',copy);await restarted.kick();
  assert.equal(f.calls.length,count);
}));
test('lost acknowledgement remains uncertain across restart and duplicate event',()=>withFixture({lostAck:true},async f=>{
  const event=await f.reply();const b=await f.bridge();await b.kick();assert.equal(b.lastDelivery.state,'uncertain');
  const {seq,at,...copy}=event;await f.store.append('peer_reply',copy);
  const restarted=await f.bridge();await restarted.kick();assert.equal(sends(f).length,1);
}));
test('crash after reservation does not retry even before a wake receipt exists',()=>withFixture({},async f=>{
  const event=await f.reply();const b=await f.bridge();
  const messageId=bridgeMessageId({type:event.type,responseId:event.responseMessageId,peerAlias:'worker',codexAlias:'review'});
  await fsp.writeFile(path.join(b.directory,messageId+'.json'),'',{mode:0o600});
  await b.kick();assert.equal(b.lastDelivery.state,'uncertain');assert.equal(sends(f).length,0);
}));
test('first enable defaults to future only; source body never reaches wake or receipt',()=>withFixture({historical:false},async f=>{
  await f.reply();const b=await f.bridge();await b.kick();assert.equal(sends(f).length,0);
  await f.reply({payload:{body:'PRIVATE_SOURCE_BODY',verdict:'PRIVATE_VERDICT'}});await b.kick();assert.equal(sends(f).length,1);
  assert.equal(JSON.stringify(f.calls).includes('PRIVATE_'),false);
  const receipts=await Promise.all((await fsp.readdir(b.directory)).map(name=>fsp.readFile(path.join(b.directory,name),'utf8')));
  assert.equal(receipts.join('').includes('PRIVATE_'),false);
}));
test('unmatched alias and uncorrelated events do not wake; concurrent kicks coalesce',()=>withFixture({},async f=>{
  const b=await f.bridge();await f.reply({alias:'other'});
  await f.store.append('peer_reply',{messageId:crypto.randomUUID(),responseMessageId:crypto.randomUUID(),threadId:crypto.randomUUID()});
  await Promise.all([b.kick(),b.kick(),b.kick()]);assert.equal(sends(f).length,0);
  await f.reply();await Promise.all([b.kick(),b.kick()]);assert.equal(sends(f).length,1);
}));
test('configuration requires explicit routes and rejects unsupported event kinds',()=>withFixture({},async f=>{
  const file=path.join(f.root,'codex-wake-bridge.json');
  await assert.rejects(loadBridgeConfig(f.root));
  await fsp.writeFile(file,JSON.stringify(f.config),{mode:0o600});assert.deepEqual(await loadBridgeConfig(f.root),f.config);
  await fsp.writeFile(file,JSON.stringify({routes:[{peerAlias:'worker',codexAlias:'review',events:['peer_frame_uncorrelated']}]}));
  await assert.rejects(loadBridgeConfig(f.root),/invalid codex bridge route/);
}));
