/** The app's rail as `SignedIn` builds it, with plain links: shared by the shell's stories. */
import { Layers, Settings, Workflow } from "lucide-react";
import { Rail, RailButton, RailLink } from "./rail";

export function StoryRail({ place = "studies" }: { place?: "studies" | "workflows" }) {
  return (
    <Rail
      home={
        <a
          href="#studies"
          aria-label="Voluma, studies"
          className="grid size-6 place-items-center rounded-md bg-primary font-semibold text-primary-foreground text-sm"
        >
          V
        </a>
      }
      end={<RailButton label="Settings" icon={<Settings />} />}
    >
      <RailLink label="Studies" icon={<Layers />} active={place === "studies"} to="#studies" />
      <RailLink
        label="Workflows"
        icon={<Workflow />}
        active={place === "workflows"}
        to="#workflows"
      />
    </Rail>
  );
}
