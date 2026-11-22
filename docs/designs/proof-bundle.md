# HashWing proof bundle

BMAD architecture spine. Status: accepted for implementation. Scope: manifest-mode evidence handoff.

- **AD-1 · Portable local proof.** The council voted 4–0 for a local ZIP. JSON would wrap the existing binary proof. A hosted link depends on access and retention. The recipient uses the same Verify workflow for independently delivered originals.
- **AD-2 · Signed contents.** Keep FLTSEAL1, receipt v1, and manifest v1. The last signed item identifies the versioned case report by name, reserved signed marker, length, and SHA-256. The report carries the case ID, an optional operator-reported flight end, a device-clock sealing time, and available inspection counts and findings, with coordinates omitted. Show those values only after checking the receipt and the report digest. The final report item occupies one slot, leaving 99 for originals.
- **AD-3 · Strict import.** Accept only the bounded, stored archive layout emitted by the app, with three members: manifest.fseal, receipt.txt, report.json. A bundle never contains selected original file bytes. Preserve separate artifact verification. Treat a public key supplied by a bundle as a candidate to check signatures. Determine trust independently using the recipient’s existing trust settings.
- **AD-4 · Review outcome.** Show original-file results and signer trust separately. A registered receipt can corroborate when the registry saw that proof. The operator and device fields remain claims from their named sources.

The independent architecture advisor approved AD-1–4 with checks for substituted report bytes, malformed ZIPs, same-name originals, and correct original counts.

## Redacted claims trial

Recruit one inspection operator and one independent claims reviewer through an authorized channel. Use a synthetic or redacted case ID, log, and photos. The operator sends the proof ZIP and originals through their usual delivery channel. Have the reviewer run Verify without instruction beyond the link and document which files they would request. Repeat with one exact original omitted and one same-name media file re-exported. Record operator preparation time, reviewer completion time, missing or substituted files found, signer confirmation and how it was obtained, and whether the reviewer requested the correct artifact. Compare with the same handoff without HashWing. Keep personal and claim data out of the trial notes.
