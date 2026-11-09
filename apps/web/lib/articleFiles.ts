import { API_URL } from "./api";

// Artikelfiler (fliken Filer, ritningsrevisionernas filer): PDF, JPEG, PNG,
// max 20 MB. Multipart upload — apiFetch sets a JSON content type, so this
// goes through fetch directly (same as the company logo upload).
export const ARTICLE_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// drawingRevisionId: the file becomes that drawing revision's (replacing a
// file it had); without it the file is loose.
export async function uploadArticleFile(articleId: string, file: File, drawingRevisionId?: string): Promise<void> {
  const body = new FormData();
  body.append("file", file);
  const query = drawingRevisionId ? `?drawingRevisionId=${encodeURIComponent(drawingRevisionId)}` : "";
  const res = await fetch(`${API_URL}/api/v1/articles/${articleId}/files${query}`, {
    method: "POST",
    credentials: "include",
    body,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? "Uppladdningen misslyckades");
  }
}

export const articleFileHref = (articleId: string, fileId: string) => `${API_URL}/api/v1/articles/${articleId}/files/${fileId}`;
