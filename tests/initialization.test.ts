import assert from 'node:assert/strict';
import { initializeRsvp, refreshEmptyRsvpSchema } from '../apps-script/main';

function fixture(options: { storedId?: string; tab?: string; rows?: number; secret?: string; fail?: boolean; busy?: boolean } = {}) {
  const properties = new Map<string, string>([['RSVP_SHARED_SECRET', options.secret ?? 'a'.repeat(64)]]);
  if (options.storedId) properties.set('RSVP_SHEET_ID', options.storedId);
  let commits = 0;
  let releases = 0;
  let requests: GoogleAppsScript.Sheets.Schema.Request[] = [];
  let title = options.tab ?? 'Sheet1';
  Object.assign(globalThis, {
    LockService: { getScriptLock: () => ({ tryLock: () => !options.busy, releaseLock: () => { releases++; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key: string) => properties.get(key) ?? null, setProperty: (key: string, value: string) => properties.set(key, value) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getId: () => 'test-sheet', getSheets: () => [{ getName: () => title, getLastRow: () => options.rows ?? 0 }] }) },
    Sheets: { Spreadsheets: {
      get: () => ({ sheets: [{ properties: { sheetId: 0 } }] }),
      batchUpdate: (input: { requests: GoogleAppsScript.Sheets.Schema.Request[] }, id: string) => {
        assert.equal(id, 'test-sheet');
        if (options.fail) throw new Error('Simulated batch failure');
        commits++; requests = input.requests; title = 'RSVP Summary';
      },
    } },
  });
  return { properties, get commits() { return commits; }, get releases() { return releases; }, get requests() { return requests; } };
}

for (const storedId of [undefined, 'test-sheet']) {
  const state = fixture({ storedId });
  initializeRsvp();
  assert.equal(state.commits, 1);
  assert.equal(state.releases, 1);
  assert.equal(state.properties.get('RSVP_SHEET_ID'), 'test-sheet');
  assert.deepEqual(state.requests.filter(r => r.addSheet).map(r => r.addSheet!.properties!.title), ['RSVPs', 'Guests', 'Operations']);
  assert.equal(state.requests.find(r => r.addSheet?.properties?.title === 'Operations')?.addSheet?.properties?.hidden, true);
  assert.throws(initializeRsvp, /already exists/);
  assert.equal(state.commits, 1, 'repeat initialization must not overwrite storage');
}
for (const options of [{ storedId: 'different-sheet' }, { rows: 1 }, { tab: 'Guests' }, { secret: 'invalid' }, { fail: true }]) {
  const state = fixture(options);
  assert.throws(initializeRsvp);
  assert.equal(state.commits, 0);
  assert.equal(state.releases, 1);
  assert.equal(state.properties.get('RSVP_SHEET_ID'), options.storedId);
}
const busy = fixture({ busy: true });
assert.throws(initializeRsvp, /busy/);
assert.equal(busy.commits, 0);
assert.equal(busy.releases, 0);

for (const dataRows of [0, 1]) {
  const state = fixture({ storedId: 'test-sheet' });
  Object.assign(globalThis, { SpreadsheetApp: { getActiveSpreadsheet: () => ({
    getId: () => 'test-sheet',
    getSheets: () => ['RSVPs', 'Guests', 'Operations', 'RSVP Summary'].map((title, id) => ({
      getName: () => title, getSheetId: () => id, getLastRow: () => 1 + dataRows, getMaxColumns: () => 20,
    })),
  }) } });
  if (dataRows) assert.throws(refreshEmptyRsvpSchema, /no data rows/);
  else {
    refreshEmptyRsvpSchema();
    assert.equal(state.requests.length, 4);
    assert.equal(state.requests[1]?.updateCells?.range?.endColumnIndex, 20, 'clear obsolete header cells');
    assert.equal(state.requests[1]?.updateCells?.rows?.[0]?.values?.length, 13);
  }
  assert.equal(state.commits, dataRows ? 0 : 1);
  assert.equal(state.releases, 1);
}
