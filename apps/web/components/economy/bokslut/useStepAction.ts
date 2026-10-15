"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiErrorMessage } from "../../../lib/errorMessages";
import type { YearEndBookResult } from "../../../lib/types";

// One action per card: pending/error/notice state, and a router.refresh()
// afterwards so the server-rendered detail (statuses, checks) is re-read.
export function useStepAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<string | null>, refresh = true) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      if (refresh) router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Åtgärden misslyckades"));
    } finally {
      setPending(false);
    }
  }

  return { pending, error, notice, run };
}

// "Lagerförändring bokförd — Verifikat BS-2024-1" and the unchanged/empty cases.
export function bookedNotice(label: string, result: YearEndBookResult): string {
  if (result.unchanged) return `${label}: oförändrat — inget nytt verifikat`;
  return result.verification ? `${label} bokförd — Verifikat ${result.verification.displayNumber}` : `${label} klar — inget att bokföra`;
}
