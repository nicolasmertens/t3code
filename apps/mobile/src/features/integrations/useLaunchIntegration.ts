import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  DISCUSS_EMAILS_INTEGRATION_ID,
  TALK_TO_FLEET_INTEGRATION_ID,
  type BrowneIntegrationDefinition,
} from "./integrationRegistry";
import { discussEmailsLaunchingAtom, launchDiscussEmails } from "../mail/discussEmails";

export function useLaunchIntegration() {
  const navigation = useNavigation();
  const discussEmailsBusy = useAtomValue(discussEmailsLaunchingAtom);

  const launch = (
    integration: BrowneIntegrationDefinition,
    options?: { readonly environmentId?: EnvironmentId },
  ): void => {
    switch (integration.id) {
      case DISCUSS_EMAILS_INTEGRATION_ID:
        void launchDiscussEmails({ environmentId: options?.environmentId });
        return;
      case TALK_TO_FLEET_INTEGRATION_ID:
        navigation.navigate("TalkToFleet");
        return;
      default:
        return;
    }
  };

  const isBusy = (integrationId: string): boolean =>
    integrationId === DISCUSS_EMAILS_INTEGRATION_ID && discussEmailsBusy;

  return { launch, isBusy };
}
