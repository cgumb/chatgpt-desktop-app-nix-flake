const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { patch } = require(process.argv[3] || "./patch-executor-permissions.cjs");

// Bind a minified module accessor to a real module: `X.default.m(` (Vite
// builds) or `X().m(` (webpack builds from 26.1023).
function bindAccessor(helper, method, module) {
  const named = helper.match(new RegExp(String.raw`([\w$]+)\.default\.${method}\(`));
  if (named) return [named[1], { default: module }];
  const called = helper.match(new RegExp(String.raw`([\w$]+)\(\)\.${method}\(`));
  return [called[1], () => module];
}

// The innermost `async function` enclosing `index`, named or anonymous. From
// 26.1103 the copy helpers are inline `async function(e,t){...}(...)`
// expressions, so the nearest "async function " is the surrounding 30 kB
// marketplace function, whose free variables do not exist in the test context.
// Bracket counting is enough here: the helpers' string literals hold no
// unbalanced brackets.
function enclosingFunction(source, index) {
  const start = Math.max(source.lastIndexOf("async function ", index), source.lastIndexOf("async function(", index));
  assert(start >= 0, "no enclosing async function");
  const close = (from, open, shut) => {
    let depth = 0;
    for (let i = source.indexOf(open, from); i < source.length; i++) {
      if (source[i] === open) depth++;
      else if (source[i] === shut && --depth === 0) return i;
    }
    throw new Error(`unbalanced ${open}${shut}`);
  };
  const body = source.indexOf("{", close(start, "(", ")"));
  return source.slice(start, close(body, "{", "}") + 1);
}

async function loadHelper(directory) {
  const names = (await fs.readdir(directory)).filter(name => /^(main|early-bootstrap)-.*\.js$/.test(name));
  const bundles = await Promise.all(names.map(name => fs.readFile(path.join(directory, name), "utf8")));
  const candidates = bundles.filter(source => source.includes("async function nixCopyExecutorPlugin"));
  assert.equal(candidates.length, 1, "exactly one patched executor bundle");
  const source = candidates[0];
  const marker = source.indexOf("await (async function nixCopyExecutorPlugin");
  const helper = enclosingFunction(source, marker);
  assert(helper.includes("CODEX_APP_TOOLS_CALLER_HOST_ID"));
  const resolver = helper.match(/await ([\w$]+)\(\{useWsl:!1,resourcesPath:/)[1];
  const [fsAlias, fsValue] = bindAccessor(helper, "cp", fs);
  const [pathAlias, pathValue] = bindAccessor(helper, "join", path);
  const hostAlias = helper.match(/CODEX_APP_TOOLS_CALLER_HOST_ID:([\w$]+)\.([\w$]+)/);
  return vm.runInNewContext(`(${helper})`, {
    [resolver]: async ({ resourcesPath }) => ({
      cwd: resourcesPath, command: path.join(resourcesPath, "server"), enabled: false, env: { EXISTING: "kept" },
    }),
    [fsAlias]: fsValue,
    [pathAlias]: pathValue,
    [hostAlias[1]]: { [hostAlias[2]]: "local" },
    process: { platform: "linux" },
    require,
  });
}

async function main() {
  assert.notEqual(process.getuid(), 0, "run as non-root so EACCES is meaningful");
  assert.throws(() => patch("upstream helper changed"), /Expected one local executor plugin copy branch/);
  const copy = await loadHelper(process.argv[2]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-executor-permissions-"));
  const source = path.join(root, "source");
  const baseline = path.join(root, "baseline");
  const destination = path.join(root, "destination");
  const outside = path.join(root, "outside");
  const mode = async file => (await fs.stat(file)).mode & 0o777;
  try {
    await fs.mkdir(source);
    await fs.mkdir(outside);
    await fs.mkdir(path.join(source, ".codex-plugin"));
    await fs.writeFile(path.join(source, ".codex-plugin", "plugin.json"), "{}\n", { mode: 0o444 });
    await fs.writeFile(path.join(outside, "sentinel"), "unchanged", { mode: 0o444 });
    await fs.writeFile(path.join(source, ".mcp.json"), "{}\n", { mode: 0o444 });
    await fs.writeFile(path.join(source, "server"), "#!/bin/sh\n", { mode: 0o555 });
    await fs.chmod(source, 0o555);
    await fs.chmod(path.join(source, ".codex-plugin"), 0o555);
    await fs.chmod(outside, 0o555);
    await fs.cp(source, baseline, { recursive: true });
    await assert.rejects(fs.writeFile(path.join(baseline, ".mcp.json"), "changed"), { code: "EACCES" });

    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await copy({ executorPluginRoot: destination, resourcesPath: source }), destination);
      const manifest = JSON.parse(await fs.readFile(path.join(destination, ".mcp.json"), "utf8"));
      assert.equal(manifest.mcpServers.codex_app.command, path.join(destination, "server"));
      assert.equal(manifest.mcpServers.codex_app.enabled, true);
      assert.equal(manifest.mcpServers.codex_app.env.EXISTING, "kept");
      assert.equal(manifest.mcpServers.codex_app.env.CODEX_APP_TOOLS_CALLER_HOST_ID, "local");
      assert.equal(await mode(path.join(destination, ".mcp.json")), 0o644);
      assert.equal(await mode(path.join(destination, "server")), 0o755);
      // The pre-copy repair must not follow links in an existing cache.
      if (attempt === 0) await fs.symlink(outside, path.join(destination, "directory-link"));
      // Reproduce an already populated cache from a previous failed startup.
      await fs.chmod(path.join(destination, ".mcp.json"), 0o444);
      await fs.chmod(destination, 0o555);
      await fs.chmod(path.join(destination, ".codex-plugin"), 0o555);
    }
    assert.equal(await mode(source), 0o555);
    assert.equal(await mode(path.join(source, ".mcp.json")), 0o444);
    assert.equal(await fs.readFile(path.join(source, ".mcp.json"), "utf8"), "{}\n");
    assert.equal(await mode(path.join(source, "server")), 0o555);
    assert.equal(await mode(outside), 0o555);
    assert.equal(await mode(path.join(outside, "sentinel")), 0o444);
    assert.equal(await fs.readFile(path.join(outside, "sentinel"), "utf8"), "unchanged");
    assert.equal(await fs.readlink(path.join(destination, "directory-link")), outside);
    console.log("Executor permissions: reproduced EACCES; actual patched helper rewrites manifest on first and repeated copies; store source unchanged and executable bits preserved");
  } finally {
    await fs.chmod(source, 0o755).catch(() => {});
    // fs.cp also preserves directory modes in the baseline and destination.
    for (const directory of [baseline, destination]) await fs.chmod(directory, 0o755).catch(() => {});
    for (const directory of [source, baseline, destination]) await fs.chmod(path.join(directory, ".codex-plugin"), 0o755).catch(() => {});
    await fs.chmod(outside, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
