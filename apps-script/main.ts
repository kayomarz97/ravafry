/// <reference types="google-apps-script" />
import { handleDomain } from '../server/domain';
import { DomainError, type DomainCommand } from '../server/contracts';
import { UpstreamError, bytesHex, parseEnvelope, signatureMessage, constantTimeEqual, consumeNonce, denied } from './auth';
import { TABLES, encodeRows, readSnapshot, writeSnapshot, summaryRows } from './sheet-store';

function json(value: unknown): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

export function doGet(): GoogleAppsScript.Content.TextOutput {
  return json({ ok: false, error: { code: 'method_not_allowed', status: 405, message: 'Use POST.' } });
}

export function doPost(event: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  let lock: GoogleAppsScript.Lock.Lock | undefined;
  try {
    if (!event?.postData || event.postData.type.split(';')[0]?.trim() !== 'application/json' ||
      event.contentLength > 48_000 || event.postData.contents.length > 48_000) throw denied();
    const now = Date.now();
    const envelope = parseEnvelope(JSON.parse(event.postData.contents), now);
    const properties = PropertiesService.getScriptProperties();
    const secret = properties.getProperty('RSVP_SHARED_SECRET');
    const sheetId = properties.getProperty('RSVP_SHEET_ID');
    if (!secret || !/^[0-9a-f]{64}$/.test(secret) || !sheetId) {
      throw new UpstreamError('not_configured', 503, 'RSVP service is not ready.');
    }
    const expected = bytesHex(Utilities.computeHmacSha256Signature(signatureMessage(envelope), secret, Utilities.Charset.UTF_8));
    if (!constantTimeEqual(expected, envelope.signature)) throw denied();
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10_000)) throw new UpstreamError('busy', 503, 'Please try again shortly.');
    consumeNonce(properties, envelope, now);
    const command = JSON.parse(envelope.payload) as DomainCommand;
    const snapshot = readSnapshot(sheetId);
    const result = handleDomain(snapshot, command, new Date(now).toISOString(), () => Utilities.getUuid(),
      (value: string) => bytesHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)));
    if (command.kind === 'save') writeSnapshot(sheetId, snapshot, result.snapshot);
    return json({ ok: true, actor: result.actor, state: result.state });
  } catch (error) {
    if (error instanceof DomainError || error instanceof UpstreamError) {
      return json({ ok: false, error: { code: error.code, status: error.status, message: error.message } });
    }
    // Never log event, upstream error details, names, phone numbers or secrets.
    return json({ ok: false, error: { code: 'upstream_failure', status: 503, message: 'Please try again shortly.' } });
  } finally { lock?.releaseLock(); }
}

// Owner runs once in Apps Script editor after setting RSVP_SHARED_SECRET.
// This is deliberately not available through doPost or the public Worker.
export function initializeRsvp(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10_000)) throw new Error('Initialization is busy. Try again shortly.');
  try { initializeEmptyStorage(); } finally { lock.releaseLock(); }
}

// Owner-only schema refresh for empty, already initialized storage.
export function refreshEmptyRsvpSchema(): void {
  if (!Sheets?.Spreadsheets) throw new Error('Enable the Advanced Sheets service.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10_000)) throw new Error('Storage is busy. Try again shortly.');
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!sheet || PropertiesService.getScriptProperties().getProperty('RSVP_SHEET_ID') !== sheet.getId()) {
      throw new Error('RSVP_SHEET_ID must match this bound Sheet.');
    }
    const titles = ['RSVPs', 'Guests', 'Operations', 'RSVP Summary'];
    const tabs = sheet.getSheets();
    if (tabs.length !== 4 || titles.some(title => !tabs.some(tab => tab.getName() === title)) || tabs.some(tab => tab.getLastRow() > 1)) {
      throw new Error('Refresh requires all four initialized tabs with no data rows. No changes made.');
    }
    const requests = tabs.map(tab => ({ updateCells: {
      range: { sheetId: tab.getSheetId(), startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: tab.getMaxColumns() },
      rows: tab.getName() === 'RSVP Summary' ? summaryRows({ rsvps: [], guests: [], operations: [] }) : encodeRows(tab.getName() as keyof typeof TABLES, []),
      fields: 'userEnteredValue',
    } }));
    Sheets.Spreadsheets!.batchUpdate({ requests }, sheet.getId());
  } finally { lock.releaseLock(); }
}

function initializeEmptyStorage(): void {
  if (!Sheets?.Spreadsheets) throw new Error('Enable the Advanced Sheets service.');
  const properties = PropertiesService.getScriptProperties();
  if (!/^[0-9a-f]{64}$/.test(properties.getProperty('RSVP_SHARED_SECRET') ?? '')) {
    throw new Error('Set RSVP_SHARED_SECRET to a securely generated 64-character hex secret in Script Properties first.');
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!sheet) throw new Error('Run from the bound RSVP Sheet project.');
  const configuredId = properties.getProperty('RSVP_SHEET_ID');
  if (configuredId && configuredId !== sheet.getId()) {
    throw new Error('RSVP_SHEET_ID does not match this bound Sheet. Initialization made no changes.');
  }
  if (sheet.getSheets().some((tab) => ['RSVPs', 'Guests', 'Operations', 'RSVP Summary'].includes(tab.getName()))) {
    throw new Error('RSVP storage already exists. Initialization never overwrites it.');
  }
  const metadata = Sheets.Spreadsheets!.get(sheet.getId(), { fields: 'sheets.properties' });
  const first = metadata.sheets?.[0]?.properties;
  if (metadata.sheets?.length !== 1 || first?.sheetId == null || sheet.getSheets()[0]!.getLastRow() !== 0) {
    throw new Error('Initialization requires the newly created empty RSVP Sheet.');
  }
  const requests: GoogleAppsScript.Sheets.Schema.Request[] = [
    { updateSheetProperties: { properties: { sheetId: first.sheetId, title: 'RSVP Summary', gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } },
    { updateCells: { start: { sheetId: first.sheetId, rowIndex: 0, columnIndex: 0 }, rows: summaryRows({ rsvps: [], guests: [], operations: [] }), fields: 'userEnteredValue' } },
  ];
  for (const [index, title] of (Object.keys(TABLES) as Array<keyof typeof TABLES>).entries()) {
    const tabId = first.sheetId + index + 1;
    requests.push({ addSheet: { properties: { sheetId: tabId, title, hidden: title === 'Operations', gridProperties: { rowCount: 1000, columnCount: 20, frozenRowCount: 1 } } } });
    requests.push({ updateCells: { start: { sheetId: tabId, rowIndex: 0, columnIndex: 0 }, rows: encodeRows(title, []), fields: 'userEnteredValue' } });
    requests.push({ addProtectedRange: { protectedRange: { range: { sheetId: tabId }, description: 'Managed by RSVP API. Do not edit raw records manually.', warningOnly: true } } });
  }
  Sheets.Spreadsheets!.batchUpdate({ requests }, sheet.getId());
  properties.setProperty('RSVP_SHEET_ID', sheet.getId());
}
