import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = '.output/chrome-mv3';
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '127');
assert.equal(manifest.action.default_popup, 'popup.html');
assert.deepEqual(manifest.host_permissions, ['https://api.resend.com/*']);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
assert.deepEqual(
  [...manifest.permissions].sort(),
  ['activeTab', 'alarms', 'identity', 'scripting', 'sidePanel', 'storage'].sort(),
);
assert.ok(manifest.content_security_policy.extension_pages.includes("script-src 'self'"));
assert.equal(manifest.content_security_policy.extension_pages.includes('unsafe-eval'), false);
for (const size of [16, 32, 48, 128]) {
  const icon = await readFile(join(root, manifest.icons[size]));
  assert.equal(icon.readUInt32BE(16), size);
  assert.equal(icon.readUInt32BE(20), size);
}
for (const file of await readdir(root, { recursive: true })) {
  if (!file.endsWith('.js')) continue;
  const code = await readFile(join(root, file), 'utf8');
  assert.equal(/https?:\/\/localhost/.test(code), false, `Development endpoint in ${file}`);
}
console.log(
  'Production bundle verified: limited permissions, no content scripts, no development endpoints.',
);
