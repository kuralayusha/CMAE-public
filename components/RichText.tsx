"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Render a locale string with `{name}` slots replaced by React nodes.
 * Translators write one full sentence per language (word order safe):
 *   en: "Open the {link} page."
 *   tr: "{link} sayfasını açın."
 */
export function RichText({
  text,
  parts,
}: {
  text: string;
  parts: Record<string, ReactNode>;
}) {
  const nodes: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const name = match[1]!;
    const part = parts[name];
    nodes.push(
      <Fragment key={`${name}-${i++}`}>
        {part !== undefined && part !== null ? part : match[0]}
      </Fragment>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return <>{nodes}</>;
}
