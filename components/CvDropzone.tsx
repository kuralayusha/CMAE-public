"use client";

import { useRef, useState, type DragEvent } from "react";
import { useT } from "@/components/I18nProvider";

function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

export function CvDropzone({
  disabled = false,
  busy = false,
  onFile,
  onInvalid,
}: {
  disabled?: boolean;
  busy?: boolean;
  onFile: (file: File) => void;
  onInvalid?: (message: string) => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const locked = disabled || busy;

  function acceptFile(file: File | undefined | null) {
    if (!file || locked) return;
    if (!isPdf(file)) {
      onInvalid?.(t("settings.error.cvPdfOnly"));
      return;
    }
    onFile(file);
  }

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (locked) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!locked) e.dataTransfer.dropEffect = "copy";
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (locked) return;
    acceptFile(e.dataTransfer.files?.[0]);
  }

  return (
    <label
      className={`cmae-cv-drop${dragging ? " is-dragging" : ""}${busy ? " is-busy" : ""}${locked ? " is-disabled" : ""}`}
      aria-label={t("cvDropzone.aria")}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <input
        className="cmae-cv-drop-input"
        type="file"
        accept="application/pdf,.pdf"
        disabled={locked}
        onChange={(e) => {
          acceptFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <span className="cmae-cv-drop-icon" aria-hidden>
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path
            d="M14 5v12M14 5l-4 4M14 5l4 4M6 19.5V21a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
            strokeLinejoin="miter"
          />
        </svg>
      </span>
      <span className="cmae-cv-drop-title">
        {busy
          ? t("cvDropzone.busy")
          : dragging
            ? t("cvDropzone.dragging")
            : t("cvDropzone.title")}
      </span>
      {!busy ? (
        <span className="cmae-cv-drop-hint">{t("cvDropzone.hint")}</span>
      ) : null}
    </label>
  );
}
