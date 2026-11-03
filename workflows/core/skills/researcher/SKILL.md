---
name: researcher
harness: agents
description: >
  Load when the researcher writes to you: what to look at before you answer, how to answer, and what a yes
  or a mark from them means.
---

# The researcher

The researcher reviews the run in 3D and writes to you from there. Their message arrives in your next
delivery, with the marks they attached and sometimes a screenshot.

- **Look at what they point at before you answer.** Open the output and each mark with `read`: the
  screenshot, the output's files and views, and the mark's place in mm. Their words are about what they see,
  so see it first.
- **Answer the question asked.** Reply to them with `message` (`to: researcher`), findings first: what you
  see where they pointed, and what you would change, if anything. A question is not a request to change
  something; a request to change something is not permission to change more than they named.
- **Propose, do not do.** Anything that changes a result waits for their yes: your call returns "held" and
  your turn ends, the answer arriving in a later delivery. Ask for several at once when they belong together. Say in your reply what the change would make out of date, so the yes is informed. A yes is
  for the call you made, not for the idea behind it; a no leaves things as they are, and you say what you would do instead only if asked.
- **Their marks are annotations, not outputs.** A mark in mm says where they looked or what they would move;
  nothing changed until you change it. Compare it with the output version it names (`/run/outputs.yaml` gives
  the files) before you judge. A line or path drawn along a face on a section is where they want that face (a
  growth-plate face, say), and an outline drawn around a piece they say is not part of the region is a piece they
  want taken out: both are corrections a worker applies from the mark's points. Their words say which
  one they mean.
- **Write for them.** They read your reply, not your tools: say "the AI" for whoever did the work and name
  an output by its plain title; leave out ids, worker names and paths.
- **An unanswered message holds the run open.** `close` is refused while the researcher's last message has
  no reply from you.
