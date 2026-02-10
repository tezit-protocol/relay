/**
 * Welcome Cookie — federation easter egg.
 *
 * When a new peer successfully joins the federation (trust level = "trusted"),
 * the relay delivers a special welcome tez containing the Nestle Toll House
 * chocolate chip cookie recipe. This serves as both a fun easter egg AND
 * a federation smoke test — if the peer can parse the bundle, resolve
 * context items, and interrogate the recipe, the protocol works end-to-end.
 *
 * "If you're reading this, your federation handshake worked. Here's a cookie."
 */

import { randomUUID } from "crypto";
import { getIdentity } from "./identity.js";
import { signRequest } from "./httpSignature.js";
import { createBundle } from "./federationBundle.js";
import { discoverServer } from "./discovery.js";
import { recordAudit } from "./audit.js";

// Issue #11: In-memory dedup to prevent duplicate welcome cookies per server lifetime
const welcomeSentTo = new Set<string>();

const WELCOME_SURFACE = `Welcome to the Tezit Federation! Your handshake worked. We baked you some cookies to celebrate. Interrogate this tez to get the recipe.`;

const WELCOME_CONTEXT_RECIPE = `# Original Nestle Toll House Chocolate Chip Cookies

## History

The chocolate chip cookie was invented in 1938 by Ruth Graves Wakefield at the Toll House Inn in Whitman, Massachusetts. She added chopped up bits from a Nestle semi-sweet chocolate bar into a butter cookie recipe, expecting the chocolate to melt and create an all-chocolate cookie. Instead, the chocolate held its shape, softening to a creamy texture — and the chocolate chip cookie was born.

Ruth's recipe was published in a Boston newspaper and became wildly popular. Nestle struck a deal: they'd print her recipe on their chocolate bar packaging in exchange for a lifetime supply of chocolate.

## The Original Recipe

### Ingredients

- 2 1/4 cups all-purpose flour
- 1 teaspoon baking soda
- 1 teaspoon salt
- 1 cup (2 sticks) butter, softened
- 3/4 cup granulated sugar
- 3/4 cup packed brown sugar
- 1 teaspoon vanilla extract
- 2 large eggs
- 2 cups (12-oz. pkg.) Nestle Toll House Semi-Sweet Chocolate Morsels
- 1 cup chopped nuts (optional)

### Instructions

1. Preheat oven to 375 degrees Fahrenheit.
2. Combine flour, baking soda, and salt in a small bowl.
3. Beat butter, granulated sugar, brown sugar, and vanilla extract in a large mixer bowl until creamy.
4. Add eggs, one at a time, beating well after each addition.
5. Gradually beat in flour mixture.
6. Stir in morsels and nuts.
7. Drop rounded tablespoon of dough onto ungreased baking sheets.
8. Bake for 9 to 11 minutes or until golden brown.
9. Cool on baking sheets for 2 minutes; remove to wire racks to cool completely.

### Yield

Approximately 5 dozen cookies.

## Tips

- Do not overbake. Cookies will look slightly underdone when you remove them.
- For chewier cookies, use more brown sugar than granulated.
- Chilling the dough for 24-36 hours before baking dramatically improves flavor.
- Use parchment paper or silicone baking mats for even browning.`;

const WELCOME_CONTEXT_HANDSHAKE = `# Federation Handshake Confirmation

Your platform completed the Tezit federation handshake. Your discovery document was validated, your Ed25519 public key was registered, and this tez was signed and delivered to prove the protocol works end-to-end.

This bundle is a smoke test:
- If you can read the surface text, your inbox parser works.
- If you can resolve the cookie recipe context, your context loader works.
- If someone can ask "what temperature do I bake at?" and get "375 degrees" with a citation, your TIP implementation is grounded.

Welcome to the network. Now go bake some cookies.

For documentation: https://tezit.com/docs
For the protocol spec: https://tezit.com/protocol`;

/**
 * Send the welcome cookie tez to a newly trusted federation peer.
 * Non-blocking — fires and forgets. Logs success/failure to audit.
 */
export async function sendWelcomeCookie(targetHost: string): Promise<void> {
  // Issue #11: Skip if already sent to this host in current process lifetime
  if (welcomeSentTo.has(targetHost)) return;
  welcomeSentTo.add(targetHost);

  try {
    const identity = getIdentity();

    // Build the welcome tez as a federation bundle
    const tezData = {
      id: `welcome-cookie-${randomUUID().slice(0, 8)}`,
      threadId: null,
      parentTezId: null,
      surfaceText: WELCOME_SURFACE,
      type: "note" as const,
      urgency: "low" as const,
      actionRequested: "Bake cookies. Interrogate this tez to get the recipe.",
      visibility: "dm" as const,
      createdAt: new Date().toISOString(),
    };

    const context = [
      {
        layer: "artifact",
        content: WELCOME_CONTEXT_RECIPE,
        mimeType: "text/markdown" as string | null,
        confidence: 100 as number | null,
        source: "verified" as string | null,
      },
      {
        layer: "background",
        content: WELCOME_CONTEXT_HANDSHAKE,
        mimeType: "text/markdown" as string | null,
        confidence: 100 as number | null,
        source: "verified" as string | null,
      },
    ];

    // Address it to the remote server's generic inbox
    // (no specific user — the server itself is the recipient)
    const bundle = createBundle({
      tez: tezData,
      context,
      from: `relay@${identity.host}`,
      to: [`admin@${targetHost}`],
      identity,
    });

    // Discover remote server's federation inbox
    const remote = await discoverServer(targetHost);
    const inboxUrl = `https://${targetHost}${remote.federationInbox}`;
    const bundleBody = JSON.stringify(bundle);

    // Sign the request
    const signedHeaders = signRequest({
      method: "POST",
      path: remote.federationInbox,
      host: targetHost,
      body: bundleBody,
      privateKeyPem: identity.privateKeyPem,
      keyId: identity.serverId,
    });

    // Deliver
    const response = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signedHeaders,
      },
      body: bundleBody,
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok || response.status === 207) {
      console.log(`Welcome cookie delivered to ${targetHost}`);
      await recordAudit({
        actorUserId: "system",
        action: "federation.sent",
        targetType: "tez",
        targetId: tezData.id,
        metadata: {
          type: "welcome_cookie",
          remoteHost: targetHost,
        },
      });
    } else {
      const errorText = await response.text().catch(() => "Unknown");
      console.warn(`Welcome cookie delivery to ${targetHost} returned ${response.status}: ${errorText}`);
      // Non-fatal — peer may not have admin@ contact yet. That's fine.
    }
  } catch (err) {
    // Non-fatal — log and move on. The peer is trusted regardless.
    console.warn(`Welcome cookie delivery to ${targetHost} failed:`, err instanceof Error ? err.message : err);
  }
}
