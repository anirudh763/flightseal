// The README and the page must keep stating the project's limits (tests/web/limits.json). Fails if one is removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { sentences, spec } = JSON.parse(readFileSync(join(ROOT, "tests/web/limits.json"), "utf8"));
const flat = (t) => t.replace(/&#39;/g, "'").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const readme = flat(readFileSync(join(ROOT, "README.md"), "utf8"));
const page = flat(readFileSync(join(ROOT, "docs/index.html"), "utf8"));

for (const [i, s] of sentences.entries()) {
  test(`limit ${i + 1} is stated in the README and on the page`, () => {
    assert.ok(readme.includes(s), `README.md lost: ${s}`);
    assert.ok(page.includes(s), `docs/index.html lost: ${s}`);
  });
}
test("both link the PX4 ULog specification", () => {
  assert.ok(readFileSync(join(ROOT, "README.md"), "utf8").includes(spec));
  assert.ok(readFileSync(join(ROOT, "docs/index.html"), "utf8").includes(spec));
});
