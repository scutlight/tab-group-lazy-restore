import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, "../extension");
const files = await readdir(extensionDir);
const worker = await readFile(resolve(extensionDir, "service-worker.js"), "utf8");
const manifest = JSON.parse(await readFile(resolve(extensionDir, "manifest.json"), "utf8"));
const allText = (
  await Promise.all(
    files
      .filter((file) => /\.(?:js|json|html|md|css)$/.test(file))
      .map((file) => readFile(resolve(extensionDir, file), "utf8"))
  )
).join("\n");

assert.equal(manifest.version, "4.3.0");
assert.equal(manifest.name, "标签组懒恢复");
assert.equal(manifest.action.default_title, "标签组懒恢复");
assert.equal(manifest.key, undefined, "public source must not embed a fixed extension key");
assert.equal(manifest.host_permissions, undefined, "the extension does not need host permissions");
assert.equal(manifest.content_scripts, undefined, "the extension does not inject content scripts");
assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
assert.deepEqual(Object.keys(manifest.action.default_icon), ["16", "32"]);

for (const forbiddenArtifact of ["recovering.html", "recovering.js", "recovery-plan.json"]) {
  assert.ok(!files.includes(forbiddenArtifact), `forbidden recovery artifact: ${forbiddenArtifact}`);
}

for (const forbiddenCall of [
  /chrome\.tabs\.create\s*\(/,
  /chrome\.tabs\.remove\s*\(/,
  /chrome\.tabs\.move\s*\(/,
  /chrome\.tabs\.group\s*\(/,
  /chrome\.tabs\.ungroup\s*\(/
]) {
  assert.doesNotMatch(worker, forbiddenCall);
}

const tabUpdateCalls = worker.match(/chrome\.tabs\.update\s*\(/g) || [];
assert.equal(tabUpdateCalls.length, 1, "only current-tab activation may use tabs.update");
assert.match(worker, /chrome\.tabs\.update\(target\.id,\s*\{\s*active:\s*true\s*\}\)/s);
assert.doesNotMatch(worker, /chrome\.tabs\.update\s*\([^)]*\burl\s*:/s);

for (const networkPrimitive of [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\s*\(/
]) {
  assert.doesNotMatch(allText, networkPrimitive, "runtime source must not send network requests");
}

assert.match(worker, /chrome\.tabs\.discard\s*\(/);
assert.doesNotMatch(worker, /^void startStartupRestore\(\)/m, "startup must not run at module load");

console.log("static safety tests passed");

