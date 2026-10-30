/**
 * A list of actions or one choice, opened from a trigger: the account menu, "View from", layout
 * choices. Radix underneath, so arrow keys, type-ahead, Escape and focus return work.
 *
 *   <Menu trigger={<Button>View from</Button>}>
 *     <MenuItem onSelect={...}>Front</MenuItem>
 *     <MenuSeparator />
 *     <MenuRadioGroup label="Appearance" value={v} onValueChange={setV}>
 *       <MenuRadioItem value="auto" description="...">Scan review dark, study light</MenuRadioItem>
 *     </MenuRadioGroup>
 *   </Menu>
 */
import { DropdownMenu as M } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { cx } from "./cx";
import { floatingClass, useThemedPortal } from "./portal";

export type MenuProps = {
  /** The element that opens it, usually a Button. */
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "center" | "end";
  open?: boolean;
  /** Called as it opens and closes, e.g. to clear an error the menu showed. */
  onOpenChange?: (open: boolean) => void;
  /** Width overrides; 240 px by default. */
  className?: string;
};

export function Menu({
  trigger,
  children,
  align = "end",
  open,
  onOpenChange,
  className,
}: MenuProps) {
  const portal = useThemedPortal(onOpenChange);
  return (
    <M.Root open={open} onOpenChange={portal.onOpenChange}>
      <M.Trigger asChild ref={portal.ref}>
        {trigger}
      </M.Trigger>
      <M.Portal>
        <M.Content
          data-theme={portal.theme}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cx(floatingClass, "w-60 max-w-[calc(100vw-16px)] p-1", className)}
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

const itemClass = cx(
  "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none",
  "data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
);

export type MenuItemProps = {
  children: ReactNode;
  /** Picking closes the menu; call `event.preventDefault()` to keep it open (e.g. while pending). */
  onSelect?: (event: Event) => void;
  /** A lucide icon, drawn at 14 px before the label. */
  icon?: ReactNode;
  /** The key that does the same, e.g. "F". */
  shortcut?: string;
  disabled?: boolean;
};

export function MenuItem({ children, onSelect, icon, shortcut, disabled }: MenuItemProps) {
  return (
    <M.Item onSelect={onSelect} disabled={disabled} className={itemClass}>
      {icon && (
        <span className="flex size-4 items-center justify-center [&_svg]:size-3.5">{icon}</span>
      )}
      <span className="flex-1">{children}</span>
      {shortcut && <kbd className="font-mono text-xs text-fg-subtle">{shortcut}</kbd>}
    </M.Item>
  );
}

/** Free content at the top of a menu, e.g. who is signed in. Not focusable. */
export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-2">{children}</div>;
}

export function MenuSeparator() {
  return <M.Separator className="-mx-1 my-1 h-px bg-border" />;
}

export type MenuRadioGroupProps<V extends string> = {
  /** Names the choice, shown above it, e.g. "Appearance". */
  label: string;
  value: V;
  onValueChange: (value: V) => void;
  children: ReactNode;
};

export function MenuRadioGroup<V extends string>({
  label,
  value,
  onValueChange,
  children,
}: MenuRadioGroupProps<V>) {
  return (
    <M.Group>
      <M.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">{label}</M.Label>
      <M.RadioGroup value={value} onValueChange={(v) => onValueChange(v as V)}>
        {children}
      </M.RadioGroup>
    </M.Group>
  );
}

export type MenuRadioItemProps = {
  value: string;
  children: ReactNode;
  /** One line under the choice: what it does. */
  description?: ReactNode;
};

export function MenuRadioItem({ value, children, description }: MenuRadioItemProps) {
  return (
    <M.RadioItem
      value={value}
      className={cx(
        itemClass,
        "group/radio grid grid-cols-[14px_1fr] items-start gap-x-2 gap-y-0.5",
      )}
    >
      <span
        aria-hidden
        className="mt-[3px] size-3.5 rounded-full inset-ring-[1.5px] inset-ring-line-strong group-data-[state=checked]/radio:inset-ring-4 group-data-[state=checked]/radio:inset-ring-select"
      />
      <span>{children}</span>
      {description && <span className="col-start-2 text-xs text-fg-subtle">{description}</span>}
    </M.RadioItem>
  );
}
