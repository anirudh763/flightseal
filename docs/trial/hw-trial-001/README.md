# HashWing claims handoff trial

**Case HW-TRIAL-001.** A roof inspection ended with an unexpected landing. An adjuster needs the exact copy of the flight capture and the original inspection records. All files are synthetic. The MAVLink capture is HashWing’s existing 100-byte fixture.

[Open HashWing](https://anirudh763.github.io/flightseal/console/#/app/protect)

## Operator card

Download [flight.tlog](https://anirudh763.github.io/flightseal/trial/hw-trial-001/operator/flight.tlog), [inspection-note.txt](https://anirudh763.github.io/flightseal/trial/hw-trial-001/operator/inspection-note.txt), and [evidence-index.csv](https://anirudh763.github.io/flightseal/trial/hw-trial-001/operator/evidence-index.csv). Under **Seal & send**, choose fingerprint-only mode and supply the three files. Enter case ID **HW-TRIAL-001**. Include filenames and the reported flight-end time from the note under **More options**. Seal the list and download the proof bundle. Deliver the ZIP and the originals through the same approved channel you use for inspection records. If you use a trial signer already set up in HashWing, supply its fingerprint through a separate channel already known to the reviewer. If you use the built-in one-time signer, tell the facilitator.

## Reviewer card

Send this section alone, with the delivered files and [HashWing link](https://anirudh763.github.io/flightseal/console/#/app/protect):

> Review the delivered evidence for case HW-TRIAL-001. Use HashWing Verify with the proof bundle and delivered evidence. Report which copies you can rely on for byte consistency, what you need the sender to resend, and how you confirmed the signer, if you could. Explain what the reported flight-end and seal times establish. Finish without help if you can.

## Facilitator protocol

1. Start with a fresh browser session for each role. For the comparison baseline, give the reviewer a parallel handoff with the same types of files and their usual process. Keep the answer key out of the participant cards. Record the order and any coaching. Alternate order with later participants to reduce learning effects.
2. Run the clean handoff first for technical validation. In the uncoached discrepancy run, route the operator’s same proof ZIP, the exact flight capture, and the [reviewer copy of inspection-note.txt](https://anirudh763.github.io/flightseal/trial/hw-trial-001/reviewer/inspection-note.txt). Leave out the index. Use a separate download folder to preserve the exact filename. The facilitator expects **one match, one changed copy, one missing file** and a request for both the sealed note and the index.
3. Start the operator timer when source files are handed over and stop when the bundle and originals are delivered. Start the reviewer timer when they can access the delivery and stop when they return a decision and next request. Record hands-on time separately from delivery, download and hashing time. Record any re-export, renaming, portal rejection, wrong file selection or follow-up request.
4. Before cloud deployment, use these initial targets. Operator finishes in **5 minutes** and reviewer in **3 minutes** with zero coaching. Reviewer identifies **all three file states**, requests the two correct artifacts, distinguishes signer trust from file integrity, and understands that timestamps have separate sources. Record how signer confirmation happened and whether it would work during an actual claim. A correctly unconfirmed demo signer is a valid result; require a confirmed operator signer before a real-data pilot.
5. On participant-owned representative hardware, add one synthetic 1 GiB media file in a later run. Record hash duration, peak browser memory, cancel/retry behavior and completion. Test a clean retry after an interrupted download. Require no freeze, verifier crash, or file upload to HashWing. Reproduce any failure before increasing fixture size.
6. Record participant and case aliases, task, duration, coaching count, expected and observed file states, signer confirmation source, next action and whether the reviewer would use it again. Ask for a second handoff on a different day before treating the result as evidence of repeat use. For thesis data collection, agree on consent and the study process with your advisor before recording participant data.

Use a private copy of the blank [scorecard](scorecard.csv) for observations.

The public exercise contains no real evidence. Names, contact details and trial responses belong in a private research record.
