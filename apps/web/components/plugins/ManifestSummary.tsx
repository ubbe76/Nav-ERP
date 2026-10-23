import { effectivePermissionsOf } from "./effective";
import {
  PLUGIN_EVENT_CATALOG,
  PLUGIN_MODULE_LABELS,
  PLUGIN_TAB_TARGET_LABELS,
  pluginEventLabel,
  type PluginManifest,
} from "../../lib/plugins";
import { PERMISSION_LABELS } from "../../lib/permissions";
import styles from "./Plugins.module.css";

// What a manifest says: who made it, what it asks for, what it subscribes to
// and where it shows up. Used by the install dialog and the plugin card.
export function ManifestSummary({ manifest }: { manifest: PluginManifest }) {
  const requested = effectivePermissionsOf(manifest.permissions);
  return (
    <div className={styles.facts}>
      <div className={styles.fact}>
        <span className={styles.factLabel}>Namn</span>
        <span className={styles.factValue}>
          {manifest.name} <span className={styles.mutedLine}>({manifest.key})</span>
        </span>
      </div>
      {manifest.description && (
        <div className={styles.fact}>
          <span className={styles.factLabel}>Beskrivning</span>
          <span className={styles.factValue}>{manifest.description}</span>
        </div>
      )}
      {manifest.author && (
        <div className={styles.fact}>
          <span className={styles.factLabel}>Utgivare</span>
          <span className={styles.factValue}>{manifest.author}</span>
        </div>
      )}
      {manifest.homepage && (
        <div className={styles.fact}>
          <span className={styles.factLabel}>Hemsida</span>
          <span className={styles.factValue}>{manifest.homepage}</span>
        </div>
      )}
      <div className={styles.fact}>
        <span className={styles.factLabel}>Begärda rättigheter</span>
        <span className={styles.factValue}>
          {requested.length > 0 ? requested.map((p) => PERMISSION_LABELS[p]).join(", ") : "Inga"}
          {manifest.readOnly ? " · Endast läsning" : ""}
        </span>
      </div>
      <div className={styles.fact}>
        <span className={styles.factLabel}>Händelser</span>
        <span className={styles.factValue}>
          {manifest.webhook && manifest.webhook.events.length > 0 ? (
            <ul className={styles.list}>
              {manifest.webhook.events.map((e) => (
                <li key={e}>
                  {pluginEventLabel(e)} <span className={styles.mutedLine}>({e})</span>
                  {!PLUGIN_EVENT_CATALOG.some((d) => d.type === e) ? " – okänd" : ""}
                </li>
              ))}
            </ul>
          ) : (
            "Tar inte emot händelser"
          )}
        </span>
      </div>
      <div className={styles.fact}>
        <span className={styles.factLabel}>Sidor</span>
        <span className={styles.factValue}>
          {manifest.pages.length > 0 ? (
            <ul className={styles.list}>
              {manifest.pages.map((p) => (
                <li key={p.key}>
                  {p.title} <span className={styles.mutedLine}>under {PLUGIN_MODULE_LABELS[p.module]}</span>
                </li>
              ))}
            </ul>
          ) : (
            "Inga"
          )}
        </span>
      </div>
      <div className={styles.fact}>
        <span className={styles.factLabel}>Flikar</span>
        <span className={styles.factValue}>
          {manifest.tabs.length > 0 ? (
            <ul className={styles.list}>
              {manifest.tabs.map((t) => (
                <li key={t.key}>
                  {t.title} <span className={styles.mutedLine}>på {PLUGIN_TAB_TARGET_LABELS[t.on].toLowerCase()}</span>
                </li>
              ))}
            </ul>
          ) : (
            "Inga"
          )}
        </span>
      </div>
    </div>
  );
}
