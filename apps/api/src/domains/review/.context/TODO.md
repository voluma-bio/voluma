# Review domain TODO

- **Thumbnails redo work when there is no picture.** A 204 or a failed render stores nothing, so every view of an ended run with no converted image (failed before conversion) or a broken asset (a missing chunk after a partial seed) repeats the readable check, the store GET, `runs.load` and the `.zattrs` reads. Once the run has ended, store a "none" marker under `runThumbnailKey`'s generation, and cache a failure briefly. The render's store reads also have no deadline: a hung GET holds the request and the shared promise for that run.
