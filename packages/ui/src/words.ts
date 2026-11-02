/**
 * The on-screen word for one scanned knee, in every case a sentence needs: "sample", the mouse-OA
 * workflow's noun (agent-model design, review.md "Naming"). Every on-screen text that names one
 * goes through this; it moves into the workflow's definition when a second workflow names its
 * input differently. Code, routes and the API keep "input" and "input"; "run" stays one go of the AI.
 */
export const INPUT_WORD = {
  one: "sample",
  many: "samples",
  One: "Sample",
  Many: "Samples",
} as const;
