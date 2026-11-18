import buttonStyles from "../ui/Button.module.css";
import { PrintButton } from "./PrintButton";

// Download + print for one created document. "Skriv ut" opens the browser's
// print dialog (lib/printPdf.ts); "Ladda ner PDF" saves the file.
export function PdfActions({ href }: { href: string }) {
  return (
    <>
      <a href={href} download className={`${buttonStyles.button} ${buttonStyles.ghost} ${buttonStyles.small}`}>
        Ladda ner PDF
      </a>
      <PrintButton href={href} />
    </>
  );
}
