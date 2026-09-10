import assert from "node:assert/strict";
import test from "node:test";

import { sortAdminCatalog, adminPage } from "./admin.js";

test("admin catalog sorts configured/ready providers above unused, stable by id", () => {
  const rows = [
    { id: "z_empty" },
    { id: "a_ready", ready: true },
    { id: "m_unused" },
    { id: "b_configured", configured: true },
  ];
  const result = sortAdminCatalog(rows);
  assert.deepEqual(
    result.map((r) => r.id),
    ["a_ready", "b_configured", "m_unused", "z_empty"]
  );
});

test("admin catalog keeps both local and cloud order within a bucket", () => {
  const rows = [
    { id: "ollama", local: true },
    { id: "groq", name: "Groq" },
    { id: "open_router", name: "OpenRouter" },
  ];
  const result = sortAdminCatalog(rows);
  assert.deepEqual(
    result.map((r) => r.id),
    ["groq", "ollama", "open_router"]
  );
});

test("admin last-route template labels LOCAL hops and last-resort locals", () => {
  const html = adminPage();
  assert.ok(html.includes("LOCAL"));
  assert.ok(html.includes("local last-resort"));
  assert.ok(html.includes("last local hop"));
});

test("admin page template includes compact class and expand data for unused cards", () => {
  const html = adminPage();
  assert.ok(html.includes('class="card compact"'));
  assert.ok(html.includes("data-expand="));
  assert.ok(!html.includes('class="card ready compact"'));
});
