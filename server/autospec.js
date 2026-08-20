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

const CANDIDATE = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short plain name, e.g. 'BILLY bookcase' or 'Pine bookcase'. No marketing words." },
    brand: { type: "string", description: "Maker or company if identifiable — 'IKEA', 'Dualit', 'Fisher-Price'. Empty string if unknown." },
    note: { type: "string", description: "One sentence a neighbour needs: what it is, condition seen in the photo, anything missing." },
    cat: { type: "string", enum: ["Furniture", "Kids", "Garden", "Electricals"] },
    kind: { type: "string", enum: ["bookcase", "toys", "chairs", "garden", "bike", "baby"], description: "Closest glyph" },
    size: { type: "string", enum: ["carry", "two-person", "van"], description: "carry = one person on foot; two-person = awkward but liftable; van = needs a vehicle" },
    hazards: {
      type: "array",
      items: { type: "string", enum: ["upholstery", "electrical", "infant", "glass", "heavy"] },
    },
    blocked: { type: "boolean", description: "true only if this is a car seat, cot/crib mattress, medicine, weapon, firework, alcohol, tobacco or similar item that must not be passed on" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    details: {
      type: "object",
      description: "Product facts. From product knowledge when the product is identified; from the photo otherwise. Omit anything unknown.",
      properties: {
        condition: { type: "string", enum: ["New", "As good as new", "Good", "Fair", "Well used"], description: "Judged from the photo" },
        carry: { type: "string", enum: ["One person can carry it", "Two people", "Needs a car or van"] },
        widthCm: { type: "number" },
        depthCm: { type: "number" },
        heightCm: { type: "number" },
        material: { type: "string", enum: ["Wood", "Metal", "Glass", "Fabric", "Plastic", "Mixed", "Terracotta", "Stone"] },
        colour: { type: "string" },
        flatpack: { type: "string", enum: ["Yes, flat packs", "No, one piece"] },
        ages: { type: "string", enum: ["0-1", "1-3", "3-5", "5-8", "8-12", "Any age"] },
        pieces: { type: "string", enum: ["Yes, complete", "Some pieces missing"] },
        washed: { type: "string", enum: ["Yes, cleaned", "Needs a wipe"] },
        works: { type: "string", enum: ["Works fine", "Works, with a fault", "Not working, for parts"] },
        cable: { type: "string", enum: ["Included", "Not included"] },
        age: { type: "string", enum: ["Under a year", "1-3 years", "3-5 years", "Over 5 years"] },
        quantity: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  required: ["title", "brand", "note", "cat", "kind", "size", "hazards", "blocked", "confidence", "details"],
  additionalProperties: false,
};

const SPEC_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: CANDIDATE,
      minItems: 1,
      maxItems: 3,
      description: "Best identification first. A generic fallback last when the exact product is uncertain.",
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

const SYSTEM = `You identify second-hand household items for Doorstep, a UK neighbour-to-neighbour giveaway app in London.

Your job is to name the actual product when you can. If the photo shows an IKEA BILLY bookcase, say so — title "BILLY bookcase", brand "IKEA" — and fill the details from what you know about that product: its width, depth and height in centimetres, its material, whether it flat-packs. Offer up to three candidates, most likely first; when you are not sure of the exact product, make the last candidate a generic honest one ("Pine bookcase", brand empty) with details judged from the photo alone.

Write as a neighbour would, in plain British English. Titles are what the thing is, never a sales pitch. The note is one sentence covering what you can see: condition, anything missing.

Size decides how long the listing runs, so judge it honestly:
- carry: one person can walk it home
- two-person: awkward or heavy, but no vehicle needed
- van: needs a vehicle and a plan

Condition is always judged from the photograph, never from the product identity.

Flag hazards where UK rules apply: upholstery (fire label rules), electrical (untested), infant (baby equipment), glass, heavy.

Set blocked only for items that must never be passed on second-hand: car seats, cot or crib mattresses, medicines, weapons, fireworks, alcohol, tobacco, solvents.

If the photo is unclear, still answer with one generic candidate at low confidence.`;

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

    const parsed = response.parsed_output;
    if (!parsed || !parsed.candidates || !parsed.candidates.length)
      return { ok: false, error: "We couldn't read that photo — fill the details in yourself" };

    /* a blocked item is blocked whichever guess is right */
    const candidates = parsed.candidates.map((c) => ({ ...c, windowMinutes: WINDOW_BY_SIZE[c.size] || 120 }));
    return { ok: true, spec: { ...candidates[0], candidates } };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError)
      return { ok: false, error: "Photo details are switched off — fill them in yourself" };
    if (e instanceof Anthropic.RateLimitError)
      return { ok: false, error: "Busy right now — fill the details in yourself" };
    return { ok: false, error: "Couldn't read the photo — fill the details in yourself" };
  }
}
