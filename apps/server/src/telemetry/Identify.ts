import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// `sub` names the login method (`google-oauth2|…`), so one person can have several.
// `user_id` (`user-…`) is the OpenAI account and is the same for every login.
const IdTokenClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({ user_id: Schema.NonEmptyString }),
});
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims));

/**
 * Who an install belongs to, from strongest to weakest. `connect` is the T3
 * Connect account. `openai` and `claude` are provider accounts. `device` is a
 * client device that connected.
 */
export const TelemetryOwnerSource = Schema.Literals(["connect", "openai", "claude", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  /** `hashTelemetryId` of the source's raw id. */
  readonly ownerId: string;
}

export const TelemetryIdentitySource = Schema.Literals(["codex", "claude", "anonymous"]);
export type TelemetryIdentitySource = typeof TelemetryIdentitySource.Type;

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

/**
 * The OpenAI account id in a ChatGPT id_token, read without verifying it.
 */
export const openAiUserId = (idToken: string) => {
  const payload = Base64Url.decodeString(idToken.split(".")[1] ?? "");
  return Result.isSuccess(payload)
    ? Option.map(
        decodeIdTokenClaims(payload.success),
        (claims) => claims["https://api.openai.com/auth"].user_id,
      )
    : Option.none<string>();
};

export const getTelemetryIdentityForHome = (
  _homeDirectory: string,
): Effect.Effect<{ readonly distinctId: string | null; readonly installId: string | null }> =>
  Effect.succeed({ distinctId: null, installId: null });

export const getTelemetryIdentity: Effect.Effect<{
  readonly distinctId: string | null;
  readonly installId: string | null;
}> = Effect.succeed({ distinctId: null, installId: null });

export const getServerOwnersForHome = (
  _homeDirectory: string,
): Effect.Effect<ReadonlyArray<TelemetryOwner>> => Effect.succeed([]);

export const getServerOwners: Effect.Effect<ReadonlyArray<TelemetryOwner>> = Effect.succeed([]);
