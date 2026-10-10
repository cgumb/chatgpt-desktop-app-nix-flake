const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { patch } = require(process.argv[3] || "./patch-executor-permissions.cjs");

async function loadHelper(directory) {
  const names = (await fs.readdir(directory)).filter(name => /^main-.*\.js$/.test(name));
  const bundles = await Promise.all(names.map(name => fs.readFile(path.join(directory, name), "utf8")));
  const candidates = bundles.filter(source => source.includes("async function nixCopyExecutorPlugin"));
  assert.equal(candidates.length, 1, "exactly one patched executor bundle");
  const source = candidates[0];
  const marker = source.indexOf("await (async function nixCopyExecutorPlugin");
  const start = source.lastIndexOf("async function ", marker);
  const end = source.indexOf("async function ", source.indexOf("CODEX_APP_TOOLS_CALLER_HOST_ID", marker));
  assert(start >= 0 && end > marker);
  const helper = source.slice(start, end);
  const resolver = helper.match(/await ([\w$]+)\(\{useWsl:!1,resourcesPath:/)[1];
  const fsAlias = helper.match(/([\w$]+)\.default\.cp\(/)[1];
  const pathAlias = helper.match(/([\w$]+)\.default\.join\(/)[1];
  const hostAlias = helper.match(/CODEX_APP_TOOLS_CALLER_HOST_ID:([\w$]+)\.([\w$]+)/);
  return vm.runInNewContext(`(${helper})`, {
    [resolver]: async ({ resourcesPath }) => ({
      cwd: resourcesPath, command: path.join(resourcesPath, "server"), enabled: false, env: { EXISTING: "kept" },
    }),
    [fsAlias]: { default: fs },
    [pathAlias]: { default: path },
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
