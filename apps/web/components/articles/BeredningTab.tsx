"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { SectionHeading } from "../ui/SectionHeading";
import { BeredningView } from "./BeredningView";
import type {
  Article,
  ArticleGroup,
  BomComponent,
  BomTreeNode,
  RoutingOperation,
  WorkCenter,
} from "../../lib/types";
import styles from "./Beredning.module.css";

interface BeredningTabProps {
  article: Article;
  tree: BomTreeNode;
  initialBom: BomComponent[];
  initialRouting: RoutingOperation[];
  workCenters: WorkCenter[];
  groups: ArticleGroup[];
}

interface SelectedArticle {
  articleId: string;
  articleNumber: string;
  name: string;
}

function treeContains(node: BomTreeNode, articleId: string): boolean {
  if (node.articleId === articleId) return true;
  return node.children.some((child) => treeContains(child, articleId));
}

function TreeNode({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: BomTreeNode;
  depth: number;
  selectedId: string;
  onSelect: (node: BomTreeNode) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={styles.treeNode}
        data-active={node.articleId === selectedId}
        style={{ paddingLeft: 8 + depth * 18 }}
        onClick={() => onSelect(node)}
      >
        <span className={styles.treeNumber}>{node.articleNumber}</span>
        <span className={styles.treeName}>
          {node.name}
          {node.isPhantom ? " · Fantom" : ""}
        </span>
        {node.quantity !== null && <span className={styles.treeQty}>× {Number(node.quantity)}</span>}
      </button>
      {node.children.map((child) => (
        <TreeNode
          key={child.bomRowId ?? child.articleId}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// Beredning (Monitor G5 term): structure + operations for the article in one
// view. The tree on the left shows the whole BOM; clicking a node makes it
// the active article whose grouped beredning (operations with their linked
// components nested underneath) is edited on the right.
export function BeredningTab({
  article,
  tree,
  initialBom,
  initialRouting,
  workCenters,
  groups,
}: BeredningTabProps) {
  const router = useRouter();

  const [selected, setSelected] = useState<SelectedArticle>({
    articleId: article.id,
    articleNumber: article.articleNumber,
    name: article.name,
  });
  // null while the selected article's data is being fetched.
  const [data, setData] = useState<{ bom: BomComponent[]; routing: RoutingOperation[] } | null>({
    bom: initialBom,
    routing: initialRouting,
  });
  // Bumped after every mutation so the effect refetches the selected
  // article's data; router.refresh() re-renders the tree from the server.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<BomComponent[]>(`/api/v1/articles/${selected.articleId}/bom`),
      apiFetch<RoutingOperation[]>(`/api/v1/articles/${selected.articleId}/routing`),
    ])
      .then(([bom, routing]) => {
        if (!cancelled) setData({ bom, routing });
      })
      .catch(() => {
        // Keep whatever is shown; the sections surface errors on mutation.
      });
    return () => {
      cancelled = true;
    };
  }, [selected.articleId, version]);

  // If the selected article was removed from the structure (its row deleted),
  // fall back to the root article rather than pointing outside the tree.
  useEffect(() => {
    if (!treeContains(tree, selected.articleId)) {
      setSelected({ articleId: article.id, articleNumber: article.articleNumber, name: article.name });
      setData(null);
    }
  }, [tree, selected.articleId, article.id, article.articleNumber, article.name]);

  function handleSelect(node: BomTreeNode) {
    if (node.articleId === selected.articleId) return;
    setSelected({ articleId: node.articleId, articleNumber: node.articleNumber, name: node.name });
    setData(null);
  }

  function handleChanged() {
    setVersion((v) => v + 1);
    router.refresh();
  }

  return (
    <div className={styles.layout}>
      <div>
        <SectionHeading>Artikelträd</SectionHeading>
        <div className={styles.treePanel}>
          <TreeNode node={tree} depth={0} selectedId={selected.articleId} onSelect={handleSelect} />
        </div>
      </div>

      <div>
        <div className={styles.activeArticle}>
          Aktiv artikel: <strong>{selected.articleNumber}</strong> — {selected.name}
        </div>

        {data ? (
          <BeredningView
            key={selected.articleId}
            articleId={selected.articleId}
            articleNumber={selected.articleNumber}
            bom={data.bom}
            routing={data.routing}
            workCenters={workCenters}
            groups={groups}
            onChanged={handleChanged}
          />
        ) : (
          <p className={styles.loading}>Laddar…</p>
        )}
      </div>
    </div>
  );
}
