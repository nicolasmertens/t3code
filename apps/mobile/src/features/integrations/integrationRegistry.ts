import type { Action } from "expo-quick-actions";
import { msg } from "gt-react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { m } from "../../i18n/messages";

export const DISCUSS_EMAILS_INTEGRATION_ID = "discuss-emails";
export const DISCUSS_EMAILS_HREF = "/new/discuss-emails";
export const TALK_TO_FLEET_INTEGRATION_ID = "talk-to-fleet";
export const TALK_TO_FLEET_HREF = "/talk-to-fleet";

export type IntegrationSurface = "iosQuickAction" | "homeStrip" | "newTask" | "commandPalette";

export interface BrowneIntegrationDefinition {
  readonly id: string;
  readonly title: () => string;
  readonly shortTitle: () => string;
  readonly subtitle: () => string;
  readonly icon: AppSymbolName;
  readonly quickActionIcon: Action["icon"];
  readonly href: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly surfaces: {
    readonly iosQuickAction: boolean;
    readonly homeStrip: boolean;
    readonly newTask: boolean;
    readonly commandPalette: boolean;
    readonly iosOnly?: boolean;
  };
}

/**
 * Central registry for Browne integrations and one-tap entry points.
 * Adding a new integration here surfaces it across iOS Quick Actions,
 * Home quick-launch pills, New Task, and the Command Palette.
 */
export const BROWNE_INTEGRATIONS: ReadonlyArray<BrowneIntegrationDefinition> = [
  {
    id: DISCUSS_EMAILS_INTEGRATION_ID,
    title: () => m(msg("Discuss emails")),
    shortTitle: () => m(msg("Emails")),
    subtitle: () => m(msg("Urgent & important mail")),
    icon: "envelope.badge",
    quickActionIcon: "symbol:envelope.badge.fill",
    href: DISCUSS_EMAILS_HREF,
    searchTerms: ["email", "emails", "mail", "inbox", "godwit", "postroom", "triage", "urgent"],
    surfaces: {
      iosQuickAction: true,
      homeStrip: true,
      newTask: true,
      commandPalette: true,
    },
  },
  {
    id: TALK_TO_FLEET_INTEGRATION_ID,
    title: () => m(msg("Talk to Fleet")),
    shortTitle: () => m(msg("Talk to Fleet")),
    subtitle: () => m(msg("Live voice")),
    icon: { ios: "waveform", android: "chat" },
    quickActionIcon: "symbol:waveform",
    href: TALK_TO_FLEET_HREF,
    searchTerms: ["talk", "fleet", "voice", "call", "speak"],
    surfaces: {
      iosQuickAction: true,
      homeStrip: true,
      newTask: true,
      commandPalette: true,
      iosOnly: true,
    },
  },
];

export function visibleIntegrationsForSurface(
  surface: IntegrationSurface,
  platformOs: string,
): ReadonlyArray<BrowneIntegrationDefinition> {
  return BROWNE_INTEGRATIONS.filter(
    (integration) =>
      integration.surfaces[surface] && (!integration.surfaces.iosOnly || platformOs === "ios"),
  );
}

export function filterIntegrationsByQuery(
  integrations: ReadonlyArray<BrowneIntegrationDefinition>,
  query: string,
): ReadonlyArray<BrowneIntegrationDefinition> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return integrations;
  }

  return integrations.filter((integration) => {
    const haystack = [
      integration.id,
      integration.title(),
      integration.shortTitle(),
      integration.subtitle(),
      ...integration.searchTerms,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
