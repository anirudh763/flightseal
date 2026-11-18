# VoiceOver pass (required QA)

Owner decision 2026-11-18: this is the next required QA task. Automated scans (axe) do not close it, and a trial by a
proficient screen-reader user is a separate usability check that this pass does not replace.

Run it on the live site, <https://anirudh763.github.io/flightseal/>, after the download-status and Jobs changes are
merged. Write what you hear, not what you expected. When a task fails: record it, fix it, then repeat that task and
record the repeat as a new row.

## Setup (fill in)

| Item | Value |
|---|---|
| Date | |
| Tester | |
| Mac model and macOS version | |
| Browser and version (Safari is VoiceOver's reference browser; repeat key tasks in Chrome) | |
| VoiceOver settings changed from default (verbosity, hints, rotor items) | |
| Site version (`main` commit, from the page footer or `git log -1`) | |
| Test files used (a small file under 45 MiB; two or more large files) | |

VoiceOver keys: Cmd+F5 turns it on or off. VO = Control+Option. VO+Right/Left moves; VO+Space activates; VO+U opens
the rotor (headings, links, form controls, landmarks); VO+A reads from here.

## Tasks

For each task: do it with the keyboard and VoiceOver only, then fill in the record row. "Pass" means you could finish
it without sight, every control had a clear spoken name, and every change (progress, result, error) was announced
without you having to search for it.

| # | Task | What should be announced |
|---|---|---|
| 1 | Front page: find and open Seal files | Page title and heading "HashWing"; the three links by name |
| 2 | Seal & send: choose a small file and seal it | The file picker's label; the file name and size; progress; the result heading; the next step |
| 3 | Seal a large file, then **Cancel** during hashing | Progress updates are announced politely, not on every tick; Cancel is reachable; "cancelled" is announced and focus lands somewhere sensible |
| 4 | Errors: choose a file over 45 MiB; copy when the clipboard is blocked | The error is announced once, says what to do, and the field it belongs to is identified |
| 5 | Download the sealed file and the receipt | The download status ("Download started ...") is announced; nothing claims the file was saved |
| 6 | Replace unsaved work: press Seal more files before confirming the download | The one-time question is announced, with focus on it, and each button's name is clear |
| 7 | Verify: paste the receipt message, choose the sealed file, Check files | The choice "I have files"; field labels; the verdict headline is read first and focus moves to it |
| 8 | Verify results: a wrong file, a missing file, an untrusted signer | Each headline (Not verified / Incomplete / Files match · signer not confirmed) and its next step |
| 9 | Download a report from Verify | The menu opens, items are named, and the download is announced |
| 10 | Jobs: search, page, Resume, Export, Remove (with its confirm) | Table caption and counts; each row's actions name the job; the Remove dialog traps focus and Keep it is the default |
| 11 | Trust: add a trusted company fingerprint | Labels, the required confirmation checkbox, the saved result |
| 12 | Sign-in (registry build only) | **Not testable on the public site yet**: the registry is off there. Run on the local registry build when it is needed. |
| 13 | Key administration (company keys on Trust) | **Not built yet** (AC-38..AC-40). Add rows when it lands. |

## Record

| Date | Task # | Browser | Steps taken | What VoiceOver said | Result (pass / fail) | Fix (PR) | Repeat result |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
