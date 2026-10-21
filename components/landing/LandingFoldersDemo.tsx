"use client";

import { useMemo, useState } from "react";
import { useT } from "@/components/I18nProvider";
import {
  useLandingScenario,
  type ScenarioCompany,
  type ScenarioFile,
} from "@/components/landing/LandingScenario";

type View =
  | { level: "root" }
  | { level: "company"; company: ScenarioCompany }
  | { level: "file"; company: ScenarioCompany; file: ScenarioFile };

export function LandingFoldersDemo() {
  const t = useT();
  const { companies, filesFor, researchDone } = useLandingScenario();
  const first = companies[0]!;
  const firstFiles = filesFor(first.id);
  const defaultFile = firstFiles[0]!;

  function badgeLabel(raw: string) {
    if (raw === "for you") return t("landing.demo.badgeForYou");
    if (raw === "for CMAE") return t("landing.demo.badgeForAi");
    return raw;
  }

  const [view, setView] = useState<View>({
    level: "file",
    company: first,
    file: defaultFile,
  });

  const crumbs = useMemo(() => {
    if (view.level === "root") return ["workspace"];
    if (view.level === "company") return ["workspace", view.company.folder];
    return ["workspace", view.company.folder, view.file.name];
  }, [view]);

  const listItems = useMemo(() => {
    if (view.level === "root") {
      return companies.map((c) => ({
        key: c.id,
        kind: "dir" as const,
        label: c.folder,
        company: c,
        file: null as ScenarioFile | null,
      }));
    }
    const company = view.company;
    return filesFor(company.id).map((f) => ({
      key: f.id,
      kind: "file" as const,
      label: f.name,
      company,
      file: f,
    }));
  }, [view, companies, filesFor]);

  const selectedFile = view.level === "file" ? view.file : null;
  const selectedCompany = view.level === "root" ? null : view.company;

  function goRoot() {
    setView({ level: "root" });
  }

  function goCompany(company: ScenarioCompany) {
    setView({ level: "company", company });
  }

  function openFile(company: ScenarioCompany, file: ScenarioFile) {
    setView({ level: "file", company, file });
  }

  function goBack() {
    if (view.level === "file") {
      setView({ level: "company", company: view.company });
      return;
    }
    if (view.level === "company") {
      setView({ level: "root" });
    }
  }

  const folderCount =
    view.level === "root" ? companies.length : 0;
  const fileCount =
    view.level === "root" ? 0 : filesFor(view.company.id).length;

  return (
    <div className="cmae-land-demo">
      <p className="cmae-land-demo-hint">
        {researchDone
          ? t("landing.demo.foldersReady")
          : t("landing.demo.foldersSample")}
      </p>

      <div className="cmae-land-inset cmae-land-fb">
        <div className="cmae-land-fb-bar">
          <div className="cmae-land-fb-nav">
            <button
              type="button"
              className="cmae-land-fb-icon"
              onClick={goBack}
              disabled={view.level === "root"}
              aria-label={t("landing.demo.foldersBack")}
            >
              ←
            </button>
            <button
              type="button"
              className="cmae-land-fb-icon"
              onClick={goRoot}
              aria-label={t("landing.demo.foldersRoot")}
            >
              ⌂
            </button>
            <nav
              className="cmae-land-fb-crumbs"
              aria-label={t("landing.demo.foldersPath")}
            >
              {crumbs.map((c, i) => (
                <span key={`${c}-${i}`} className="cmae-land-fb-crumb">
                  {i > 0 ? (
                    <span className="cmae-land-fb-sep" aria-hidden>
                      /
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="cmae-land-fb-crumb-btn"
                    onClick={() => {
                      if (i === 0) goRoot();
                      else if (i === 1 && selectedCompany) goCompany(selectedCompany);
                    }}
                  >
                    {c}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <span className="cmae-land-fb-count">
            {folderCount
              ? t("landing.demo.foldersCount", { count: folderCount })
              : null}
            {folderCount && fileCount ? " · " : null}
            {fileCount
              ? t("landing.demo.filesCount", { count: fileCount })
              : null}
            {!folderCount && !fileCount ? "—" : null}
          </span>
        </div>

        <div className={`cmae-land-fb-body${selectedFile ? " is-split" : ""}`}>
          <ul className="cmae-land-fb-list" role="list">
            {listItems.map((item) => {
              const selected =
                item.kind === "file" &&
                selectedFile &&
                item.file?.id === selectedFile.id;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    className={`cmae-land-fb-row${selected ? " is-selected" : ""}`}
                    onClick={() => {
                      if (item.kind === "dir") goCompany(item.company);
                      else if (item.file) openFile(item.company, item.file);
                    }}
                  >
                    <span className="cmae-land-fb-name">
                      {item.kind === "dir" ? (
                        <span className="cmae-land-fb-dir">{item.label}/</span>
                      ) : (
                        item.label
                      )}
                    </span>
                    {item.file
                      ? item.file.badges.map((b) => (
                          <span
                            key={b.label}
                            className={`cmae-land-fb-badge is-${b.tone}`}
                          >
                            ({badgeLabel(b.label)})
                          </span>
                        ))
                      : null}
                  </button>
                </li>
              );
            })}
          </ul>

          {selectedFile ? (
            <div className="cmae-land-fb-preview">
              <div className="cmae-land-fb-preview-head">
                <span className="cmae-land-fb-preview-title">
                  {selectedFile.name}
                </span>
                <span className="cmae-land-fb-preview-meta">
                  {selectedCompany?.name}
                </span>
              </div>
              <pre className="cmae-land-fb-preview-body">{selectedFile.body}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
