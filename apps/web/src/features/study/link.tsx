/** A path as the `LinkTo` the shared parts take (rows, breadcrumbs), through the app's router. */
import type { LinkRenderProps } from "@voluma/ui";
import { Link } from "react-router";

export const linkTo = (href: string) => (props: LinkRenderProps) => <Link to={href} {...props} />;
