import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  buildAddProjectRemoteSourceReadiness,
  getDefaultCloneUrl,
} from "@t3tools/client-runtime/operations/projects";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
  suggestedTrackedFolders,
} from "@t3tools/client-runtime/state/projects";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  PROJECT_TRACKED_FOLDERS_MAX,
  SourceControlProviderKind,
  type EnvironmentId,
  type ProjectTrackedFolder,
  type SourceControlRepositoryListItem,
  type WorkspaceFolderState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CheckIcon, FolderIcon, PlusIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { checkProjectAccess, reportProjectFailure } from "../../hooks/useProjectGroupUpdate";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { sourceControlIcon } from "../../sourceControlPresentation";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { filterRemoteRepositories, getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import { suggestAppAccessForRemote } from "../sourceControlAppAccessToast";
import {
  defaultRepositoryCloneDestination,
  findProjectFolderForRepository,
  resolveRepositoryCloneTarget,
  resolveTrackedFolderInput,
  trackedFolderDisplayPath,
  trackedFolderForClone,
} from "./trackedFolders.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NO_TRACKED_FOLDERS: ReadonlyArray<ProjectTrackedFolder> = [];
const BROWSE_SUGGESTION_LIMIT = 100;
const REPOSITORY_SUGGESTION_LIMIT = 50;
const GITHUB_PROVIDER = SourceControlProviderKind.make("github");
const GitHubIcon = sourceControlIcon(sourceControlClients.get(GITHUB_PROVIDER));

// The last place a folder came from opens the dialog next time; it is only this browser's habit.
const AddFolderSource = Schema.Literals(["disk", "repository"]);
type AddFolderSource = typeof AddFolderSource.Type;
const ADD_FOLDER_SOURCE_STORAGE_KEY = "t3code:project-settings:add-folder-source";

const FOLDER_STATE_LABELS: Record<WorkspaceFolderState, string> = {
  git: msg("Git repository"),
  plain: msg("Folder", { $context: "a plain folder that is not a Git repository" }),
  missing: msg("Missing", { $context: "folder state: not found on disk" }),
};

const LIST_ROW_CLASS_NAME =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

/** A clone the project is waiting on, kept while the dialog is closed and opened again. */
interface PendingClone {
  readonly nameWithOwner: string;
  readonly destinationPath: string;
}

/** Tracked folder paths belong to one checkout's machine, so each checkout has its own list. */
export function ProjectRepositoriesSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  const gt = useGT();
  if (checkouts.length === 0) return null;
  return (
    <SettingsSection id="project-repositories" title={gt("Repositories")}>
      {checkouts.map((member) => (
        <CheckoutRepositories key={member.physicalProjectKey} member={member} />
      ))}
    </SettingsSection>
  );
}

function CheckoutRepositories({ member }: { member: SidebarProjectGroupMember }) {
  const environmentId = member.environmentId;
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const isConnected = environment?.connection.phase === "connected";
  const canEdit = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canClone = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const access = useFilesystemReadAccess(environmentId);
  const tracked = member.trackedFolders ?? NO_TRACKED_FOLDERS;
  // Read from disk: the project's own copy of the list can be a moment behind a clone.
  const listQuery = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.listFolders({ environmentId, input: { projectId: member.id } })
      : null,
  );
  const folders: ReadonlyArray<ProjectTrackedFolder & { state?: WorkspaceFolderState }> =
    listQuery.data?.folders ?? tracked;
  // Only a workspace file's folders are offered: the rest is found without asking.
  const scanQuery = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.scanFolders({
          environmentId,
          input: { workspaceRoot: member.workspaceRoot },
        })
      : null,
  );
  const suggested = suggestedTrackedFolders(folders, scanQuery.data?.folders ?? []);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [pendingClone, setPendingClone] = useState<PendingClone | null>(null);
  // A save builds on the listed folders, so it waits for the list that follows the last one.
  const disabled = !canEdit || !isConnected || isSaving || listQuery.isPending;
  const gt = useGT();
  const m = useMessages();

  // One folder in or out: the server applies it to its own list, which another client may have
  // changed since this one was read.
  const save = async (
    change: { readonly track: ProjectTrackedFolder } | { readonly untrack: string },
    failureTitle: string,
  ) => {
    if (checkProjectAccess([member], failureTitle)) return false;
    setIsSaving(true);
    const result = await updateProject({
      environmentId,
      input: {
        projectId: member.id,
        ...("track" in change
          ? { trackFolders: [{ path: change.track.path, name: change.track.name }] }
          : { untrackFolders: [change.untrack] }),
      },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      reportProjectFailure(failureTitle, result);
      return false;
    }
    listQuery.refresh();
    return true;
  };

  const addFolder = async (folder: ProjectTrackedFolder) => {
    if (await save({ track: folder }, gt("Failed to add folder"))) setIsAddingFolder(false);
  };

  // The clone runs here rather than in the dialog, so closing the dialog does not drop the folder
  // it was cloned for.
  const cloneAndAddFolder = async (
    repository: SourceControlRepositoryListItem,
    destinationPath: string,
  ) => {
    const failureTitle = gt("Failed to clone {repository}", {
      repository: repository.nameWithOwner,
    });
    if (checkProjectAccess([member], failureTitle)) return;
    const remoteUrl = getDefaultCloneUrl(repository);
    setPendingClone({ nameWithOwner: repository.nameWithOwner, destinationPath });
    const result = await cloneRepository({
      environmentId,
      input: { remoteUrl, destinationPath },
    });
    setPendingClone(null);
    if (result._tag === "Failure") {
      reportProjectFailure(failureTitle, result);
      return;
    }
    void suggestAppAccessForRemote(environmentId, remoteUrl);
    const folder = trackedFolderForClone(result.value.cwd);
    if (folder !== null) await addFolder(folder);
  };

  return (
    <>
      <SettingsRow
        title={member.environmentLabel ?? gt("Environment")}
        description={member.workspaceRoot}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || folders.length >= PROJECT_TRACKED_FOLDERS_MAX}
            onClick={() => setIsAddingFolder(true)}
          >
            {pendingClone === null ? (
              <PlusIcon className="size-3.5" />
            ) : (
              <Spinner className="size-3.5" />
            )}
            <T>Add folder</T>
          </Button>
        }
      />
      {folders.length === 0 ? (
        <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
          <T>
            Repositories inside this folder are part of the project as soon as they are there. Add a
            folder to bring in one from somewhere else.
          </T>
        </p>
      ) : (
        folders.map((folder) => (
          <SettingsRow
            key={folder.path}
            className="py-2"
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{folder.name}</span>
                {folder.state ? (
                  <Badge size="sm" variant={folder.state === "missing" ? "warning" : "outline"}>
                    {m(FOLDER_STATE_LABELS[folder.state])}
                  </Badge>
                ) : null}
              </span>
            }
            description={
              <code className="block max-w-full truncate font-mono">
                {trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
              </code>
            }
            control={
              // A repository inside the project folder is there for as long as it is on disk.
              folder.discovered === true ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={gt("Remove {name} from the project", { name: folder.name })}
                  onClick={() => void save({ untrack: folder.path }, gt("Failed to remove folder"))}
                >
                  <T>Remove</T>
                </Button>
              )
            }
          />
        ))
      )}
      {suggested.map((folder) => (
        <SettingsRow
          key={folder.path}
          className="py-2"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-muted-foreground">{folder.name}</span>
              <Badge size="sm" variant="outline">
                <T>In workspace file</T>
              </Badge>
            </span>
          }
          description={
            <code className="block max-w-full truncate font-mono">
              {trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
            </code>
          }
          control={
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-label={gt("Add {name} to the project", { name: folder.name })}
              onClick={() => void save({ track: folder }, gt("Failed to add folder"))}
            >
              <T>Add</T>
            </Button>
          }
        />
      ))}
      {listQuery.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-warning-foreground sm:px-4">
          {listQuery.error}
        </p>
      ) : null}
      {isAddingFolder ? (
        <AddTrackedFolderDialog
          environmentId={environmentId}
          workspaceRoot={member.workspaceRoot}
          projectFolders={folders.map((folder) => folder.path)}
          platform={getEnvironmentBrowsePlatform(
            environment?.serverConfig?.environment.platform.os,
          )}
          canBrowse={access.canReadFiles}
          canClone={canClone}
          busy={isSaving || listQuery.isPending}
          pendingClone={pendingClone}
          onAdd={(folder) => void addFolder(folder)}
          onClone={(repository, destinationPath) =>
            void cloneAndAddFolder(repository, destinationPath)
          }
          onClose={() => setIsAddingFolder(false)}
        />
      ) : null}
    </>
  );
}

interface AddTrackedFolderDialogProps {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Folders the project already has, besides its own. */
  readonly projectFolders: ReadonlyArray<string>;
  readonly platform: string;
  readonly canBrowse: boolean;
  readonly canClone: boolean;
  readonly busy: boolean;
  readonly pendingClone: PendingClone | null;
  readonly onAdd: (folder: ProjectTrackedFolder) => void;
  readonly onClone: (repository: SourceControlRepositoryListItem, destinationPath: string) => void;
  readonly onClose: () => void;
}

function AddTrackedFolderDialog(props: AddTrackedFolderDialogProps) {
  const gt = useGT();
  const [storedSource, setStoredSource] = useLocalStorage(
    ADD_FOLDER_SOURCE_STORAGE_KEY,
    "disk",
    AddFolderSource,
  );
  // A clone in progress keeps its pane open, so its progress stays in view.
  const source: AddFolderSource = !props.canClone
    ? "disk"
    : props.pendingClone !== null
      ? "repository"
      : storedSource;
  const sourcePicker = props.canClone ? (
    <ToggleGroup
      aria-label={gt("Add from")}
      className="w-full *:flex-1"
      value={[source]}
      disabled={props.pendingClone !== null}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "disk" || value === "repository") setStoredSource(value);
      }}
    >
      <Toggle value="disk">
        <FolderIcon />
        <T>This machine</T>
      </Toggle>
      <Toggle value="repository">
        <GitHubIcon />
        <T>GitHub</T>
      </Toggle>
    </ToggleGroup>
  ) : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        {source === "repository" ? (
          <RepositoryCloneForm {...props} sourcePicker={sourcePicker} />
        ) : (
          <DiskFolderForm {...props} sourcePicker={sourcePicker} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function DiskFolderForm(props: AddTrackedFolderDialogProps & { readonly sourcePicker: ReactNode }) {
  const inputId = useId();
  // Repositories next to the project folder are the common case, so the listing starts there.
  const [query, setQuery] = useState(
    () =>
      getBrowseParentPath(props.workspaceRoot) ?? ensureBrowseDirectoryPath(props.workspaceRoot),
  );
  const browsePath = getFilesystemBrowsePath(query, props.platform, props.canBrowse);
  const browseQuery = useEnvironmentQuery(
    browsePath.isBrowsing && browsePath.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: browsePath.directoryPath, cwd: props.workspaceRoot },
        })
      : null,
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    browseQuery.data?.entries ?? [],
    browsePath.filterQuery,
  );
  const folder = resolveTrackedFolderInput({
    query,
    listedDirectoryPath: browseQuery.data?.parentPath ?? null,
    exactEntryPath: exactEntry?.fullPath ?? null,
  });
  const parentPath = browsePath.canBrowseUp ? browsePath.parentPath : null;
  const hiddenCount = Math.max(0, visibleEntries.length - BROWSE_SUGGESTION_LIMIT);

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (folder && !props.busy) props.onAdd(folder);
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <T>Add folder</T>
        </DialogTitle>
        <DialogDescription>
          <T>Track a repository or folder anywhere on this project's machine.</T>
        </DialogDescription>
        {props.sourcePicker}
        <div className="flex flex-col gap-2 pt-1">
          <Label htmlFor={inputId}>
            <T>Folder path</T>
          </Label>
          <Input
            id={inputId}
            font="mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="/path/to/repository"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      </DialogHeader>
      <DialogPanel>
        <div className="-mx-2 flex min-h-40 flex-col">
          {parentPath !== null ? (
            <button
              type="button"
              className={LIST_ROW_CLASS_NAME}
              onClick={() => setQuery(parentPath)}
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              ..
            </button>
          ) : null}
          {visibleEntries.slice(0, BROWSE_SUGGESTION_LIMIT).map((entry) => (
            <button
              key={entry.fullPath}
              type="button"
              className={LIST_ROW_CLASS_NAME}
              onClick={() =>
                setQuery(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
              }
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
          ))}
          {browseQuery.error ? (
            <p role="alert" className="px-2 py-1.5 text-sm text-muted-foreground">
              {browseQuery.error}
            </p>
          ) : browseQuery.isPending && browseQuery.data === null ? (
            <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
              <T>Loading folders…</T>
            </p>
          ) : hiddenCount > 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              <T>
                <Var>{hiddenCount}</Var> more. Keep typing to narrow the list.
              </T>
            </p>
          ) : !props.canBrowse ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              <T>This connection cannot browse folders. Enter an absolute path.</T>
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          <T>Cancel</T>
        </Button>
        <Button type="submit" disabled={folder === null || props.busy}>
          <T>Add folder</T>
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Moves focus between the rows of a list with the arrow keys, from the search box too. */
function focusSiblingRow(container: HTMLElement | null, from: Element | null, step: 1 | -1) {
  if (container === null) return false;
  const rows = [...container.querySelectorAll<HTMLButtonElement>("[data-repository-row]")];
  if (rows.length === 0) return false;
  const index = from instanceof HTMLButtonElement ? rows.indexOf(from) : -1;
  const next = index === -1 ? (step === 1 ? rows[0] : undefined) : rows[index + step];
  next?.focus();
  return next !== undefined;
}

function RepositoryCloneForm(
  props: AddTrackedFolderDialogProps & { readonly sourcePicker: ReactNode },
) {
  const gt = useGT();
  const m = useMessages();
  const searchId = useId();
  const destinationId = useId();
  const destinationHintId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SourceControlRepositoryListItem | null>(null);
  const [destination, setDestination] = useState("");
  const pending = props.pendingClone;
  const isCloning = pending !== null;

  const discoveryQuery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId: props.environmentId, input: {} }),
  );
  const readiness =
    discoveryQuery.data === null
      ? null
      : buildAddProjectRemoteSourceReadiness(discoveryQuery.data, m)(GITHUB_PROVIDER);
  const repositoriesQuery = useEnvironmentQuery(
    readiness?.ready === true
      ? sourceControlEnvironment.repositories({
          environmentId: props.environmentId,
          input: { provider: GITHUB_PROVIDER },
        })
      : null,
  );
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const matches = filterRemoteRepositories(repositories, query);
  const visibleMatches = matches.slice(0, REPOSITORY_SUGGESTION_LIMIT);
  const hiddenCount = matches.length - visibleMatches.length;
  const listError = discoveryQuery.error ?? repositoriesQuery.error;
  const isLoading =
    listError === null &&
    (discoveryQuery.data === null ||
      (readiness?.ready === true && repositoriesQuery.data === null));

  // The destination's parent folder is listed to find out whether the destination is already there.
  const destinationBrowse = getFilesystemBrowsePath(destination, props.platform, props.canBrowse);
  const destinationBrowseQuery = useEnvironmentQuery(
    selected !== null &&
      destinationBrowse.isBrowsing &&
      destinationBrowse.directoryPath.length > 0 &&
      destinationBrowse.filterQuery.length > 0
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: destinationBrowse.directoryPath, cwd: props.workspaceRoot },
        })
      : null,
  );
  const destinationEntry = filterFilesystemBrowseEntries(
    destinationBrowseQuery.data?.entries ?? [],
    destinationBrowse.filterQuery,
  ).exactEntry;
  const isCheckingDestination =
    destinationBrowseQuery.isPending && destinationBrowseQuery.data === null;
  const target =
    selected === null
      ? null
      : resolveRepositoryCloneTarget({
          destination,
          workspaceRoot: props.workspaceRoot,
          projectFolders: props.projectFolders,
          exactEntryPath: destinationEntry?.fullPath ?? null,
        });
  const canSubmit =
    !isCloning &&
    !props.busy &&
    !isCheckingDestination &&
    target !== null &&
    (target.kind === "new" || target.kind === "existing");

  const select = (repository: SourceControlRepositoryListItem) => {
    setSelected(repository);
    setDestination(
      defaultRepositoryCloneDestination({
        nameWithOwner: repository.nameWithOwner,
        workspaceRoot: props.workspaceRoot,
        projectFolders: props.projectFolders,
      }),
    );
  };

  const submit = () => {
    if (!canSubmit || selected === null || target === null) return;
    if (target.kind === "existing") props.onAdd(target.folder);
    if (target.kind === "new") props.onClone(selected, target.path);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const moved = focusSiblingRow(
      listRef.current,
      event.target instanceof Element ? event.target : null,
      event.key === "ArrowDown" ? 1 : -1,
    );
    if (moved) event.preventDefault();
  };

  const statusMessage = (() => {
    if (pending !== null) {
      return gt("Cloning {repository}…", { repository: pending.nameWithOwner });
    }
    if (target === null || isCheckingDestination) return null;
    switch (target.kind) {
      case "invalid":
        return gt("Enter an absolute path to clone into.");
      case "in-project":
        return gt("This folder is already part of the project.");
      case "existing":
        return gt("A folder is already there. It is added as it is, without cloning.");
      case "new":
        return gt("Clones into a new folder, then adds it to the project.");
    }
  })();

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <T>Add folder</T>
        </DialogTitle>
        <DialogDescription>
          <T>Clone one of your GitHub repositories and track it in this project.</T>
        </DialogDescription>
        {props.sourcePicker}
        <div className="flex flex-col gap-2 pt-1">
          <Label htmlFor={searchId}>
            <T>Repository</T>
          </Label>
          <Input
            id={searchId}
            type="search"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            disabled={isCloning}
            placeholder={gt("Search your repositories")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // Enter picks the best match unless a listed one is picked; then it adds that one.
                const selectedIsListed =
                  selected !== null &&
                  visibleMatches.some(
                    (repository) => repository.nameWithOwner === selected.nameWithOwner,
                  );
                if (!selectedIsListed) {
                  event.preventDefault();
                  const first = visibleMatches[0];
                  if (first !== undefined) select(first);
                }
                return;
              }
              onListKeyDown(event);
            }}
          />
        </div>
      </DialogHeader>
      <DialogPanel>
        <div
          ref={listRef}
          role="group"
          aria-label={gt("Your repositories")}
          className="-mx-2 flex min-h-40 flex-col"
          onKeyDown={onListKeyDown}
        >
          {readiness !== null && !readiness.ready ? (
            <p role="alert" className="px-2 py-1.5 text-sm text-muted-foreground">
              {readiness.hint}
            </p>
          ) : listError !== null ? (
            <p role="alert" className="px-2 py-1.5 text-sm text-muted-foreground">
              {listError}
            </p>
          ) : isLoading ? (
            <div role="status" aria-label={gt("Loading repositories…")}>
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="flex items-center gap-2 px-2 py-2">
                  <Skeleton className="size-4 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-2/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : repositoriesQuery.data?.supported === false ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              <T>This machine cannot list GitHub repositories.</T>
            </p>
          ) : visibleMatches.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {query.trim().length > 0 ? (
                <T>No repository in your account matches that.</T>
              ) : (
                <T>No repositories in your account yet.</T>
              )}
            </p>
          ) : (
            <>
              {visibleMatches.map((repository) => {
                const isSelected = selected?.nameWithOwner === repository.nameWithOwner;
                const [owner, name] = splitNameWithOwner(repository.nameWithOwner);
                const inProject =
                  findProjectFolderForRepository({
                    nameWithOwner: repository.nameWithOwner,
                    workspaceRoot: props.workspaceRoot,
                    projectFolders: props.projectFolders,
                  }) !== null;
                return (
                  <button
                    key={repository.nameWithOwner}
                    type="button"
                    data-repository-row=""
                    aria-pressed={isSelected}
                    disabled={isCloning}
                    className={cn(
                      LIST_ROW_CLASS_NAME,
                      "items-start py-2 transition-colors duration-150 disabled:cursor-default disabled:opacity-64",
                      isSelected && "bg-accent text-accent-foreground hover:bg-accent",
                    )}
                    onClick={() => select(repository)}
                  >
                    <GitHubIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">
                          {owner ? <span className="text-muted-foreground">{owner}/</span> : null}
                          <span className="font-medium">{name}</span>
                        </span>
                        {repository.isPrivate ? (
                          <Badge size="sm" variant="outline">
                            <T>Private</T>
                          </Badge>
                        ) : null}
                        {inProject ? (
                          <Badge size="sm" variant="secondary">
                            <T>In project</T>
                          </Badge>
                        ) : null}
                      </span>
                      {repository.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {repository.description}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    ) : repository.pushedAt ? (
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatRelativeTimeLabel(repository.pushedAt, undefined, m)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {hiddenCount > 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  <T>
                    <Var>{hiddenCount}</Var> more. Keep typing to narrow the list.
                  </T>
                </p>
              ) : null}
            </>
          )}
        </div>
      </DialogPanel>
      {selected !== null || pending !== null ? (
        <div className="flex flex-col gap-2 border-t px-6 pt-3 pb-4">
          <Label htmlFor={destinationId}>
            <T>Clone into</T>
          </Label>
          <Input
            id={destinationId}
            font="mono"
            autoComplete="off"
            spellCheck={false}
            disabled={isCloning}
            aria-describedby={destinationHintId}
            value={pending?.destinationPath ?? destination}
            onChange={(event) => setDestination(event.currentTarget.value)}
          />
          <p
            id={destinationHintId}
            aria-live="polite"
            className={cn(
              "min-h-4 text-xs",
              target?.kind === "in-project" || target?.kind === "invalid"
                ? "text-warning-foreground"
                : "text-muted-foreground",
            )}
          >
            {statusMessage}
          </p>
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          {isCloning ? <T>Close</T> : <T>Cancel</T>}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {isCloning ? (
            <>
              <Spinner />
              <T>Cloning…</T>
            </>
          ) : target?.kind === "existing" ? (
            <T>Add folder</T>
          ) : (
            <T>Clone and add</T>
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function splitNameWithOwner(nameWithOwner: string): readonly [string | null, string] {
  const separator = nameWithOwner.lastIndexOf("/");
  return separator === -1
    ? [null, nameWithOwner]
    : [nameWithOwner.slice(0, separator), nameWithOwner.slice(separator + 1)];
}
