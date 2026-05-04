/**
 * Clear Command Extension
 *
 * Adds a /clear command that starts a fresh session, matching the practical
 * behavior of the built-in /new command through the public extension API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session",
		handler: async (_args, ctx) => {
			const result = await ctx.newSession();

			if (result.cancelled) {
				return;
			}

			// The original command context is stale after a successful session
			// replacement, so intentionally do no further session-bound work here.
		},
	});
}
