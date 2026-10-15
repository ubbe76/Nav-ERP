// Readable rendering of an audit_log row's `detail` JSONB — shared between
// AuditTrailSection (the card-mounted "Historik" section) and
// AuditLogPageClient (the /system/handelselogg admin list), since both show
// the same shape of data. Renders plain "key: value" lines, and specially
// recognizes the { before, after } shape row-edit audit entries use
// (timereport-korrigeringarnas mönster, see CLAUDE.md) as
// "field: before → after" — one line per changed field, before/after
// union'd so a field present only on one side still shows.
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "–";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function AuditDetail({ detail }: { detail: unknown }) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "object" || Array.isArray(detail)) {
    return <>{formatValue(detail)}</>;
  }

  const { before, after, ...rest } = detail as Record<string, unknown>;
  const lines: string[] = [];

  if (before !== undefined && after !== undefined && typeof before === "object" && typeof after === "object") {
    const beforeObj = (before ?? {}) as Record<string, unknown>;
    const afterObj = (after ?? {}) as Record<string, unknown>;
    const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
    for (const key of keys) {
      lines.push(`${key}: ${formatValue(beforeObj[key])} → ${formatValue(afterObj[key])}`);
    }
  } else {
    if (before !== undefined) lines.push(`before: ${formatValue(before)}`);
    if (after !== undefined) lines.push(`after: ${formatValue(after)}`);
  }

  for (const [key, value] of Object.entries(rest)) {
    lines.push(`${key}: ${formatValue(value)}`);
  }

  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} style={{ fontSize: 13 }}>
          {line}
        </div>
      ))}
    </>
  );
}
