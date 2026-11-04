/** A path as the link a breadcrumb takes (`CrumbTo`), through the app's router. */
import type { ReactNode } from "react";
import { Link } from "react-router";

export const linkTo = (href: string) => (props: { className: string; children: ReactNode }) => (
  <Link to={href} {...props} />
);
