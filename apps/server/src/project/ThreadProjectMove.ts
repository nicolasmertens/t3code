import {
  CommandId,
  isDelegatedAppThread,
  isListedThreadLineage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /**
     * Moves an idle listed thread to an existing active project's root checkout,
     * detaching live sessions and rebinding the thread's scheduled tasks.
     */
    readonly move: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

function dispatchFailureReason(cause: unknown, threadTitle: string): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "OrchestratorDispatchError" &&
    "cause" in cause &&
    typeof cause.cause === "string"
  ) {
    if (cause.cause.includes("still has running background agents or commands")) {
      return `"${threadTitle}" still has running background agents or commands. Wait for them to finish, or press Stop, then try again.`;
    }
    if (cause.cause.includes("still has work in progress")) {
      return `"${threadTitle}" is still working. Finish or stop it first.`;
    }
  }
  return "Could not move thread to project.";
}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;

  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({ reason, cause });

  const move: ThreadProjectMove["Service"]["move"] = Effect.fn("ThreadProjectMove.move")(
    function* (input) {
      const rawThread = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(fail("Could not read the thread.")));
      if (rawThread === null || rawThread.deletedAt !== null) {
        return yield* new ThreadProjectMoveError({ reason: "Thread not found." });
      }
      const thread = rawThread;
      if (!isListedThreadLineage(thread.lineage) || isDelegatedAppThread(thread)) {
        return yield* new ThreadProjectMoveError({
          reason: "Subagent, side chat, and workflow threads cannot be moved to another project.",
        });
      }
      const target = yield* projects
        .getById(input.projectId)
        .pipe(Effect.mapError(fail("Could not read the target project.")));
      if (Option.isNone(target) || target.value.deletedAt !== null) {
        return yield* new ThreadProjectMoveError({ reason: "Project not found." });
      }
      if (target.value.archivedAt !== null) {
        return yield* new ThreadProjectMoveError({
          reason: "Archived projects cannot accept moved threads.",
        });
      }
      if (yield* managedFolders.isScratchProject(input.projectId)) {
        return yield* new ThreadProjectMoveError({
          reason: "Threads cannot be moved into No project.",
        });
      }
      const records = yield* threads
        .getThreadRecords(thread.id, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail(`Could not read "${thread.title}".`)));
      if (threadHasUnfinishedWork(records)) {
        return yield* new ThreadProjectMoveError({
          reason: `"${thread.title}" is still working. Finish or stop it first.`,
        });
      }

      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const commandId = CommandId.make(`thread-project-move:${yield* random.uuidV4()}`);
          yield* threads
            .dispatch({
              type: "thread.project.move",
              commandId,
              threadId: thread.id,
              projectId: input.projectId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadProjectMoveError({
                    reason: dispatchFailureReason(cause, thread.title),
                    cause,
                  }),
              ),
            );
          yield* scheduledTasks
            .moveThreadTasks({ threadIds: [thread.id], projectId: input.projectId })
            .pipe(Effect.mapError(fail("Could not move the thread's scheduled tasks.")));
          return { projectId: input.projectId };
        }),
      );
    },
  );

  return ThreadProjectMove.of({ move });
});

export const layer = Layer.effect(ThreadProjectMove, make);
