import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

const unsignedJwt = (claims: Readonly<Record<string, unknown>>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");

const layerIdentity = (prefix: string) =>
  Layer.provideMerge(ServerSecretStore.layer, ServerConfig.layerTest(process.cwd(), { prefix }));

const writeHomeFile = Effect.fn("test.writeHomeFile")(function* (
  homeDirectory: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homeDirectory, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
  return filePath;
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("telemetry identity", (it) => {
  it.effect(
    "returns null telemetry identity and never reads provider auth files or creates anonymous-id",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = path.join(config.baseDir, "home");

        yield* writeHomeFile(
          homeDirectory,
          ".codex/auth.json",
          JSON.stringify({
            tokens: {
              account_id: "team-workspace",
              id_token: unsignedJwt({
                "https://api.openai.com/auth": { user_id: "user-openai-person" },
              }),
            },
          }),
        );
        yield* writeHomeFile(
          homeDirectory,
          ".claude.json",
          JSON.stringify({
            userID: "claude-machine",
            oauthAccount: { accountUuid: "claude-person" },
          }),
        );

        const readPaths: Array<string> = [];
        const spyFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readFile: (filePath) => {
            readPaths.push(filePath);
            return fileSystem.readFile(filePath);
          },
          readFileString: (filePath, encoding) => {
            readPaths.push(filePath);
            return fileSystem.readFileString(filePath, encoding);
          },
        });

        const identity = yield* Identify.getTelemetryIdentityForHome(homeDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, spyFileSystem),
        );
        assert.deepEqual(identity, { distinctId: null, installId: null });
        assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
        assert.deepEqual(readPaths, []);

        yield* fileSystem.writeFileString(config.anonymousIdPath, "persisted-anonymous-id");
        const identityWithExisting = yield* Identify.getTelemetryIdentityForHome(
          homeDirectory,
        ).pipe(Effect.provideService(FileSystem.FileSystem, spyFileSystem));
        assert.deepEqual(identityWithExisting, { distinctId: null, installId: null });
        assert.deepEqual(yield* Identify.getTelemetryIdentity, {
          distinctId: null,
          installId: null,
        });
        assert.deepEqual(readPaths, []);
      }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-disabled-"))),
  );

  it.effect(
    "returns empty server owners and never reads Connect or provider credential files",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = path.join(config.baseDir, "home");

        yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("user_connect"));
        yield* writeHomeFile(
          homeDirectory,
          ".codex/auth.json",
          JSON.stringify({
            tokens: {
              account_id: "team-workspace",
              id_token: unsignedJwt({
                "https://api.openai.com/auth": { user_id: "user-openai-person" },
              }),
            },
          }),
        );
        yield* writeHomeFile(
          homeDirectory,
          ".claude.json",
          JSON.stringify({
            userID: "claude-machine",
            oauthAccount: { accountUuid: "claude-person" },
          }),
        );

        const readPaths: Array<string> = [];
        const spyFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readFile: (filePath) => {
            readPaths.push(filePath);
            return fileSystem.readFile(filePath);
          },
          readFileString: (filePath, encoding) => {
            readPaths.push(filePath);
            return fileSystem.readFileString(filePath, encoding);
          },
        });

        const owners = yield* Identify.getServerOwnersForHome(homeDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, spyFileSystem),
        );
        assert.deepEqual(owners, []);
        assert.deepEqual(yield* Identify.getServerOwners, []);
        assert.deepEqual(readPaths, []);
      }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-owners-disabled-"))),
  );

  it("still decodes OpenAI user_id purely in memory", () => {
    const token = unsignedJwt({
      "https://api.openai.com/auth": { user_id: "user-openai-person" },
    });
    assert.deepEqual(Identify.openAiUserId(token), Option.some("user-openai-person"));
  });
});
