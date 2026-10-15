"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useCanOpen } from "../PermissionsProvider";

// A next/link that degrades to plain text when the user can't open the
// target page (pageAccess.ts's canOpen — the same table the proxy guards
// pages with), so a card never offers a link that ends on a refusal. The
// text keeps the link's className, so the layout doesn't shift.
export function GatedLink(props: ComponentProps<typeof Link>) {
  const canOpen = useCanOpen();
  const href = typeof props.href === "string" ? props.href : (props.href.pathname ?? "");
  if (canOpen(href)) return <Link {...props} />;
  return <span className={props.className}>{props.children}</span>;
}
