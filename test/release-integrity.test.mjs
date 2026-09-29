import {test,expect} from "bun:test";
import fsp from "node:fs/promises";import path from "node:path";import os from "node:os";import crypto from "node:crypto";
import {verifyRelease} from "../tools/verify-release.mjs";
const hash=(s)=>crypto.createHash("sha256").update(s).digest("hex");
test("R01 pinned release manifest rejects drift, omitted/extra files and symlinks",async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),"uprelease-"));
 try{const manifest=hash("original")+"  fixture.mjs\n";await fsp.writeFile(path.join(root,"RELEASE-MANIFEST.sha256"),manifest);await fsp.writeFile(path.join(root,"fixture.mjs"),"original");
 expect(verifyRelease(root,hash(manifest)).verified).toBe(true);
 await fsp.writeFile(path.join(root,"fixture.mjs"),"changed");expect(()=>verifyRelease(root,hash(manifest))).toThrow("file mismatch");
 await fsp.unlink(path.join(root,"fixture.mjs"));expect(()=>verifyRelease(root,hash(manifest))).toThrow("missing");
 await fsp.writeFile(path.join(root,"fixture.mjs"),"original");await fsp.writeFile(path.join(root,"extra"),"extra");expect(()=>verifyRelease(root,hash(manifest))).toThrow("file mismatch");await fsp.unlink(path.join(root,"extra"));
 await fsp.symlink("fixture.mjs",path.join(root,"link"));expect(()=>verifyRelease(root,hash(manifest))).toThrow("symbolic link");
 expect(()=>verifyRelease(root,"0".repeat(64))).toThrow("manifest hash mismatch");
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
