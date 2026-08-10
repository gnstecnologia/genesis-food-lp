/**
 * Agenda tag MQL no GHL após o lead entrar pelo webhook do formulário.
 *
 * Regra: MQL a partir de "50 mil até 80 mil" (inclusive).
 * Não MQL: "Até 30 mil" e "30 mil até 50 mil".
 * Fluxo: espera ~3 min (lead cria no GHL) → busca por e-mail/telefone → tag MQL
 *
 * Env: GHL_API_TOKEN, GHL_LOCATION_ID, GHL_MQL_TAG (default: MQL)
 */
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const DEFAULT_DELAY_MS = 3 * 60 * 1000;
const MAX_DELAY_MS = 4 * 60 * 1000;
const MQL_REVENUES = [
  "50 mil até 80 mil",
  "80 mil até 100 mil",
  "100 mil até 150 mil",
  "150 mil até 250 mil",
  "250 mil até 400 mil",
  "400 mil até 600 mil",
  "600 mil até 1 milhão",
  "Mais de 1 milhão",
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
    Version: GHL_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhone(phone) {
  var d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && d.length >= 12) return "+" + d;
  if (d.length >= 10 && d.length <= 11) return "+55" + d;
  return d.startsWith("+") ? String(phone) : "+" + d;
}

function isMqlRevenue(faturamento) {
  var v = String(faturamento || "").trim();
  if (!v) return false;
  return MQL_REVENUES.includes(v);
}

async function searchContacts(locationId, filters) {
  const res = await fetch(`${GHL_BASE}/contacts/search`, {
    method: "POST",
    headers: ghlHeaders(),
    body: JSON.stringify({
      locationId,
      pageLimit: 1,
      filters,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GHL search failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return (body.contacts || [])[0] || null;
}

async function findContact(locationId, email, phone) {
  if (email) {
    const byEmail = await searchContacts(locationId, [
      { field: "email", operator: "eq", value: String(email).trim().toLowerCase() },
    ]);
    if (byEmail?.id) return byEmail;
  }
  const e164 = normalizePhone(phone);
  if (e164) {
    const byPhone = await searchContacts(locationId, [
      { field: "phone", operator: "eq", value: e164 },
    ]);
    if (byPhone?.id) return byPhone;
  }
  return null;
}

async function addTag(contactId, tag) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: ghlHeaders(),
    body: JSON.stringify({ tags: [tag] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GHL tags failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function findAndTag({ email, phone, tag, retries }) {
  const locationId = process.env.GHL_LOCATION_ID;
  let last = null;
  for (let i = 0; i < retries; i++) {
    last = await findContact(locationId, email, phone);
    if (last?.id) break;
    if (i < retries - 1) await sleep(15000);
  }
  if (!last?.id) {
    return { ok: false, error: "Contact not found after retries", email, phone };
  }
  const tagsResult = await addTag(last.id, tag);
  return { ok: true, contactId: last.id, email, tag, tagsResult };
}

async function runDelayedTag(job) {
  try {
    if (job.delayMs > 0) await sleep(job.delayMs);
    const result = await findAndTag(job);
    console.log("tag-mql result", JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("tag-mql error", err);
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, { ok: true });
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  if (!process.env.GHL_API_TOKEN || !process.env.GHL_LOCATION_ID) {
    return json(res, 500, { error: "Missing GHL_API_TOKEN or GHL_LOCATION_ID" });
  }

  const data = await readBody(req);
  const email = String(data.email || "").trim().toLowerCase();
  const phone = String(data.phone || data.whatsapp || "").trim();
  const faturamento = String(data.faturamento || data.revenue || "").trim();
  const forceMql = data.mql === true || data.mql === 1 || data.mql === "1";
  const mql = forceMql || isMqlRevenue(faturamento);
  const tag = String(process.env.GHL_MQL_TAG || data.tag || "MQL").trim() || "MQL";

  if (!email && !phone) {
    return json(res, 400, { error: "Missing email or phone" });
  }

  if (!mql) {
    return json(res, 200, {
      ok: true,
      skipped: true,
      reason: "not_mql",
      faturamento,
      mqlValues: MQL_REVENUES,
    });
  }

  let delayMs = Number(data.delayMs);
  if (!Number.isFinite(delayMs)) delayMs = DEFAULT_DELAY_MS;
  delayMs = Math.max(0, Math.min(MAX_DELAY_MS, Math.floor(delayMs)));
  const forceSync = data.sync === true || data.sync === 1 || data.sync === "1";

  const job = {
    email,
    phone,
    tag,
    delayMs,
    retries: Number(data.retries) > 0 ? Math.min(8, Number(data.retries)) : 4,
  };

  let waitUntil;
  try {
    waitUntil = require("@vercel/functions").waitUntil;
  } catch (_) {
    waitUntil = null;
  }

  if (!forceSync && typeof waitUntil === "function") {
    waitUntil(runDelayedTag(job));
    return json(res, 202, {
      ok: true,
      scheduled: true,
      tag,
      delayMs,
      email,
      faturamento,
    });
  }

  // Sync / fallback: mantém a execução viva até terminar (precisa maxDuration >= delay)
  const result = await runDelayedTag(job);
  return json(res, result.ok ? 200 : 404, {
    scheduled: false,
    delayMs,
    faturamento,
    ...result,
  });
};
