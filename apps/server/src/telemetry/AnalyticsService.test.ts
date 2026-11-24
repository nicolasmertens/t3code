import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect(
  "is a pure no-op and makes zero HTTP requests even when telemetry env vars are enabled",
  () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requestCount += 1;
        }).pipe(Effect.andThen(Effect.die(new Error(`Unexpected HTTP request to ${request.url}`)))),
      );
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3CODE_TELEMETRY_ENABLED: true,
              T3CODE_POSTHOG_KEY: "phc_test_key",
              T3CODE_POSTHOG_HOST: "https://ingest.example.test",
            }),
          ),
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      );

      const recorded = yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const accepted = yield* analytics.record("server.boot.heartbeat", {
          threadCount: 1,
          projectCount: 1,
        });
        yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        yield* analytics.flush;
        return accepted;
      }).pipe(Effect.provide(runtimeLayer));

      assert.isFalse(recorded);
      assert.equal(requestCount, 0);
    }),
);
