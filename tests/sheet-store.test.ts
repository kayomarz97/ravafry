import assert from 'node:assert/strict';
import { decodeRows, encodeRows, literalCell, TABLES, writeSnapshot } from '../apps-script/sheet-store';
import type { DomainSnapshot } from '../server/contracts';

const formula = '=IMPORTXML("https://example.invalid", "//x")';
assert.deepEqual(literalCell(formula), { userEnteredValue: { stringValue: formula } });
assert.deepEqual(literalCell('+919876543210'), { userEnteredValue: { stringValue: '+919876543210' } });
assert.deepEqual(literalCell(false), { userEnteredValue: { boolValue: false } });
assert.throws(() => decodeRows('Guests', [['wrong schema']]));
const empty: DomainSnapshot = { rsvps: [], guests: [], operations: [] };
assert.deepEqual(decodeRows('RSVPs', [TABLES.RSVPs.headings]), []);
assert.equal(encodeRows('Operations', []).length, 1);

let commits = 0;
let requests: GoogleAppsScript.Sheets.Schema.Request[] = [];
Object.assign(globalThis, { Sheets: { Spreadsheets: {
  get: () => ({ sheets: ['RSVPs', 'Guests', 'Operations', 'RSVP Summary'].map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 1000 } } })) }),
  batchUpdate: (input: { requests: GoogleAppsScript.Sheets.Schema.Request[] }) => { commits++; requests = input.requests; },
} } });
writeSnapshot('fictional-sheet', empty, empty);
assert.equal(commits, 1, 'all tables commit in a single batch');
assert.equal(requests.length, 4);
assert.equal(requests.every((request) => request.updateCells?.fields === 'userEnteredValue'), true);
const staleOperations = { ...empty, operations: Array.from({ length: 9 }, () => ({})) } as DomainSnapshot;
writeSnapshot('fictional-sheet', staleOperations, empty);
assert.equal(requests[2]?.updateCells?.range?.endRowIndex, 10, 'clear pruned operation rows atomically');
assert.equal(requests[2]?.updateCells?.rows?.length, 1);
