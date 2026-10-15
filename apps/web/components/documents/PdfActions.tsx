import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";

// Download + print for one created document. "Skriv ut" opens the PDF in a
// new tab and leaves the printing to the browser's own viewer — the same
// idiom as the pallet card and the delivery note. window.print() can't reach
// into a cross-origin PDF tab, so there is nothing to gain from wiring it up.
export function PdfActions({ href }: { href: string }) {
  return (
    <>
      <a href={href} download className={`${buttonStyles.button} ${buttonStyles.ghost} ${buttonStyles.small}`}>
        Ladda ner PDF
      </a>
      <Button type="button" variant="ghost" size="small" onClick={() => window.open(href, "_blank", "noopener")}>
        Skriv ut
      </Button>
    </>
  );
}
