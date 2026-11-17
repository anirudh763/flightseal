// Sealing a whole file (docs/rawfile.js, tools/raw_file.py): the browser and Python encoders must write identical
// records, the real C++ CLI must seal and verify them, both extractors must give back the exact original bytes, and
// an edit or a cut tail must be caught.   FSEAL_BIN=build/fseal node --test tests/web/rawfile.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { fileToRecords, recordsToFile, parseManifest, handoverText, parseHandover, RAW_MAX_BYTES, RAW_CHUNK } from "../../docs/rawfile.js";
import { SEAL_MAX_BYTES } from "../../docs/wasm/client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FSEAL = process.env.FSEAL_BIN || join(ROOT, "build", "fseal");
const TOOL = join(ROOT, "tools", "raw_file.py");
const PX4 = join(ROOT, "tests", ".data", "px4-sample.ulg");
if (!existsSync(FSEAL)) throw new Error(`build the CLI first (cmake --build build); missing ${FSEAL}`);
const dir = mkdtempSync(join(tmpdir(), "fseal-raw-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (cmd, args, input) => spawnSync(cmd, args, { input, encoding: input === undefined ? "utf8" : undefined, maxBuffer: 1 << 28 });
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (!existsSync(PX4)) throw new Error("tests/.data/px4-sample.ulg is missing: python3 tools/fetch_sample.py tests/.data");
const sample = readFileSync(PX4); // a real PX4 flight log; its size is not a multiple of the chunk
const name = "flight 7 (ä).ulg";
const original = join(dir, name);
writeFileSync(original, sample);

function seal(tsv, tag) {
  const key = join(dir, `${tag}.pem`), log = join(dir, `${tag}.fseal`), receipts = join(dir, `${tag}.receipts`);
  const pub = run(FSEAL, ["keygen", key]).stdout.toString().trim();
  const r = run(FSEAL, ["append", log, "--key", key, "--receipts", receipts, "--every", "1000000"], tsv);
  assert.equal(r.status, 0, r.stderr?.toString());
  return { log, receipts, pub };
}
const verify = (log, receipts, pub) => run(FSEAL, ["verify", log, "--receipts", receipts, "--pubkey", pub]);

test("browser and Python encoders write identical records", async () => {
  const js = Buffer.from(await (await fileToRecords(new File([sample], name))).records.arrayBuffer());
  const py = run("python3", [TOOL, "encode", original], Buffer.alloc(0));
  assert.equal(py.status, 0, py.stderr.toString());
  assert.equal(sha(js), sha(py.stdout));
  assert.match(js.toString("utf8", 0, 200), /^0\tflightseal-file v1 name=flight%207%20\(%C3%A4\)\.ulg bytes=\d+ sha256=[0-9a-f]{64} chunk=49152\n/);
});

test("the CLI seals the records, verifies INTACT with one receipt, and both extractors give back the exact file", async () => {
  const { records, sha256 } = await fileToRecords(new File([sample], name));
  assert.equal(sha256, sha(sample));
  const { log, receipts, pub } = seal(Buffer.from(await records.arrayBuffer()), "ok");
  assert.equal(readFileSync(receipts, "utf8").trim().split("\n").length, 1);
  const v = verify(log, receipts, pub);
  assert.equal(v.status, 0);
  assert.match(v.stdout.toString(), /RESULT: INTACT/);
  assert.match(v.stdout.toString(), / 0 record\(s\) after the last receipt are not covered/);

  const js = await recordsToFile(readFileSync(log));
  assert.equal(js.matches, true);
  assert.equal(js.name, name);
  assert.equal(Buffer.compare(Buffer.from(js.data), sample), 0);
  const out = join(dir, "restored.bin");
  const py = run("python3", [TOOL, "extract", log, out]);
  assert.equal(py.status, 0, py.stderr);
  assert.equal(sha(readFileSync(out)), sha(sample));
});

test("a one-byte edit inside the sealed file and a cut tail are both TAMPERED", async () => {
  const { records } = await fileToRecords(new File([sample], name));
  const { log, receipts, pub } = seal(Buffer.from(await records.arrayBuffer()), "attack");
  const bytes = readFileSync(log);
  const edited = Buffer.from(bytes);
  const second = 8 + 20 + bytes.readUInt32LE(8) + 36; // record 1 starts after the manifest record
  const at = second + 20 + 1000; // inside record 1's base64 payload
  edited[at] = edited[at] === 0x41 ? 0x42 : 0x41;
  writeFileSync(join(dir, "edited.fseal"), edited);
  const e = verify(join(dir, "edited.fseal"), receipts, pub);
  assert.equal(e.status, 1);
  assert.match(e.stdout.toString(), /RESULT: TAMPERED/);
  writeFileSync(join(dir, "short.fseal"), bytes.subarray(0, bytes.length - 70_000)); // drops the last record(s)
  const s = verify(join(dir, "short.fseal"), receipts, pub);
  assert.equal(s.status, 1);
  assert.match(s.stdout.toString(), /RESULT: TAMPERED/);
});

test("a whole rewrite of the file with a fresh key verifies on its own but fails against the witness's receipt", async () => {
  const { records: honest } = await fileToRecords(new File([sample], name));
  const witness = seal(Buffer.from(await honest.arrayBuffer()), "honest");
  const changed = Buffer.from(sample); changed[100] ^= 1;
  const { records: forged } = await fileToRecords(new File([changed], name));
  const attacker = seal(Buffer.from(await forged.arrayBuffer()), "forged");
  assert.equal(verify(attacker.log, attacker.receipts, attacker.pub).status, 0); // self-consistent
  const r = verify(attacker.log, witness.receipts, witness.pub);
  assert.notEqual(r.status, 0); // the witness's receipt and key reject it
});

test("extract refuses logs that are not sealed files, and rejects mismatched contents", async () => {
  assert.equal(await recordsToFile(new Uint8Array([1, 2, 3])), null);
  const px4log = join(dir, "plain.fseal");
  run(FSEAL, ["append", px4log], Buffer.from("5\thello\n6\tworld\n"));
  assert.equal(await recordsToFile(readFileSync(px4log)), null);
  // A manifest whose recorded SHA-256 is wrong: the rebuilt file is flagged, never silently accepted.
  const bad = Buffer.from(`0\tflightseal-file v1 name=a bytes=2 sha256=${"0".repeat(64)} chunk=49152\n0\taGk=\n`);
  const badlog = join(dir, "bad.fseal");
  run(FSEAL, ["append", badlog], bad);
  assert.equal((await recordsToFile(readFileSync(badlog))).matches, false);
  assert.notEqual(run("python3", [TOOL, "extract", badlog, join(dir, "x")]).status, 0);
  // A manifest claiming a huge original is refused before anything that size is allocated.
  const huge = join(dir, "huge.fseal");
  run(FSEAL, ["append", huge], Buffer.from(`0\tflightseal-file v1 name=a bytes=999999999999999 sha256=${"0".repeat(64)} chunk=49152\n0\taGk=\n`));
  await assert.rejects(recordsToFile(readFileSync(huge)), /do not add up/);
  assert.notEqual(run("python3", [TOOL, "extract", huge, join(dir, "y")]).status, 0);
  // Chunks out of order are rejected.
  const swapped = join(dir, "swapped.fseal");
  run(FSEAL, ["append", swapped], Buffer.from(`0\tflightseal-file v1 name=a bytes=2 sha256=${sha(Buffer.from("hi"))} chunk=49152\n1\taGk=\n`));
  await assert.rejects(recordsToFile(readFileSync(swapped)));
});

test("a file at the size limit fits the browser sealer's input and output caps", async () => {
  const { records } = await fileToRecords(new File([new Uint8Array(RAW_MAX_BYTES)], "max.ulg"));
  assert.ok(records.size <= SEAL_MAX_BYTES, `${records.size} > ${SEAL_MAX_BYTES}`);
  const chunks = Math.ceil(RAW_MAX_BYTES / RAW_CHUNK);
  const sealed = 8 + records.size + (chunks + 1) * 56; // magic, payload text (an upper bound), per-record overhead
  assert.ok(sealed <= 64 * 1024 * 1024, `sealed ${sealed} bytes exceeds the 64 MiB output cap`);
});

test("both readers refuse the same malformed logs", async () => {
  const cases = {
    "bad name escape": `0\tflightseal-file v1 name=%E0%A4%A bytes=2 sha256=${sha(Buffer.from("hi"))} chunk=49152\n0\taGk=\n`,
    "unpadded base64": `0\tflightseal-file v1 name=a bytes=2 sha256=${sha(Buffer.from("hi"))} chunk=49152\n0\taGk\n`,
    "base64 with a space": `0\tflightseal-file v1 name=a bytes=2 sha256=${sha(Buffer.from("hi"))} chunk=49152\n0\taG k=\n`,
    "byte-order mark": `0\t\ufeffflightseal-file v1 name=a bytes=2 sha256=${sha(Buffer.from("hi"))} chunk=49152\n0\taGk=\n`,
    "broken percent escape": `0\tflightseal-file v1 name=a%ZZ bytes=2 sha256=${sha(Buffer.from("hi"))} chunk=49152\n0\taGk=\n`,
    "no-break space in name": `0\tflightseal-file v1 name=a\u00a0b bytes=2 sha256=${sha(Buffer.from("hi"))} chunk=49152\n0\taGk=\n`,
    "short middle chunk": `0\tflightseal-file v1 name=a bytes=4 sha256=${sha(Buffer.from("hiya"))} chunk=3\n0\taGk=\n2\teWE=\n`,
    "non-ASCII digits": `0\tflightseal-file v1 name=a bytes=\u0662 sha256=${sha(Buffer.from("hi"))} chunk=49152\n0\taGk=\n`,
  };
  for (const [label, tsv] of Object.entries(cases)) {
    const log = join(dir, `${label.replace(/ /g, "-")}.fseal`);
    assert.equal(run(FSEAL, ["append", log], Buffer.from(tsv)).status, 0, label);
    const js = await recordsToFile(readFileSync(log)).then((r) => (r && r.matches ? "accepted" : "refused"), () => "refused");
    assert.equal(js, "refused", `browser, ${label}`);
    assert.notEqual(run("python3", [TOOL, "extract", log, join(dir, "z")]).status, 0, `python, ${label}`);
  }
  const empty = join(dir, "empty.fseal");
  writeFileSync(empty, "FLTSEAL1");
  assert.equal(await recordsToFile(readFileSync(empty)), null); // holds no file; not "damaged"
});

test("Python writes LF-only bytes, and backslash folder names are dropped by both encoders", async () => {
  const winName = join(dir, "C:\\logs\\flight.ulg");
  writeFileSync(winName, Buffer.from("abc"));
  const py = run("python3", [TOOL, "encode", winName], Buffer.alloc(0)).stdout;
  assert.equal(py.includes(13), false);
  const js = Buffer.from(await (await fileToRecords(new File([Buffer.from("abc")], "C:\\logs\\flight.ulg"))).records.arrayBuffer());
  assert.equal(sha(js), sha(py));
  assert.match(js.toString(), /name=flight\.ulg /);
});

test("input limits and manifest parsing", async () => {
  await assert.rejects(fileToRecords(new File([], "empty.ulg")), /empty/);
  await assert.rejects(fileToRecords(new File([new Uint8Array(RAW_MAX_BYTES + 1)], "big.ulg")), /larger than 45 MiB/);
  assert.equal(parseManifest("flightseal-file v1 name=../../etc%2Fpasswd bytes=1 sha256=" + "a".repeat(64) + " chunk=1").name, "passwd");
  assert.equal(parseManifest("flightseal-file v2 name=a bytes=1 sha256=" + "a".repeat(64) + " chunk=1"), null);
  assert.equal(parseManifest("flightseal-file v1 name=%E0%A4%A bytes=1 sha256=" + "a".repeat(64) + " chunk=1"), null);
});

test("the handover message round-trips the receipt and key, and conflicting keys are refused", () => {
  const key = "ab".repeat(32);
  const receipt = `fseal-receipt v1 count=3 head=${"cd".repeat(32)} key=${key} sig=${"ef".repeat(64)}`;
  const text = handoverText({ name: "a.ulg", bytes: 5, sha256: "00".repeat(32), receipts: receipt + "\n", publicKey: key, sealedAt: "2026-11-17T10:00:00Z", checkUrl: "https://example.test/" });
  const quoted = text.split("\n").map((l) => `> ${l}`).join("\r\n"); // as an email reply would quote it
  assert.deepEqual(parseHandover(quoted), { receipts: receipt + "\n", publicKey: key, keyConflict: false });
  assert.equal(parseHandover(text.replace(`Public key: ${key}`, `Public key: ${"11".repeat(32)}`)).keyConflict, true);
  assert.equal(parseHandover("nothing here").receipts, "");
  // A mail program wrapped every line at 72 characters, breaking inside the hex fields.
  const wrapped = text.split("\n").flatMap((line) => line.match(/.{1,72}/g) || [""]).map((l) => `> ${l}`).join("\n");
  assert.deepEqual(parseHandover(wrapped), { receipts: receipt + "\n", publicKey: key, keyConflict: false });
  // Upper-case hex, and the same message pasted twice (a quoted reply under a forward).
  assert.deepEqual(parseHandover(text.toUpperCase().replace(/FSEAL-RECEIPT V1 COUNT=/g, "fseal-receipt v1 count=").replace(/HEAD=|KEY=|SIG=/g, (m) => m.toLowerCase()).replace("PUBLIC KEY:", "Public key:") + text),
    { receipts: receipt + "\n", publicKey: key, keyConflict: false });
});
