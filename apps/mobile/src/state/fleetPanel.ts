import { type PrepareDiscussEmailsInput } from "@t3tools/contracts";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const DISCUSS_EMAILS_TIMEOUT_MS = 15_000;

export const fleetPanelEnvironment = {
  prepareDiscussEmails: createEnvironmentCommand(connectionAtomRuntime, {
    label: "fleet-panel:prepare-discuss-emails",
    execute: (input: PrepareDiscussEmailsInput) =>
      executeConnectedEnvironmentHttpRequest({
        group: "fleetPanel",
        method: "POST",
        url: (urls) => urls.prepareDiscussEmails(),
        timeoutMs: DISCUSS_EMAILS_TIMEOUT_MS,
        request: ({ client, headers }) => client.prepareDiscussEmails({ headers, payload: input }),
      }),
  }),
};
