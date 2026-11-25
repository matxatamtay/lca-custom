import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lca-peer-routing-"));
const primary = path.join(tmp, "twa-verimie-app");
const secondary = path.join(tmp, "twa-blena-browser");
const brand = path.join(tmp, "twa-verimie-app-brand");
const roots = [primary, secondary, brand];
let child, first, second;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
function check(label, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("PASS", label); });
}
async function connect(port) {
  const client = new Client({ name: "peer-routing-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}
function raw(client, name, args) { return client.callTool({ name, arguments: args }); }
async function json(client, name, args) {
  const result = await raw(client, name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent || JSON.parse(result.content[0].text);
}
async function rejects(client, name, args, pattern) {
  const result = await raw(client, name, args);
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, pattern);
}
async function facade(client, name, action, project, args = {}) {
  return json(client, name, { action, ...(project ? { project } : {}), arguments: args });
}

try {
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "shared.txt"), path.basename(root));
    await writeFile(path.join(root, "package.json"), JSON.stringify({name:path.basename(root),scripts:{test:"node --version"}}));
    execFileSync("git", ["init", "-q", root]);
  }
  await writeFile(path.join(secondary, "peer-only.txt"), "secondary-only");
  const port = await new Promise(resolve => {
    const listener = http.createServer();
    listener.listen(0, "127.0.0.1", () => { const {port} = listener.address(); listener.close(() => resolve(port)); });
  });
  let stderr = "";
  child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(port), AGENT_WORKSPACE: primary, AGENT_EXTRA_ROOTS_JSON: JSON.stringify([secondary,brand]), AGENTMEMORY_RECORD_SESSIONS: "0", AGENT_MEMORY_VAULT: path.join(tmp,"vault"), MCP_AUTH_TOKEN: "", AGENT_AUDIT: "0", AGENT_PERFORMANCE_PROFILING: "0" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", chunk => {stderr += chunk;});
  let ready = false;
  for (let i=0;i<100;i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { ready=true; break; } } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, stderr);
  first = await connect(port);
  second = await connect(port);
  await check("peer mode has no effective primary; named scope is explicit", async () => {
    const global = await facade(first,"workspace_status","info");
    assert.equal(global.effective_primary_root,null);
    assert.equal(global.project_routing_mode,"peer-roots");
    assert.equal(global.performance_profiling.enabled,false);
    assert.equal(global.performance_follow.storage.persisted,false);
    assert.equal(global.performance_follow.storage.retained_samples,0);
    const scoped = await facade(first,"workspace_status","info","twa-blena-browser");
    assert.equal(scoped.effective_primary_root,secondary);
    assert.deepEqual(scoped.discovery_roots,[secondary]);
  });
  await check("unscoped defaults fail instead of selecting first folder", async () => {
    await rejects(first,"workspace_exec",{action:"one",arguments:{command:"pwd"}},/Project not selected/);
    await rejects(first,"workspace_git",{action:"status"},/Project not selected/);
    await rejects(first,"workspace_verify",{action:"detect"},/Project not selected/);
    await rejects(first,"workspace_edit",{action:"plan",arguments:{goal:"wrong",steps:["wrong"]}},/Project not selected/);
    await rejects(first,"workspace_context",{task:"Investigate a regression"},/Project not selected/);
  });
  await check("unknown names, ambiguous tasks and missing absolute folders fail", async () => {
    await rejects(first,"workspace_read",{action:"one",project:"does-not-exist",arguments:{path:"shared.txt"}},/Unknown project/);
    await rejects(first,"workspace_context",{task:"Compare twa-verimie-app and twa-blena-browser"},/Ambiguous project/);
    await rejects(first,"workspace_git",{project:path.join(tmp,"missing")},/does not exist/);
  });
  await check("context selects explicit named scope over conflicting task text", async () => {
    const result = await json(first,"workspace_context",{task:"Inspect twa-verimie-app",project:"twa-blena-browser",max_items:3,max_chars:2000});
    assert.equal(result.project_resolution.workspace_root,secondary);
    assert.equal(result.project_resolution.requested_root,secondary);
    assert.equal(result.root,secondary);
    for(const provider of ["filesystem","semantic","codegraph","agentmemory"]) assert.equal(result.coverage[provider].queried,true);
  });
  await check("context infers full repo name, not a longer-name prefix", async () => {
    const result = await json(first,"workspace_context",{task:"Inspect twa-verimie-app-brand.",max_items:3,max_chars:2000});
    assert.equal(result.project_resolution.workspace_root,brand);
  });
  await check("read scope selects correct duplicate and missing files do not leak", async () => {
    const result = await facade(first,"workspace_read","one","twa-blena-browser",{path:"shared.txt"});
    assert.equal(result.content,"twa-blena-browser");
    await rejects(first,"workspace_read",{action:"one",project:"twa-verimie-app",arguments:{path:"peer-only.txt"}},/ENOENT|not found|does not exist/i);
    await rejects(first,"workspace_read",{action:"one",arguments:{path:"shared.txt"}},/Ambiguous relative path/);
    const peer = await facade(first,"workspace_read","one",undefined,{path:"peer-only.txt"});
    assert.equal(peer.content,"secondary-only");
  });
  await check("scoped edits and task state target only selected repo", async () => {
    await facade(first,"workspace_edit","write","twa-blena-browser",{path:"shared.txt",content:"changed-secondary"});
    assert.equal(await readFile(path.join(secondary,"shared.txt"),"utf8"),"changed-secondary");
    assert.equal(await readFile(path.join(primary,"shared.txt"),"utf8"),"twa-verimie-app");
    const state = await facade(first,"workspace_edit","plan","twa-blena-browser",{goal:"secondary only",steps:["verify"]});
    assert.equal(state.root,secondary);
    const current = await facade(first,"workspace_edit","state","twa-blena-browser");
    assert.equal(current.goal,"secondary only");
  });
  await check("undo cannot restore another project's last edit", async () => {
    await facade(first,"workspace_edit","write","twa-verimie-app",{path:"shared.txt",content:"changed-primary"});
    await rejects(first,"workspace_edit",{action:"undo"},/Project not selected/);
    const undo = await facade(first,"workspace_edit","undo","twa-blena-browser");
    assert.equal(undo.ok,true);
    assert.equal(await readFile(path.join(secondary,"shared.txt"),"utf8"),"twa-blena-browser");
    assert.equal(await readFile(path.join(primary,"shared.txt"),"utf8"),"changed-primary");
  });
  await check("search snippets, maps and sibling project names stay scoped", async () => {
    const search = await facade(first,"workspace_search","text","twa-blena-browser",{query:"twa-blena-browser",context:1});
    assert.ok(search.matches.some(match=>match.path==="shared.txt" && match.snippet.includes("twa-blena-browser")));
    const sibling = await facade(first,"workspace_search","text",undefined,{path:brand,query:"twa-verimie-app-brand"});
    assert.ok(sibling.matches.some(match=>match.path===path.join(brand,"shared.txt")));
    const map = await facade(first,"workspace_search","map","twa-blena-browser",{depth:2});
    assert.ok(map.tree.includes("shared.txt"));
    const other = await facade(second,"workspace_search","map","twa-verimie-app-brand",{depth:2});
    assert.ok(other.tree.includes("shared.txt"));
    assert.equal((await facade(first,"workspace_search","map","twa-blena-browser",{depth:2})).cached,true);
  });
  await check("persistent task protocol is project scoped", async () => {
    const a = await facade(first,"workspace_read","memory","twa-verimie-app");
    const b = await facade(second,"workspace_read","memory","twa-blena-browser");
    assert.notEqual(a.project_id,b.project_id);
    assert.notEqual(a.folders.project,b.folders.project);
  });
  await check("git and verify use the same scoped default", async () => {
    const git = await facade(first,"workspace_git","status","twa-blena-browser");
    assert.equal(git.cwd,secondary);
    const detect = await facade(first,"workspace_verify","detect","twa-blena-browser");
    assert.equal(detect.commands.test,"npm test");
    for(const root of [primary,secondary]) {
      await mkdir(path.join(root,".agent"),{recursive:true});
      await writeFile(path.join(root,".agent","profile.json"),JSON.stringify({testCommands:{test:"echo "+path.basename(root)}}));
      const profile = await facade(first,"workspace_status","reload_profile",path.basename(root));
      assert.equal(profile.profile.testCommands.test,"echo "+path.basename(root));
    }
    const commands = await Promise.all([primary,secondary].map(root=>facade(first,"workspace_verify","detect",path.basename(root))));
    assert.equal(commands[0].commands.test,"echo twa-verimie-app");
    assert.equal(commands[1].commands.test,"echo twa-blena-browser");
  });
  await check("parallel clients keep their own cwd and child workspace env", async () => {
    const results = await Promise.all([primary,secondary,brand].map((root,i) =>
      facade(i===0?first:second,"workspace_exec","one",path.basename(root),{command:'node -p "JSON.stringify([process.cwd(),process.env.AGENT_WORKSPACE])"'})));
    for (let i=0;i<results.length;i++) {
      assert.equal(results[i].cwd,roots[i]);
      const [cwd,env] = JSON.parse(results[i].stdout.trim());
      assert.equal(await import("node:fs/promises").then(fs=>fs.realpath(cwd)),await import("node:fs/promises").then(fs=>fs.realpath(roots[i])));
      assert.equal(env,roots[i]);
    }
    await rejects(first,"workspace_exec",{action:"one",arguments:{command:"pwd"}},/Project not selected/);
  });
  await check("explicit absolute cross-project access remains supported", async () => {
    const peer = await facade(first,"workspace_read","one","twa-verimie-app",{path:path.join(secondary,"peer-only.txt")});
    assert.equal(peer.content,"secondary-only");
    await rejects(first,"workspace_read",{action:"one",project:"twa-verimie-app",arguments:{path:"twa-blena-browser/peer-only.txt"}},/conflicts with selected project/);
  });
  await check("companion selection resolves exact names and unscoped stays unscoped", async () => {
    assert.equal((await json(first,"lca_input",{primary_project:"twa-blena-browser"})).primary_project,secondary);
    assert.equal((await json(first,"lca_input",{})).primary_project,null);
  });
  await check("disabled profiling retains RAM task metrics but creates no performance files", async () => {
    await delay(650);
    const status = await facade(first,"workspace_status","info","twa-blena-browser");
    assert.equal(status.performance_profiling.enabled,false);
    assert.ok(status.performance.recent.length > 0);
    assert.equal(status.performance_follow.samples,0);
    const trace = await facade(first,"workspace_status","trace","twa-blena-browser");
    assert.equal(trace.performance_profiling_enabled,false);
    assert.equal(trace.authoritative_history,"RuntimeEventStore");
    const workspaceId = createHash("sha256").update(process.platform === "win32" ? primary.toLowerCase() : primary).digest("hex").slice(0,16);
    for (const name of ["performance-follow.json","performance-telemetry.json"]) {
      await assert.rejects(readFile(path.join("data","workspaces",workspaceId,name)), {code:"ENOENT"});
    }
  });
  console.log(`PASS ${passed} peer-routing integration groups`);
} finally {
  await Promise.allSettled([first?.close(),second?.close()]);
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit",resolve));
    child.kill("SIGTERM");
    await Promise.race([exited,delay(1500)]);
    if(child.exitCode===null && child.signalCode===null) child.kill("SIGKILL");
  }
  await rm(tmp,{recursive:true,force:true});
}
