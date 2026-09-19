import type { CountryCode } from 'libphonenumber-js/max';
import type { DomainState, PrimaryGuestState, PrimaryPatch, SavePatch, SelfPatch } from '../../server/contracts';
import { countryOptions, normalizePhone } from '../lib/phone';
import { getRsvpConfig, getRsvpState, RsvpApiError, saveRsvp, startRsvpSession } from '../lib/rsvp-api';

interface Turnstile {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: Turnstile } }
let turnstileLoading: Promise<Turnstile> | undefined;
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoading) return turnstileLoading;
  turnstileLoading = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => { script.remove(); reject(new Error('Verification could not load. Please try again.')); }, 15_000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => { clearTimeout(timeout); window.turnstile ? resolve(window.turnstile) : reject(new Error('Verification unavailable.')); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Verification could not load. Please try again.')); };
    document.head.append(script);
  }).catch((error) => { turnstileLoading = undefined; throw error; });
  return turnstileLoading;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const message = '<p data-error role="alert" tabindex="-1" hidden></p><p data-status role="status" aria-live="polite"></p>';
function showError(app: HTMLElement, error: unknown): void {
  const node = app.querySelector<HTMLElement>('[data-error]');
  if (node) { node.textContent = error instanceof Error ? error.message : 'Please try again.'; node.hidden = false; node.focus(); }
}
function phoneFields(country: CountryCode, phone = '', required = true): string {
  const normalized = phone ? normalizePhone(phone, country) : null;
  const selected = normalized?.country ?? country;
  return `<div class="phone-row"><label>Country<select name="country">${countryOptions().map((option) => `<option value="${option.code}"${option.code === selected ? ' selected' : ''}>${escape(option.label)} (+${option.callingCode})</option>`).join('')}</select></label>
    <label>Phone number<input name="phone" inputmode="tel" autocomplete="tel-national" maxlength="64" value="${escape(normalized?.displayNational ?? phone)}"${required ? ' required' : ''}></label></div>`;
}
function details(person?: Partial<PrimaryGuestState>, requiredPhone = true): string {
  return `<label>Full name<input name="name" autocomplete="name" maxlength="120" required value="${escape(person?.name ?? '')}"></label>
    ${phoneFields(person?.country ?? 'IN', person?.phone ?? '', requiredPhone)}
    `;
}
function readDetails(element: HTMLElement, requiredPhone = true) {
  const value = (name: string) => element.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value.trim() ?? '';
  const raw = value('phone');
  const country = value('country') as CountryCode;
  const parsed = raw ? normalizePhone(raw, country) : null;
  if ((raw || requiredPhone) && !parsed) throw new Error('Enter a valid mobile number.');
  return { name: value('name'), phone: parsed?.e164 ?? '', country: parsed?.country ?? country };
}
function changed(before: PrimaryGuestState, after: ReturnType<typeof readDetails>): SelfPatch | undefined {
  const patch: SelfPatch = { guestRevision: before.guestRevision };
  if (before.name !== after.name) patch.name = after.name;
  if (before.phone !== after.phone || before.country !== after.country) { patch.phone = after.phone; patch.country = after.country; }
  return Object.keys(patch).length > 1 ? patch : undefined;
}

async function lookup(app: HTMLElement): Promise<void> {
  app.innerHTML = `<p>Enter your mobile number to RSVP or update an existing response.</p>
    <form data-lookup data-lookup-form>${phoneFields('IN')}<div data-turnstile></div>${message}<button type="submit" disabled>Proceed</button></form>`;
  const form = app.querySelector<HTMLFormElement>('form')!;
  const submit = form.querySelector<HTMLButtonElement>('button')!;
  let token = '';
  let widget: string | undefined;
  let verification: Turnstile | undefined;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const phone = readDetails(form);
      if (!token) throw new Error('Please complete the verification.');
      const result = await startRsvpSession(phone.phone, phone.country, token);
      if (widget !== undefined) verification?.remove(widget);
      renderState(app, result.state);
    } catch (error) {
      token = ''; showError(app, error);
      if (widget !== undefined) verification?.reset(widget);
    }
  });
  try {
    const config = await getRsvpConfig();
    const api = await loadTurnstile();
    if (!form.isConnected) return;
    verification = api;
    widget = api.render(form.querySelector<HTMLElement>('[data-turnstile]')!, {
      sitekey: config.turnstileSiteKey, action: 'rsvp', size: 'flexible',
      callback: (value: string) => { token = value; submit.disabled = false; },
      'expired-callback': () => { token = ''; submit.disabled = true; },
      'error-callback': () => { token = ''; submit.disabled = true; showError(app, new Error('Verification failed. Please retry.')); },
    });
  } catch (error) {
    showError(app, error);
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
    retry.addEventListener('click', () => { if (widget !== undefined) verification?.remove(widget); void lookup(app); }); form.append(retry);
  }
}

function renderState(app: HTMLElement, state: DomainState): void {
  const additional = state.kind === 'additional';
  const primary = state.kind === 'primary' ? state : undefined;
  const firstName = state.kind === 'new' ? '' : escape(state.name.split(/\s+/)[0]!);
  const heading = state.kind === 'new' ? 'Your invitation' : additional ? `Hi, ${firstName}.` : `Welcome back, ${firstName}.`;
  app.innerHTML = `<button type="button" data-restart class="secondary">← Use another number</button><h3>${heading}</h3>
    <p>${state.kind === 'new' ? 'We look forward to hearing from you.' : additional ? 'You’re already included in this RSVP. Review or update your own details below.' : 'Your RSVP is already saved. Review or update it below.'}</p>
    <form data-response><div data-self>${details(state.kind === 'new' ? { phone: state.phone, country: state.country } : state)}</div>
      ${additional ? '' : `<fieldset><legend>Will you attend?</legend><div class="choice"><label><input type="radio" name="attendance" value="yes"${primary?.attendance !== 'no' ? ' checked' : ''}> Joyfully attending</label><label><input type="radio" name="attendance" value="no"${primary?.attendance === 'no' ? ' checked' : ''}> Unable to attend</label></div></fieldset>
      <div data-party><label>Guests joining you<select name="guestCount">${Array.from({ length: 11 }, (_, i) => `<option${i === (primary?.guests.length ?? 0) ? ' selected' : ''}>${i}</option>`).join('')}</select></label><p><small>Adding a guest’s mobile number allows them to review and update their own details later.</small></p><div data-guests></div><p>Your stay is provided.</p></div>`}
      ${message}<button type="submit">${additional ? 'Save my details' : 'Save response'}</button><button type="button" data-reload class="secondary" hidden>Reload saved response (discard these edits)</button></form>`;
  app.querySelector('[data-restart]')?.addEventListener('click', () => { void lookup(app); });
  const form = app.querySelector<HTMLFormElement>('form')!;
  const self = form.querySelector<HTMLElement>('[data-self]')!;
  if (state.kind === 'new') {
    self.querySelector<HTMLInputElement>('[name="phone"]')!.readOnly = true;
    self.querySelector<HTMLSelectElement>('[name="country"]')!.disabled = true;
  }
  const container = form.querySelector<HTMLElement>('[data-guests]');
  const count = form.querySelector<HTMLSelectElement>('[name="guestCount"]');
  const fillGuests = () => {
    if (!container || !count) return;
    while (container.children.length > Number(count.value)) container.lastElementChild!.remove();
    while (container.children.length < Number(count.value)) {
      const index = container.children.length;
      const guest = primary?.guests[index];
      const field = document.createElement('fieldset'); field.dataset.guest = guest?.guestId ?? '';
      field.innerHTML = `<legend>Guest ${index + 1}</legend>${details(guest, false)}`;
      container.append(field);
    }
  };
  const updateAttendance = () => {
    const attending = form.querySelector<HTMLInputElement>('[name="attendance"]:checked')?.value !== 'no';
    const party = form.querySelector<HTMLElement>('[data-party]');
    if (party) { party.hidden = !attending; party.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select,textarea').forEach((input) => { input.disabled = !attending; }); }
  };
  fillGuests(); updateAttendance();
  count?.addEventListener('change', fillGuests);
  form.querySelectorAll('[name="attendance"]').forEach((input) => input.addEventListener('change', updateAttendance));
  let pending: { payload: string; operationId: string } | undefined;
  const reload = form.querySelector<HTMLButtonElement>('[data-reload]')!;
  reload.addEventListener('click', async () => {
    reload.disabled = true;
    try { renderState(app, (await getRsvpState()).state); } catch (error) { showError(app, error); reload.disabled = false; }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    const status = form.querySelector<HTMLElement>('[data-status]')!;
    form.querySelector<HTMLElement>('[data-error]')!.hidden = true;
    try {
      const personal = readDetails(self);
      const attendance = form.querySelector<HTMLInputElement>('[name="attendance"]:checked')?.value === 'no' ? 'no' : 'yes';
      let patch: SavePatch;
      if (state.kind === 'additional') {
        const selfPatch = changed(state, personal);
        if (!selfPatch) { status.textContent = 'Your details are already up to date.'; return; }
        patch = { kind: 'additional', ...selfPatch };
      } else if (state.kind === 'new') {
        patch = { kind: 'new', name: personal.name, attendance,
          guests: attendance === 'yes' ? [...container!.children].map((element) => readDetails(element as HTMLElement, false)) : [] };
      } else {
        const primaryPatch: PrimaryPatch = { kind: 'primary' };
        const selfPatch = changed(state, personal);
        if (selfPatch) primaryPatch.self = selfPatch;
        if (state.attendance !== attendance) primaryPatch.attendance = attendance;
        const fields = attendance === 'yes' ? [...container!.children] as HTMLElement[] : [];
        const upserts: NonNullable<PrimaryPatch['upserts']> = [];
        for (const element of fields) {
          const old = state.guests.find((guest) => guest.guestId === element.dataset.guest);
          const value = readDetails(element, false);
          if (!old) upserts.push(value);
          else { const delta = changed(old, value); if (delta) upserts.push({ guestId: old.guestId, ...delta }); }
        }
        if (upserts.length) primaryPatch.upserts = upserts;
        const removals = state.guests.filter((guest) => !fields.some((field) => field.dataset.guest === guest.guestId)).map(({ guestId, guestRevision }) => ({ guestId, guestRevision }));
        if (removals.length) primaryPatch.removals = removals;
        if (primaryPatch.attendance || primaryPatch.upserts || primaryPatch.removals) primaryPatch.partyRevision = state.partyRevision;
        if (Object.keys(primaryPatch).length === 1) { status.textContent = 'Your RSVP is already up to date.'; return; }
        patch = primaryPatch;
      }
      const payload = JSON.stringify(patch);
      if (!pending || pending.payload !== payload) pending = { payload, operationId: crypto.randomUUID() };
      status.textContent = 'Saving…';
      const saved = await saveRsvp(pending.operationId, patch);
      app.innerHTML = `<div role="status"><h3>Thank you${saved.state.kind !== 'new' ? `, ${escape(saved.state.name.split(/\s+/)[0]!)}` : ''}.</h3><p>Your response is saved.</p></div><button type="button" data-review>Review saved response</button>`;
      app.querySelector('[data-review]')!.addEventListener('click', async () => {
        try { renderState(app, (await getRsvpState()).state); }
        catch { void lookup(app); }
      });
    } catch (error) {
      status.textContent = ''; showError(app, error);
      if (error instanceof RsvpApiError && error.code === 'conflict') reload.hidden = false;
    } finally { submit.disabled = false; }
  });
}

export async function initRsvp(root: HTMLElement): Promise<void> {
  const app = root.querySelector<HTMLElement>('[data-rsvp-app]');
  if (!app || app.dataset.initialized) return;
  app.dataset.initialized = 'true';
  await lookup(app);
}
