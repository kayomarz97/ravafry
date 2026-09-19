/// <reference types="google-apps-script" />
import type { DomainSnapshot } from '../server/contracts';
import { UpstreamError } from './auth';

// Keys are code contracts; headings are the stable family/export-facing schema.
export const TABLES = {
  RSVPs: {
    keys: ['rsvpId', 'createdAt', 'updatedAt', 'primaryGuestId', 'groupStatus', 'totalPartySize', 'additionalGuestCount', 'partyRevision'],
    headings: ['rsvp_id', 'created_at', 'updated_at', 'primary_guest_id', 'group_status', 'total_party_size', 'additional_guest_count', 'party_revision'],
  },
  Guests: {
    keys: ['guestId', 'rsvpId', 'role', 'name', 'country', 'phoneNormalized', 'phoneDisplay', 'attendance', 'createdAt', 'updatedAt', 'active', 'guestRevision', 'authVersion'],
    headings: ['guest_id', 'rsvp_id', 'role', 'name', 'country', 'phone_normalized', 'phone_display', 'attendance', 'created_at', 'updated_at', 'active', 'guest_revision', 'auth_version'],
  },
  Operations: {
    keys: ['operationId', 'actorKey', 'payloadHash', 'resultActor', 'createdAt'],
    headings: ['operation_id', 'actor_hash', 'payload_hash', 'result_actor', 'created_at'],
  },
};
type Table = keyof typeof TABLES;
type CellValue = string | number | boolean | null;

export function decodeRows(table: Table, rows: CellValue[][]): Record<string, unknown>[] {
  if (JSON.stringify(rows[0]) !== JSON.stringify(TABLES[table].headings)) {
    throw new UpstreamError('storage_schema', 503, 'RSVP storage needs attention.');
  }
  return rows.slice(1).filter((row) => row[0] !== '' && row[0] != null).map((row) =>
    Object.fromEntries(TABLES[table].keys.map((key, i) => {
      let value: unknown = row[i] ?? '';
      if (key === 'phoneNormalized' && value === '') value = null;
      if (key === 'resultActor') value = JSON.parse(String(value));
      return [key, value];
    })),
  );
}

export function literalCell(value: unknown): GoogleAppsScript.Sheets.Schema.CellData {
  if (value == null) return { userEnteredValue: { stringValue: '' } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
  return { userEnteredValue: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } };
}

export function encodeRows(table: Table, records: object[]): GoogleAppsScript.Sheets.Schema.RowData[] {
  return [TABLES[table].headings, ...records.map((record) => TABLES[table].keys.map((key) => (record as Record<string, unknown>)[key]))]
    .map((row) => ({ values: row.map(literalCell) }));
}

export function summaryRows(snapshot: DomainSnapshot): GoogleAppsScript.Sheets.Schema.RowData[] {
  const rows: unknown[][] = [['Primary Guest', 'Phone', 'Attendance', 'Total Party Size', 'Guest Names', 'Updated At']];
  for (const rsvp of snapshot.rsvps) {
    const primary = snapshot.guests.find((guest) => guest.guestId === rsvp.primaryGuestId);
    if (!primary) throw new UpstreamError('storage_schema', 503, 'RSVP storage needs attention.');
    const guests = snapshot.guests.filter((guest) => guest.rsvpId === rsvp.rsvpId && guest.active);
    rows.push([primary.name, primary.phoneNormalized, rsvp.groupStatus, rsvp.totalPartySize,
      guests.filter((guest) => guest.role === 'additional').map((guest) => guest.name).join(', '),
      rsvp.updatedAt]);
  }
  return rows.map((row) => ({ values: row.map(literalCell) }));
}

export function readSnapshot(sheetId: string): DomainSnapshot {
  if (!Sheets?.Spreadsheets) throw new UpstreamError('not_configured', 503, 'RSVP service is not ready.');
  const ranges = ['RSVPs!A:H', 'Guests!A:N', 'Operations!A:E'];
  const result = Sheets.Spreadsheets!.Values!.batchGet(sheetId, { ranges, valueRenderOption: 'UNFORMATTED_VALUE' });
  const values = result.valueRanges ?? [];
  return {
    rsvps: decodeRows('RSVPs', values[0]?.values ?? []),
    guests: decodeRows('Guests', values[1]?.values ?? []),
    operations: decodeRows('Operations', values[2]?.values ?? []),
  } as unknown as DomainSnapshot;
}

export function writeSnapshot(sheetId: string, previous: DomainSnapshot, snapshot: DomainSnapshot): void {
  if (!Sheets?.Spreadsheets) throw new UpstreamError('not_configured', 503, 'RSVP service is not ready.');
  const metadata = Sheets.Spreadsheets!.get(sheetId, { fields: 'sheets.properties' });
  const tables = [
    { title: 'RSVPs', rows: encodeRows('RSVPs', snapshot.rsvps), oldLength: previous.rsvps.length + 1 },
    { title: 'Guests', rows: encodeRows('Guests', snapshot.guests), oldLength: previous.guests.length + 1 },
    { title: 'Operations', rows: encodeRows('Operations', snapshot.operations), oldLength: previous.operations.length + 1 },
    { title: 'RSVP Summary', rows: summaryRows(snapshot), oldLength: previous.rsvps.length + 1 },
  ];
  const requests: GoogleAppsScript.Sheets.Schema.Request[] = [];
  for (const table of tables) {
    const properties = metadata.sheets?.find((sheet) => sheet.properties?.title === table.title)?.properties;
    if (properties?.sheetId == null || !properties.gridProperties?.rowCount) throw new UpstreamError('storage_schema', 503, 'RSVP storage needs attention.');
    const rowCount = Math.max(table.rows.length, table.oldLength);
    if (rowCount > 20_000) throw new UpstreamError('storage_capacity', 503, 'Please try again later.');
    if (rowCount > properties.gridProperties.rowCount) {
      requests.push({ appendDimension: { sheetId: properties.sheetId, dimension: 'ROWS', length: rowCount - properties.gridProperties.rowCount } });
    }
    requests.push({ updateCells: {
      range: { sheetId: properties.sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: table.rows[0]!.values!.length },
      rows: table.rows, fields: 'userEnteredValue',
    } });
  }
  // One atomic API call commits RSVP, guest changes, summary and idempotency.
  Sheets.Spreadsheets!.batchUpdate({ requests }, sheetId);
}
