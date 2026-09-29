#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const hash=(bytes)=>crypto.createHash("sha256").update(bytes).digest("hex");
export function verifyRelease(root, expectedManifestHash) {
  if(!/^[a-f0-9]{64}$/.test(expectedManifestHash))throw new Error("a pinned manifest SHA-256 is required");
  const manifest=fs.readFileSync(path.join(root,"RELEASE-MANIFEST.sha256"));
  if(hash(manifest)!==expectedManifestHash)throw new Error("release manifest hash mismatch");
  const expected=new Map();
  for(const row of manifest.toString("utf8").trimEnd().split("\n")){
    const m=/^([a-f0-9]{64})  ([A-Za-z0-9_./-]+)$/.exec(row);
    if(!m || m[2].startsWith("/") || m[2].split("/").some(x=>!x || x==="." || x==="..") || expected.has(m[2]))throw new Error("invalid manifest entry");
    expected.set(m[2],m[1]);
  }
  let files=0;
  function visit(dir){
    for(const item of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,item.name), relative=path.relative(root,file).split(path.sep).join("/");
      if(item.isSymbolicLink())throw new Error("release contains symbolic link");
      if(item.isDirectory()){visit(file);continue;}
      if(!item.isFile())throw new Error("release contains unsupported file type");
      if(relative==="RELEASE-MANIFEST.sha256")continue;
      if(!expected.has(relative) || hash(fs.readFileSync(file))!==expected.get(relative))throw new Error("release file mismatch");
      expected.delete(relative);files++;
    }
  }
  visit(root);if(expected.size)throw new Error("release file is missing");
  return {verified:true,files,manifestSha256:expectedManifestHash};
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const args=process.argv.slice(2);if(args.length!==3||args[1]!=="--manifest-sha256")throw new Error("usage: verify-release.mjs PACKAGE_ROOT --manifest-sha256 PINNED_SHA256");console.log(JSON.stringify(verifyRelease(path.resolve(args[0]),args[2])));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
