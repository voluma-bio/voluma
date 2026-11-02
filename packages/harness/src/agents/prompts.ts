/**
 * The prompts of an agent-model thread. PLACEHOLDER of the spine lane: the roles lane replaces
 * this file with the real system prompt (role body, words, environment, mounts, skill list) and
 * first messages. The spine needs only `systemPromptOf` and `firstMessageOf`.
 */

import type { RunEvent } from "@voluma/contracts/events";
import { renderFinalOutputs } from "@voluma/contracts/output-files";
import type { WorkflowDefinition } from "@voluma/workflow/definition";
import type { ThreadLayout } from "../layout";

export interface PromptAgent {
  name: string;
  role: "main" | "worker";
  layout: ThreadLayout;
  brief?: string;
  skills?: string[];
}

export function systemPromptOf(def: WorkflowDefinition, agent: PromptAgent): string {
  const role = def.agents[agent.role];
  if (!role) throw new Error(`${agent.name} runs on ${agent.role}, which is not a role file`);
  const skills = def.skills
    .map((s) => `- ${s.name}: ${s.description} (${s.path}/SKILL.md)`)
    .join("\n");
  return `${role.body}\n\nYou work in a sandbox. Your files:\n${agent.layout.description}\n\nSkills (read a SKILL.md with read before you rely on it):\n${skills}`;
}

export function firstMessageOf(
  def: WorkflowDefinition,
  agent: PromptAgent,
  events: readonly RunEvent[],
  notes: string | undefined,
): string {
  const notesBlock = notes ? `\n\nThe researcher's notes:\n${notes}` : "";
  if (agent.role === "main") {
    return `Your run starts. The final outputs the researcher asked for (/run/final-outputs.yaml):\n\n${renderFinalOutputs(events)}${notesBlock}`;
  }
  return `You are ${agent.name}. Final outputs: /run/final-outputs.yaml; published versions: /run/outputs.yaml; the plan: /work/main/plan.md.\n\nFrom main:\n${agent.brief ?? ""}${notesBlock}`;
}
