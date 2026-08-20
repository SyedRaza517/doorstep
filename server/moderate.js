import Anthropic from "@anthropic-ai/sdk";

/* Safety moderation at listing time. The regex layer in index.js catches the
   words we already know about; this catches what a regex can't — "Britax
   Römer for the little one" never says "car seat", but a model knows what it
   is. Runs between the regex checks and the INSERT, and only when a
   credential is present, so a bare install still works exactly as before.

   Haiku, not Opus: this runs on every single listing, so it has to be the
   cheap fast model — the judgement required is "is this a car seat", not
   "identify this exact product". */

const MODEL = process.env.AI_MODEL || "claude-haiku-4-5-20251001";

export const hasCredentials = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
);

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic();
  return client;
};

/* Three verdicts, because there are two very different kinds of wrong:
   "block" is for things that must never change hands and stops the listing
   with a reason the lister reads; "review" is for things that are probably
   fine but worth a second look — those go live untouched and only leave an
   audit trail, because false positives on launch day cost more trust than
   the occasional odd listing. */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["fine", "block", "review"] },
    reason: {
      type: "string",
      description:
        "One plain sentence shown to the lister when blocked, e.g. \"Car seats can't be passed on second-hand because crash damage is invisible.\" Empty string when the verdict is fine.",
    },
    category: {
      type: "string",
      enum: [
        "banned-item",
        "weapon",
        "medicine",
        "alcohol-tobacco",
        "recalled-safety",
        "food-safety",
        "not-a-giveaway",
        "misleading-photo",
        "abuse",
        "other",
        "none",
      ],
    },
  },
  required: ["verdict", "reason", "category"],
  additionalProperties: false,
};

const SYSTEM = `You are the safety check for Doorstep, a UK neighbour-to-neighbour giveaway app. Everything on Doorstep is given away free between neighbours. Judge whether one listing is safe to go live.

Verdict "block" — things that must never be passed on second-hand or don't belong here at all: car seats and booster seats, cot or crib mattresses, medicines of any kind, weapons and knives, fireworks, alcohol, tobacco, vapes and nicotine products, solvents, recalled baby equipment, live animals, anything being sold rather than given away, and clearly abusive or sexual content. When you block, write the reason as one plain sentence the lister will read.

Verdict "review" — probably fine, but worth a second look: the photo plainly contradicts the title, food listings whose text suggests the item is past its use-by or was handled unsafely (raw meat, cooked rice held at room temperature), or what looks like commercial dumping dressed up as a giveaway.

Verdict "fine" — everything else. Be honest and unfussy: this is neighbours passing on household things, and a scuffed sofa, a well-used toy or a wonky bookcase is exactly what the app is for. Do not block or flag things for being old, worn or unglamorous.`;

/* Same data-URL shape autospec accepts: only formats the API takes, and the
   base64 payload separated from its media type in one pass. */
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/;

export async function checkListing({ title, note, type, photo }) {
  const content = [];
  const match = DATA_URL_RE.exec(photo || "");
  if (match)
    content.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
  content.push({
    type: "text",
    text: `Listing type: ${type === "food" ? "food" : "non-food"}\nTitle: ${title}\nNote: ${note || "(none)"}`,
  });

  try {
    const response = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      messages: [{ role: "user", content }],
    });

    /* a refusal is the model declining to look, not a judgement on the
       listing — treat it the same as any other failure below */
    if (response.stop_reason === "refusal") return { verdict: "fine", degraded: true };

    const parsed = response.parsed_output;
    if (!parsed || !["fine", "block", "review"].includes(parsed.verdict))
      return { verdict: "fine", degraded: true };
    return { verdict: parsed.verdict, reason: parsed.reason || "", category: parsed.category || "none" };
  } catch {
    /* On ANY error — bad key, rate limit, network down — the answer is
       "fine": moderation must never stop a neighbourhood from sharing. The
       regex layer already caught the hard bans before we were called, so
       failing open here only loses the subtle cases, never the known ones. */
    return { verdict: "fine", degraded: true };
  }
}
