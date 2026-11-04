/** The app's rail as `SignedIn` builds it, with plain links: shared by the shell's stories. */
import { Layers, LogIn, Settings, Workflow } from "lucide-react";
import { volumaMarkUrl } from "../brand";
import { Rail, RailButton, RailLink } from "./rail";

export function StoryBrand() {
  return (
    <img
      src={volumaMarkUrl}
      alt="Voluma"
      width={224}
      height={176}
      className="size-6 object-contain"
    />
  );
}

export function StoryRail({
  place = "studies",
  guest = false,
}: {
  place?: "studies" | "workflows";
  /** A guest: Sign in sits on the rail above Settings. */
  guest?: boolean;
}) {
  return (
    <Rail
      end={
        <>
          {guest && <RailButton label="Sign in" icon={<LogIn />} />}
          <RailButton label="Settings" icon={<Settings />} />
        </>
      }
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
