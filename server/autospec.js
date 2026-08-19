import Anthropic from "@anthropic-ai/sdk";

/* Photograph → structured listing. The giver confirms; they never type from
   scratch. Matches Olio's AI-assisted listing and goes further: the estimated
   size picks the listing window, which was the long-standing WINDOW_MS issue.

   Runs only when a credential is present. Without one the endpoint reports
   configured:false and the app falls back to the manual form. */

const MODEL = "claude-opus-5";

export const hasCredentials = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
);

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic();
  return client;
};

const SPEC_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short plain name, e.g. 'Pine bookcase'. No marketing words." },
    note: { type: "string", description: "One sentence a neighbour needs: condition, what's included, missing parts." },
    cat: { type: "string", enum: ["Furniture", "Kids", "Garden", "Electricals"] },
    kind: { type: "string", enum: ["bookcase", "toys", "chairs", "garden", "bike", "baby"], description: "Closest glyph" },
    size: { type: "string", enum: ["carry", "two-person", "van"], description: "carry = one person on foot; two-person = awkward but liftable; van = needs a vehicle" },
    hazards: {
      type: "array",
      items: { type: "string", enum: ["upholstery", "electrical", "infant", "glass", "heavy"] },
      description: "Flags that trigger UK-specific safety guidance",
    },
    blocked: { type: "boolean", description: "true only if this is a car seat, cot/crib mattress, medicine, weapon, firework, alcohol, tobacco or similar item that must not be passed on" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["title", "note", "cat", "kind", "size", "hazards", "blocked", "confidence"],
  additionalProperties: false,
};

const SYSTEM = `You describe second-hand household items for Doorstep, a UK neighbour-to-neighbour giveaway app in London.

Write as a neighbour would, in plain British English. The title is what the thing is, not a sales pitch — "Pine bookcase", never "Beautiful vintage bookcase!". The note is one sentence covering condition and anything missing.

Size decides how long the listing runs, so judge it honestly:
- carry: one person can walk it home
- two-person: awkward or heavy, but no vehicle needed
- van: needs a vehicle and a plan

Flag hazards where UK rules apply: upholstery (fire label rules), electrical (untested), infant (baby equipment), glass, heavy.

Set blocked only for items that must never be passed on second-hand: car seats, cot or crib mattresses, medicines, weapons, fireworks, alcohol, tobacco, solvents.

If the photo is unclear, still answer, and set confidence to low.`;

/* size → listing window. Bulky items need longer because collection needs a
   van and a plan; small items go stale if they linger. */
export const WINDOW_BY_SIZE = { carry: 120, "two-person": 180, van: 240 };

export async function specFromPhoto(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(dataUrl || "");
  if (!match) return { ok: false, error: "That photo didn't come through — try taking it again" };

  try {
    const response = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SPEC_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } },
            { type: "text", text: "Describe this item for a Doorstep listing." },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal")
      return { ok: false, error: "We couldn't read that photo — fill the details in yourself" };

    const spec = response.parsed_output;
    if (!spec) return { ok: false, error: "We couldn't read that photo — fill the details in yourself" };

    return { ok: true, spec: { ...spec, windowMinutes: WINDOW_BY_SIZE[spec.size] || 120 } };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError)
      return { ok: false, error: "Photo details are switched off — fill them in yourself" };
    if (e instanceof Anthropic.RateLimitError)
      return { ok: false, error: "Busy right now — fill the details in yourself" };
    return { ok: false, error: "Couldn't read the photo — fill the details in yourself" };
  }
}
