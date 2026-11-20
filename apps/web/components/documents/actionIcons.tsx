import {
  ArrowLeftRight,
  Ban,
  Banknote,
  BellRing,
  Calculator,
  CalendarClock,
  Check,
  CircleX,
  Download,
  Factory,
  FileMinus,
  FileOutput,
  FilePlus2,
  ListChecks,
  Lock,
  MailCheck,
  MoveRight,
  PackageCheck,
  PackageOpen,
  Play,
  Plus,
  Printer,
  ReceiptText,
  RotateCcw,
  Send,
  Stamp,
  ThumbsDown,
  Truck,
  type LucideIcon,
  SquareArrowOutUpRight,
} from "lucide-react";

// Programramen (the user's sketch): the document toolbar's buttons carry an
// icon — Skriv ut, Orderbekräftelse, Utleverera, Fakturera … The cards keep
// their plain labelled buttons; DocumentActionBar looks the label up here.
const EXACT: Record<string, LucideIcon> = {
  "Lägg till rad": Plus,
  "Öppna artikelkort": SquareArrowOutUpRight,
  "Kontrollera fraktpris": Calculator,
  Leveranstidskontroll: CalendarClock,
  "Skapa kundorder": FilePlus2,
  Bekräfta: Check,
  "Starta tillverkning": Factory,
  Leverera: Truck,
  Utleveransrutinen: ListChecks,
  Fakturera: ReceiptText,
  "Förlorad…": ThumbsDown,
  "Öppna igen": RotateCcw,
  Frisläpp: Play,
  Efterkalkylera: Calculator,
  "Flytta halvfabrikaten…": MoveRight,
  "Ladda ner PDF": Download,
  "Skicka förfrågan": Send,
  "Markera besvarad": MailCheck,
  "Gör till inköpsorder": FileOutput,
  Utfärda: Stamp,
  "Registrera betalning": Banknote,
  "Skicka påminnelse": BellRing,
  "Skapa kreditfaktura": FileMinus,
  Avsändning: PackageOpen,
  "Bekräfta rader…": ListChecks,
  "Ta emot leverans": PackageCheck,
  Inleveransrutinen: ListChecks,
  "Stäng order": Lock,
  "Makulera order": Ban,
};

// A label not listed: by its first word.
const PREFIX: [string, LucideIcon][] = [
  ["Skriv ut", Printer],
  ["Avbryt", CircleX],
  ["Byt ", ArrowLeftRight],
  ["Skicka", Send],
  ["Skapa", FilePlus2],
  ["Bekräfta", Check],
];

export function actionIcon(label: string): LucideIcon | null {
  const text = label.replace(/\s+/g, " ").trim();
  return EXACT[text] ?? PREFIX.find(([p]) => text.startsWith(p))?.[1] ?? null;
}
