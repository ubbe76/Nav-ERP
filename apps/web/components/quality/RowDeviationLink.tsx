"use client";

import Link from "next/link";
import buttonStyles from "../ui/Button.module.css";
import { useCan } from "../PermissionsProvider";
import { newDeviationHref, type NewDeviationParams } from "../../lib/quality";

// "Reklamera" / "Skapa avvikelse" on one row (order row, IO row, kassationsrad):
// opens Ny avvikelse prefilled from the row. Hidden without Kvalitet.
export function RowDeviationLink({ params, label }: { params: NewDeviationParams; label: string }) {
  const canWrite = useCan()(["kvalitet"]);
  if (!canWrite) return null;
  return (
    <Link href={newDeviationHref(params)} className={`${buttonStyles.button} ${buttonStyles.ghost} ${buttonStyles.small}`}>
      {label}
    </Link>
  );
}
