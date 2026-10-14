"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";

type Entry = {
  name: string;
  relativePath: string;
  kind: "dir" | "file";
  size: number;
  mtime: number;
  badge?: { text: string; tone: "muted" | "ok" | "ai" } | null;
};

type Crumb = { name: string; path: string };

type Listing = {
  path: string;
  breadcrumbs: Crumb[];
  entries: Entry[];
};

type FileView = {
  path: string;
  name: string;
  content: string;
  size: number;
  mtime: number;
  binary: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
  entry: Entry;
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat("tr-TR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

function FolderGlyph() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden>
      <path
        d="M1 2.75A1.75 1.75 0 0 1 2.75 1h3.1L7.2 2.5h6.05A1.75 1.75 0 0 1 15 4.25v6.5A1.75 1.75 0 0 1 13.25 12.5H2.75A1.75 1.75 0 0 1 1 10.75v-8Z"
        fill="currentColor"
        opacity="0.2"
      />
      <path
        d="M1 2.75A1.75 1.75 0 0 1 2.75 1h3.1L7.2 2.5h6.05A1.75 1.75 0 0 1 15 4.25v6.5A1.75 1.75 0 0 1 13.25 12.5H2.75A1.75 1.75 0 0 1 1 10.75v-8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden>
      <path
        d="M2.5.75h5.6L13.25 5.9V13.5A1.75 1.75 0 0 1 11.5 15.25h-9A1.75 1.75 0 0 1 .75 13.5V2.5A1.75 1.75 0 0 1 2.5.75Z"
        fill="currentColor"
        opacity="0.1"
      />
      <path
        d="M2.5.75h5.6L13.25 5.9V13.5A1.75 1.75 0 0 1 11.5 15.25h-9A1.75 1.75 0 0 1 .75 13.5V2.5A1.75 1.75 0 0 1 2.5.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path
        d="M8.1.75V4.4c0 .97.78 1.75 1.75 1.75h3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

export function FolderBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const path = searchParams.get("path") || "";
  const filePath = searchParams.get("file") || "";

  const [listing, setListing] = useState<Listing | null>(null);
  const [preview, setPreview] = useState<FileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const atRoot = !path;

  const go = useCallback(
    (nextPath: string, nextFile?: string) => {
      const q = new URLSearchParams();
      if (nextPath) q.set("path", nextPath);
      if (nextFile) q.set("file", nextFile);
      const s = q.toString();
      router.push(s ? `/folders?${s}` : "/folders");
    },
    [router],
  );

  const loadList = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/folders?path=${encodeURIComponent(p)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Liste alınamadı");
      setListing(data);
    } catch (err) {
      setListing(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (p: string) => {
    setError(null);
    try {
      const res = await fetch(
        `/api/folders?view=file&path=${encodeURIComponent(p)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Dosya okunamadı");
      setPreview(data);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadList(path);
  }, [path, loadList]);

  useEffect(() => {
    if (filePath) void loadFile(filePath);
    else setPreview(null);
  }, [filePath, loadFile]);

  useEffect(() => {
    if (!menu || deleteTarget) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, deleteTarget]);

  useEffect(() => {
    if (renamingPath) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingPath]);

  useEffect(() => {
    if (!deleteTarget) return;
    deleteCancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) setDeleteTarget(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteTarget, busy]);

  function openEntry(entry: Entry) {
    if (renamingPath === entry.relativePath) return;
    if (entry.kind === "dir") {
      go(entry.relativePath);
      return;
    }
    const parent = entry.relativePath.includes("/")
      ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/"))
      : "";
    go(parent, entry.relativePath);
  }

  function parentPath(p: string): string {
    if (!p) return "";
    const i = p.lastIndexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  }

  function openContextMenu(e: ReactMouseEvent, entry: Entry) {
    if (!atRoot || entry.kind !== "dir") return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }

  function startRename(entry: Entry) {
    setMenu(null);
    setRenamingPath(entry.relativePath);
    setRenameValue(entry.name);
  }

  async function commitRename() {
    if (!renamingPath || busy) return;
    const next = renameValue.trim();
    const current = listing?.entries.find((e) => e.relativePath === renamingPath);
    if (!current || !next || next === current.name) {
      setRenamingPath(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rename",
          path: renamingPath,
          newName: next,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Yeniden adlandırılamadı");
      setRenamingPath(null);
      if (filePath === renamingPath || filePath.startsWith(`${renamingPath}/`)) {
        go("");
      }
      await loadList(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function askDelete(entry: Entry) {
    setMenu(null);
    setDeleteTarget(entry);
  }

  async function confirmDelete() {
    if (!deleteTarget || busy) return;
    const entry = deleteTarget;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", path: entry.relativePath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Silinemedi");
      setDeleteTarget(null);
      if (
        path === entry.relativePath ||
        path.startsWith(`${entry.relativePath}/`) ||
        filePath === entry.relativePath ||
        filePath.startsWith(`${entry.relativePath}/`)
      ) {
        go("");
      }
      await loadList(path === entry.relativePath ? "" : path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }

  async function revealInOs(targetPath: string) {
    setRevealing(true);
    setError(null);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reveal", path: targetPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Finder açılamadı");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealing(false);
    }
  }

  const crumbs = listing?.breadcrumbs ?? [{ name: "workspace", path: "" }];
  const dirCount = listing?.entries.filter((e) => e.kind === "dir").length ?? 0;
  const fileCount = listing?.entries.filter((e) => e.kind === "file").length ?? 0;

  const menuStyle = menu
    ? {
        left: Math.min(menu.x, typeof window !== "undefined" ? window.innerWidth - 180 : menu.x),
        top: Math.min(menu.y, typeof window !== "undefined" ? window.innerHeight - 100 : menu.y),
      }
    : undefined;

  return (
    <div className="cmae-fb">
      <div className="cmae-fb-main">
        <div className="cmae-fb-bar">
          <div className="cmae-fb-nav">
            <button
              type="button"
              className="cmae-fb-nav-btn"
              disabled={!path}
              onClick={() => go(parentPath(path))}
              aria-label="Üst klasör"
              title="Üst klasör"
            >
              ←
            </button>
            <button
              type="button"
              className="cmae-fb-nav-btn"
              disabled={!path && !filePath}
              onClick={() => go("")}
              aria-label="workspace kökü"
              title="workspace kökü"
            >
              ⌂
            </button>
          </div>

          <nav className="cmae-fb-crumbs" aria-label="Konum">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1 && !filePath;
              return (
                <span
                  key={`${c.path}-${i}`}
                  style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}
                >
                  {i > 0 ? <span className="cmae-fb-crumb-sep">/</span> : null}
                  {last ? (
                    <span className="cmae-fb-crumb-now" aria-current="page">
                      {c.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cmae-fb-crumb"
                      onClick={() => go(c.path)}
                    >
                      {c.name}
                    </button>
                  )}
                </span>
              );
            })}
            {filePath ? (
              <span style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
                <span className="cmae-fb-crumb-sep">/</span>
                <span className="cmae-fb-crumb-now" aria-current="page">
                  {filePath.split("/").pop()}
                </span>
              </span>
            ) : null}
          </nav>

          <div className="cmae-fb-count">
            {dirCount} klasör · {fileCount} dosya
          </div>
        </div>

        {error ? (
          <p className="cmae-error" style={{ margin: "12px 14px" }}>
            {error}
          </p>
        ) : null}

        <div className={`cmae-fb-body${preview ? " is-split" : ""}`}>
          <div className="cmae-fb-list-pane">
            <div className="cmae-fb-cols" aria-hidden>
              <span>Ad</span>
              <span>Boyut</span>
              <span>Değiştirilme</span>
            </div>

            {loading && !listing ? (
              <p className="cmae-fb-loading">Yükleniyor…</p>
            ) : listing && listing.entries.length === 0 ? (
              <div className="cmae-fb-empty">
                <p>Bu klasör boş</p>
                <span>Search çalıştırınca şirket klasörleri burada görünür.</span>
              </div>
            ) : (
              <ul className="cmae-fb-list">
                {listing?.entries.map((entry) => {
                  const selected =
                    entry.kind === "file" && filePath === entry.relativePath;
                  const isRenaming = renamingPath === entry.relativePath;
                  return (
                    <li key={entry.relativePath}>
                      {isRenaming ? (
                        <div className="cmae-fb-row is-renaming">
                          <span className="cmae-fb-ico">
                            <FolderGlyph />
                          </span>
                          <input
                            ref={renameInputRef}
                            className="cmae-fb-rename"
                            value={renameValue}
                            disabled={busy}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => void commitRename()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void commitRename();
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setRenamingPath(null);
                              }
                            }}
                            aria-label="Klasör adını düzenle"
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={`cmae-fb-row${selected ? " is-selected" : ""}`}
                          onClick={() => openEntry(entry)}
                          onContextMenu={(e) => openContextMenu(e, entry)}
                        >
                          <span className="cmae-fb-ico">
                            {entry.kind === "dir" ? <FolderGlyph /> : <FileGlyph />}
                          </span>
                          <span className="cmae-fb-name">
                            <span className="cmae-fb-name-text">{entry.name}</span>
                            {entry.badge ? (
                              <span
                                className={`cmae-fb-badge is-${entry.badge.tone}`}
                                title={
                                  entry.badge.tone === "muted"
                                    ? "Başvuru linki yok"
                                    : entry.badge.tone === "ai"
                                      ? "AI ara çıktısı — genelde kullanıcıya gerekmez"
                                      : `${entry.badge.text} başvuru linki`
                                }
                              >
                                {entry.badge.text}
                              </span>
                            ) : null}
                          </span>
                          <span className="cmae-fb-cell">
                            {entry.kind === "dir" ? "—" : formatSize(entry.size)}
                          </span>
                          <span className="cmae-fb-cell cmae-fb-date">
                            {formatDate(entry.mtime)}
                          </span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {preview ? (
            <aside className="cmae-fb-preview" aria-label="Dosya önizleme">
              <div className="cmae-fb-preview-head">
                <div className="cmae-fb-preview-title">
                  <strong>{preview.name}</strong>
                  <span>
                    {formatSize(preview.size)} · {formatDate(preview.mtime)}
                  </span>
                </div>
                <div className="cmae-fb-preview-actions">
                  <button
                    type="button"
                    className="cmae-fb-close"
                    disabled={revealing}
                    onClick={() => void revealInOs(preview.path)}
                    title="Finder / Dosya Gezgini’nde göster"
                  >
                    {revealing ? "Açılıyor…" : "Finder’da aç"}
                  </button>
                  <button
                    type="button"
                    className="cmae-fb-close"
                    onClick={() => go(path)}
                  >
                    Kapat
                  </button>
                </div>
              </div>
              <div className="cmae-fb-preview-body">
                {preview.binary ? (
                  <p className="cmae-fb-loading">
                    Bu dosya metin olarak önizlenemiyor.
                  </p>
                ) : (
                  <pre>{preview.content}</pre>
                )}
              </div>
            </aside>
          ) : null}
        </div>
      </div>

      {menu ? (
        <div
          ref={menuRef}
          className="cmae-fb-menu"
          style={menuStyle}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="cmae-fb-menu-item"
            disabled={busy}
            onClick={() => startRename(menu.entry)}
          >
            Yeniden adlandır
          </button>
          <button
            type="button"
            role="menuitem"
            className="cmae-fb-menu-item is-danger"
            disabled={busy}
            onClick={() => askDelete(menu.entry)}
          >
            Sil
          </button>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="cmae-fb-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setDeleteTarget(null);
          }}
        >
          <div
            className="cmae-fb-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cmae-fb-delete-title"
            aria-describedby="cmae-fb-delete-desc"
          >
            <h2 id="cmae-fb-delete-title">Klasörü sil</h2>
            <p id="cmae-fb-delete-desc">
              <strong>{deleteTarget.name}</strong> klasörü ve içindeki tüm
              dosyalar kalıcı olarak silinecek. Bu işlem geri alınamaz.
            </p>
            <div className="cmae-fb-modal-actions">
              <button
                ref={deleteCancelRef}
                type="button"
                className="cmae-btn cmae-btn-ghost"
                disabled={busy}
                onClick={() => setDeleteTarget(null)}
              >
                Vazgeç
              </button>
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() => void confirmDelete()}
              >
                {busy ? "Siliniyor…" : "Sil"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
