import Anthropic from "@anthropic-ai/sdk";

/* The small AI layer: understanding what a neighbour typed, and suggesting
   what they might say next. Everything here runs on the cheapest model that
   does the job — these are penny tasks, not showpieces — and every caller
   has a graceful path when no credential is present, because the app must
   never need AI, only be quicker with it. */

const MODEL = process.env.AI_MODEL || "claude-haiku-4-5-20251001";

export const aiConfigured = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic();
  return client;
};

/* "a desk under half a mile I can carry home" → filters the feed already
   understands. Also serves the wish list: "something for my toddler to sit
   in at dinner" → keyword "high chair", category Kids. */
const UNDERSTAND_SCHEMA = {
  type: "object",
  properties: {
    keyword: { type: "string", description: "The thing itself, one or two plain words: 'desk', 'high chair', 'moving boxes'. Empty if they only named a category." },
    cat: {
      type: "string",
      enum: ["Anything", "Furniture", "Kids", "Garden", "Electricals", "Bakery", "Fruit & veg", "Dairy", "Store cupboard", "Ready meals", "Drinks"],
    },
    type: { type: "string", enum: ["all", "food", "nonfood"] },
    radiusMiles: { type: "number", description: "Only when they said a distance. 0 when they didn't." },
    carryOnly: { type: "boolean", description: "true when they said carry / on foot / no car" },
  },
  required: ["keyword", "cat", "type", "radiusMiles", "carryOnly"],
  additionalProperties: false,
};

export async function understand(text) {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 1000,
    system:
      "You turn what a London neighbour typed into search filters for a giveaway app. Be literal about distance and category; put the object they want into keyword as the name a listing would use. British English.",
    output_config: { format: { type: "json_schema", schema: UNDERSTAND_SCHEMA } },
    messages: [{ role: "user", content: String(text).slice(0, 300) }],
  });
  return response.parsed_output || null;
}

/* Three things a person in this handover thread would most plausibly say
   next — replacing the fixed quick-reply chips with situational ones. */
const REPLIES_SCHEMA = {
  type: "object",
  properties: {
    replies: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 3,
      description: "Short, warm, plain British English. Under 60 characters each. Practical next sentences, never salesy.",
    },
  },
  required: ["replies"],
  additionalProperties: false,
};

export async function suggestReplies({ role, title, messages }) {
  const transcript = messages
    .slice(-8)
    .map((m) => (m.system ? `[app] ${m.body}` : `${m.mine ? "me" : "them"}: ${m.body}`))
    .join("\n");
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 1000,
    system: `You suggest the next message in a doorstep-collection chat on a London giveaway app. The user is the ${
      role === "giving" ? "giver" : "collector"
    } of "${title}". Suggest what THEY would most usefully say next: arranging times, directions, small warmth. Never invent facts like addresses or times not in the thread.`,
    output_config: { format: { type: "json_schema", schema: REPLIES_SCHEMA } },
    messages: [{ role: "user", content: transcript || "(no messages yet)" }],
  });
  return (response.parsed_output && response.parsed_output.replies) || null;
}

/* Hackney is one of the most multilingual boroughs in Britain, and a free
   sofa is no use to someone who cannot read the sentence arranging its
   collection. This is the smallest possible translator: one message in, one
   message out, no explanation and no embellishment — the neighbour's own
   words, in a language the reader has. */
const TRANSLATE_SCHEMA = {
  type: "object",
  properties: {
    translated: { type: "string", description: "The message rendered in the target language, and nothing else." },
    sourceLanguage: { type: "string", description: "The language the original was written in, as its English name: 'Polish', 'Turkish', 'English'." },
    alreadyTarget: { type: "boolean", description: "true when the original was already in the target language and has simply been echoed back." },
  },
  required: ["translated", "sourceLanguage", "alreadyTarget"],
  additionalProperties: false,
};

export async function translate(text, targetLanguage) {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 1000,
    system:
      `You translate short neighbourly messages about handing over free items in London into ${targetLanguage}. Keep it plain, warm and literal — the register of a text message between two people arranging a doorstep collection. Never add, omit or explain anything, and never answer the message: just translate it. If the text is already in ${targetLanguage}, set alreadyTarget true and echo it back unchanged.`,
    output_config: { format: { type: "json_schema", schema: TRANSLATE_SCHEMA } },
    messages: [{ role: "user", content: String(text).slice(0, 500) }],
  });
  return response.parsed_output || null;
}
