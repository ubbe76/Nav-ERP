"use client";

// Kostnadsställen och projekt (bokföringsgranskningen etapp 5 del A): the two
// fixed accounting dimensions (SIE 1 and 6). This module is the one place the
// web reads the two registers from, for every picker (verification rows,
// invoices, order headers, group/supplier defaults, report filters).
import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { CostCenter, DimensionRef, Project } from "./types";

export function dimensionLabel(ref: { code: string; name: string } | null | undefined): string {
  return ref ? `${ref.code} · ${ref.name}` : "";
}

export interface DimensionLists {
  // Everything, inactive and closed ones included — a document that already
  // carries one keeps showing its name.
  allCostCenters: CostCenter[];
  allProjects: Project[];
  // What can be picked on a new row: active cost centres, open active projects.
  costCenters: CostCenter[];
  projects: Project[];
  loaded: boolean;
}

const EMPTY: DimensionLists = { allCostCenters: [], allProjects: [], costCenters: [], projects: [], loaded: false };

let cache: { at: number; promise: Promise<DimensionLists> } | null = null;
const CACHE_MS = 10_000;

async function load(): Promise<DimensionLists> {
  const [cc, pr] = await Promise.all([
    apiFetch<{ rows: CostCenter[] }>("/api/v1/cost-centers?includeInactive=true&limit=1000").catch(() => ({ rows: [] as CostCenter[] })),
    apiFetch<{ rows: Project[] }>("/api/v1/projects?includeInactive=true&limit=1000").catch(() => ({ rows: [] as Project[] })),
  ]);
  return {
    allCostCenters: cc.rows,
    allProjects: pr.rows,
    costCenters: cc.rows.filter((c) => c.active),
    projects: pr.rows.filter((p) => p.active && p.status === "open"),
    loaded: true,
  };
}

// Fetches both registers once per mount (a short module cache keeps pages with
// several consumers from asking twice). A failed read gives empty lists — the
// pickers then simply have nothing to offer, they never block a form.
export function useDimensions(): DimensionLists {
  const [lists, setLists] = useState<DimensionLists>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), promise: load() };
    cache.promise.then((value) => {
      if (!cancelled) setLists(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return lists;
}

export function refOf(
  id: string | null | undefined,
  all: { id: string; code: string; name: string }[]
): DimensionRef | null {
  if (!id) return null;
  const hit = all.find((x) => x.id === id);
  return hit ? { id: hit.id, code: hit.code, name: hit.name } : null;
}

// "—" for an empty cell in a list/report.
export function dimensionText(ref: { code: string; name: string } | null | undefined): string {
  return ref ? `${ref.code} ${ref.name}` : "—";
}

// The Kostnadsställe/Projekt entries of a document header card — only those
// the document actually carries. `doc` brings either the joined objects or
// just the ids (looked up in the registers).
export function headerDimensionFields(
  doc: {
    costCenterId?: string | null;
    projectId?: string | null;
    costCenter?: DimensionRef | null;
    project?: DimensionRef | null;
  },
  lists: Pick<DimensionLists, "allCostCenters" | "allProjects">,
  options: { costCenter?: boolean } = { costCenter: true }
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (options.costCenter !== false) {
    const cc = doc.costCenter ?? refOf(doc.costCenterId, lists.allCostCenters);
    if (cc) out.push({ label: "Kostnadsställe", value: dimensionLabel(cc) });
  }
  const project = doc.project ?? refOf(doc.projectId, lists.allProjects);
  if (project) out.push({ label: "Projekt", value: dimensionLabel(project) });
  return out;
}
