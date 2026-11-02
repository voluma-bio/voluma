/**
 * The on-screen word for one scanned knee, in every case a sentence needs. It is "scan" for now
 * (agent-model design, review.md "Naming": "Scan" stays for now), and the mockups' "sample" was
 * not adopted; a later switch is this one edit. Code names (`SampleTree`, `TreeSample`) keep
 * "sample" and are not words on screen.
 */
export const INPUT_WORD = { one: "scan", many: "scans", One: "Scan", Many: "Scans" } as const;
