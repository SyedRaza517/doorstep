/* Does a listing answer a wish?
 *
 * The first version asked whether the wish's words appeared inside the
 * listing's words, which is a thin kind of understanding: someone wishing
 * for a "bookcase" heard nothing about the "Pine shelving unit" two streets
 * away, and "high chair" missed every "highchair" ever listed. The wish list
 * is this app's best feature; a matcher that only recognises its own spelling
 * wastes it.
 *
 * So: words are compared rather than characters, simple plurals are folded
 * together, spaces are ignored where English can't make up its mind
 * (highchair, high chair), and a small hand-written map carries the everyday
 * synonyms of a British household. No model, no network, no cost — just the
 * vocabulary people actually use on a doorstep. */

/* Each line is a family of words that mean the same thing to a neighbour.
   Kept deliberately small and concrete: guessing widely would tell people
   about things they never asked for, which is worse than silence. */
const FAMILIES = [
  ["bookcase", "bookshelf", "shelving", "shelves", "shelf", "bookshelves"],
  ["sofa", "settee", "couch"],
  ["armchair", "chair"],
  ["highchair", "high chair", "feeding chair"],
  ["pushchair", "buggy", "stroller", "pram"],
  ["bike", "bicycle", "cycle"],
  ["cot", "crib"],
  ["wardrobe", "closet"],
  ["chest of drawers", "drawers", "dresser"],
  ["rug", "carpet"],
  ["lamp", "light", "lighting"],
  ["television", "tv", "telly"],
  ["fridge", "refrigerator"],
  ["washing machine", "washer"],
  ["hoover", "vacuum"],
  ["pot", "planter", "plant pot"],
  ["plant", "houseplant", "seedling"],
  ["desk", "table"],
  ["toy", "toys", "games", "game"],
  ["mirror", "looking glass"],
  ["box", "boxes", "crate", "crates"],
  ["jar", "jars"],
  ["kettle", "boiler"],
  ["duvet", "quilt", "bedding"],
  ["pushbike", "bike"],
];

/* word → the family it belongs to, built once */
const FAMILY_OF = new Map();
for (const family of FAMILIES) {
  const key = family[0];
  for (const word of family) FAMILY_OF.set(word.replace(/\s+/g, ""), key);
}

const clean = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* "boxes" and "box" are the same request; anything shorter than four letters
   is left alone, because "gas" is not the plural of "ga" */
function singular(word) {
  if (word.length < 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("hes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/* every form a word might reasonably be written in */
function formsOf(word) {
  const base = singular(word);
  const forms = new Set([word, base]);
  const family = FAMILY_OF.get(base) || FAMILY_OF.get(word);
  if (family) {
    forms.add(family);
    for (const [member, key] of FAMILY_OF) if (key === family) forms.add(member);
  }
  return forms;
}

/* Does this listing answer this keyword? Every word of the wish must be
   recognisable in the listing — all of them, so "kids bike" doesn't match a
   grown-up's bike, but each may arrive spelled its own way. */
export function keywordMatches(keyword, haystack) {
  const wanted = clean(keyword);
  if (!wanted) return true;

  const text = clean(haystack);
  if (!text) return false;

  /* the spaceless comparison catches the words English cannot settle on */
  const squashedText = text.replace(/\s/g, "");
  if (squashedText.includes(wanted.replace(/\s/g, ""))) return true;

  const textForms = new Set();
  for (const word of text.split(" ")) for (const form of formsOf(word)) textForms.add(form.replace(/\s+/g, ""));

  return wanted.split(" ").every((word) => {
    for (const form of formsOf(word)) if (textForms.has(form.replace(/\s+/g, ""))) return true;
    /* a long word may still be a prefix of the listing's word: "shelv" of
       "shelving" — but never the other way round, and never for short words */
    return word.length >= 5 && squashedText.includes(word);
  });
}
