import { z } from "zod";
import { statusListParam } from "./list.js";

// ABC-klassning (#10, etapp 2): the three classes by förbrukningsvärde
// (consumed quantity over the period × standard cost). Derived at read time
// by the planning module's abc.ts — never stored. Lives in its own leaf so
// both the article register's filter (article.ts) and the ABC page's query
// (planning.ts) read one definition.
export const ABC_CLASSES = ["A", "B", "C"] as const;
export const abcClassSchema = z.enum(ABC_CLASSES);
export type AbcClass = z.infer<typeof abcClassSchema>;

// `?abcClass=A,B` / `?class=A,B` — a comma-separated list, validated.
export const abcClassListParam = () => statusListParam(ABC_CLASSES);
