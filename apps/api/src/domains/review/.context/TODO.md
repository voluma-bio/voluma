# Review domain TODO

- **The scan is not a volume in the review data yet.** `fold` leaves an annotation on the scan with `volumeId` null for the API to fill, and the contract needs the scan as a `Volume` (`shapeZyx`, `affine` from its DICOM headers, `data` of format `dicom`). The API reads no DICOM headers, so `review-run.ts` leaves those annotations out, with every measurement, score and To check `focus` reference to them. Fill it from the input: the intake task's `hu.json` (spacing and shape on the scan grid), or headers read once at upload and stored with the input.
- **Task titles are the task ids** until the plan carries `title` ([#86](https://github.com/voluma-bio/voluma/pull/86)); then `titleOf` in `review-run.ts` reads it.
- **Files are R2 keys only.** Serving evidence and files to the browser follows the same-origin download descriptor (`@voluma/contracts/download`), once the R2 adapter on `andrew/r2-reference-viewer` lands.
