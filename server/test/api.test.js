import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}/api`;
/* Each run gets its own PGlite directory — a real Postgres, in-process, so
   the tests exercise the same SQL that Supabase will. Set DATABASE_URL to
   point the suite at a real Postgres instead. */
const dbDir = path.join(os.tmpdir(), `doorstep-test-${process.pid}`);
const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));

let server;

async function call(pathname, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const signIn = async (email, password) =>
  (await call("/auth/signin", { method: "POST", body: { email, password } })).body.token;

/* A fresh signup geocodes against postcodes.io, so tests lean on the seeded
   accounts wherever the network isn't the thing under test. */
const newNeighbour = async (name) =>
  (
    await call("/auth/signup", {
      method: "POST",
      body: { name, email: `t${Date.now()}${Math.round(performance.now())}@test.uk`, postcode: "E8 3EP", password: "password99" },
    })
  ).body.token;

before(async () => {
  server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PGLITE_DIR: dbDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  /* PGlite has to boot Postgres in WASM and run the schema, so allow longer */
  for (let i = 0; i < 160; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("test server never came up");
});

after(() => {
  server.kill();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {}
});

test("the seeded demo account signs in and a wrong password does not", async () => {
  const ok = await call("/auth/signin", { method: "POST", body: { email: "demo@doorstep.uk", password: "doorstep123" } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.token, /^[0-9a-f]{64}$/);

  const bad = await call("/auth/signin", { method: "POST", body: { email: "demo@doorstep.uk", password: "wrong" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.field, "password");
});

test("signup refuses a duplicate email", async () => {
  const res = await call("/auth/signup", {
    method: "POST",
    body: { name: "Impostor", email: "demo@doorstep.uk", postcode: "E8 3EP", password: "password99" },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.field, "email");
});

test("signup rejects a malformed postcode and a short password", async () => {
  const pc = await call("/auth/signup", {
    method: "POST",
    body: { name: "A B", email: `pc${Date.now()}@test.uk`, postcode: "NOT A POSTCODE", password: "password99" },
  });
  assert.equal(pc.status, 400);
  assert.equal(pc.body.field, "postcode");

  const pw = await call("/auth/signup", {
    method: "POST",
    body: { name: "A B", email: `pw${Date.now()}@test.uk`, postcode: "E8 3EP", password: "short" },
  });
  assert.equal(pw.status, 400);
  assert.equal(pw.body.field, "password");
});

test("a revoked token stops working", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  assert.equal((await call("/items", { token })).status, 200);
  await call("/auth/signout", { method: "POST", token });
  assert.equal((await call("/items", { token })).status, 401);
});

test("the feed hides addresses and blurs pins until you claim", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const { body } = await call("/items", { token });
  assert.ok(body.items.length >= 8, "seed listings should be live");

  for (const item of body.items) {
    if (item.status === "live" && !item.owner) {
      assert.equal(item.address, undefined, `${item.title} leaked an address`);
      assert.equal(item.lat, Math.round(item.lat * 1000) / 1000, "pin should be snapped to the grid");
    }
    assert.ok(item.giver.name && !item.giver.name.includes(" "), "giver shows a first name only");
  }
});

test("claiming releases the address to the claimer and nobody else", async () => {
  const mine = await signIn("demo@doorstep.uk", "doorstep123");
  const theirs = await newNeighbour("Rival Neighbour");

  const feed = await call("/items", { token: mine });
  const target = feed.body.items.find((i) => i.status === "live" && !i.owner);

  const claimed = await call(`/items/${target.id}/claim`, { method: "POST", token: mine });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.status, "yours");
  assert.ok(claimed.body.address, "the claimer must get the address");

  const raced = await call(`/items/${target.id}/claim`, { method: "POST", token: theirs });
  assert.equal(raced.status, 409, "a second claimer must be turned away");

  const rivalFeed = await call("/items", { token: theirs });
  const sameItem = rivalFeed.body.items.find((i) => i.id === target.id);
  assert.equal(sameItem.status, "taken");
  assert.equal(sameItem.address, undefined, "the address must not leak to others");
});

test("you cannot claim your own listing, and unsafe items never list", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const created = await call("/items", {
    method: "POST",
    token,
    body: { title: "Spare stool", cat: "Furniture", road: "Test Road, E8", address: "1 Test Road, London E8 3EP", spot: "porch" },
  });
  assert.equal(created.status, 201);

  const own = await call(`/items/${created.body.id}/claim`, { method: "POST", token });
  assert.equal(own.status, 400);

  const banned = await call("/items", {
    method: "POST",
    token,
    body: { title: "Britax car seat", cat: "Kids", road: "Test Road, E8", address: "1 Test Road, London E8 3EP" },
  });
  assert.equal(banned.status, 400, "car seats must be refused");
});

test("marking an item collected takes it out of the feed and into the impact figures", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const before = (await call("/impact", { token })).body.you.items;

  const feed = await call("/items", { token });
  const target = feed.body.items.find((i) => i.status === "live" && !i.owner);
  await call(`/items/${target.id}/claim`, { method: "POST", token });
  const done = await call(`/items/${target.id}/collected`, { method: "POST", token });
  assert.equal(done.status, 200);

  const after = await call("/items", { token });
  assert.equal(after.body.items.find((i) => i.id === target.id), undefined, "collected items leave the feed");

  const impact = (await call("/impact", { token })).body.you;
  assert.equal(impact.items, before + 1);
  assert.ok(impact.kg > 0 && impact.avoidedCost > 0);
});

test("a wish notifies the wisher when a match is listed, and only for matches", async () => {
  const watcher = await signIn("demo@doorstep.uk", "doorstep123");
  const giver = await newNeighbour("Nearby Giver");

  const alert = await call("/wishes", { method: "POST", token: watcher, body: { keyword: "wardrobe", cat: "Anything", radius: 2 } });
  assert.equal(alert.status, 201);

  await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Oak wardrobe", note: "Solid", cat: "Furniture", road: "Wilton Way, E8", address: "3 Wilton Way, London E8 3EP", spot: "doorstep" },
  });

  const notes = await call("/notifications", { token: watcher });
  assert.ok(notes.body.notifications.some((n) => n.title === "Oak wardrobe"), "the watcher should be told");
  assert.ok(notes.body.unread > 0);

  const quietBefore = notes.body.notifications.length;
  await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Bag of soil", cat: "Garden", road: "Wilton Way, E8", address: "3 Wilton Way, London E8 3EP", spot: "doorstep" },
  });
  const quietAfter = (await call("/notifications", { token: watcher })).body.notifications.length;
  assert.equal(quietAfter, quietBefore, "a non-matching listing must stay quiet");

  await call(`/wishes/${alert.body.id}`, { method: "DELETE", token: watcher });
  assert.equal((await call("/wishes", { token: watcher })).body.wishes.length, 0);
});

test("an empty wish is refused", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const res = await call("/wishes", { method: "POST", token, body: { keyword: "", cat: "Anything", radius: 1 } });
  assert.equal(res.status, 400);
});

test("the giver's own listing shows its address and a fallback plan", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const created = await call("/items", {
    method: "POST",
    token,
    body: { title: "Folding table", cat: "Furniture", road: "Test Road, E8", address: "9 Test Road, London E8 3EP", spot: "front garden" },
  });
  assert.equal(created.body.owner, true);
  assert.ok(created.body.address, "the giver sees their own address");

  const fallback = await call(`/items/${created.body.id}/fallback`, { token });
  assert.equal(fallback.status, 200);
  const keys = fallback.body.options.map((o) => o.key);
  assert.ok(keys.includes("bhf") && keys.includes("council"));
  assert.ok(keys.indexOf("bhf") < keys.indexOf("council"), "charity should come before the council");
});

test("someone else's listing offers you no fallback plan", async () => {
  const mine = await signIn("demo@doorstep.uk", "doorstep123");
  const feed = await call("/items", { token: mine });
  const notMine = feed.body.items.find((i) => !i.owner);
  const res = await call(`/items/${notMine.id}/fallback`, { token: mine });
  assert.equal(res.status, 404);
});

test("autospec reports whether it is switched on rather than failing", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const status = await call("/autospec/status", { token });
  assert.equal(status.status, 200);
  assert.equal(typeof status.body.configured, "boolean");

  if (!status.body.configured) {
    const attempt = await call("/autospec", { method: "POST", token, body: { photo: "data:image/png;base64,iVBORw0KGgo=" } });
    assert.equal(attempt.status, 503, "without a key it should say so, not crash");
  }
});

test("a listing can carry several photos", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const created = await call("/items", {
    method: "POST",
    token,
    body: { title: "Nest of tables", cat: "Furniture", road: "Test Road, E8", address: "2 Test Road, London E8 3EP", photos: [png, png, png] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.photos.length, 3);
  assert.equal(created.body.photo, png, "the first photo stays the thumbnail");

  const tooMany = await call("/items", {
    method: "POST",
    token,
    body: { title: "Too many", cat: "Furniture", road: "Test Road, E8", address: "2 Test Road, London E8 3EP", photos: Array(6).fill(png) },
  });
  assert.equal(tooMany.status, 400);
});

test("a giver can edit, extend and withdraw a listing, but not once it is claimed", async () => {
  const owner = await signIn("demo@doorstep.uk", "doorstep123");
  const created = await call("/items", {
    method: "POST",
    token: owner,
    body: { title: "Bedside table", cat: "Furniture", road: "Test Road, E8", address: "4 Test Road, London E8 3EP", spot: "porch" },
  });
  const id = created.body.id;

  const edited = await call(`/items/${id}`, { method: "PATCH", token: owner, body: { title: "Oak bedside table", spot: "front garden", extendMinutes: 60 } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, "Oak bedside table");
  assert.equal(edited.body.spot, "front garden");
  assert.ok(edited.body.expiresAt > created.body.expiresAt, "extending should push the window out");

  const claimer = await newNeighbour("Quick Claimer");
  await call(`/items/${id}/claim`, { method: "POST", token: claimer });

  const late = await call(`/items/${id}`, { method: "PATCH", token: owner, body: { title: "Too late" } });
  assert.equal(late.status, 409, "a claimed item is frozen");
  const pull = await call(`/items/${id}`, { method: "DELETE", token: owner });
  assert.equal(pull.status, 409);
});

test("withdrawing a listing takes it out of the feed", async () => {
  const owner = await signIn("demo@doorstep.uk", "doorstep123");
  const created = await call("/items", {
    method: "POST",
    token: owner,
    body: { title: "Ironing board", cat: "Furniture", road: "Test Road, E8", address: "5 Test Road, London E8 3EP" },
  });
  assert.equal((await call(`/items/${created.body.id}`, { method: "DELETE", token: owner })).status, 200);
  const feed = await call("/items", { token: owner });
  assert.equal(feed.body.items.find((i) => i.id === created.body.id), undefined);
});

test("only the owner can edit or withdraw", async () => {
  const owner = await signIn("demo@doorstep.uk", "doorstep123");
  const created = await call("/items", {
    method: "POST",
    token: owner,
    body: { title: "Clothes airer", cat: "Furniture", road: "Test Road, E8", address: "6 Test Road, London E8 3EP" },
  });
  const stranger = await newNeighbour("Nosy Neighbour");
  assert.equal((await call(`/items/${created.body.id}`, { method: "PATCH", token: stranger, body: { title: "Mine now" } })).status, 404);
  assert.equal((await call(`/items/${created.body.id}`, { method: "DELETE", token: stranger })).status, 404);
});

test("three reports hide a listing, and nobody can report twice", async () => {
  const owner = await newNeighbour("Reported Giver");
  const created = await call("/items", {
    method: "POST",
    token: owner,
    body: { title: "Sofa on the kerb", cat: "Furniture", road: "Test Road, E8", address: "7 Test Road, London E8 3EP" },
  });
  const id = created.body.id;

  const first = await newNeighbour("Reporter One");
  const r1 = await call(`/items/${id}/report`, { method: "POST", token: first, body: { reason: "pavement" } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.hidden, false);

  const again = await call(`/items/${id}/report`, { method: "POST", token: first, body: { reason: "pavement" } });
  assert.equal(again.body.alreadyReported, true, "a second report from the same person must not count");

  const second = await newNeighbour("Reporter Two");
  await call(`/items/${id}/report`, { method: "POST", token: second, body: { reason: "pavement" } });
  const third = await newNeighbour("Reporter Three");
  const r3 = await call(`/items/${id}/report`, { method: "POST", token: third, body: { reason: "pavement" } });
  assert.equal(r3.body.hidden, true, "three reports should hide it");

  const watcher = await signIn("demo@doorstep.uk", "doorstep123");
  const feed = await call("/items", { token: watcher });
  assert.equal(feed.body.items.find((i) => i.id === id), undefined, "hidden items leave the feed");

  const ownerFeed = await call("/items", { token: owner });
  assert.ok(ownerFeed.body.items.find((i) => i.id === id), "the giver still sees their own listing");
});

test("you cannot report your own listing, and the reason must be real", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const created = await call("/items", {
    method: "POST",
    token,
    body: { title: "Own listing", cat: "Furniture", road: "Test Road, E8", address: "8 Test Road, London E8 3EP" },
  });
  assert.equal((await call(`/items/${created.body.id}/report`, { method: "POST", token, body: { reason: "unsafe" } })).status, 400);

  const feed = await call("/items", { token });
  const other = feed.body.items.find((i) => !i.owner);
  assert.equal((await call(`/items/${other.id}/report`, { method: "POST", token, body: { reason: "made-up" } })).status, 400);
});

test("holding three items at once is the limit", async () => {
  const giver = await newNeighbour("Bulk Giver");
  const hoarder = await newNeighbour("Eager Claimer");
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const made = await call("/items", {
      method: "POST",
      token: giver,
      body: { title: `Spare chair ${i}`, cat: "Furniture", road: "Test Road, E8", address: `${20 + i} Test Road, London E8 3EP` },
    });
    ids.push(made.body.id);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal((await call(`/items/${ids[i]}/claim`, { method: "POST", token: hoarder })).status, 200);
  }
  const fourth = await call(`/items/${ids[3]}/claim`, { method: "POST", token: hoarder });
  assert.equal(fourth.status, 429, "a fourth simultaneous claim must be refused");
});

test("recently collected items are listed without giving away addresses", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const recent = await call("/items/recent", { token });
  assert.equal(recent.status, 200);
  assert.ok(recent.body.items.length > 0, "the seeded history should show here");
  for (const r of recent.body.items) {
    assert.equal(r.address, undefined);
    assert.ok(r.agoMinutes > 0);
  }
});

test("handing a claim back puts the item straight back in the feed", async () => {
  const claimer = await signIn("demo@doorstep.uk", "doorstep123");
  const feed = await call("/items", { token: claimer });
  const target = feed.body.items.find((i) => i.status === "live" && !i.owner);

  await call(`/items/${target.id}/claim`, { method: "POST", token: claimer });
  const released = await call(`/items/${target.id}/release`, { method: "POST", token: claimer });
  assert.equal(released.status, 200);
  assert.equal(released.body.status, "live", "the item should be claimable again");
  assert.equal(released.body.address, undefined, "the address goes away with the claim");

  const other = await newNeighbour("Second Chance");
  assert.equal((await call(`/items/${target.id}/claim`, { method: "POST", token: other })).status, 200);
});

test("you cannot hand back something that was never yours", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const feed = await call("/items", { token });
  const notMine = feed.body.items.find((i) => i.status === "live" && !i.owner);
  assert.equal((await call(`/items/${notMine.id}/release`, { method: "POST", token })).status, 400);
});

test("blocking a neighbour removes their listings and their alerts", async () => {
  const me = await signIn("demo@doorstep.uk", "doorstep123");
  const nuisance = await newNeighbour("Nuisance Neighbour");

  const listed = await call("/items", {
    method: "POST",
    token: nuisance,
    body: { title: "Suspicious sideboard", cat: "Furniture", road: "Test Road, E8", address: "30 Test Road, London E8 3EP" },
  });
  const giverId = listed.body.giver.id;

  const before = await call("/items", { token: me });
  assert.ok(before.body.items.find((i) => i.id === listed.body.id), "visible before blocking");

  assert.equal((await call(`/users/${giverId}/block`, { method: "POST", token: me })).status, 200);

  const after = await call("/items", { token: me });
  assert.equal(after.body.items.find((i) => i.id === listed.body.id), undefined, "blocked listings disappear");
  assert.ok((await call("/blocks", { token: me })).body.blocked.some((b) => b.id === giverId));

  /* an alert from a blocked neighbour must stay silent */
  const alert = await call("/wishes", { method: "POST", token: me, body: { keyword: "sideboard", cat: "Anything", radius: 2 } });
  const notesBefore = (await call("/notifications", { token: me })).body.notifications.length;
  await call("/items", {
    method: "POST",
    token: nuisance,
    body: { title: "Another sideboard", cat: "Furniture", road: "Test Road, E8", address: "31 Test Road, London E8 3EP" },
  });
  const notesAfter = (await call("/notifications", { token: me })).body.notifications.length;
  assert.equal(notesAfter, notesBefore, "blocked neighbours cannot reach you through alerts");

  await call(`/wishes/${alert.body.id}`, { method: "DELETE", token: me });
  assert.equal((await call(`/users/${giverId}/block`, { method: "DELETE", token: me })).status, 200);
  const unblocked = await call("/items", { token: me });
  assert.ok(unblocked.body.items.find((i) => i.id === listed.body.id), "unblocking brings them back");
});

test("you cannot block yourself", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const me = (await call("/me", { token })).body.user;
  assert.equal((await call(`/users/${me.id}/block`, { method: "POST", token })).status, 400);
});

test("saving an item to the watchlist is reflected in the feed", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const feed = await call("/items", { token });
  const target = feed.body.items.find((i) => !i.owner);
  assert.equal(target.saved, false);

  assert.equal((await call(`/items/${target.id}/save`, { method: "POST", token })).status, 200);
  const after = await call("/items", { token });
  assert.equal(after.body.items.find((i) => i.id === target.id).saved, true);

  await call(`/items/${target.id}/save`, { method: "DELETE", token });
  const cleared = await call("/items", { token });
  assert.equal(cleared.body.items.find((i) => i.id === target.id).saved, false);
});

test("a thank-you can only be sent after collecting, and only once", async () => {
  const giver = await newNeighbour("Kind Giver");
  const taker = await newNeighbour("Grateful Taker");
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Cake tin", cat: "Furniture", road: "Test Road, E8", address: "40 Test Road, London E8 3EP" },
  });
  const id = listed.body.id;

  const early = await call(`/items/${id}/thanks`, { method: "POST", token: taker, body: { token: "brew" } });
  assert.equal(early.status, 400, "no thanks before collecting");

  await call(`/items/${id}/claim`, { method: "POST", token: taker });
  await call(`/items/${id}/collected`, { method: "POST", token: taker });

  assert.equal((await call(`/items/${id}/thanks`, { method: "POST", token: taker, body: { token: "brew" } })).status, 200);
  assert.equal((await call(`/items/${id}/thanks`, { method: "POST", token: taker, body: { token: "brew" } })).status, 409);

  const giverNotes = await call("/notifications", { token: giver });
  assert.ok(giverNotes.body.notifications.some((n) => n.title === "Thank you"), "the giver hears about it");
});

test("the extended banned list catches more than car seats", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  for (const title of ["Kitchen knife set", "Box of fireworks", "Bottle of vodka", "Disposable vapes", "Gift card for Boots"]) {
    const res = await call("/items", {
      method: "POST",
      token,
      body: { title, cat: "Furniture", road: "Test Road, E8", address: "1 Test Road, London E8 3EP" },
    });
    assert.equal(res.status, 400, `${title} should be refused`);
  }
  const fine = await call("/items", {
    method: "POST",
    token,
    body: { title: "Kitchen table", cat: "Furniture", road: "Test Road, E8", address: "1 Test Road, London E8 3EP" },
  });
  assert.equal(fine.status, 201, "ordinary things still list");
});

test("you can export your data and erase your account", async () => {
  const token = await newNeighbour("Departing Neighbour");
  await call("/items", {
    method: "POST",
    token,
    body: { title: "Leaving lamp", cat: "Electricals", road: "Test Road, E8", address: "50 Test Road, London E8 3EP" },
  });

  const dump = await call("/me/export", { token });
  assert.equal(dump.status, 200);
  assert.ok(dump.body.account.email.includes("@"));
  assert.equal(dump.body.listings.length, 1);

  assert.equal((await call("/me", { method: "DELETE", token })).status, 200);
  assert.equal((await call("/items", { token })).status, 401, "the session dies with the account");
});

test("a new wish immediately surfaces things that are already listed", async () => {
  const giver = await newNeighbour("Early Giver");
  const wisher = await newNeighbour("Late Wisher");

  /* listed BEFORE the wish exists — the case that used to be missed */
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Welsh dresser", note: "Solid oak", cat: "Furniture", road: "Test Road, E8", address: "60 Test Road, London E8 3EP" },
  });
  assert.equal(listed.status, 201);

  const wish = await call("/wishes", { method: "POST", token: wisher, body: { keyword: "dresser", cat: "Anything", radius: 2 } });
  assert.equal(wish.status, 201);
  assert.equal(wish.body.alreadyOut, 1, "the wish should find what is already up");

  const notes = await call("/notifications", { token: wisher });
  const hit = notes.body.notifications.find((n) => n.title === "Welsh dresser");
  assert.ok(hit, "the wisher is told about the existing listing");
  assert.match(hit.body, /already up/);
});

test("a wisher is never told twice about the same item", async () => {
  const giver = await newNeighbour("Repeat Giver");
  const wisher = await newNeighbour("Patient Wisher");

  await call("/wishes", { method: "POST", token: wisher, body: { keyword: "bookcase", cat: "Anything", radius: 2 } });
  await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Billy bookcase", cat: "Furniture", road: "Test Road, E8", address: "61 Test Road, London E8 3EP" },
  });
  const first = (await call("/notifications", { token: wisher })).body.notifications.filter((n) => n.title === "Billy bookcase").length;
  assert.equal(first, 1);

  /* a second wish covering the same item must not re-notify for it */
  const second = await call("/wishes", { method: "POST", token: wisher, body: { keyword: "billy", cat: "Anything", radius: 2 } });
  assert.equal(second.status, 201);
  const total = (await call("/notifications", { token: wisher })).body.notifications.filter((n) => n.title === "Billy bookcase").length;
  assert.equal(total, 2, "a different wish may match, but each wish tells you once");

  const again = await call("/wishes", { method: "POST", token: wisher, body: { keyword: "bookcase", cat: "Furniture", radius: 2 } });
  const after = (await call("/notifications", { token: wisher })).body.notifications.filter((n) => n.title === "Billy bookcase").length;
  assert.equal(after, 3);
  assert.ok(again.status === 201);
});

test("your own listings never trigger your own wishes", async () => {
  const token = await newNeighbour("Self Wisher");
  await call("/wishes", { method: "POST", token, body: { keyword: "mirror", cat: "Anything", radius: 5 } });
  await call("/items", {
    method: "POST",
    token,
    body: { title: "Hallway mirror", cat: "Furniture", road: "Test Road, E8", address: "62 Test Road, London E8 3EP" },
  });
  const notes = await call("/notifications", { token });
  assert.equal(notes.body.notifications.filter((n) => n.title === "Hallway mirror").length, 0);
});

test("a giver can see how many neighbours are waiting for something", async () => {
  const wisher = await newNeighbour("Sofa Seeker");
  await call("/wishes", { method: "POST", token: wisher, body: { keyword: "chaise", cat: "Anything", radius: 5 } });

  const giver = await newNeighbour("Sofa Owner");
  const demand = await call("/wishes/demand", { method: "POST", token: giver, body: { title: "Velvet chaise longue", cat: "Furniture" } });
  assert.equal(demand.status, 200);
  assert.ok(demand.body.wishers >= 1, "someone is waiting for it");

  const none = await call("/wishes/demand", { method: "POST", token: giver, body: { title: "Nobody wants this exact thing xyzzy", cat: "Furniture" } });
  assert.equal(none.body.wishers, 0);
});

test("listing something reports how many wishes it satisfied", async () => {
  const wisher = await newNeighbour("Desk Seeker");
  await call("/wishes", { method: "POST", token: wisher, body: { keyword: "trestle", cat: "Anything", radius: 5 } });

  const giver = await newNeighbour("Desk Owner");
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Trestle desk", cat: "Furniture", road: "Test Road, E8", address: "63 Test Road, London E8 3EP" },
  });
  assert.equal(listed.body.wishers, 1, "the giver learns someone was waiting");
});

test("your things splits into what you're collecting, what you have, and what you gave", async () => {
  const giver = await newNeighbour("Stuff Giver");
  const taker = await newNeighbour("Stuff Taker");

  const a = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Coffee table", cat: "Furniture", road: "Test Road, E8", address: "70 Test Road, London E8 3EP", spot: "porch" },
  });
  const b = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Plant pot", cat: "Garden", road: "Test Road, E8", address: "70 Test Road, London E8 3EP" },
  });

  /* one claimed and collected, one still on the go */
  await call(`/items/${a.body.id}/claim`, { method: "POST", token: taker });
  await call(`/items/${a.body.id}/collected`, { method: "POST", token: taker });
  await call(`/items/${b.body.id}/claim`, { method: "POST", token: taker });

  const mine = await call("/me/stuff", { token: taker });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.toCollect.length, 1);
  assert.equal(mine.body.toCollect[0].title, "Plant pot");
  assert.ok(mine.body.toCollect[0].holdEndsAt > Date.now(), "the hold countdown is included");
  assert.ok(mine.body.toCollect[0].address, "you get the address for what you're collecting");

  assert.equal(mine.body.collected.length, 1);
  assert.equal(mine.body.collected[0].title, "Coffee table");
  assert.ok(mine.body.collected[0].collectedAt, "collected items carry the date");
  assert.equal(mine.body.collected[0].thanked, false);

  const theirs = await call("/me/stuff", { token: giver });
  assert.equal(theirs.body.listed.length, 2);
  const states = theirs.body.listed.map((i) => i.state).sort();
  assert.deepEqual(states, ["claimed", "gone"]);
});

test("a saved address prefills the next listing", async () => {
  const token = await newNeighbour("Repeat Giver");
  let me = await call("/me", { token });
  assert.equal(me.body.user.address, null);

  await call("/items", {
    method: "POST",
    token,
    body: { title: "First thing", cat: "Furniture", road: "Mentmore Terrace, E8", address: "9 Mentmore Terrace, London E8 3PH", spot: "porch" },
  });

  me = await call("/me", { token });
  assert.equal(me.body.user.address, "9 Mentmore Terrace, London E8 3PH", "listing remembers the address");
  assert.equal(me.body.user.road, "Mentmore Terrace, E8");
  assert.equal(me.body.user.spot, "porch");

  const edited = await call("/me", { method: "PATCH", token, body: { address: "11 Mentmore Terrace, London E8 3PH", spot: "front garden" } });
  assert.equal(edited.status, 200);
  assert.equal((await call("/me", { token })).body.user.address, "11 Mentmore Terrace, London E8 3PH");

  const bad = await call("/me", { method: "PATCH", token, body: { spot: "the pavement" } });
  assert.equal(bad.status, 400, "the pavement is never an option");
});
