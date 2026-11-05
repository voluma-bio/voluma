/** The app's rail with plain links, shared by the shell's stories. */
import { CircleUserRound, Layers, Settings, Workflow } from "lucide-react";
import { useState } from "react";
import { volumaMarkUrl } from "../brand";
import { Button } from "../button";
import { Popover } from "../popover";
import { useTheme } from "../portal";
import { SegmentedControl } from "../segmented-control";
import { Rail, RailButton, RailLink } from "./rail";

export function StoryRail({
  guest = false,
  place = "studies",
}: {
  guest?: boolean;
  place?: "studies" | "workflows";
}) {
  const [theme, setTheme] = useState(useTheme() ?? "light");
  return (
    <Rail
      brand={<StoryBrand />}
      end={
        <>
          <Popover
            side="right"
            label="Settings"
            className="w-64 p-3"
            trigger={<RailButton label="Settings" icon={<Settings />} />}
          >
            <p className="m-0 mb-1.5 text-muted-foreground text-sm">Theme</p>
            <SegmentedControl
              label="Theme"
              value={theme}
              onValueChange={setTheme}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Popover>
          <Popover
            side="right"
            label="Account"
            className="w-64 p-3"
            trigger={<RailButton label="Account" icon={<CircleUserRound />} />}
          >
            <p className="m-0 mb-2 font-medium text-sm">{guest ? "Guest" : "Researcher"}</p>
            <Button size="sm">{guest ? "Sign in" : "Sign out"}</Button>
          </Popover>
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

function StoryBrand() {
  return (
    <img
      src={volumaMarkUrl}
      alt="Voluma"
      width={224}
      height={176}
      className="size-5 object-contain"
    />
  );
}
