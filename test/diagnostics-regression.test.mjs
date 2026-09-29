import { test, expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
const root = process.env.PEER_DIAGNOSTIC_ROOT;
const at = (p) => root ? pathToFileURL(path.join(root, "src", p)).href : new URL(`../src/${p}`, import.meta.url).href;
const { handleLegacy } = await import(at("mcp/legacy-2025-06-18.mjs"));
const { handleModern, PROTOCOL_KEY, CLIENT_CAPS_KEY } = await import(at("mcp/modern-2026-07-28.mjs"));
const { toolDefinitions } = await import(at("mcp/tools.mjs"));
const { PeerCore, frameObserver } = await import(at("core/peer-core.mjs"));
const { EventStore } = await import(at("core/events.mjs"));
const { statePaths } = await import(at("core/state-paths.mjs"));
const { senderEnvelope } = await import(at("adapters/claude-native-v1/protocol.mjs"));
const tools = toolDefinitions(["friday-main"]);
const M="11111111-1111-4111-8111-111111111111", T="22222222-2222-4222-8222-222222222222", R="33333333-3333-4333-8333-333333333333";
const args = {alias:"friday-main",messageId:M,threadId:T,kind:"hello",body:"synthetic body"};
const variants = [["legacy",handleLegacy,{}],["modern",handleModern,{[PROTOCOL_KEY]:"2026-07-28",[CLIENT_CAPS_KEY]:{}}]];
for(const [era,handle,_meta] of variants){
 const call=(name,arguments_,callTool)=>handle({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:arguments_,_meta}},{tools,callTool});
 test(`D01 ${era}: invalid UUID names field and constraint, never executes`,async()=>{
  let called=0;const r=await call("peer_send",{...args,threadId:"not-a-uuid"},()=>called++);
  expect(r.error.code).toBe(-32602);expect(r.error.message).toContain("threadId: invalid uuid");expect(called).toBe(0);
 });
 test(`D02 ${era}: unknown argument key/value never leaks`,async()=>{
  let called=0;const r=await call("peer_send",{...args,["private-key-name-sentinel"]:"private-value-sentinel"},()=>called++);
  expect(r.error.code).toBe(-32602);expect(JSON.stringify(r)).not.toContain("sentinel");expect(called).toBe(0);
 });
 test(`D03 ${era}: target cause survives public boundary`,async()=>{
  const r=await call("peer_status",{alias:"friday-main"},()=>{throw Object.assign(new Error("private /secret/path"),{code:"TARGET_UNAVAILABLE",diagnostic:"no_live_session_for_session_id"});});
  expect(r.result.isError).toBe(true);expect(r.result.structuredContent).toEqual({reason:"target_unavailable",diagnostic:"no_live_session_for_session_id"});expect(JSON.stringify(r)).not.toContain("/secret");
 });
 test(`D04 ${era}: unknown diagnosis is not reflected`,async()=>{
  const r=await call("peer_status",{alias:"friday-main"},()=>{throw Object.assign(new Error("sentinel"),{code:"TARGET_UNAVAILABLE",diagnostic:"private-sentinel"});});
  expect(r.result.structuredContent).toEqual({reason:"target_unavailable"});expect(JSON.stringify(r)).not.toContain("sentinel");
 });
 test(`D05 ${era}: historic refusal diagnostics remain readable`,async()=>{
  const r=await call("peer_list_events",{},()=>({cursor:1,events:[{seq:1,type:"peer_frame_refused",at:new Date().toISOString(),reason:"identity_unavailable",connectionId:"historic-uuid",frameOrdinal:0}]}));
  expect(r.result.isError).not.toBe(true);expect(r.result.structuredContent.events[0].reason).toBe("identity_unavailable");
 });
}
async function withCore(run,{unavailable=false}={}){
 const root=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),"updiag-")));await fsp.chmod(root,0o700);
 const store=new EventStore(statePaths(root));await store.init();
 const peer={pid:99,procStart:"fixture-start"};
 const target={sessionId:R,cwd:root,permissionMode:"prompting",...peer,socketPath:"/tmp/fixture.sock",token:"1".repeat(32),permission:{mode:"prompting",verifiedBy:"kern_procargs2"}};
 let sent=0;
 const core=new PeerCore({targets:{"friday-main":target},store,address:"uds:/tmp/sender-fixture.sock",resolver:async()=>{if(unavailable)throw new Error("resolved to 0 live candidates");return target;},sender:async()=>{sent++;return {bytesWritten:42};}});
 try{await run({core,store,peer,sends:()=>sent});}finally{await store.close();await fsp.rm(root,{recursive:true,force:true});}
}
test("D06 stale session reports reason before reserve/write",()=>withCore(async({core,store,sends})=>{
 await expect(core.send(args)).rejects.toMatchObject({code:"TARGET_UNAVAILABLE",diagnostic:"no_live_session_for_session_id"});
 expect(sends()).toBe(0);expect(store.events).toHaveLength(1);expect(store.events[0]).toMatchObject({type:"target_resolve_failed",reason:"no_live_session_for_session_id"});
},{unavailable:true}));
test("D07 delayed ACK remains observable after timeout without resend",()=>withCore(async({core,store,peer,sends})=>{
 expect((await core.send(args)).status).toBe("written");
 expect(await core.wait({messageId:M,require:"ack",timeoutMs:1})).toMatchObject({timedOut:true,state:"written"});
 const content=senderEnvelope({from:"uds:/tmp/fixture.sock",body:`PEER_ACK v=1 message_id=${R} thread_id=${T} reply_to=${M}`});
 await core.acceptFrame({from:"uds:/tmp/fixture.sock",message:{content}},peer);
 expect((await core.wait({messageId:M,require:"ack",timeoutMs:1})).event.type).toBe("peer_ack");
 expect((await core.send(args)).status).toBe("acknowledged");expect(sends()).toBe(1);
}));
test("D08 wrong PID cannot become an ACK or delivered result",()=>withCore(async({core,store,peer})=>{
 await core.send(args);const observe=frameObserver({core,store});
 await expect(observe({message:{content:`PEER_ACK v=1 message_id=${R} thread_id=${T} reply_to=${M}`}}, {...peer,pid:100})).rejects.toMatchObject({code:"INBOUND_IDENTITY_MISMATCH"});
 expect(store.events.at(-1).type).toBe("peer_frame_refused");expect((await core.wait({messageId:M,require:"ack",timeoutMs:1})).state).toBe("written");
}));
const {observeBuild,compareBuilds}=await import(at("core/build-identity.mjs"));
test("D09 running code reports disk replacement without relabeling startup",async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),"upbuild-"));
 try{await fsp.writeFile(path.join(root,"fixture.mjs"),"export const a=1;\n");const read=observeBuild({root,buildId:"fixture-build-A"});const before=read();
 expect(before.sourceChangedSinceStart).toBe(false);await fsp.writeFile(path.join(root,"fixture.mjs"),"export const a=2;\n");const after=read();
 expect(after.sourceChangedSinceStart).toBe(true);expect(after.startupSourceDigest).toBe(before.startupSourceDigest);expect(after.buildId).toBe(before.buildId);
 const next=observeBuild({root,buildId:"fixture-build-A"})();expect(compareBuilds(before,next)).toBe(true);expect(compareBuilds(before,{})).toBeNull();
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
for(const [era,handle,_meta] of variants)test(`D10 ${era}: runtime build observations survive wire contract`,async()=>{
 const build=observeBuild()();const raw={running:true,pid:42,procStart:"fixture-start",admin:false,eventSeq:0,targetCount:0,serverBuild:build,daemonBuild:build,buildMismatch:false};
 const r=await handle({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"daemon_status",arguments:{},_meta}},{tools,callTool:async()=>raw});
 expect(r.result.isError).not.toBe(true);expect(r.result.structuredContent.serverBuild).toEqual(build);expect(r.result.structuredContent.buildMismatch).toBe(false);
});
const {parseReplyHeader}=await import(at("adapters/claude-native-v1/protocol.mjs"));
for(const separator of [" | ","|"])test(`D11 same-line ${JSON.stringify(separator)} preserves correlation and verdict`,()=>{
 expect(parseReplyHeader(`PEER_REPLY re=${M} thread=${T} verdict=pass${separator}hello | re=${R}`)).toMatchObject({replyTo:M.replaceAll("-",""),threadId:T.replaceAll("-",""),verdict:"pass"});
});
test("D12 malformed verdict/version and duplicate fields refuse correlation",()=>{
 for(const suffix of ["verdict=unknown","verdict=pass verdict=fail","v=1 v=1",`re=${M}`,`replyTo=${M}`,`thread=${T} thread_id=${T}`])expect(parseReplyHeader(`PEER_REPLY re=${M} ${suffix} | body`)).toBeNull();
 expect(parseReplyHeader(`body first\nPEER_REPLY re=${M} | body`)).toBeNull();
 expect(parseReplyHeader(`PEER_REPLY re=${M} verdict=pass | ${"x".repeat(2048)}`)).not.toBeNull();
 expect(parseReplyHeader(`PEER_REPLY re=${M} ${"x".repeat(1024)} | body`)).toBeNull();
});
test("D13 same-line reply correlates only to the bound thread and peer",()=>withCore(async({core,store,peer})=>{
 await core.send(args);
 const body=`PEER_REPLY re=${M} thread=${T} verdict=pass | hello`;
 expect(await core.acceptFrame({message:{content:body.replace(T,R)}},peer)).toEqual({ reason: "reply_thread_mismatch", peerPid: peer.pid, peerProcStart: peer.procStart });
 await expect(core.acceptFrame({message:{content:body}},{...peer,pid:100})).rejects.toMatchObject({code:"INBOUND_IDENTITY_MISMATCH"});
 await core.acceptFrame({message:{content:body}},peer);expect(store.events.at(-1)).toMatchObject({type:"peer_reply",messageId:M,threadId:T,verdict:"pass"});
}));
for(const [era,handle,_meta] of variants)test(`D14 ${era}: application timeout offers wait without asserting delivery failure`,()=>withCore(async({core})=>{
 await core.send(args);
 const r=await handle({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"peer_wait",arguments:{messageId:M,require:"ack",timeoutMs:1},_meta}},{tools,callTool:(_,a)=>core.wait(a)});
 expect(r.result.structuredContent).toMatchObject({timedOut:true,timeoutScope:"application_wait",nextAction:"wait_same_message_id",state:"written"});
}));
const {controlTimeoutMs}=await import(at("core/control.mjs"));
test("D15 control deadline distinguishes short status calls from application waits",()=>{
 expect(controlTimeoutMs("peer_status",{})).toBe(10000);expect(controlTimeoutMs("daemon_status",{})).toBe(10000);
 expect(controlTimeoutMs("peer_wait",{timeoutMs:45000})).toBe(55000);expect(controlTimeoutMs("peer_wait",{timeoutMs:300000})).toBe(310000);
});
test("D16 paged UTF-8 ledger reads preserve filtered order and stay below wire ceiling",()=>withCore(async({core,store})=>{
 for(let i=0;i<70;i++)await store.append("fixture",{messageId:i%2===0?M:R,reason:"한글".repeat(4000)});
 const readAll=async(messageId)=>{let afterSeq=0;let all=[];let pages=0;do{const page=core.events({afterSeq,limit:1000,...(messageId?{messageId}:{})});expect(Buffer.byteLength(JSON.stringify({requestId:M,ok:true,result:page}))).toBeLessThan(1024*1024);all.push(...page.events.map(x=>x.seq));expect(page.cursor).toBeGreaterThan(afterSeq);afterSeq=page.cursor;pages++;if(!page.hasMore)break;}while(pages<100);return{all,pages};};
 const unfiltered=await readAll();expect(unfiltered.pages).toBeGreaterThan(1);expect(unfiltered.all).toEqual(store.events.map(x=>x.seq));
 const filtered=await readAll(M);expect(filtered.pages).toBeGreaterThan(1);expect(filtered.all).toEqual(store.events.filter(x=>x.messageId===M).map(x=>x.seq));
 expect(core.events({afterSeq:70})).toMatchObject({hasMore:false,cursor:70,events:[]});
}));
test("D17 rejected correlated peer writes no body; storage failure remains explicit",()=>withCore(async({core,store,peer})=>{
 await core.send(args);let writes=0;core.inboundSpool={write:async()=>{writes++;throw new Error("private storage failure");}};
 const body=`PEER_REPLY re=${M} verdict=pass | body`;
 await expect(core.acceptFrame({message:{content:body}},{...peer,pid:100})).rejects.toMatchObject({code:"INBOUND_IDENTITY_MISMATCH"});expect(writes).toBe(0);
 await core.acceptFrame({message:{content:body}},peer);expect(writes).toBe(1);expect(store.events.at(-1)).toMatchObject({type:"peer_reply",bodyStorageOmitted:"write_failed"});expect(JSON.stringify(store.events)).not.toContain("private storage failure");
}));
const {ensureDaemon}=await import(at("core/control.mjs"));
test("D18 isolated startup failure reports safe child exit instead of silent readiness timeout",async()=>{
 const root=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),"up-start-fail-")));await fsp.chmod(root,0o700);
 try{await fsp.writeFile(path.join(root,"targets.json"),"invalid fixture",{mode:0o600});
 await expect(ensureDaemon({root,timeoutMs:3000})).rejects.toMatchObject({code:"DAEMON_START_FAILED",message:"daemon startup failed: exit_code_1"});
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
