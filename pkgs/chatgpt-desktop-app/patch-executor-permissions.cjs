// The local Work executor copies its app-tools plugin separately from the
// marketplace, then rewrites .mcp.json before registering with the cloud.
const fs = require("node:fs");
const path = require("node:path");

const copyBranch = /await (?<fs>[\w$]+\.default)\.cp\((?<plugin>[\w$]+)\.cwd,(?<destination>[\w$]+),\{recursive:!0\}\)/g;

function findCopyBranch(source) {
  const matches = [...source.matchAll(copyBranch)].filter(match => {
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 650);
    return after.includes("CODEX_APP_TOOLS_CALLER_HOST_ID") && after.includes("`.mcp.json`") && after.includes(".writeFile(");
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one local executor plugin copy branch, found ${matches.length}`);
  }
  return matches[0];
}

function patch(source) {
  const match = findCopyBranch(source);
  const api = match.groups.fs;
  // Repair an existing read-only cache before cp replaces its files, then
  // normalize the new copy before the app rewrites its manifest. Never change
  // the store source or follow symlinks; retain existing executable bits.
  const replacement = `await (async function nixCopyExecutorPlugin(source,destination){
    async function writable(root){
      const stat=await ${api}.lstat(root);
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))return;
      await ${api}.chmod(root,(stat.mode&0o7777)|0o200);
      if(stat.isDirectory())for(const name of await ${api}.readdir(root))
        await writable(require("node:path").join(root,name));
    }
    try{await writable(destination)}catch(error){if(error.code!=="ENOENT")throw error}
    await ${api}.cp(source,destination,{recursive:!0});
    await writable(destination);
  })(${match.groups.plugin}.cwd,${match.groups.destination})`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function patchDirectory(directory) {
  const candidates = fs.readdirSync(directory)
    .filter(name => /^main-.*\.js$/.test(name))
    .map(name => path.join(directory, name))
    .filter(file => fs.readFileSync(file, "utf8").includes("Local Work executor startup failed"));
  if (candidates.length !== 1) throw new Error(`Expected one local executor main bundle, found ${candidates.length}`);
  const file = candidates[0];
  fs.writeFileSync(file, patch(fs.readFileSync(file, "utf8")));
  console.log(`Patched local executor plugin copy permissions in ${file}`);
}

module.exports = { findCopyBranch, patch, patchDirectory };
if (require.main === module) {
  if (process.argv.length !== 3) throw new Error("Usage: patch-executor-permissions.cjs BUILD_DIRECTORY");
  patchDirectory(process.argv[2]);
}
