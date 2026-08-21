import { query } from "./db.js";

/* Diversion reporting — the thing councils actually buy. Essex County Council
   funds Freegle in exchange for exactly this: items, tonnage, CO2 and avoided
   disposal cost, broken down by area.

   Every constant below is now a published figure with a source. Nothing here
   is invented.

   WEIGHTS — Merseyside Recycling & Waste Authority's approved average weights
     of materials, calculated with the Furniture Re-use Network. The Reuse
     Network's successor Product Weight Protocol is paywalled (£360+VAT/yr),
     so the MRWA/FRN list is the citable public equivalent.
       Furniture   35 kg  (mean of 45 listed items; median 30)
       Kids        11 kg  (cot 16, pram 14, highchair 13, box of toys 11)
       Garden      11 kg  (garden table 20, BBQ 15, chair 7, small tool 1)
       Electricals  2 kg  (the PWP "small item" class: kettle, toaster, lamp)

   CO2 — Freegle's published blended factor of 0.51 tonnes CO2e avoided per
     tonne reused, which they derive by running FRN weights through WRAP's
     Benefits of Reuse tool. It is internally consistent across four of their
     published datasets (national, Essex x2, Cumbria) and is the conservative
     choice: WRAP's 2024 BOR3 tables give substantially higher numbers
     (furniture 0.456 t/t and home electricals 1.347 t/t against
     business-as-usual). One methodology, stated plainly, beats a flattering
     mixture — so this stays until per-category WRAP factors replace it
     wholesale. WRAP publishes no factor at all for toys or garden items.

   DISPOSAL — WRAP UK Gate Fees 2025-26: non-hazardous landfill £34/tonne
     median plus £126.15/tonne landfill tax (from 1 April 2025) = £160.15.
     Freegle's own council reporting uses £120-160/tonne avoided, so this sits
     at the top of a range they already put in front of councils.

   CREDIT — £71.16/tonne, Merseyside R&WA's 2025/26 recycling credit rate,
     consistent to four significant figures across all five districts. Shown
     separately because claiming it needs a charity or CIC vehicle. */

const KG_PER_ITEM = { Furniture: 35, Kids: 11, Garden: 11, Electricals: 2 };
const DEFAULT_KG = 22.9; /* Freegle: 14,000 items ≈ 320 tonnes */
const CO2E_PER_KG = 0.51;
const DISPOSAL_COST_PER_TONNE = 160.15;
const RECYCLING_CREDIT_PER_TONNE = 71.16;

/* The same published weights, lent out. Anywhere else in the app that wants
   to say "that is roughly this many kilos" must borrow this rather than
   invent an average of its own — two different numbers for the same pile of
   furniture is how a diversion report stops being citable. */
export const kgForCat = (cat) => KG_PER_ITEM[cat] || DEFAULT_KG;

export const IMPACT_CAVEAT =
  "Weights: MRWA/Furniture Re-use Network approved averages. CO2: Freegle's published 0.51 tCO2e per tonne reused (WRAP Benefits of Reuse tool). Disposal: WRAP Gate Fees 2025-26, landfill £34/t plus £126.15/t landfill tax.";

const round = (n, dp = 1) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export async function impactFor({ userId = null, since = 0 } = {}) {
  const where = userId
    ? "collected_at IS NOT NULL AND collected_at > $1 AND (owner_id = $2 OR claimed_by = $2)"
    : "collected_at IS NOT NULL AND collected_at > $1";
  const params = userId ? [since, userId] : [since];

  const rows = await query(`SELECT cat, postcode FROM items WHERE ${where}`, params);

  let kg = 0;
  const byDistrict = new Map();
  for (const r of rows) {
    const itemKg = KG_PER_ITEM[r.cat] || DEFAULT_KG;
    kg += itemKg;
    /* postcode district — "E8 3PA" → "E8", the unit councils report on */
    const district = (r.postcode || "").trim().split(/\s+/)[0] || "unknown";
    const d = byDistrict.get(district) || { district, items: 0, kg: 0 };
    d.items += 1;
    d.kg += itemKg;
    byDistrict.set(district, d);
  }

  const tonnes = kg / 1000;
  return {
    items: rows.length,
    kg: round(kg),
    tonnes: round(tonnes, 3),
    kgCo2e: round(kg * CO2E_PER_KG),
    avoidedCost: round(tonnes * DISPOSAL_COST_PER_TONNE, 2),
    creditValue: round(tonnes * RECYCLING_CREDIT_PER_TONNE, 2),
    byDistrict: [...byDistrict.values()].map((d) => ({ ...d, kg: round(d.kg) })).sort((a, b) => b.items - a.items),
    caveat: IMPACT_CAVEAT,
  };
}
