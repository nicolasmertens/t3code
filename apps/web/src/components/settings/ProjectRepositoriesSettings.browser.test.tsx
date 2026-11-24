import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type AuthEnvironmentScope,
  type SourceControlRepositoryListItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";

const ENVIRONMENT_ID = EnvironmentId.make("environment-repositories");
const GITHUB = SourceControlProviderKind.make("github");

function repository(
  name: string,
  extra: Partial<SourceControlRepositoryListItem> = {},
): SourceControlRepositoryListItem {
  return {
    provider: GITHUB,
    nameWithOwner: `acme/${name}`,
    url: `https://github.com/acme/${name}`,
    sshUrl: `git@github.com:acme/${name}.git`,
    pushedAt: "2026-11-20T12:00:00.000Z",
    ...extra,
  };
}

interface QueryDescriptor {
  readonly kind: string;
  readonly args: { readonly input?: { readonly partialPath?: string } };
}

const { state, query, descriptor } = vi.hoisted(() => ({
  state: {
    scopes: new Set<string>(),
    repositories: [] as SourceControlRepositoryListItem[],
    browseEntries: [] as Array<{ name: string; fullPath: string }>,
    folders: [] as Array<{ path: string; name: string; state: "git" | "plain" }>,
    clone: vi.fn(),
    update: vi.fn(),
    reportFailure: vi.fn(),
  },
  query: (data: unknown) => ({ data, isPending: false, error: null, refresh: () => {} }),
  descriptor: (kind: string) => (args: { readonly input?: { readonly partialPath?: string } }) => ({
    kind,
    args,
  }),
}));

vi.mock(import("~/state/query"), async (original) => {
  const [actual, Option, { SourceControlProviderKind }] = await Promise.all([
    original(),
    import("effect/Option"),
    import("@t3tools/contracts"),
  ]);
  return {
    ...actual,
    useEnvironmentQuery: ((atom: QueryDescriptor | null) => {
      switch (atom?.kind) {
        case "listFolders":
          return query({ folders: state.folders });
        case "scanFolders":
          return query({ folders: [] });
        case "browse": {
          const parentPath = atom.args.input?.partialPath ?? "/";
          return query({
            parentPath,
            entries: state.browseEntries.filter((entry) => entry.fullPath.startsWith(parentPath)),
          });
        }
        case "discovery":
          return query({
            sourceControlProviders: [
              {
                kind: SourceControlProviderKind.make("github"),
                label: "GitHub",
                status: "available",
                auth: { status: "authenticated", detail: Option.none() },
              },
            ],
          });
        case "repositories":
          return query({ supported: true, repositories: state.repositories });
        default:
          return { data: null, isPending: false, error: null, refresh: () => {} };
      }
    }) as never,
  };
});
vi.mock(import("~/state/filesystem"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useFilesystemReadAccess: (() => ({ canReadFiles: true })) as never,
    filesystemEnvironment: {
      ...actual.filesystemEnvironment,
      listFolders: descriptor("listFolders"),
      scanFolders: descriptor("scanFolders"),
      browse: descriptor("browse"),
    } as never,
  };
});
vi.mock(import("~/state/sourceControl"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    sourceControlEnvironment: {
      ...actual.sourceControlEnvironment,
      discovery: descriptor("discovery"),
      repositories: descriptor("repositories"),
    } as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const [actual, { EnvironmentId }] = await Promise.all([original(), import("@t3tools/contracts")]);
  return {
    ...actual,
    useEnvironments: (() => ({
      environments: [
        {
          environmentId: EnvironmentId.make("environment-repositories"),
          connection: { phase: "connected" },
          serverConfig: { environment: { platform: { os: "linux" } } },
        },
      ],
    })) as never,
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_environmentId: string, scope: AuthEnvironmentScope) =>
    state.scopes.has(scope)) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.clone) as never,
}));
vi.mock(import("~/state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => state.update) as never,
}));
vi.mock(import("~/hooks/useProjectGroupUpdate"), async (original) => ({
  ...(await original()),
  checkProjectAccess: (() => null) as never,
  reportProjectFailure: state.reportFailure as never,
}));
vi.mock(import("../sourceControlAppAccessToast"), async (original) => ({
  ...(await original()),
  suggestAppAccessForRemote: (async () => {}) as never,
}));

import { ProjectRepositoriesSettings } from "./ProjectRepositoriesSettings";

const member = {
  id: ProjectId.make("project-humble"),
  environmentId: ENVIRONMENT_ID,
  physicalProjectKey: "project-humble",
  environmentLabel: "Build box",
  workspaceRoot: "/work/code/humble-tools",
  trackedFolders: [],
  isScratch: false,
} as unknown as SidebarProjectGroupMember;

function setup(options: { readonly canClone?: boolean } = {}) {
  vi.clearAllMocks();
  localStorage.clear();
  state.scopes = new Set([
    AuthOrchestrationOperateScope,
    ...(options.canClone === false ? [] : [AuthSourceControlWriteScope]),
  ]);
  state.repositories = [
    repository("humble-tools", { isPrivate: true }),
    repository("humble-onboarding", { isPrivate: true }),
    repository("humble-search", {
      description: "Whole-disk, typo-tolerant file search",
      isPrivate: true,
    }),
    repository("site-routes", { description: "Two routes per site" }),
    repository("notes-app"),
  ];
  state.folders = [
    { path: "/work/code/humble-onboarding", name: "humble-onboarding", state: "git" },
  ];
  state.browseEntries = [
    { name: "humble-onboarding", fullPath: "/work/code/humble-onboarding" },
    { name: "humble-tools", fullPath: "/work/code/humble-tools" },
    { name: "site-routes", fullPath: "/work/code/site-routes" },
  ];
  state.clone.mockReset();
  state.clone.mockImplementation(
    async (request: { input: { destinationPath: string; remoteUrl: string } }) =>
      AsyncResult.success({
        cwd: request.input.destinationPath,
        remoteUrl: request.input.remoteUrl,
        repository: null,
      }),
  );
  state.update.mockReset();
  state.update.mockResolvedValue(AsyncResult.success(undefined));
  state.reportFailure.mockReset();
}

const dialog = () => page.getByRole("dialog");

async function openGitHubPane() {
  await userEvent.click(page.getByRole("button", { name: "Add folder" }));
  await userEvent.click(dialog().getByRole("button", { name: "GitHub" }));
  await expect.element(dialog().getByPlaceholder("Search your repositories")).toBeVisible();
}

function repositoryRow(name: string) {
  return dialog().getByRole("button", { name: new RegExp(`acme/${name}`) });
}

describe("ProjectRepositoriesSettings", () => {
  it("clones a GitHub repository next to the project and adds it", async () => {
    setup();
    await using _screen = await render(<ProjectRepositoriesSettings members={[member]} />);
    await openGitHubPane();

    await userEvent.type(dialog().getByPlaceholder("Search your repositories"), "search");
    await expect.element(repositoryRow("humble-search")).toBeVisible();
    await expect.element(repositoryRow("notes-app")).not.toBeInTheDocument();

    // Enter picks the best match first.
    await userEvent.keyboard("{Enter}");
    await expect.element(repositoryRow("humble-search")).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(dialog().getByLabelText("Clone into"))
      .toHaveValue("/work/code/humble-search");
    await expect
      .element(dialog().getByText("Clones into a new folder, then adds it to the project."))
      .toBeVisible();

    await userEvent.click(dialog().getByRole("button", { name: "Clone and add" }));

    await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
    expect(state.clone).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        remoteUrl: expect.stringMatching(/acme\/humble-search/),
        destinationPath: "/work/code/humble-search",
      },
    });
    expect(state.update).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        projectId: member.id,
        trackFolders: [{ path: "/work/code/humble-search", name: "humble-search" }],
      },
    });
    await expect.element(dialog()).not.toBeInTheDocument();
  });

  it("does not clone a repository the project already has", async () => {
    setup();
    await using _screen = await render(<ProjectRepositoriesSettings members={[member]} />);
    await openGitHubPane();

    await expect.element(repositoryRow("humble-onboarding").getByText("In project")).toBeVisible();
    await expect.element(repositoryRow("humble-tools").getByText("In project")).toBeVisible();
    await userEvent.click(repositoryRow("humble-onboarding"));

    await expect
      .element(dialog().getByLabelText("Clone into"))
      .toHaveValue("/work/code/humble-onboarding");
    await expect
      .element(dialog().getByText("This folder is already part of the project."))
      .toBeVisible();
    await expect.element(dialog().getByRole("button", { name: "Clone and add" })).toBeDisabled();
    expect(state.clone).not.toHaveBeenCalled();
  });

  it("adds a folder already on disk instead of cloning over it", async () => {
    setup();
    await using _screen = await render(<ProjectRepositoriesSettings members={[member]} />);
    await openGitHubPane();

    await userEvent.click(repositoryRow("site-routes"));
    await expect
      .element(
        dialog().getByText("A folder is already there. It is added as it is, without cloning."),
      )
      .toBeVisible();
    await userEvent.click(dialog().getByRole("button", { name: "Add folder" }));

    await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
    expect(state.update).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        projectId: member.id,
        trackFolders: [{ path: "/work/code/site-routes", name: "site-routes" }],
      },
    });
    expect(state.clone).not.toHaveBeenCalled();
  });

  it("reports a failed clone and keeps the dialog open", async () => {
    setup();
    state.clone.mockResolvedValueOnce(AsyncResult.failure(new Error("clone failed") as never));
    await using _screen = await render(<ProjectRepositoriesSettings members={[member]} />);
    await openGitHubPane();

    await userEvent.click(repositoryRow("notes-app"));
    await userEvent.click(dialog().getByRole("button", { name: "Clone and add" }));

    await vi.waitFor(() => expect(state.reportFailure).toHaveBeenCalledOnce());
    expect(state.reportFailure.mock.calls[0]?.[0]).toBe("Failed to clone acme/notes-app");
    expect(state.update).not.toHaveBeenCalled();
    await expect.element(dialog()).toBeVisible();
  });

  it("opens on the source used last", async () => {
    setup();
    await using _screen = await render(<ProjectRepositoriesSettings members={[member]} />);
    await openGitHubPane();
    await userEvent.click(dialog().getByRole("button", { name: "Cancel" }));
    await expect.element(dialog()).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Add folder" }));
    await expect.element(dialog().getByPlaceholder("Search your repositories")).toBeVisible();
  });

  it("offers only folders on disk to a connection that cannot clone", async () => {
    setup({ canClone: false });
    localStorage.setItem("t3code:project-settings:add-folder-source", JSON.stringify("repository"));
    await using _screen = await render(<ProjectRepositoriesSettings members={[member]} />);
    await userEvent.click(page.getByRole("button", { name: "Add folder" }));

    await expect.element(dialog().getByLabelText("Folder path")).toBeVisible();
    await expect.element(dialog().getByRole("button", { name: "GitHub" })).not.toBeInTheDocument();
  });
});
