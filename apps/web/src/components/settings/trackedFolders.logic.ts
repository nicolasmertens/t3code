import type { ProjectTrackedFolder } from "@t3tools/contracts";
import {
  getCloneDestinationPath,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";
import {
  getBrowseParentPath,
  hasTrailingPathSeparator,
} from "@t3tools/client-runtime/state/projects";
import {
  fileBasename,
  isAbsolutePath,
  isHostPath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

// `ProjectTrackedFolder.name` takes at most 128 characters.
const TRACKED_FOLDER_NAME_MAX = 128;

/** Relative to the project folder when inside it, absolute otherwise. */
export function trackedFolderDisplayPath(path: string, workspaceRoot: string): string {
  const relative = workspaceRelativeFilePath(path, workspaceRoot);
  return relative === null || relative === "." ? path : relative;
}

/**
 * The folder a typed path adds. A listing resolves `~/` and names the directory exactly; without
 * one, only an absolute path is safe to send.
 */
export function resolveTrackedFolderInput(input: {
  readonly query: string;
  readonly listedDirectoryPath: string | null;
  readonly exactEntryPath: string | null;
}): ProjectTrackedFolder | null {
  const query = input.query.trim();
  if (query.length === 0) return null;
  const rawPath =
    input.exactEntryPath ??
    (hasTrailingPathSeparator(query) && input.listedDirectoryPath !== null
      ? input.listedDirectoryPath
      : isAbsolutePath(query)
        ? query
        : null);
  if (rawPath === null) return null;
  return trackedFolderAt(rawPath);
}

function trackedFolderAt(rawPath: string): ProjectTrackedFolder | null {
  const path = normalizeProjectPathForDispatch(rawPath);
  const name = fileBasename(path).slice(0, TRACKED_FOLDER_NAME_MAX).trim();
  if (path.length === 0 || name.length === 0) return null;
  return { path, name };
}

function isSamePath(left: string, right: string): boolean {
  return normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);
}

/** The project folder itself or one of its listed folders. */
function findProjectFolder(
  path: string,
  workspaceRoot: string,
  projectFolders: ReadonlyArray<string>,
): string | null {
  if (isSamePath(path, workspaceRoot)) return workspaceRoot;
  return projectFolders.find((folder) => isSamePath(path, folder)) ?? null;
}

/** The project's folder that carries a repository's name, which is how a clone is named. */
export function findProjectFolderForRepository(input: {
  readonly nameWithOwner: string;
  readonly workspaceRoot: string;
  readonly projectFolders: ReadonlyArray<string>;
}): string | null {
  const name = getCloneDirectoryName(input.nameWithOwner);
  if (name.length === 0) return null;
  return (
    [input.workspaceRoot, ...input.projectFolders].find(
      (folder) => fileBasename(folder).toLowerCase() === name.toLowerCase(),
    ) ?? null
  );
}

/**
 * Where a repository from a source control host lands: the folder of that name the project
 * already has, else next to the project folder, where repositories added from disk usually are.
 */
export function defaultRepositoryCloneDestination(input: {
  readonly nameWithOwner: string;
  readonly workspaceRoot: string;
  readonly projectFolders: ReadonlyArray<string>;
}): string {
  const existing = findProjectFolderForRepository(input);
  if (existing !== null) return existing;
  const parent = getBrowseParentPath(input.workspaceRoot) ?? input.workspaceRoot;
  return getCloneDestinationPath(parent, getCloneDirectoryName(input.nameWithOwner));
}

export type RepositoryCloneTarget =
  /** Nothing to clone into yet: an empty or relative path. */
  | { readonly kind: "invalid" }
  /** The project already has this folder. */
  | { readonly kind: "in-project"; readonly path: string }
  /** A folder is already there, so it is added as it is instead of cloned over. */
  | { readonly kind: "existing"; readonly folder: ProjectTrackedFolder }
  /** A clone creates this folder; the server resolves a `~` prefix. */
  | { readonly kind: "new"; readonly path: string };

/**
 * What adding a repository at a destination does. `exactEntryPath` is the destination as the
 * listing of its parent folder names it, when that folder is already on disk.
 */
export function resolveRepositoryCloneTarget(input: {
  readonly destination: string;
  readonly workspaceRoot: string;
  readonly projectFolders: ReadonlyArray<string>;
  readonly exactEntryPath: string | null;
}): RepositoryCloneTarget {
  const destination = normalizeProjectPathForDispatch(input.destination);
  if (destination.length === 0 || !isHostPath(destination)) return { kind: "invalid" };
  const projectFolder = findProjectFolder(
    input.exactEntryPath ?? destination,
    input.workspaceRoot,
    input.projectFolders,
  );
  if (projectFolder !== null) return { kind: "in-project", path: projectFolder };
  if (input.exactEntryPath !== null) {
    const folder = trackedFolderAt(input.exactEntryPath);
    return folder === null ? { kind: "invalid" } : { kind: "existing", folder };
  }
  // A filesystem root has no folder of its own to clone into.
  if (getBrowseParentPath(destination) === null) return { kind: "invalid" };
  return { kind: "new", path: destination };
}

/** The folder a finished clone adds, named after its checkout. */
export function trackedFolderForClone(cwd: string): ProjectTrackedFolder | null {
  return trackedFolderAt(cwd);
}
