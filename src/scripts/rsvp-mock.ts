// Explicit development-only preview, never the production RSVP implementation.
import type { CountryCode } from 'libphonenumber-js/max';
import { countryOptions, normalizePhone } from '../lib/phone';
import {
  createPrimary,
  lookupRsvp,
  MockRsvpError,
  RSVP_PREVIEW_FIXTURES,
  saveAdditional,
  savePrimary,
  type AdditionalResponse,
  type GuestResponse,
  type LookupResult,
} from '../lib/mock-rsvp';

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]!));

const optionMarkup = (selected: CountryCode) => countryOptions().map(({ code, callingCode, label }) =>
  `<option value="${code}"${code === selected ? ' selected' : ''}>${escapeHtml(label)} (+${callingCode})</option>`,
).join('');

function phoneFields(prefix: string, country: CountryCode, national = '', required = false, readonly = false): string {
  return `<div class="phone-row">
    <label>Country
      <select name="${prefix}Country" ${readonly ? 'disabled' : ''}>${optionMarkup(country)}</select>
    </label>
    <label>Phone number
      <input name="${prefix}Phone" value="${escapeHtml(national)}" inputmode="tel" autocomplete="tel-national" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''}>
    </label>
  </div>`;
}

function errorMarkup(): string {
  return '<p class="form-error" data-form-error role="alert" aria-live="assertive" tabindex="-1" hidden></p>';
}

function setError(app: HTMLElement, message: string): void {
  const error = app.querySelector<HTMLElement>('[data-form-error]');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
  if (message) error.focus();
}

function readPhone(data: FormData, prefix: string, required: boolean): ReturnType<typeof normalizePhone> {
  const raw = String(data.get(`${prefix}Phone`) ?? '').trim();
  if (!raw && !required) return null;
  const country = String(data.get(`${prefix}Country`) ?? 'IN') as CountryCode;
  return normalizePhone(raw, country);
}

function renderLookup(app: HTMLElement): void {
  app.innerHTML = `<p>Enter your mobile number to RSVP or update an existing response.</p><p>No response is stored after this preview is refreshed.</p>
    <div class="fixture-row" aria-label="Preview fixtures">
      <button type="button" data-fixture="primary">Preview primary guest</button>
      <button type="button" data-fixture="additional">Preview additional guest</button>
      <button type="button" data-fixture="new">Preview new guest</button>
    </div>
    <form data-lookup-form novalidate>
      ${phoneFields('lookup', 'IN', '', true)}
      ${errorMarkup()}
      <button type="submit">Proceed</button>
    </form>`;

  const form = app.querySelector<HTMLFormElement>('[data-lookup-form]')!;
  app.querySelectorAll<HTMLButtonElement>('[data-fixture]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.fixture as keyof typeof RSVP_PREVIEW_FIXTURES;
      const phone = normalizePhone(RSVP_PREVIEW_FIXTURES[key])!;
      const country = form.elements.namedItem('lookupCountry') as HTMLSelectElement;
      const input = form.elements.namedItem('lookupPhone') as HTMLInputElement;
      country.value = phone.country;
      input.value = phone.displayNational;
      input.focus();
    });
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    setError(app, '');
    const phone = readPhone(new FormData(form), 'lookup', true);
    if (!phone) return setError(app, 'Enter a valid phone number.');
    try {
      renderResponse(app, lookupRsvp(phone.e164));
    } catch (error) {
      setError(app, error instanceof Error ? error.message : 'We could not find that invitation.');
    }
  });
}

function guestMarkup(guest: GuestResponse, index: number): string {
  const parsed = guest.phone ? normalizePhone(guest.phone, guest.phoneCountry) : null;
  return `<fieldset class="guest" data-guest data-id="${escapeHtml(guest.id)}">
    <legend>Guest ${index + 1}</legend>
    <label>Full name <input name="guestName" value="${escapeHtml(guest.name)}" autocomplete="name" required></label>
    ${phoneFields('guest', parsed?.country ?? guest.phoneCountry ?? 'IN', parsed?.displayNational ?? '')}
    <p><small>Phone is optional and defaults to India.</small></p>

  </fieldset>`;
}

function primaryForm(app: HTMLElement, response: Extract<LookupResult, { kind: 'primary' | 'new' }>): void {
  const existing = response.kind === 'primary' ? response : null;
  const mainPhone = normalizePhone(response.phone, response.phoneCountry)!;
  const guests = existing?.guests.filter((guest) => guest.active) ?? [];
  const attendance = existing?.attendance ?? 'yes';
  const firstName = existing?.name.trim().split(/\s+/)[0] ?? '';
  const heading = existing ? `Hi, ${escapeHtml(firstName)}.` : 'We found a new invitation';
  app.innerHTML = `<button type="button" class="secondary" data-start-over>← Use another number</button>
    <h3>${heading}</h3>
    ${existing ? '<p>Review your saved response and update anything that has changed.</p>' : `<p>We’ll use ${escapeHtml(mainPhone.e164)} for this response.</p>`}
    <form data-primary-form novalidate>
      <label>Full name <input name="name" value="${escapeHtml(existing?.name ?? '')}" autocomplete="name" required></label>
      ${existing ? phoneFields('primary', mainPhone.country, mainPhone.displayNational, true) : ''}
      <fieldset><legend>Will you attend?</legend><div class="choice">
        <label><input type="radio" name="attendance" value="yes" ${attendance === 'yes' ? 'checked' : ''}> Joyfully attending</label>
        <label><input type="radio" name="attendance" value="no" ${attendance === 'no' ? 'checked' : ''}> Unable to attend</label>
      </div></fieldset>
      <div data-attending-fields ${attendance === 'no' ? 'hidden' : ''}>

        <label>Guests joining you
          <select name="guestCount" data-guest-count>${Array.from({ length: 11 }, (_, value) => `<option value="${value}"${value === guests.length ? ' selected' : ''}>${value}</option>`).join('')}</select>
        </label>
        <div data-guests>${guests.map(guestMarkup).join('')}</div>
      </div>
      <p>Your stay is provided.</p>
      ${errorMarkup()}
      <div class="actions"><button type="submit">Save response</button><span data-busy role="status" aria-live="polite"></span></div>
    </form>`;

  const form = app.querySelector<HTMLFormElement>('[data-primary-form]')!;
  const attending = form.querySelector<HTMLElement>('[data-attending-fields]')!;
  const guestContainer = form.querySelector<HTMLElement>('[data-guests]')!;
  const count = form.querySelector<HTMLSelectElement>('[data-guest-count]')!;
  const setAttendingEnabled = (enabled: boolean) => attending.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]').forEach((field) => { field.disabled = !enabled; });
  form.querySelectorAll<HTMLInputElement>('[name="attendance"]').forEach((radio) => radio.addEventListener('change', () => {
    attending.hidden = radio.checked && radio.value === 'no';
    setAttendingEnabled(!attending.hidden);
  }));
  setAttendingEnabled(attendance === 'yes');
  count.addEventListener('change', () => {
    const target = Number(count.value);
    while (guestContainer.children.length > target) guestContainer.lastElementChild?.remove();
    while (guestContainer.children.length < target) {
      const index = guestContainer.children.length;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = guestMarkup(guests[index] ?? { id: crypto.randomUUID(), name: '', phone: '', phoneCountry: 'IN', active: true }, index);
      guestContainer.append(wrapper.firstElementChild!);
    }
    guestContainer.querySelectorAll<HTMLFieldSetElement>('[data-guest]')[Math.max(0, target - 1)]?.querySelector<HTMLInputElement>('[name="guestName"]')?.focus();
  });
  app.querySelector('[data-start-over]')?.addEventListener('click', () => renderLookup(app));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    setError(app, '');
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const isAttending = data.get('attendance') === 'yes';
    const nextGuests: GuestResponse[] = [];
    if (isAttending) {
      for (const [index, element] of [...guestContainer.querySelectorAll<HTMLElement>('[data-guest]')].entries()) {
        const guestData = new FormData();
        element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]').forEach((field) => guestData.set(field.name, field.value));
        const rawPhone = String(guestData.get('guestPhone') ?? '').trim();
        const phone = rawPhone ? readPhone(guestData, 'guest', false) : null;
        if (rawPhone && !phone) return setError(app, `Guest ${index + 1} has an invalid phone number.`);
        nextGuests.push({
          id: element.dataset.id!, name: String(guestData.get('guestName') ?? '').trim(),
          phone: phone?.e164 ?? '', phoneCountry: phone?.country ?? String(guestData.get('guestCountry') ?? 'IN') as CountryCode,
          active: true,
        });
      }
    }
    const busy = form.querySelector<HTMLElement>('[data-busy]')!;
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    busy.textContent = 'Saving preview…'; submit.disabled = true;
    try {
      const updatedMain = existing ? readPhone(data, 'primary', true) : mainPhone;
      if (!updatedMain) throw new MockRsvpError('invalid', 'Enter a valid phone number.');
      const base = {
        name: String(data.get('name') ?? '').trim(), phone: updatedMain.e164, phoneCountry: updatedMain.country,
        attendance: isAttending ? 'yes' as const : 'no' as const, guests: nextGuests,
      };
      const saved = existing
        ? savePrimary({ ...existing, ...base })
        : createPrimary(base);
      renderSuccess(app, saved.name);
    } catch (error) {
      setError(app, error instanceof MockRsvpError ? error.message : 'The preview could not be saved.');
      busy.textContent = ''; submit.disabled = false;
    }
  });
}

function additionalForm(app: HTMLElement, response: AdditionalResponse): void {
  const phone = normalizePhone(response.phone, response.phoneCountry)!;
  app.innerHTML = `<button type="button" class="secondary" data-start-over>← Use another number</button>
    <h3>Hi, ${escapeHtml(response.name.trim().split(/\s+/)[0] ?? response.name)}.</h3>
    <p>You’re already included in this RSVP. You can update only your own details.</p>
    <form data-additional-form novalidate>
      <label>Full name <input name="name" value="${escapeHtml(response.name)}" autocomplete="name" required></label>
      ${phoneFields('additional', phone.country, phone.displayNational, true)}

      ${errorMarkup()}
      <div class="actions"><button type="submit">Save my details</button><span data-busy role="status" aria-live="polite"></span></div>
    </form>`;
  app.querySelector('[data-start-over]')?.addEventListener('click', () => renderLookup(app));
  const form = app.querySelector<HTMLFormElement>('[data-additional-form]')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault(); setError(app, '');
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const updatedPhone = readPhone(data, 'additional', true);
    if (!updatedPhone) return setError(app, 'Enter a valid phone number.');
    const busy = form.querySelector<HTMLElement>('[data-busy]')!;
    busy.textContent = 'Saving preview…';
    try {
      const saved = saveAdditional({ ...response, phone: updatedPhone.e164, phoneCountry: updatedPhone.country, name: String(data.get('name') ?? '').trim() });
      renderSuccess(app, saved.name);
    } catch (error) {
      setError(app, error instanceof Error ? error.message : 'The preview could not be saved.'); busy.textContent = '';
    }
  });
}

function renderSuccess(app: HTMLElement, name: string): void {
  app.innerHTML = `<div role="status" aria-live="polite"><h3>Thank you, ${escapeHtml(name)}.</h3><p>Your preview response was saved in memory only. Refreshing the page resets it.</p></div>
    <button type="button" class="secondary" data-start-over>Preview another response</button>`;
  app.querySelector('[data-start-over]')?.addEventListener('click', () => renderLookup(app));
}

function renderResponse(app: HTMLElement, result: LookupResult): void {
  if (result.kind === 'additional') additionalForm(app, result);
  else primaryForm(app, result);
}

export function initRsvp(root: HTMLElement): void {
  const app = root.querySelector<HTMLElement>('[data-rsvp-app]');
  if (!app || app.dataset.initialized) return;
  app.dataset.initialized = 'true';
  renderLookup(app);
}
