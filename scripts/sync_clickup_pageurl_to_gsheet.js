import axios from "axios";
import { google } from "googleapis";

const CLICKUP_TOKEN = (process.env.CLICKUP_TOKEN || "").trim();
const CLICKUP_LIST_ID = (process.env.CLICKUP_LIST_ID || "").trim();

const GOOGLE_SHEET_ID = (process.env.GOOGLE_SHEET_ID || "").trim();
const SHEET_TAB_NAME = (process.env.SHEET_TAB_NAME || "Completed Tasks").trim();
const PAGE_URL_FIELD_NAME = (process.env.PAGE_URL_FIELD_NAME || "Page URL").trim();

const SA_JSON_RAW = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!CLICKUP_TOKEN) throw new Error("Missing CLICKUP_TOKEN (GitHub Secret).");
if (!CLICKUP_LIST_ID) throw new Error("Missing CLICKUP_LIST_ID (GitHub Variable/Secret).");
if (!GOOGLE_SHEET_ID) throw new Error("Missing GOOGLE_SHEET_ID (GitHub Variable/Secret).");
if (!SA_JSON_RAW) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON (GitHub Secret).");

const clickup = axios.create({
  baseURL: "https://api.clickup.com/api/v2",
  headers: { Authorization: CLICKUP_TOKEN },
  timeout: 30_000,
});

function isDone(task) {
  const s = String(task?.status?.status || "").toLowerCase();
  // Adjust if your team uses different done names
  return ["complete", "completed", "done", "published", "finalized", "closed"].includes(s) || task?.archived === true;
}

/**
 * ClickUp custom fields look like:
 * task.custom_fields = [{ id, name, type, value, ... }, ...]
 *
 * For URL fields, value is typically a string (the URL),
 * but we guard for other shapes just in case.
 */
function getCustomFieldValue(task, fieldName) {
  const fields = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
  const match = fields.find((f) => String(f?.name || "").trim().toLowerCase() === fieldName.trim().toLowerCase());
  if (!match) return "";

  const v = match.value;

  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);

  // Sometimes ClickUp stores structured values (rare for URL but possible)
  if (typeof v === "object") {
    if (typeof v.url === "string") return v.url;
    if (typeof v.value === "string") return v.value;
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }

  return "";
}

async function fetchAllTasksFromList(listId) {
  let page = 0;
  const all = [];

  while (true) {
    const res = await clickup.get(`/list/${listId}/task`, {
      params: {
        include_closed: true,
        page,
      },
    });

    const tasks = res.data?.tasks || [];
    all.push(...tasks);

    // If no more results
    if (!tasks.length) break;
    page += 1;

    // safety cap
    if (page > 200) break;
  }

  return all;
}

function toIso(ms) {
  const n = Number(ms);
  if (!n) return "";
  return new Date(n).toISOString();
}

function normalize(tasks) {
  return tasks
    .filter(isDone)
    .map((t) => ({
      task_id: String(t.id || ""),
      task_name: t.name || "",
      status: t.status?.status || "",
      assignees: (t.assignees || []).map((a) => a.username || a.email || a.id).join(", "),
      page_url: getCustomFieldValue(t, PAGE_URL_FIELD_NAME),
      date_closed: toIso(t.date_closed || t.date_done || ""),
      url: t.url || "",
    }))
    .filter((r) => r.task_id);
}

function buildAuth() {
  const sa = JSON.parse(SA_JSON_RAW);
  return new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

async function getSheetsClient() {
  const auth = buildAuth();
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

const HEADERS = ["task_id", "task_name", "status", "assignees", "page_url", "date_closed", "url"];

function rowFromRecord(r) {
  return HEADERS.map((h) => r[h] ?? "");
}

async function ensureHeaderRow(sheets) {
  const range = `${SHEET_TAB_NAME}!A1:G1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
  });

  const existing = res.data.values?.[0] || [];
  const ok =
    existing.length === HEADERS.length &&
    existing.every((v, i) => String(v).trim() === HEADERS[i]);

  if (!ok) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }
}

async function upsertByTaskId(sheets, records) {
  // Read existing rows
  const readRange = `${SHEET_TAB_NAME}!A2:G`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: readRange,
  });

  const rows = res.data.values || [];

  // Map task_id -> sheet row number
  const idToRow = new Map();
  for (let i = 0; i < rows.length; i++) {
    const taskId = rows[i]?.[0];
    if (taskId) idToRow.set(String(taskId), i + 2); // start at row 2
  }

  const updates = [];
  const appends = [];

  for (const r of records) {
    const rowNum = idToRow.get(r.task_id);
    const values = [rowFromRecord(r)];

    if (rowNum) {
      updates.push({
        range: `${SHEET_TAB_NAME}!A${rowNum}:G${rowNum}`,
        values,
      });
    } else {
      appends.push(values[0]);
    }
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });
  }

  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:G`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appends },
    });
  }

  console.log(`Updated: ${updates.length}, Appended: ${appends.length}`);
}

async function main() {
  console.log(`Fetching tasks from list ${CLICKUP_LIST_ID}...`);
  const tasks = await fetchAllTasksFromList(CLICKUP_LIST_ID);
  console.log(`Fetched ${tasks.length} tasks.`);

  const records = normalize(tasks);
  console.log(`Done tasks to sync: ${records.length}`);

  const sheets = await getSheetsClient();
  await ensureHeaderRow(sheets);
  await upsertByTaskId(sheets, records);

  console.log("Sync complete ✅");
}

main().catch((err) => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
