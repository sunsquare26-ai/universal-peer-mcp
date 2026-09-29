import {test,expect} from "bun:test";
import {pathToFileURL} from "node:url";import path from "node:path";
const r=process.env.PEER_DIAGNOSTIC_ROOT;const at=p=>r?pathToFileURL(path.join(r,"src",p)).href:new URL(`../src/${p}`,import.meta.url).href;
const {handleLegacy}=await import(at("mcp/legacy-2025-06-18.mjs"));const {toolDefinitions}=await import(at("mcp/tools.mjs"));const {parseReplyHeader}=await import(at("adapters/claude-native-v1/protocol.mjs"));const {PeerCore}=await import(at("core/peer-core.mjs"));
const M="11111111-1111-4111-8111-111111111111",T="22222222-2222-4222-8222-222222222222";
test("NC1 invalid input preserves actionable constraint",async()=>{
 const x=await handleLegacy({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"peer_send",arguments:{alias:"review",messageId:M,threadId:"invalid",kind:"hello",body:"fixture"}}},{tools:toolDefinitions(["review"]),callTool:()=>{throw new Error("must not call");}});
 expect(x.error.message).toContain("threadId: invalid uuid");
});
test("NC2 target failure preserves safe diagnostic",async()=>{
 const x=await handleLegacy({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"peer_status",arguments:{alias:"review"}}},{tools:toolDefinitions(["review"]),callTool:()=>{throw Object.assign(new Error("target unavailable"),{code:"TARGET_UNAVAILABLE",diagnostic:"no_live_session_for_session_id"});}});
 expect(x.result.structuredContent.diagnostic).toBe("no_live_session_for_session_id");
});
for(const pipe of [" | ","|"])test(`NC3 same-line body boundary ${JSON.stringify(pipe)}`,()=>expect(parseReplyHeader(`PEER_REPLY re=${M} verdict=pass${pipe}body`)?.verdict).toBe("pass"));
test("NC4 invalid explicit verdict refuses correlation",()=>expect(parseReplyHeader(`PEER_REPLY re=${M} verdict=invalid`)).toBeNull());
test("NC5 event listing honors page size and continuing cursor",()=>{
 const rows=Array.from({length:101},(_,i)=>({seq:i+1,type:"fixture",at:new Date().toISOString()}));const core=new PeerCore({targets:{},address:"uds:/tmp/fixture",store:{events:rows,list:()=>rows}});
 expect(core.events({limit:100})).toMatchObject({cursor:100,hasMore:true});expect(core.events({limit:100}).events).toHaveLength(100);
});
test("NC6 rejected correlated peer creates no orphan body",async()=>{
 let writes=0;const request={messageId:M,threadId:T,targetPid:99,targetProcStart:"fixture",targetProcStartRendering:"utc0-c-squeezed"};
 const core=new PeerCore({targets:{},address:"uds:/tmp/fixture",store:{request:()=>request},inboundSpool:{write:async()=>{writes++;return{};}}});
 await expect(core.acceptFrame({message:{content:`PEER_ACK v=1 message_id=${M} thread_id=${T} reply_to=${M}`}},{pid:100,procStart:"fixture"})).rejects.toMatchObject({code:"INBOUND_IDENTITY_MISMATCH"});expect(writes).toBe(0);
});
