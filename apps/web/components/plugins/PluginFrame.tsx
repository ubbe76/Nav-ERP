"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { isInternalNavigationPath, tokenRefreshDelay, type PluginContextResponse } from "../../lib/plugins";
import { THEME_TOKENS } from "../../lib/themeCore";
import { useThemeBoot } from "../ThemeBootProvider";
import { FormError } from "../ui/Form";
import styles from "./PluginFrame.module.css";

export type PluginFrameRequest = { page: string } | { tab: string; entityId: string };

const MIN_TAB_HEIGHT = 120;
const MAX_TAB_HEIGHT = 6000;

// The theme the user sees, as CSS the plugin can inject: every token's
// current computed value under the theme's own selector.
function currentThemeCss(id: string): string {
  const style = getComputedStyle(document.documentElement);
  const lines = THEME_TOKENS.map((t) => {
    const value = style.getPropertyValue(`--${t.name}`).trim();
    return value ? `  --${t.name}: ${value};` : null;
  }).filter((line): line is string => line !== null);
  return `:root[data-theme="${id}"] {\n${lines.join("\n")}\n}`;
}

// A plugin's page or tab in a sandboxed iframe. The context token (who is
// looking, what they may do) comes from POST /plugins/:id/context and rides
// on the URL; the plugin talks back with postMessage, which is only believed
// from the iframe's own window AND the plugin's origin:
//   nav:resize {height}   - the iframe's height (tabs; pages fill the area)
//   nav:navigate {path}   - Nav goes to an internal path (starts with "/")
//   nav:theme             - answered with {type:"nav:theme", id, css}
//   nav:context           - answered with the current token (also pushed
//                           again shortly before the token expires)
export function PluginFrame({
  pluginId,
  title,
  request,
  mode,
}: {
  pluginId: string;
  title: string;
  request: PluginFrameRequest;
  mode: "page" | "tab";
}) {
  const router = useRouter();
  const { theme } = useThemeBoot();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ctxRef = useRef<PluginContextResponse | null>(null);
  const themeRef = useRef<string | null>(theme);
  const [src, setSrc] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(360);

  themeRef.current = theme;
  const requestKey = JSON.stringify(request);

  const post = useCallback((message: Record<string, unknown>) => {
    const ctx = ctxRef.current;
    const win = iframeRef.current?.contentWindow;
    if (ctx && win) win.postMessage(message, ctx.origin);
  }, []);

  const sendTheme = useCallback(() => {
    const id = themeRef.current;
    if (id) post({ type: "nav:theme", id, css: currentThemeCss(id) });
  }, [post]);

  // Fetches a token; the first one sets the iframe's address, later ones are
  // pushed to the running plugin (reloading would throw its state away).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    async function load() {
      try {
        const ctx = await apiFetch<PluginContextResponse>(`/api/v1/plugins/${pluginId}/context`, {
          method: "POST",
          body: requestKey,
        });
        if (cancelled) return;
        ctxRef.current = ctx;
        if (first) {
          first = false;
          setOrigin(ctx.origin);
          setSrc(ctx.url);
        } else {
          post({ type: "nav:context", token: ctx.token, expiresAt: ctx.expiresAt });
        }
        timer = setTimeout(() => void load(), tokenRefreshDelay(ctx.expiresAt));
      } catch (err) {
        if (cancelled) return;
        // A failed refresh leaves the running page alone; only the first load shows an error.
        if (first) setError(apiErrorMessage(err, "Kunde inte öppna tillägget"));
        else timer = setTimeout(() => void load(), 30_000);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pluginId, requestKey, post]);

  // The theme follows the user's choice.
  useEffect(() => {
    if (src) sendTheme();
  }, [theme, src, sendTheme]);

  useEffect(() => {
    if (!origin) return;
    function onMessage(event: MessageEvent) {
      if (event.origin !== origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown; path?: unknown } | null;
      if (!data || typeof data !== "object") return;
      switch (data.type) {
        case "nav:resize":
          if (mode === "tab" && typeof data.height === "number" && Number.isFinite(data.height)) {
            setHeight(Math.min(MAX_TAB_HEIGHT, Math.max(MIN_TAB_HEIGHT, Math.ceil(data.height))));
          }
          break;
        case "nav:navigate":
          if (isInternalNavigationPath(data.path)) router.push(data.path);
          break;
        case "nav:theme":
          sendTheme();
          break;
        case "nav:context": {
          const ctx = ctxRef.current;
          if (ctx) post({ type: "nav:context", token: ctx.token, expiresAt: ctx.expiresAt });
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, mode, router, post, sendTheme]);

  if (error) return <FormError>{error}</FormError>;
  if (!src) return <div className={styles.status}>Öppnar tillägget…</div>;

  return (
    <div className={styles.wrap}>
      <iframe
        ref={iframeRef}
        src={src}
        title={title}
        className={`${styles.frame} ${mode === "page" ? styles.page : styles.tab}`}
        style={mode === "tab" ? { height } : undefined}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
        referrerPolicy="no-referrer"
        onLoad={sendTheme}
      />
    </div>
  );
}
