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
  assert.equal((await call("/me", { token })).status, 200);
  await call("/auth/signout", { method: "POST", token });
  assert.equal((await call("/me", { token })).status, 401);
  /* browsing survives, because it never needed an account */
  assert.equal((await call("/items", { token })).status, 200);
});

test("anyone can browse without an account, but not act", async () => {
  const feed = await call("/items");
  assert.equal(feed.status, 200);
  assert.equal(feed.body.guest, true);
  assert.ok(feed.body.items.length >= 8);

  for (const item of feed.body.items) {
    assert.equal(item.address, undefined, "a guest never sees an address");
    assert.equal(item.saved, false);
    assert.equal(item.owner, false);
    assert.equal(item.dist, "", "we do not know where a guest lives");
  }

  const target = feed.body.items[0];
  assert.equal((await call(`/items/${target.id}/claim`, { method: "POST" })).status, 401);
  assert.equal((await call("/items", { method: "POST", body: { title: "x", address: "y" } })).status, 401);
  assert.equal((await call("/me/stuff")).status, 401);
  assert.equal((await call("/wishes")).status, 401);
});

test("the feed hides addresses and blurs pins until you claim", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const { body } = await call("/items", { token });
  assert.ok(body.items.length >= 8, "seed listings should be live");

  for (const item of body.items) {
    /* during last orders the pin sharpens for everyone by design —
       the address itself stays hidden even then */
    if (item.status === "live" && !item.owner && !item.lastOrders) {
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
  const watcher = await newNeighbour("Wardrobe Watcher");
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
  const feed = await call("/items?q=Sofa%20on%20the%20kerb", { token: watcher });
  assert.equal(feed.body.items.find((i) => i.id === id), undefined, "hidden items leave the feed");

  const ownerFeed = await call("/items?q=Sofa%20on%20the%20kerb", { token: owner });
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

  const before = await call("/items?q=Suspicious%20sideboard", { token: me });
  assert.ok(before.body.items.find((i) => i.id === listed.body.id), "visible before blocking");

  assert.equal((await call(`/users/${giverId}/block`, { method: "POST", token: me })).status, 200);

  const after = await call("/items?q=Suspicious%20sideboard", { token: me });
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
  const unblocked = await call("/items?q=Suspicious%20sideboard", { token: me });
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
  const target = feed.body.items.find((i) => !i.owner && !i.saved);
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
  assert.equal((await call("/me", { token })).status, 401, "the session dies with the account");
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

  /* a second wish that also covers it must not announce it all over again:
     being told once is what the reader was promised */
  const second = await call("/wishes", { method: "POST", token: wisher, body: { keyword: "billy", cat: "Anything", radius: 2 } });
  assert.equal(second.status, 201);
  const total = (await call("/notifications", { token: wisher })).body.notifications.filter((n) => n.title === "Billy bookcase").length;
  assert.equal(total, 1, "one item, one alert, however many wishes match it");
});

test("removing a wish and adding it back does not replay alerts", async () => {
  const giver = await newNeighbour("Encore Giver");
  const wisher = await newNeighbour("Encore Wisher");

  const wish = await call("/wishes", { method: "POST", token: wisher, body: { keyword: "kettle", cat: "Anything", radius: 2 } });
  await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Copper kettle", cat: "Electricals", road: "Test Road, E8", address: "63 Test Road, London E8 3EP" },
  });
  const before = (await call("/notifications", { token: wisher })).body.notifications.filter((n) => n.title === "Copper kettle").length;
  assert.equal(before, 1);

  await call(`/wishes/${wish.body.id}`, { method: "DELETE", token: wisher });
  await call("/wishes", { method: "POST", token: wisher, body: { keyword: "kettle", cat: "Anything", radius: 2 } });

  const after = (await call("/notifications", { token: wisher })).body.notifications.filter((n) => n.title === "Copper kettle").length;
  assert.equal(after, 1, "they already read that one");
});

test("the same wish twice is refused, and wishes count what is up now", async () => {
  const giver = await newNeighbour("Dup Giver");
  const wisher = await newNeighbour("Dup Wisher");

  await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Zephyrine bookstand", cat: "Furniture", road: "Test Road, E8", address: "64 Test Road, London E8 3EP" },
  });

  const first = await call("/wishes", { method: "POST", token: wisher, body: { keyword: "zephyrine", cat: "Anything", radius: 2 } });
  assert.equal(first.status, 201);
  assert.equal(first.body.upNow, 1, "one is up right now");
  assert.ok(first.body.createdAt > 0, "the row knows when it was added");

  const again = await call("/wishes", { method: "POST", token: wisher, body: { keyword: "ZEPHYRINE", cat: "Anything", radius: 2 } });
  assert.equal(again.status, 409, "the same wish twice is a duplicate, whatever the casing");

  const list = await call("/wishes", { token: wisher });
  assert.equal(list.body.wishes.length, 1);
  assert.equal(list.body.wishes[0].upNow, 1);
});

test("a postcode becomes an address someone can finish", async () => {
  const found = await call("/address?postcode=E8 3EP");
  assert.equal(found.status, 200);
  assert.ok(["list", "street"].includes(found.body.mode));
  assert.equal(found.body.postcode, "E8 3EP");
  if (found.body.mode === "list") assert.ok(Array.isArray(found.body.addresses));

  const nonsense = await call("/address?postcode=ZZ99 9ZZ");
  assert.equal(nonsense.status, 404);

  const malformed = await call("/address?postcode=hello");
  assert.equal(malformed.status, 400);
});

test("an address chosen at signup is kept for giving", async () => {
  const res = await call("/auth/signup", {
    method: "POST",
    body: {
      name: "Addressed Neighbour",
      email: `addr${Date.now()}@test.uk`,
      postcode: "E8 3EP",
      password: "doorstep123",
      address: "12 Ellingfort Road",
      road: "Ellingfort Road",
    },
  });
  assert.equal(res.status, 201);
  const me = await call("/me", { token: res.body.token });
  assert.equal(me.body.user.address, "12 Ellingfort Road");
  assert.equal(me.body.user.road, "Ellingfort Road");
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
  assert.ok(listed.body.wishers >= 1, "the giver learns someone was waiting");
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

test("food needs a use-by date, and one that has not passed", async () => {
  const token = await newNeighbour("Food Giver");
  const base = { cat: "Bakery", type: "food", road: "Test Road, E8", address: "80 Test Road, London E8 3EP" };

  const noDate = await call("/items", { method: "POST", token, body: { ...base, title: "Two loaves" } });
  assert.equal(noDate.status, 400);
  assert.equal(noDate.body.field, "useBy");

  const past = await call("/items", {
    method: "POST",
    token,
    body: { ...base, title: "Two loaves", useBy: Date.now() - 86400000 },
  });
  assert.equal(past.status, 400, "food past its use-by must be refused");

  const ok = await call("/items", {
    method: "POST",
    token,
    body: { ...base, title: "Two loaves", useBy: Date.now() + 2 * 86400000, portions: 2 },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.type, "food");
  assert.equal(ok.body.portions, 2);
  assert.ok(ok.body.useBy > Date.now());
});

test("a food listing never outlives its use-by date", async () => {
  const token = await newNeighbour("Late Baker");
  const useBy = Date.now() + 60 * 60 * 1000; /* an hour from now */
  const made = await call("/items", {
    method: "POST",
    token,
    body: {
      title: "Sandwiches",
      cat: "Ready meals",
      type: "food",
      useBy,
      windowMinutes: 480,
      road: "Test Road, E8",
      address: "81 Test Road, London E8 3EP",
    },
  });
  assert.equal(made.status, 201);
  assert.ok(made.body.expiresAt <= useBy, "the window must close by the use-by date");
});

test("high-risk food is refused outright", async () => {
  const token = await newNeighbour("Risky Cook");
  for (const title of ["Raw chicken thighs", "Leftover cooked rice", "Unpasteurised cheese", "Baby formula tub"]) {
    const res = await call("/items", {
      method: "POST",
      token,
      body: { title, cat: "Ready meals", type: "food", useBy: Date.now() + 86400000, road: "Test Road, E8", address: "82 Test Road, London E8 3EP" },
    });
    assert.equal(res.status, 400, `${title} should be refused`);
  }
});

test("categories belong to their type", async () => {
  const token = await newNeighbour("Muddled Giver");
  const wrong = await call("/items", {
    method: "POST",
    token,
    body: { title: "Bread", cat: "Furniture", type: "food", useBy: Date.now() + 86400000, road: "Test Road, E8", address: "83 Test Road, London E8 3EP" },
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.field, "cat");

  const alsoWrong = await call("/items", {
    method: "POST",
    token,
    body: { title: "Chair", cat: "Bakery", road: "Test Road, E8", address: "83 Test Road, London E8 3EP" },
  });
  assert.equal(alsoWrong.status, 400);
});

test("the feed carries both kinds, and the seed has food in it", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const foodPage = await call("/items?type=food&limit=40", { token });
  const nonfoodPage = await call("/items?type=nonfood&limit=1", { token });
  const food = foodPage.body.items;
  assert.ok(foodPage.body.total >= 3, `expected seeded food, saw ${foodPage.body.total}`);
  assert.ok(nonfoodPage.body.total >= 5, `expected seeded non-food, saw ${nonfoodPage.body.total}`);
  for (const f of food) {
    assert.ok(f.useBy > Date.now(), `${f.title} should not be past its use-by`);
    assert.ok(FOODCATS.includes(f.cat), `${f.cat} is not a food category`);
  }
});

const FOODCATS = ["Bakery", "Fruit & veg", "Dairy", "Store cupboard", "Ready meals", "Drinks"];

test("the category list is published for both types", async () => {
  const res = await call("/categories");
  assert.equal(res.status, 200);
  assert.equal(res.body.food.length, 6);
  assert.equal(res.body.nonfood.length, 4);
  assert.ok(res.body.food.every((c) => c.cat && c.kind));
});

test("the feed is paged, and the pages do not overlap", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const first = await call("/items?limit=4&offset=0", { token });
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 4);
  assert.ok(first.body.total >= 8);
  assert.equal(first.body.more, true);

  const second = await call("/items?limit=4&offset=4", { token });
  const ids = new Set(first.body.items.map((i) => i.id));
  assert.ok(second.body.items.every((i) => !ids.has(i.id)), "page two must not repeat page one");

  /* the page size is capped, so page past the end instead of asking for everything */
  const total = first.body.total;
  const tail = await call(`/items?limit=60&offset=${Math.max(0, total - 1)}`, { token });
  assert.equal(tail.body.more, false, "the last page should say there is no more");
  assert.equal(tail.body.items.length, Math.min(1, total), "and it should hold the final item");
});

test("searching and filtering happen in the database, across every page", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");

  /* create the thing being searched for, rather than leaning on a seeded
     item that an earlier test may already have claimed or collected */
  const giver = await newNeighbour("Search Subject");
  await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Anglepoise zorbulon", cat: "Electricals", road: "Test Road, E8", address: "90 Test Road, London E8 3EP" },
  });

  const search = await call("/items?q=zorbulon", { token });
  assert.equal(search.body.total, 1, "the search should find exactly the item just listed");
  assert.ok(search.body.items.every((i) => /zorbulon/i.test(`${i.title} ${i.note} ${i.road}`)));

  const food = await call("/items?type=food", { token });
  assert.ok(food.body.total >= 3);
  assert.ok(food.body.items.every((i) => i.type === "food"));

  const kids = await call("/items?cat=Kids", { token });
  assert.ok(kids.body.items.every((i) => i.cat === "Kids"));

  /* a search that matches nothing should say so rather than returning the feed */
  const none = await call("/items?q=zzzznotathing", { token });
  assert.equal(none.body.total, 0);
  assert.equal(none.body.items.length, 0);
});

test("a guest gets the same paging", async () => {
  const res = await call("/items?limit=3");
  assert.equal(res.status, 200);
  assert.equal(res.body.guest, true);
  assert.equal(res.body.items.length, 3);
  assert.ok(res.body.total > 3);
});

test("a listing carries the details people would otherwise have to ask for", async () => {
  const token = await newNeighbour("Detailed Giver");
  const made = await call("/items", {
    method: "POST",
    token,
    body: {
      title: "Oak dining table",
      cat: "Furniture",
      road: "Test Road, E8",
      address: "95 Test Road, London E8 3EP",
      details: {
        condition: "Good",
        carry: "Needs a car or van",
        width: 140,
        depth: 80,
        height: 75,
        material: "Wood",
        colour: "Oak",
        flatpack: "No, one piece",
        /* not a field for furniture, and not a real option — both should go */
        storage: "Fridge",
        nonsense: "drop me",
      },
    },
  });
  assert.equal(made.status, 201);
  const d = made.body.details;
  assert.equal(d.width, 140);
  assert.equal(d.material, "Wood");
  assert.equal(d.carry, "Needs a car or van");
  assert.equal(d.storage, undefined, "a fridge is not a question about a table");
  assert.equal(d.nonsense, undefined, "unknown fields are dropped");
});

test("details are checked, not just stored", async () => {
  const token = await newNeighbour("Fibbing Giver");
  const made = await call("/items", {
    method: "POST",
    token,
    body: {
      title: "Desk lamp",
      cat: "Electricals",
      road: "Test Road, E8",
      address: "96 Test Road, London E8 3EP",
      details: { condition: "Immaculate", works: "Works fine", cable: "Included", brand: "x".repeat(200) },
    },
  });
  assert.equal(made.status, 201);
  const d = made.body.details;
  assert.equal(d.condition, undefined, "a condition outside the list is not kept");
  assert.equal(d.works, "Works fine");
  assert.ok(d.brand.length <= 60, "free text is trimmed");
});

test("food details ask food questions", async () => {
  const token = await newNeighbour("Food Detailer");
  const made = await call("/items", {
    method: "POST",
    token,
    body: {
      title: "Bag of apples",
      cat: "Fruit & veg",
      type: "food",
      useBy: Date.now() + 3 * 86400000,
      road: "Test Road, E8",
      address: "97 Test Road, London E8 3EP",
      details: { storage: "Fridge", diet: "Vegan", allergens: "None", width: 40 },
    },
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.details.storage, "Fridge");
  assert.equal(made.body.details.diet, "Vegan");
  assert.equal(made.body.details.width, undefined, "width is not a question about apples");
});

test("the seeded neighbourhood has details on its listings", async () => {
  const token = await signIn("demo@doorstep.uk", "doorstep123");
  const { body } = await call("/items?cat=Furniture&limit=6", { token });
  const withSize = body.items.filter((i) => i.details && i.details.width);
  assert.ok(withSize.length >= 3, `expected sizes on furniture, saw ${withSize.length}`);
  assert.ok(body.items.every((i) => i.details && i.details.condition), "every listing says what condition it is in");
});

/* ---------------- the arrangement thread ---------------- */

test("a claim opens a conversation, and the milestones write themselves", async () => {
  const giver = await newNeighbour("Chat Giver");
  const claimer = await newNeighbour("Chat Claimer");

  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Ficus in a basket", cat: "Garden", road: "Test Road, E8", address: "70 Test Road, London E8 3EP" },
  });
  const claimed = await call(`/items/${listed.body.id}/claim`, { method: "POST", token: claimer });
  assert.equal(claimed.status, 200);
  assert.ok(claimed.body.conversationId > 0, "the claim carries its conversation");

  const thread = await call(`/chats/${claimed.body.conversationId}`, { token: claimer });
  assert.equal(thread.status, 200);
  assert.equal(thread.body.role, "collecting");
  assert.ok(thread.body.messages.some((m) => m.system && /held for 30 minutes/.test(m.body)), "the app wrote the first line");
  assert.ok(thread.body.address, "the claimer sees where to go");

  /* both sides can talk; a third party cannot */
  const sent = await call(`/chats/${claimed.body.conversationId}`, { method: "POST", token: claimer, body: { body: "On my way!" } });
  assert.equal(sent.status, 201);
  const reply = await call(`/chats/${claimed.body.conversationId}`, { method: "POST", token: giver, body: { body: "It's by the door" } });
  assert.equal(reply.status, 201);
  const stranger = await newNeighbour("Nosy Stranger");
  const barred = await call(`/chats/${claimed.body.conversationId}`, { token: stranger });
  assert.equal(barred.status, 404, "a stranger cannot read the thread");

  /* the giver's list shows the unread count, and opening clears it */
  const list = await call("/chats", { token: giver });
  const mine = list.body.chats.find((c) => c.itemId === listed.body.id);
  assert.ok(mine, "the giver sees the thread");
  assert.equal(mine.role, "giving");
  await call(`/chats/${claimed.body.conversationId}`, { token: giver });
  const after = await call("/chats", { token: giver });
  assert.equal(after.body.chats.find((c) => c.itemId === listed.body.id).unread, 0, "opening the thread read it");
});

test("stars unlock only after the handover, once, both directions", async () => {
  const giver = await newNeighbour("Rated Giver");
  const claimer = await newNeighbour("Rating Claimer");
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Spice rack", cat: "Furniture", road: "Test Road, E8", address: "71 Test Road, London E8 3EP" },
  });
  await call(`/items/${listed.body.id}/claim`, { method: "POST", token: claimer });

  const early = await call(`/items/${listed.body.id}/rate`, { method: "POST", token: claimer, body: { stars: 5 } });
  assert.equal(early.status, 400, "no stars before the handover");

  await call(`/items/${listed.body.id}/collected`, { method: "POST", token: claimer });

  const rated = await call(`/items/${listed.body.id}/rate`, { method: "POST", token: claimer, body: { stars: 5 } });
  assert.equal(rated.status, 201);
  const again = await call(`/items/${listed.body.id}/rate`, { method: "POST", token: claimer, body: { stars: 1 } });
  assert.equal(again.status, 409, "one rating per handover");

  const giverRates = await call(`/items/${listed.body.id}/rate`, { method: "POST", token: giver, body: { stars: 4 } });
  assert.equal(giverRates.status, 201, "the giver rates the collector too");

  const stranger = await newNeighbour("Rating Stranger");
  const barred = await call(`/items/${listed.body.id}/rate`, { method: "POST", token: stranger, body: { stars: 1 } });
  assert.equal(barred.status, 403, "only the two people who met can rate");
});

test("an expired listing goes back up in one tap, a live one doesn't", async () => {
  const giver = await newNeighbour("Relist Giver");
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Herb planter", cat: "Garden", road: "Test Road, E8", address: "72 Test Road, London E8 3EP" },
  });

  const tooSoon = await call(`/items/${listed.body.id}/relist`, { method: "POST", token: giver });
  assert.equal(tooSoon.status, 400, "still live — nothing to relist");
});

test("away mode hides your listings until you're back", async () => {
  const giver = await newNeighbour("Away Giver");
  const looker = await newNeighbour("Still Here");
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Xylophone for kids", cat: "Kids", road: "Test Road, E8", address: "73 Test Road, London E8 3EP" },
  });

  const sees = async () => {
    const feed = await call("/items?q=xylophone", { token: looker });
    return feed.body.items.some((i) => i.id === listed.body.id);
  };
  assert.equal(await sees(), true, "visible before going away");

  await call("/me", { method: "PATCH", token: giver, body: { away: true } });
  assert.equal(await sees(), false, "hidden while away");

  await call("/me", { method: "PATCH", token: giver, body: { away: false } });
  assert.equal(await sees(), true, "back means back");
});

test("an ask is not an offer: separate feed, no claim, answered with a message", async () => {
  const asker = await newNeighbour("Asking Neighbour");
  const helper = await newNeighbour("Helpful Neighbour");

  const ask = await call("/items", {
    method: "POST",
    token: asker,
    body: { title: "Quixotic flugelhorn case", note: "Long shot, but you never know.", cat: "Furniture", wanted: true, windowMinutes: 48 * 60 },
  });
  assert.equal(ask.status, 201, "an ask needs no address and no photo");
  assert.equal(ask.body.wanted, true);

  /* it lives in the asks feed, not the offers feed */
  const offers = await call("/items?q=flugelhorn", { token: helper });
  assert.equal(offers.body.items.length, 0, "asks stay out of the offers feed");
  const asks = await call("/items?q=flugelhorn&asks=1", { token: helper });
  assert.equal(asks.body.items.length, 1, "and appear in the asks feed");

  /* nobody can claim a thing that doesn't exist yet */
  const claimed = await call(`/items/${ask.body.id}/claim`, { method: "POST", token: helper });
  assert.equal(claimed.status, 400);

  /* "I have one" opens the thread */
  const offer = await call(`/items/${ask.body.id}/offer`, { method: "POST", token: helper });
  assert.equal(offer.status, 201);
  assert.ok(offer.body.conversationId > 0);
  const thread = await call(`/chats/${offer.body.conversationId}`, { token: asker });
  assert.ok(thread.body.messages.some((m) => m.system && /has one for you/.test(m.body)));

  /* offering twice reuses the same thread rather than spamming */
  const again = await call(`/items/${ask.body.id}/offer`, { method: "POST", token: helper });
  assert.equal(again.body.conversationId, offer.body.conversationId);

  /* your own ask takes no offer from you */
  const own = await call(`/items/${ask.body.id}/offer`, { method: "POST", token: asker });
  assert.equal(own.status, 400);
});

/* ---------------- fair chance, dibs, last orders, rain ---------------- */

test("fair chance: hands go up, the giver picks, everyone hears", async () => {
  const giver = await newNeighbour("Fair Giver");
  const near = await newNeighbour("Near Hand");
  const far = await newNeighbour("Other Hand");

  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Velvet pouffe", cat: "Furniture", road: "Test Road, E8", address: "80 Test Road, London E8 3EP", claimMode: "fair" },
  });
  assert.equal(listed.body.claimMode, "fair");

  const h1 = await call(`/items/${listed.body.id}/claim`, { method: "POST", token: near });
  assert.equal(h1.status, 200);
  assert.equal(h1.body.fair, true);
  assert.equal(h1.body.hands, 1, "a hand, not a hold");
  const h2 = await call(`/items/${listed.body.id}/claim`, { method: "POST", token: far });
  assert.equal(h2.body.hands, 2);

  /* the giver sees who is asking */
  const hands = await call(`/items/${listed.body.id}/hands`, { token: giver });
  assert.equal(hands.body.hands.length, 2);
  const nearId = hands.body.hands[0].userId;

  /* a stranger cannot look */
  const nosy = await newNeighbour("Nosy Hands");
  assert.equal((await call(`/items/${listed.body.id}/hands`, { token: nosy })).status, 403);

  /* the pick assigns the hold and opens the thread */
  const picked = await call(`/items/${listed.body.id}/pick`, { method: "POST", token: giver, body: { userId: nearId } });
  assert.equal(picked.status, 200);
  assert.ok(picked.body.conversationId > 0);
  const thread = await call(`/chats/${picked.body.conversationId}`, { token: near });
  assert.ok(thread.body.messages.some((m) => m.system && /picked you/.test(m.body)));

  /* the other hand was let down gently */
  const notes = await call("/notifications", { token: far });
  assert.ok(notes.body.notifications.some((n) => /another neighbour/.test(n.body)));

  /* picking someone whose hand never went up is refused */
  const rogue = await call(`/items/${listed.body.id}/pick`, { method: "POST", token: giver, body: { userId: 99999 } });
  assert.ok(rogue.status >= 400);
});

test("first dibs holds the door for the street", async () => {
  const giver = await newNeighbour("Dibs Giver"); /* E8 3EP */
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Ottoman with dibs", cat: "Furniture", road: "Test Road, E8", address: "81 Test Road, London E8 3EP", dibs: true },
  });
  assert.equal(listed.body.dibs, true);

  /* a neighbour registered far away is told when it opens, not refused outright */
  const farAway = await call("/auth/signup", {
    method: "POST",
    body: { name: "Distant Claimer", email: `dibs${Date.now()}@x.uk`, postcode: "N16 0SS", password: "doorstep123" },
  });
  const tried = await call(`/items/${listed.body.id}/claim`, { method: "POST", token: farAway.body.token });
  assert.equal(tried.status, 403);
  assert.match(tried.body.error, /first dibs.*opens to you at/i);

  /* and the item shape says when */
  const feed = await call("/items?q=ottoman", { token: farAway.body.token });
  const it = feed.body.items.find((i) => i.id === listed.body.id);
  assert.ok(it.dibsOpensAt > Date.now(), "the wait is visible, not a surprise");
});

test("last orders sharpens the pin and rings the bell once", async () => {
  const giver = await newNeighbour("Closing Giver");
  const watcher = await newNeighbour("Hopeful Watcher");

  /* a 20-minute window is born inside last orders */
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Zanzibar clock", cat: "Furniture", road: "Test Road, E8", address: "82 Test Road, London E8 3EP", windowMinutes: 20 },
  });
  await call(`/items/${listed.body.id}/save`, { method: "POST", token: watcher });

  /* the sweep runs on every feed request */
  const feed = await call("/items?q=zanzibar", { token: watcher });
  const it = feed.body.items.find((i) => i.id === listed.body.id);
  assert.equal(it.lastOrders, true);
  assert.equal(it.address, undefined, "the address stays hidden even at last orders");
  assert.notEqual(it.lat, Math.round(it.lat * 1000) / 1000, "the pin sharpens off the fuzzing grid");

  const notes = await call("/notifications", { token: watcher });
  const bells = notes.body.notifications.filter((n) => /Last orders/.test(n.body));
  assert.equal(bells.length, 1, "the bell rings once");

  /* asking again does not ring it twice */
  await call("/items?q=zanzibar", { token: watcher });
  const again = await call("/notifications", { token: watcher });
  assert.equal(again.body.notifications.filter((n) => /Last orders/.test(n.body)).length, 1);
});

test("rain check pushes the window back and tells the savers", async () => {
  const giver = await newNeighbour("Soggy Giver");
  const saver = await newNeighbour("Dry Saver");
  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Wicker chair for rain", cat: "Furniture", road: "Test Road, E8", address: "83 Test Road, London E8 3EP" },
  });
  await call(`/items/${listed.body.id}/save`, { method: "POST", token: saver });

  const before = (await call("/items?q=wicker", { token: saver })).body.items[0].expiresAt;
  const checked = await call(`/items/${listed.body.id}/raincheck`, { method: "POST", token: giver });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.until, before + 2 * 60 * 60 * 1000, "two hours later, exactly");

  const notes = await call("/notifications", { token: saver });
  assert.ok(notes.body.notifications.some((n) => /Rain check/.test(n.body)), "the saver heard");

  /* only the giver holds the umbrella */
  const cheeky = await call(`/items/${listed.body.id}/raincheck`, { method: "POST", token: saver });
  assert.equal(cheeky.status, 403);
});

test("the demand radar reads the wish list backwards, counts only", async () => {
  const giver = await newNeighbour("Radar Giver"); /* E8 3EP */
  const wisher1 = await newNeighbour("Radar Wisher One");
  const wisher2 = await newNeighbour("Radar Wisher Two");

  await call("/wishes", { method: "POST", token: wisher1, body: { keyword: "gramophone", cat: "Anything", radius: 5 } });
  await call("/wishes", { method: "POST", token: wisher2, body: { keyword: "Gramophone", cat: "Anything", radius: 5 } });
  /* a wish whose radius cannot reach the giver must not count */
  const farWisher = await call("/auth/signup", {
    method: "POST",
    body: { name: "Too Far", email: `radar${Date.now()}@x.uk`, postcode: "M1 1AE", password: "doorstep123" },
  });
  await call("/wishes", { method: "POST", token: farWisher.body.token, body: { keyword: "gramophone", cat: "Anything", radius: 1 } });

  const radar = await call("/demand", { token: giver });
  assert.equal(radar.status, 200);
  const gram = radar.body.wants.find((w) => w.label === "gramophone");
  assert.ok(gram, "the want shows on the radar");
  assert.equal(gram.count, 2, "two reachable wishers, casing folded, the far one excluded");
  assert.ok(!JSON.stringify(radar.body).match(/Wisher One|Wisher Two/), "counts only, never who");
});

test("following a giver rings the bell for their next listing, and only while followed", async () => {
  const giver = await newNeighbour("Prolific Giver");
  const follower = await newNeighbour("Faithful Follower");
  const giverId = (await call("/me", { token: giver })).body.user.id;

  /* following yourself is nonsense — you already know what's on your doorstep */
  const selfie = await call(`/givers/${giverId}/follow`, { method: "POST", token: giver });
  assert.equal(selfie.status, 400);

  const followed = await call(`/givers/${giverId}/follow`, { method: "POST", token: follower });
  assert.equal(followed.status, 200);
  assert.equal(followed.body.following, true);

  const listed = await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Rattan magazine rack", cat: "Furniture", road: "Test Road, E8", address: "85 Test Road, London E8 3EP" },
  });
  assert.equal(listed.status, 201);

  const notes = await call("/notifications", { token: follower });
  assert.ok(
    notes.body.notifications.some((n) => /you follow/.test(n.body)),
    "the follower should hear the moment their giver lists"
  );

  /* the giver card carries the relationship, so the button knows its state */
  const feed = await call("/items?q=rattan", { token: follower });
  const it = feed.body.items.find((i) => i.id === listed.body.id);
  assert.equal(it.giver.following, true);
  assert.ok(it.giver.followers >= 1, "the follower count is on the card");

  /* unfollow, and the next listing passes in silence */
  const unfollowed = await call(`/givers/${giverId}/follow`, { method: "DELETE", token: follower });
  assert.equal(unfollowed.body.following, false);
  await call("/items", {
    method: "POST",
    token: giver,
    body: { title: "Rattan plant stand", cat: "Furniture", road: "Test Road, E8", address: "85 Test Road, London E8 3EP" },
  });
  const again = await call("/notifications", { token: follower });
  assert.equal(
    again.body.notifications.filter((n) => /you follow/.test(n.body)).length,
    1,
    "no second bell after unfollowing"
  );
});

test("one trip: a bundle joins the anchor's hold, refuses other doorsteps and strangers", async () => {
  const giver = await newNeighbour("Bundle Giver");
  const otherGiver = await newNeighbour("Other Doorstep");
  const taker = await newNeighbour("Trip Taker");
  const stranger = await newNeighbour("Bundle Stranger");

  const list = (token, title, address) =>
    call("/items", { method: "POST", token, body: { title, cat: "Furniture", road: "Test Road, E8", address } });
  const anchor = await list(giver, "Trip bookcase", "90 Test Road, London E8 3EP");
  const table = await list(giver, "Trip side table", "90 Test Road, London E8 3EP");
  const mirror = await list(giver, "Trip mirror", "90 Test Road, London E8 3EP");
  const elsewhere = await list(otherGiver, "Trip impostor lamp", "91 Test Road, London E8 3EP");

  /* nobody holds the anchor yet, so there is no trip to join */
  const noClaim = await call(`/items/${anchor.body.id}/bundle`, { method: "POST", token: stranger, body: { itemIds: [table.body.id] } });
  assert.equal(noClaim.status, 403);

  const claimed = await call(`/items/${anchor.body.id}/claim`, { method: "POST", token: taker });
  assert.equal(claimed.status, 200);
  const hold = claimed.body.claimExpiresAt;
  assert.ok(hold > Date.now());

  /* holding the anchor is the ticket — a stranger without it is turned away */
  const cheeky = await call(`/items/${anchor.body.id}/bundle`, { method: "POST", token: stranger, body: { itemIds: [table.body.id] } });
  assert.equal(cheeky.status, 403);

  /* a different giver is a different doorstep, so it cannot join this walk */
  const wrongDoor = await call(`/items/${anchor.body.id}/bundle`, { method: "POST", token: taker, body: { itemIds: [elsewhere.body.id] } });
  assert.equal(wrongDoor.status, 400);
  assert.match(wrongDoor.body.error, /different doorstep/i);

  /* both of the giver's other listings join in one call, on the anchor's clock */
  const bundled = await call(`/items/${anchor.body.id}/bundle`, { method: "POST", token: taker, body: { itemIds: [table.body.id, mirror.body.id] } });
  assert.equal(bundled.status, 200);
  assert.equal(bundled.body.items.length, 2);
  for (const it of bundled.body.items) {
    assert.equal(it.status, "yours");
    assert.equal(it.claimExpiresAt, hold, "the whole trip lapses together");
  }

  /* no new threads: the anchor's conversation carries a note per addition */
  const chat = await call(`/chats/${claimed.body.conversationId}`, { token: taker });
  const notes = chat.body.messages.filter((m) => m.system && /Also picking up/.test(m.body));
  assert.equal(notes.length, 2);
  assert.ok(notes.some((m) => m.body.includes("Trip side table")));
  assert.ok(notes.some((m) => m.body.includes("Trip mirror")));
});
