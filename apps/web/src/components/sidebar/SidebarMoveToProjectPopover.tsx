import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { MoveTargetProject } from "@t3tools/client-runtime/state/projects";
import { FolderInputIcon, SearchIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { readMoveThreadProjectTargets } from "../../hooks/useThreadActions";
import type { Project } from "../../types";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export function SidebarMoveThreadDialog(props: {
  thread: EnvironmentThreadShell | null;
  projectByKey: ReadonlyMap<string, Project>;
  onClose: () => void;
  onMoveThread: (
    threadRef: ScopedThreadRef,
    targetProjectId: ProjectId,
    targetName: string,
  ) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const thread = props.thread;
  const threadRef = thread ? scopeThreadRef(thread.environmentId, thread.id) : null;
  const targets: readonly MoveTargetProject[] = threadRef
    ? readMoveThreadProjectTargets(threadRef)
    : [];
  const normalized = query.trim().toLowerCase();
  const filteredTargets =
    normalized.length === 0
      ? targets
      : targets.filter((target) => target.name.toLowerCase().includes(normalized));

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setQuery("");
      props.onClose();
    }
  };

  return (
    <Dialog open={thread !== null} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <T>Move thread to project</T>
          </DialogTitle>
          {thread ? (
            <DialogDescription>
              <span className="block truncate">{thread.title}</span>
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border px-2">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              size="sm"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={gt("Filter projects...")}
              aria-label={gt("Filter target projects")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && filteredTargets.length > 0 && threadRef) {
                  event.preventDefault();
                  const first = filteredTargets[0]!;
                  props.onMoveThread(threadRef, first.id, first.name);
                  setQuery("");
                  props.onClose();
                }
              }}
            />
          </div>
          {filteredTargets.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              <T>No available projects to move this thread into.</T>
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {filteredTargets.map((target) => {
                const project = thread
                  ? props.projectByKey.get(`${thread.environmentId}:${target.id}`)
                  : undefined;
                return (
                  <li key={target.id} className="list-none">
                    <button
                      type="button"
                      data-testid={`sidebar-move-target-${target.id}`}
                      onClick={() => {
                        if (!threadRef) return;
                        props.onMoveThread(threadRef, target.id, target.name);
                        setQuery("");
                        props.onClose();
                      }}
                      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      {project ? (
                        <ProjectFavicon project={project} className="size-4 shrink-0" />
                      ) : (
                        <FolderInputIcon
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{target.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function SidebarOrganizeNoProjectDialog(props: {
  open: boolean;
  threads: readonly EnvironmentThreadShell[];
  projectByKey: ReadonlyMap<string, Project>;
  onClose: () => void;
  onMoveThread: (
    threadRef: ScopedThreadRef,
    targetProjectId: ProjectId,
    targetName: string,
  ) => void;
}) {
  const gt = useGT();

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Organize No project threads</T>
          </DialogTitle>
          <DialogDescription>
            <T>Assign ungrouped threads to a project to keep your queue tidy.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.threads.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              <T>All caught up. No ungrouped threads left.</T>
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
              {props.threads.map((thread) => {
                const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                const threadKey = scopedThreadKey(threadRef);
                const targets = readMoveThreadProjectTargets(threadRef);
                return (
                  <li
                    key={threadKey}
                    data-testid="sidebar-organize-row"
                    className="flex list-none items-center gap-2 rounded-md border border-border/70 px-2.5 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {thread.title}
                    </span>
                    {targets.length > 0 ? (
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="xs"
                              variant="outline"
                              aria-label={gt("Move {title} to project", { title: thread.title })}
                            />
                          }
                        >
                          <FolderInputIcon aria-hidden className="size-3" />
                          <span>
                            <T>Move</T>
                          </span>
                        </MenuTrigger>
                        <MenuPopup align="end">
                          {targets.map((target) => {
                            const project = props.projectByKey.get(
                              `${thread.environmentId}:${target.id}`,
                            );
                            return (
                              <MenuItem
                                key={target.id}
                                onClick={() =>
                                  props.onMoveThread(threadRef, target.id, target.name)
                                }
                              >
                                {project ? (
                                  <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                                ) : null}
                                <span className="truncate">{target.name}</span>
                              </MenuItem>
                            );
                          })}
                        </MenuPopup>
                      </Menu>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        <T>Unavailable</T>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
