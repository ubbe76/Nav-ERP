"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { apiFetch } from "../../lib/api";
import type { Article, Paged } from "../../lib/types";
import { Input } from "./Field";
import pickerStyles from "./SearchPicker.module.css";
import styles from "./ArticleNumberInput.module.css";

interface ArticleNumberInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  "aria-label"?: string;
}

// A free-text artikelnummer with the register's suggestions — for a field
// whose value need not be an existing article, like the Artikelnummer
// från/till bounds in Förkalkylera flera. Typing searches /api/v1/articles
// the way ArticlePicker does (debounced, first 20, number + benämning) and
// picking a suggestion fills in its number; whatever is typed stands
// otherwise. So nothing is highlighted until the arrow keys move, and Enter
// only picks a highlighted suggestion. The options stack number over
// benämning so the list fits the field's own width (a narrow range field
// on a phone must not push a wider list past the screen edge).
export function ArticleNumberInput({ id, value, onChange, placeholder, "aria-label": ariaLabel }: ArticleNumberInputProps) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Article[]>([]);
  const [highlighted, setHighlighted] = useState(-1);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  function search(term: string) {
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      async () => {
        const seq = ++requestSeq.current;
        setLoading(true);
        try {
          const page = await apiFetch<Paged<Article>>(`/api/v1/articles?search=${encodeURIComponent(term)}&limit=20`);
          if (seq !== requestSeq.current) return; // a newer search superseded this one
          setResults(page.rows);
          setHighlighted(-1);
        } catch {
          if (seq === requestSeq.current) setResults([]);
        } finally {
          if (seq === requestSeq.current) setLoading(false);
        }
      },
      term === "" ? 0 : 250
    );
  }

  function pick(article: Article) {
    onChange(article.articleNumber);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        search(value.trim());
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter") {
      const hit = results[highlighted];
      if (hit) {
        e.preventDefault();
        pick(hit);
      }
    } else if (e.key === "Escape") {
      // Only the list closes: inside a dialog, Esc would otherwise also
      // cancel the dialog (and Modal unmounts the filled-in form).
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  const activeId = open && highlighted >= 0 ? `${listId}-${highlighted}` : undefined;

  return (
    <div className={pickerStyles.picker}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        autoComplete="off"
        onFocus={() => search(value.trim())}
        onChange={(e) => {
          onChange(e.target.value);
          search(e.target.value.trim());
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay so a mousedown on a suggestion can complete its click first.
          setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && (
        <ul id={listId} className={pickerStyles.list} role="listbox" ref={listRef}>
          {results.map((article, index) => (
            <li key={article.id}>
              <button
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={`${pickerStyles.option} ${styles.option}`}
                data-highlighted={index === highlighted}
                tabIndex={-1}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(article)}
              >
                <span className={pickerStyles.optionNumber}>{article.articleNumber}</span>
                <span className={`${pickerStyles.optionName} ${styles.name}`}>{article.name}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className={pickerStyles.empty}>{loading ? "Söker…" : "Inga artiklar matchar"}</li>}
        </ul>
      )}
    </div>
  );
}
