import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { syncTopLevelFolderRefs } from "@/lib/research/folder-refs";
import {
  compactTopLevelFolderIndices,
  deleteWorkspaceEntry,
  listWorkspace,
  readWorkspaceFile,
  renameWorkspaceEntry,
  resolveWorkspacePath,
  revealInFileManager,
} from "@/lib/research/workspace";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const url = new URL(req.url);
    const pathParam = url.searchParams.get("path") || "";
    const view = url.searchParams.get("view") || "list";

    if (view === "file") {
      const file = await readWorkspaceFile(pathParam);
      return NextResponse.json(file);
    }

    const listing = await listWorkspace(pathParam);
    return NextResponse.json(listing);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function POST(req: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const body = await req.json();
    const action = String(body.action || "");
    const pathParam = String(body.path || "");

    if (action === "reveal") {
      const result = await revealInFileManager(pathParam);
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "rename") {
      const newName = String(body.newName || "");
      const oldBase = pathParam.includes("/")
        ? pathParam.slice(pathParam.lastIndexOf("/") + 1)
        : pathParam;
      const isTopLevel = Boolean(pathParam) && !pathParam.includes("/");
      const result = await renameWorkspaceEntry(pathParam, newName);
      if (isTopLevel && result.kind === "dir") {
        syncTopLevelFolderRefs(oldBase, {
          name: result.name,
          absolutePath: resolveWorkspacePath(result.path),
        });
      }
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "delete") {
      const oldBase = pathParam.includes("/")
        ? pathParam.slice(pathParam.lastIndexOf("/") + 1)
        : pathParam;
      const isTopLevel = Boolean(pathParam) && !pathParam.includes("/");
      const result = await deleteWorkspaceEntry(pathParam);
      if (isTopLevel) {
        syncTopLevelFolderRefs(oldBase, null);
        // Fill gaps: 1,3,4 → 1,2,3 and keep tracker/job refs in sync
        const renumbers = await compactTopLevelFolderIndices((from, next) => {
          syncTopLevelFolderRefs(from, next);
        });
        return NextResponse.json({ ok: true, ...result, renumbers });
      }
      return NextResponse.json({ ok: true, ...result });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
