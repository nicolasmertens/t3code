import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

const DEFAULT_DIRECT_APNS_BUNDLE_ID = "com.nicolasmertens.browne";
const DEFAULT_DIRECT_APNS_APP_TITLE = "Browne";

interface DirectApnsEnvSettings {
  readonly keyPath: string;
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly appTitle: string;
}

export interface DirectApnsConfig extends DirectApnsEnvSettings {
  readonly privateKeyPem: string;
}

function readTrimmedEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function parseDirectApnsEnv(
  env: NodeJS.ProcessEnv = process.env,
):
  | { readonly status: "unconfigured" }
  | { readonly status: "incomplete"; readonly missing: ReadonlyArray<string> }
  | { readonly status: "configured"; readonly settings: DirectApnsEnvSettings } {
  const keyPath = readTrimmedEnv(env, "T3CODE_DIRECT_APNS_KEY_PATH");
  const keyId = readTrimmedEnv(env, "T3CODE_DIRECT_APNS_KEY_ID");
  const teamId = readTrimmedEnv(env, "T3CODE_DIRECT_APNS_TEAM_ID");
  const bundleId =
    readTrimmedEnv(env, "T3CODE_DIRECT_APNS_BUNDLE_ID") ?? DEFAULT_DIRECT_APNS_BUNDLE_ID;
  const appTitle =
    readTrimmedEnv(env, "T3CODE_DIRECT_APNS_APP_TITLE") ?? DEFAULT_DIRECT_APNS_APP_TITLE;

  const missing = [
    ...(keyPath ? [] : ["T3CODE_DIRECT_APNS_KEY_PATH"]),
    ...(keyId ? [] : ["T3CODE_DIRECT_APNS_KEY_ID"]),
    ...(teamId ? [] : ["T3CODE_DIRECT_APNS_TEAM_ID"]),
  ];

  if (missing.length === 3) {
    return { status: "unconfigured" };
  }
  if (missing.length > 0) {
    return { status: "incomplete", missing };
  }

  return {
    status: "configured",
    settings: {
      keyPath: keyPath!,
      keyId: keyId!,
      teamId: teamId!,
      bundleId,
      appTitle,
    },
  };
}

export const loadDirectApnsConfig = Effect.fn("directApnsConfig.loadDirectApnsConfig")(function* (
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<DirectApnsConfig | null, never, FileSystem.FileSystem> {
  const parsed = parseDirectApnsEnv(env);
  if (parsed.status === "unconfigured") {
    return null;
  }
  if (parsed.status === "incomplete") {
    yield* Effect.logWarning("Direct APNs disabled: incomplete environment configuration", {
      missing: parsed.missing,
    });
    return null;
  }

  const fs = yield* FileSystem.FileSystem;
  const pemOption = yield* fs.readFileString(parsed.settings.keyPath).pipe(
    Effect.asSome,
    Effect.catch((cause) =>
      Effect.logWarning("Direct APNs disabled: failed to read APNs signing key file", {
        keyPath: parsed.settings.keyPath,
        cause,
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );
  if (Option.isNone(pemOption)) {
    return null;
  }
  const privateKeyPem = pemOption.value.trim();
  if (privateKeyPem.length === 0) {
    yield* Effect.logWarning("Direct APNs disabled: APNs signing key file is empty", {
      keyPath: parsed.settings.keyPath,
    });
    return null;
  }

  return {
    ...parsed.settings,
    privateKeyPem,
  };
});
