// Adapt the bundled marketplace's Linux copy helper to read-only Nix inputs.
// Fail closed when upstream changes the helper instead of silently losing the fix.
const fs = require("node:fs");
const path = require("node:path");

// Two minified shapes of the same Linux branch. Builds up to 26.1007 (Vite):
//   if(X.default.platform!==`win32`){await Y.default.cp(s,d,{...});return}
// From 26.1023 (webpack, early-bootstrap-*.js chunks):
//   if("win32"!==X().platform)return void await Y().cp(s,d,{...});
// The fs/os accessors are captured whole (`Y.default` or `Y()`).
const accessor = String.raw`[\w$]+(?:\.default|\(\))`;
const copyBranch = new RegExp([
  String.raw`if\((?<os>${accessor})\.platform!==\`win32\`\)\{await (?<fs>${accessor})\.cp\((?<source>[\w$]+),(?<destination>[\w$]+),\{recursive:!0,verbatimSymlinks:!0\}\);return\}`,
  String.raw`if\("win32"!==(?<os2>${accessor})\.platform\)return void await (?<fs2>${accessor})\.cp\((?<source2>[\w$]+),(?<destination2>[\w$]+),\{recursive:!0,verbatimSymlinks:!0\}\);`,
].join("|"), "g");

function findCopyBranch(source) {
  const matches = [...source.matchAll(copyBranch)];
  if (matches.length !== 1) {
    throw new Error(`Expected one bundled plugin copy branch, found ${matches.length}`);
  }
  const match = matches[0];
  const g = match.groups;
  match.groups = g.fs !== undefined ? g : { os: g.os2, fs: g.fs2, source: g.source2, destination: g.destination2 };
  const before = source.slice(Math.max(0, match.index - 250), match.index);
  const after = source.slice(match.index + match[0].length, match.index + match[0].length + 350);
  if (!before.includes("/usr/bin/ditto") ||
      !after.includes("copyDirectoryAllowDecryptedDestinationOnEncryptionFailure")) {
    throw new Error("Copy branch is not the expected bundled marketplace helper");
  }
  return match;
}

function patch(source) {
  const match = findCopyBranch(source);
  const api = match.groups.fs;
  const destination = match.groups.destination;
  // Walk only the newly copied tree. lstat avoids chmod following symlinks
  // back into the Nix store or to any other target outside the cache.
  const makeWritable = `await (async function nixWritablePluginCopy(root){
    const stat=await ${api}.lstat(root);
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))return;
    await ${api}.chmod(root,(stat.mode&0o7777)|0o200);
    if(stat.isDirectory())for(const name of await ${api}.readdir(root))
      await nixWritablePluginCopy(root+"/"+name);
  })(${destination});`;
  const g = match.groups;
  const copy = `await ${api}.cp(${g.source},${destination},{recursive:!0,verbatimSymlinks:!0});`;
  const replacement = match[0].startsWith("if(\"win32\"")
    ? `if("win32"!==${g.os}.platform){${copy}${makeWritable}return}`
    : match[0].replace(";return}", `;${makeWritable}return}`);
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function patchDirectory(directory) {
  // The marker string appears in more than one chunk from 26.1023; the copy
  // branch itself is what identifies the bundle to patch.
  const candidates = fs.readdirSync(directory)
    .filter(name => /^(main|early-bootstrap)-.*\.js$/.test(name))
    .map(name => path.join(directory, name))
    .filter(file => {
      const source = fs.readFileSync(file, "utf8");
      return source.includes("plugin_marketplace_folder_write_failed") && [...source.matchAll(copyBranch)].length > 0;
    });
  if (candidates.length !== 1) {
    throw new Error(`Expected one marketplace main bundle, found ${candidates.length}`);
  }
  const file = candidates[0];
  fs.writeFileSync(file, patch(fs.readFileSync(file, "utf8")));
  console.log(`Patched bundled plugin copy permissions in ${file}`);
}

module.exports = { findCopyBranch, patch, patchDirectory };
if (require.main === module) {
  if (process.argv.length !== 3) throw new Error("Usage: patch-plugin-permissions.cjs BUILD_DIRECTORY");
  patchDirectory(process.argv[2]);
}
