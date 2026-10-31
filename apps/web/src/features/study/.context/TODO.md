# Study feature TODO

- The To check page (`study/to-check.tsx`) decides read-only on the client (`detail.study.example`,
  no held revision), unlike the scan page, which renders the run read's `cannotAccept`. Send the
  reason from the study read instead, so the rules live in one place ([#377](https://github.com/voluma-bio/voluma/pull/377)).
