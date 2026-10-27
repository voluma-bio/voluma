/** Small OA6-1RK fixture adapted from the approved mockup, not a verified run record.
 * Source: voluma-bio/docs/work/microct-workflow-mvp/mockups/review-live.html.
 * Femoral demo numbers approximate the mockup's comparisons and are marked synthetic.
 * Missing numbers stay null. No private images, volumes, or lab files are bundled.
 */
import {
  type Asset,
  type Measurement,
  type ReviewRun,
  type ReviewTask,
  reviewRunSchema,
  type Structure,
} from "@voluma/contracts";

const missing = (id: string, label: string, path: string): Asset => ({
  id,
  label,
  path,
  url: null,
  unavailableReason: "Private reference asset is not included in this demo.",
});
const measure = (
  id: string,
  label: string,
  value: number | null,
  unit: string,
  evidenceIds: string[],
  references: Measurement["references"] = [],
): Measurement => ({
  id,
  label,
  value,
  unit,
  evidenceIds,
  references,
  status: "provisional",
  origin: value === null ? "unavailable" : "documented",
});
const base = { resultRevisionId: "r1", messages: [] };
const tasks: ReviewTask[] = [
  {
    ...base,
    id: "segmentation",
    title: "Segmentation",
    ask: "Segment the knee and separate every mineralized structure.",
    dependsOn: [],
    structureIds: ["femur", "tibia", "patella", "fibula", "ossification"],
    actions: [
      "Switched from threshold components to watershed with reviewed marker arrays when femur and tibia fused.",
      "Separated detached tibial-margin fragments and a proximal patellar ossification after three review rounds.",
    ],
    checker: {
      verdict: "passed",
      text: "The documented independent re-review found no remaining coordinate or arithmetic blocker. Anatomical ownership of the separate ossification is still a reviewer decision.",
    },
    measurements: [
      measure("patella-volume", "Patella core volume", null, "mm³", [
        "seg-slices",
      ]),
      measure("ossification-volume", "Separate ossification", 0.121, "mm³", [
        "seg-slices",
      ]),
    ],
    checks: [
      {
        id: "ossification",
        title: "Separate proximal patellar ossification",
        detail:
          "The disconnected 0.121 mm³ region was kept separate from the patella core. Decide whether that matches the anatomical definition.",
        status: "open",
      },
    ],
    evidence: [
      missing(
        "seg-slices",
        "Separated labels on orthogonal slices",
        "assets/evidence/seg-slices.webp",
      ),
    ],
    files: [
      missing(
        "labels",
        "Segmentation label volume",
        "review-07-separated/labels.npy",
      ),
      missing(
        "seg-provenance",
        "Segmentation provenance",
        "review-07-separated/provenance.json",
      ),
    ],
  },
  {
    ...base,
    id: "femur",
    title: "Distal femur",
    ask: "Measure distal femoral width and length, and the width/length ratio.",
    dependsOn: ["segmentation"],
    structureIds: ["femur"],
    actions: [
      "Measured width on a shaft-transverse plane through the condyles, keeping attached outgrowths.",
      "Measured a straight 3D distance from ridge onset (A) to the notch roof (C), not a surface arc.",
      "Moving A along the reviewed transition gives a length range of 2.387–2.479 mm.",
    ],
    checker: {
      verdict: "needs-review",
      text: "The second agent reproduced both distances and their ratio. Landmark A remains uncertain; the primary reader’s length falls outside the documented placement range.",
    },
    measurements: [
      measure(
        "femoral-width",
        "Distal femoral width",
        3.393,
        "mm",
        ["femur-anterior"],
        [{ reader: "Reader 1", value: 3.48 }],
      ),
      measure(
        "femoral-length",
        "Femoral length (A–C)",
        2.423,
        "mm",
        ["femur-anterior", "femur-joint"],
        [{ reader: "Reader 1", value: 2.29 }],
      ),
      measure(
        "femoral-ratio",
        "Width / length",
        1.4,
        "",
        ["femur-anterior"],
        [
          { reader: "Reader 1", value: 1.52 },
          { reader: "Reader 2", value: 1.404 },
        ],
      ),
    ],
    checks: [
      {
        id: "width-plane",
        title: "Width includes attached outgrowths",
        detail:
          "Confirm the shaft-transverse plane and whether your protocol includes the attached condylar outgrowths.",
        status: "open",
      },
      {
        id: "landmark-a",
        title: "Review landmark A",
        detail:
          "Ridge onset is the least certain landmark. Reader 1 reports 2.290 mm, outside the documented 2.387–2.479 mm placement range.",
        status: "open",
      },
    ],
    evidence: [
      missing(
        "femur-anterior",
        "Anterior view with A, C and width chord",
        "assets/evidence/femur-anterior.webp",
      ),
      missing(
        "femur-joint",
        "Joint-facing view",
        "assets/evidence/femur-joint.webp",
      ),
    ],
    files: [
      missing(
        "measurements",
        "Measurements and coordinates",
        "final-measurements/measurements.json",
      ),
      missing(
        "comparison",
        "Reference cells and hashes",
        "supplement-comparison/comparison.json",
      ),
    ],
  },
  {
    ...base,
    id: "iioc",
    title: "Tibial IIOC",
    ask: "Measure the tibial IIOC: total volume, bone volume, BV/TV, heights and growth-plate width.",
    dependsOn: ["segmentation"],
    structureIds: ["tibia", "iioc-envelope", "iioc-bone"],
    actions: [
      "Used the marked IIOC region above the growth plate, retaining marrow in total volume.",
      "Sealed the growth-plate cut before hole filling and excluded small disconnected fragments.",
      "Measured direct 3D heights in the tibial frame; bone volume uses unfiltered HU > 2459.875 inside the same ROI.",
    ],
    checker: {
      verdict: "needs-review",
      text: "No coordinate or arithmetic blocker for provisional reporting. A disconnected medial region needs an anatomical ownership decision.",
    },
    measurements: [
      measure("iioc-tv", "Total volume (TV)", null, "mm³", ["iioc-coronal"]),
      measure("iioc-bv", "Bone volume (BV)", null, "mm³", ["iioc-coronal"]),
      measure("iioc-bvtv", "BV/TV", null, "%", ["iioc-coronal"]),
      measure("iioc-height", "Maximum height", null, "mm", ["iioc-rulers"]),
      measure("iioc-lateral-height", "Lateral height", null, "mm", [
        "iioc-rulers",
      ]),
      measure("iioc-medial-height", "Medial height", null, "mm", [
        "iioc-rulers",
      ]),
      measure("iioc-width", "Growth-plate width", null, "mm", ["iioc-rulers"]),
      measure("iioc-ratio", "Height / width", null, "", ["iioc-rulers"]),
    ],
    checks: [
      {
        id: "medial-region",
        title: "Check the medial region",
        detail:
          "The growth-plate face was traced every 20 slices and interpolated. Review medial bridges and the disconnected medial region.",
        status: "open",
      },
    ],
    evidence: [
      missing(
        "iioc-coronal",
        "Envelope and growth-plate face",
        "assets/evidence/iioc-coronal.webp",
      ),
      missing(
        "iioc-rulers",
        "Height and width rulers",
        "assets/evidence/iioc-rulers.webp",
      ),
    ],
    files: [
      missing("iioc-results", "Values and sensitivity", "iioc/results.json"),
      missing("iioc-mask", "IIOC tissue mask", "iioc/tissue-mask-original.npy"),
    ],
  },
  {
    ...base,
    id: "trabecular",
    title: "Trabecular IIOC",
    ask: "Now only the trabecular part of the IIOC: TV, BV, BV/TV, Tb.Th, Tb.N and Tb.Sp.",
    dependsOn: ["iioc"],
    structureIds: ["trab-roi", "trab-bone"],
    actions: [
      "Traced an anatomical trabecular compartment rather than subtracting plate candidates from the whole IIOC.",
      "Kept two voxels of clearance from the outer shell and growth-plate face.",
      "Tb.Th and Tb.Sp use largest-inscribed-sphere diameters. Tb.N is (BV/TV)/Tb.Th, not a direct count.",
    ],
    checker: {
      verdict: "needs-review",
      text: "Arithmetic and grid checks passed. The anatomical boundary remains unreviewed, especially at the dense medial plate-to-trabecula transition.",
    },
    measurements: [
      measure("trab-tv", "Total volume (TV)", null, "mm³", ["trab-coronal"]),
      measure("trab-bv", "Bone volume (BV)", null, "mm³", ["trab-coronal"]),
      measure("trab-bvtv", "BV/TV", null, "%", ["trab-coronal"]),
      measure("trab-th", "Trabecular thickness (Tb.Th)", 97.6, "µm", [
        "trab-spheres",
      ]),
      measure("trab-n", "Trabecular number (Tb.N)", null, "/mm", [
        "trab-spheres",
      ]),
      measure("trab-sp", "Trabecular separation (Tb.Sp)", 262.9, "µm", [
        "trab-spheres",
      ]),
    ],
    checks: [
      {
        id: "trab-boundary",
        title: "Review the plate-to-trabecula boundary",
        detail:
          "Every trabecular value depends on this boundary. The medial plate thins into trabeculae; the dividing line is an anatomical judgment.",
        status: "open",
      },
    ],
    evidence: [
      missing(
        "trab-coronal",
        "Trabecular ROI on a coronal section",
        "assets/evidence/trab-coronal.webp",
      ),
      missing(
        "trab-spheres",
        "Thickness and separation sphere maps",
        "assets/evidence/trab-spheres.webp",
      ),
    ],
    files: [
      missing(
        "trab-results",
        "Trabecular values and sensitivity",
        "tibial-trabecular/results.json",
      ),
      missing(
        "trab-mask",
        "Trabecular tissue ROI",
        "tibial-trabecular/tissue-mask.npy",
      ),
    ],
  },
  {
    ...base,
    id: "plate",
    title: "Plate thickness",
    ask: "Measure subchondral plate thickness, medial and lateral.",
    dependsOn: ["trabecular"],
    structureIds: ["medial-plate", "lateral-plate"],
    actions: [
      "Sampled 0.42 × 0.42 mm patches on each plateau and took the median first contiguous mineralized run along the shaft.",
      "This is a directional candidate, not the paper’s surface-to-first-trabecula measurement.",
    ],
    checker: {
      verdict: "needs-review",
      text: "Not accepted as an anatomical measurement: trabecular bridges extend some runs. A reviewed plate-to-trabecula boundary is needed.",
    },
    measurements: [
      {
        ...measure("plate-medial", "Medial plate thickness", null, "µm", [
          "plate-sagittal",
        ]),
        status: "candidate",
      },
      {
        ...measure("plate-lateral", "Lateral plate thickness", null, "µm", [
          "plate-sagittal",
        ]),
        status: "candidate",
      },
    ],
    checks: [
      {
        id: "plate-bridges",
        title: "Exclude trabecular bridges",
        detail:
          "668 of 1600 lateral columns extended beyond 0.35 mm. Settle the trabecular boundary before treating these candidates as plate thickness.",
        status: "open",
      },
    ],
    evidence: [
      missing(
        "plate-sagittal",
        "Medial and lateral plate patches",
        "assets/evidence/plate-sagittal.webp",
      ),
    ],
    files: [
      missing(
        "plate-mask",
        "Lateral plate patch",
        "iioc/lateral-plate-mask.npy",
      ),
    ],
  },
];

const structureNames = [
  ["femur", "Femur"],
  ["tibia", "Tibia"],
  ["patella", "Patella"],
  ["fibula", "Fibula"],
  ["medial-min", "Medial joint mineralization"],
  ["lateral-min", "Lateral joint mineralization"],
  ["anterior-min", "Anterior joint mineralization"],
  ["medial-sesamoid", "Medial sesamoid"],
  ["lateral-sesamoid", "Lateral sesamoid"],
  ["anterior-fragment", "Anterior tibial margin fragment"],
  ["lateral-fragment", "Lateral tibial margin fragment"],
  ["ossification", "Proximal patellar ossification"],
  ["iioc-envelope", "IIOC tissue envelope"],
  ["iioc-bone", "IIOC mineralized bone"],
  ["medial-plate", "Medial plate patch"],
  ["lateral-plate", "Lateral plate patch"],
  ["trab-roi", "Trabecular tissue ROI"],
  ["trab-bone", "Trabecular bone"],
];
const structures: Structure[] = structureNames.map(([id, name], index) => ({
  id,
  name,
  declared: index < 4 || index >= 12,
  status: index >= 12 ? "provisional" : "done",
  reason:
    index >= 12
      ? "Anatomical boundary requires review; mesh unavailable in demo."
      : "Reported segmented in the reference mockup; mesh unavailable in demo.",
}));

export function createFixture(): ReviewRun {
  const fixtureTasks = structuredClone(tasks);
  for (const task of fixtureTasks) {
    if (task.id === "femur") {
      for (const measurement of task.measurements)
        measurement.origin = "synthetic";
    }
  }
  return reviewRunSchema.parse({
    id: "oa6-1rk",
    sample: "OA6-1RK",
    workflow: "Mouse OA knee",
    workflowVersion: "1.0",
    revisions: [
      {
        id: "r1",
        label: "Original result",
        createdAt: "2026-10-24T12:00:00Z",
        tasks: fixtureTasks,
        structures,
      },
    ],
    record: [
      {
        id: "initial",
        revisionId: "r1",
        taskId: null,
        text: "Demo initialized from documented mockup content. This is not the authoritative scientific run record.",
        at: "2026-10-24T12:00:00Z",
      },
    ],
  });
}
