/**
 * Cal.com → Genesis Food LP → GoHighLevel
 *
 * Receives Cal.com webhooks (BOOKING_CREATED) and/or embed callbacks,
 * finds the contact in GHL by email and:
 *  - adds tag "Agendou Cal.com"
 *  - creates a note with booking details
 *  - optionally forwards to GHL inbound webhook for workflows
 *
 * Env (Vercel):
 *  GHL_API_TOKEN
 *  GHL_LOCATION_ID
 *  GHL_BOOKING_TAG (optional, default: "Agendou Cal.com")
 *  GHL_WEBHOOK_URL (optional)
 *  CAL_WEBHOOK_SECRET (optional)
 */
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-cal-signature-256");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw: "", data: {} };
  try {
    return { raw, data: JSON.parse(raw) };
  } catch {
    return { raw, data: {} };
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

function pickBooking(data) {
  // Cal.com server webhook
  const payload = data.payload || data;
  const trigger = data.triggerEvent || data.type || data.action || "";
  const attendees = payload.attendees || [];
  const attendee = attendees[0] || {};
  const responses = payload.responses || {};

  // Embed bookingSuccessful shapes vary
  const detail = data.detail || {};
  const embedData = detail.data || data.data || {};

  const email =
    attendee.email ||
    embedData.email ||
    responses.email?.value ||
    data.email ||
    "";
  const name =
    attendee.name ||
    embedData.name ||
    responses.name?.value ||
    data.nome ||
    data.name ||
    "";
  const phone =
    attendee.phoneNumber ||
    attendee.phone ||
    embedData.phone ||
    responses.attendeePhoneNumber?.value ||
    data.whatsapp ||
    data.phone ||
    "";

  const startTime =
    payload.startTime || embedData.startTime || data.startTime || "";
  const endTime = payload.endTime || embedData.endTime || data.endTime || "";
  const title = payload.title || embedData.title || data.title || "Reunião";
  const uid =
    payload.uid ||
    payload.bookingId ||
    embedData.uid ||
    data.uid ||
    `${email}-${startTime}`;

  return {
    trigger,
    email: String(email || "").trim().toLowerCase(),
    name: String(name || "").trim(),
    phone: String(phone || "").trim(),
    startTime,
    endTime,
    title,
    uid: String(uid),
    source: data.source || (data.payload ? "cal-webhook" : "embed"),
    rawTrigger: trigger,
  };
}

async function findContactByEmail(locationId, email) {
  const res = await fetch(`${GHL_BASE}/contacts/search`, {
    method: "POST",
    headers: ghlHeaders(),
    body: JSON.stringify({
      locationId,
      pageLimit: 1,
      filters: [{ field: "email", operator: "eq", value: email }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GHL search failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const contacts = body.contacts || body.data?.contacts || [];
  return contacts[0] || null;
}

async function findContactByPhone(locationId, phone) {
  if (!phone) return null;
  const res = await fetch(`${GHL_BASE}/contacts/search`, {
    method: "POST",
    headers: ghlHeaders(),
    body: JSON.stringify({
      locationId,
      pageLimit: 1,
      filters: [{ field: "phone", operator: "eq", value: phone }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const contacts = body.contacts || [];
  return contacts[0] || null;
}

async function upsertContact(locationId, booking) {
  const byEmail = booking.email
    ? await findContactByEmail(locationId, booking.email)
    : null;
  if (byEmail?.id) return byEmail;

  const byPhone = await findContactByPhone(locationId, booking.phone);
  if (byPhone?.id) return byPhone;

  const nameParts = booking.name.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || "Lead";
  const lastName = nameParts.slice(1).join(" ") || "";
  const res = await fetch(`${GHL_BASE}/contacts/`, {
    method: "POST",
    headers: ghlHeaders(),
    body: JSON.stringify({
      locationId,
      firstName,
      lastName,
      email: booking.email || undefined,
      phone: booking.phone || undefined,
      source: "Cal.com | Genesis Food",
      tags: [process.env.GHL_BOOKING_TAG || "Agendou Cal.com"],
    }),
  });
  const body = await res.json().catch(() => ({}));
  // Location blocks duplicates — reuse the matched contact from GHL meta
  if (!res.ok && body?.meta?.contactId) {
    return { id: body.meta.contactId, name: body.meta.contactName || "" };
  }
  if (!res.ok) {
    throw new Error(`GHL create failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.contact || body;
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

async function addNote(contactId, booking) {
  const bodyText = [
    "Agendamento Cal.com confirmado",
    `Título: ${booking.title}`,
    `Início: ${booking.startTime || "-"}`,
    `Fim: ${booking.endTime || "-"}`,
    `UID: ${booking.uid}`,
    `Fonte: ${booking.source}`,
  ].join("\n");

  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
    method: "POST",
    headers: ghlHeaders(),
    body: JSON.stringify({ body: bodyText }),
  });
  const body = await res.json().catch(() => ({}));
  // note endpoint may fail without scope — don't hard-fail the whole flow
  return { ok: res.ok, status: res.status, body };
}

async function forwardWebhook(booking, contact) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) return { skipped: true };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "cal_booking",
      tag: process.env.GHL_BOOKING_TAG || "Agendou Cal.com",
      contactId: contact?.id || "",
      email: booking.email,
      full_name: booking.name,
      phone: booking.phone,
      title: booking.title,
      startTime: booking.startTime,
      endTime: booking.endTime,
      uid: booking.uid,
      source: booking.source,
      timestamp: new Date().toISOString(),
    }),
  });
  return { ok: res.ok, status: res.status };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, { ok: true });
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  if (!process.env.GHL_API_TOKEN || !process.env.GHL_LOCATION_ID) {
    return json(res, 500, { error: "Missing GHL_API_TOKEN or GHL_LOCATION_ID" });
  }

  const { data } = await readBody(req);
  const trigger = String(data.triggerEvent || data.type || data.action || "").toUpperCase();

  // Ignore cancellations from Cal server webhooks
  if (/BOOKING_CANCELLED|BOOKING_REJECTED/.test(trigger)) {
    return json(res, 200, { ok: true, ignored: true, trigger });
  }

  try {
    const booking = pickBooking(data);
    if (!booking.email) {
      return json(res, 400, { error: "Missing attendee email", booking });
    }

    const tag = process.env.GHL_BOOKING_TAG || "Agendou Cal.com";
    const contact = await upsertContact(process.env.GHL_LOCATION_ID, booking);
    const contactId = contact.id || contact.contact?.id;
    if (!contactId) {
      return json(res, 502, { error: "Contact without id", contact });
    }

    const tagsResult = await addTag(contactId, tag);
    const noteResult = await addNote(contactId, booking);
    const webhookResult = await forwardWebhook(booking, { id: contactId });

    return json(res, 200, {
      ok: true,
      contactId,
      email: booking.email,
      tag,
      uid: booking.uid,
      tagsResult,
      noteResult,
      webhookResult,
    });
  } catch (err) {
    console.error("cal-webhook error", err);
    return json(res, 500, { error: err.message || String(err) });
  }
};
