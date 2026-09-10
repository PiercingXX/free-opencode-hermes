import assert from "node:assert/strict";
import test from "node:test";

import { sortAdminCatalog } from "./admin.js";

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
