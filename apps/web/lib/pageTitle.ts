// The page's own name as the app reads it — a tab's name, a favourite's
// suggested name, Senast öppnade, a message's link: the card's
// data-page-title (DocumentIdentity, Programramen steg 3: "Kundorder
// KO-5008"), else the page topbar's title (AppShell .title).
export function readPageTitle(topbarTitleClass: string | undefined): string {
  const named = document.querySelector("[data-page-title]")?.getAttribute("data-page-title");
  if (named) return named.trim();
  if (!topbarTitleClass) return "";
  return document.querySelector(`.${topbarTitleClass}`)?.textContent?.trim() ?? "";
}
