"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  MAX_NOTICES,
  NOTICE_ERROR_MS,
  NOTICE_MS,
  NOTICE_WITH_ACTION_MS,
  registerNoticeHost,
  type NoticeInput,
} from "../../lib/notice";
import { apiErrorMessage } from "../../lib/errorMessages";
import styles from "./NoticeHost.module.css";

interface Shown extends NoticeInput {
  id: number;
  running: boolean;
}

// The notices (see lib/notice.ts): at most three, newest last, above the
// status bar. aria-live, so a screen reader reads them out.
export function NoticeHost() {
  const [notices, setNotices] = useState<Shown[]>([]);
  const nextId = useRef(1);

  const close = useCallback((id: number) => setNotices((list) => list.filter((n) => n.id !== id)), []);

  useEffect(() => {
    registerNoticeHost((notice) => {
      const id = nextId.current++;
      setNotices((list) => [...list, { ...notice, id, running: false }].slice(-MAX_NOTICES));
    });
    return () => registerNoticeHost(null);
  }, []);

  async function runAction(notice: Shown) {
    if (!notice.action || notice.running) return;
    setNotices((list) => list.map((n) => (n.id === notice.id ? { ...n, running: true } : n)));
    try {
      const text = await notice.action.run();
      if (text === null) {
        close(notice.id);
        return;
      }
      // The same notice, now saying what happened — a new id restarts its timer.
      const id = nextId.current++;
      setNotices((list) =>
        list.map((n) => (n.id === notice.id ? { id, message: text ?? "Ångrat.", tone: "success", running: false } : n))
      );
    } catch (err) {
      const id = nextId.current++;
      setNotices((list) =>
        list.map((n) =>
          n.id === notice.id
            ? { id, message: apiErrorMessage(err, "Det gick inte att ångra"), tone: "error", running: false }
            : n
        )
      );
    }
  }

  return (
    <div className={styles.region} role="status" aria-live="polite">
      {notices.map((notice) => (
        <NoticeItem key={notice.id} notice={notice} close={close} onAction={() => runAction(notice)} />
      ))}
    </div>
  );
}

// `close` is stable (the timer must not restart on every render of the host).
function NoticeItem({ notice, close, onAction }: { notice: Shown; close: (id: number) => void; onAction: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(
    notice.tone === "error" ? NOTICE_ERROR_MS : notice.action ? NOTICE_WITH_ACTION_MS : NOTICE_MS
  );

  useEffect(() => {
    if (paused || notice.running) return;
    const started = Date.now();
    const timer = setTimeout(() => close(notice.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(remaining.current - (Date.now() - started), 1500);
    };
  }, [paused, notice.running, notice.id, close]);

  return (
    <div
      className={styles.notice}
      data-tone={notice.tone ?? "success"}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span className={styles.message}>{notice.message}</span>
      {notice.action && (
        <button type="button" className={styles.action} disabled={notice.running} onClick={onAction}>
          {notice.running ? "Arbetar…" : notice.action.label}
        </button>
      )}
      <button type="button" className={styles.close} aria-label="Stäng notisen" onClick={() => close(notice.id)}>
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
