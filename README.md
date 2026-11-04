# Voluma

Voluma turns a micro-CT scan into validated measurements where every number traces to its evidence. A
researcher picks a workflow, adds a scan, and AI agents segment the bones, place the regions and landmarks,
measure, and check their own work. The researcher reviews each result in 3D beside the evidence it rests on,
and corrects it by talking to the AI.

The first workflow measures mouse knee osteoarthritis, for the lab of Dr. Zhenqiang Yao at the University of
Rochester Medical Center.

## The problem

Osteoarthritis affected 595 million people in 2020, 7.6% of the world's population, and is projected to reach
nearly 1 billion by 2050; the knee is the most common site ([GBD 2021, *Lancet Rheumatology*
2023](https://www.thelancet.com/journals/lanrhe/article/PIIS2665-9913(23)00163-7/fulltext)). In the US it
accounted for $80 billion in health spending in 2016 ([Dieleman et al., *JAMA*
2020](https://jamanetwork.com/journals/jama/fullarticle/2762309)). There is no approved drug that slows the
disease ([Oo et al. 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8273751/)).

Candidate drugs and mechanisms are tested first in mouse models, and micro-CT is how labs measure what the
disease does to bone: osteophytes, the subchondral plate, trabecular bone. Scanning is fast. The analysis is
not: contouring bone by hand is "time-consuming and subjective" ([Das Neves Borges et al.
2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5363908/)), and labs define their measurement regions so
differently that their results can't be compared ([*Osteoarthritis and Cartilage*,
2026](https://www.sciencedirect.com/science/article/pii/S1063458426009131)).

Dr. Yao's lab proposed a fix: two whole-bone ratios measured from micro-CT, the distal femur's width to
length and the tibial IIOC's height to width, which track OA severity and agree between
raters (ICC 0.85 and 0.89) ([Tang et al., *Biology* 2026](https://doi.org/10.3390/biology15030262)). They
were measured by hand in Amira, commercial software that costs thousands of dollars a year and takes months
to learn, so a collaborating lab can't easily use them.

Voluma runs that method, plus the standard bone measurements, from a browser, and shows the evidence for
every number so a researcher can check it.

## How it works

1. **A workflow is a set of skills.** `workflows/mouse-oa/` holds the method: the measurements a run can
   produce (`outputs.yaml`) and skills, each a written method plus Python scripts that measure and check.
   `workflows/core/` holds the agent roles and the generic micro-CT skills. A run snapshots both, so it can
   be reopened and re-checked later.
2. **Agents do the analysis.** A main agent (Meta's Muse Wonder) plans the run and starts up to four workers,
   each in its own sandbox: intake segments the bones, then workers straighten the tibia, find the growth
   plate and IIOC, place the femur landmarks and measure. Each publishes its outputs with the evidence they
   rest on: the files, the quality-check images it looked at, and the open questions.
3. **Scripts check the agents.** A script refuses an output that breaks the method (two bones fused
   through bone, the femur and tibia labelled the wrong way round, a femur width shorter than the bone)
   and says how to fix it. When a step fails, main audits the failed work first, then has it redone.
4. **Segmentation uses SAM 3.1,** prompted by the agents, and a SAM 3.1 fine-tune of our own for the
   tibial growth plate, the line the IIOC measurements depend on.
5. **The researcher reviews and corrects.** Each output opens in a 3D viewer with axial, coronal and
   sagittal slices, aligned to the frame it was measured on, with the bone labels and the output drawn over
   the scan. Items the agents could not settle are marked To check. A message to the AI, with the current
   view attached, starts a review agent that can redo the work and publish a new version.

## The growth-plate model

A LoRA fine-tune of SAM 3.1 that finds the tibial growth plate in coronal sections, trained on
sections from the lab's scans. On a test scan whose cut lines an expert corrected, the three-seed vote sits 16.4 µm (about 1.5
voxels) from his lines; a perfect trace scores about 11 µm through the same measure. Weights:
[VolumaBio/mouse-knee-growth-plate](https://huggingface.co/VolumaBio/mouse-knee-growth-plate). Training,
scores and every method we tried: [training/plate-finetune](training/plate-finetune/README.md).

## Repository

| Path | What it is |
|---|---|
| `apps/web` | The web app: studies, new runs, and the sample review |
| `apps/api` | The API on Postgres: runs, their event log, review and corrections |
| `apps/runner` | Claims queued runs and runs them on the agent loop in Modal sandboxes |
| `apps/gateway` | The proxy sandboxes reach model and tool providers through: it adds our key and checks a run's spend |
| `packages/harness` | The agent loop: roles, tools, compaction, the event log |
| `packages/viewer` | The 3D and slice viewer |
| `packages/contracts` | The schemas every part builds against |
| `workflows/` | The method: agent roles, skills and their Python scripts |
| `training/plate-finetune` | The growth-plate model's training and its inference app |

## Run it

Install Node (the version in `.tool-versions`), pnpm and [uv](https://docs.astral.sh/uv/), then:

```bash
pnpm i
pnpm db:up      # local Postgres in Docker, once per machine
pnpm dev        # API and web app on free ports; prints both URLs
pnpm check      # lint, typecheck and tests, as CI runs them
```

A run needs model and sandbox keys in `.env`; see `apps/runner` and `apps/api`.

## More

- [AGENTS.md](AGENTS.md): how we work, the commands, and the rules for contributors and coding agents.
- [Architecture](.context/CONTEXT.md) and [design rules](DESIGN.md).
- Specifications: [input review](apps/web/src/features/input/.context/CONTEXT.md),
  [run view](packages/run-view/.context/CONTEXT.md), [grid viewer](packages/viewer/.context/CONTEXT.md).
