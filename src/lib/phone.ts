import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';

export interface NormalizedPhone {
  country: CountryCode;
  countryCallingCode: string;
  e164: string;
  national: string;
  displayNational: string;
}

export interface CountryOption {
  code: CountryCode;
  callingCode: string;
  label: string;
}

export function normalizePhone(input: string, defaultCountry: CountryCode = 'IN'): NormalizedPhone | null {
  const value = input.trim();
  if (!value || value.length > 64 || !getCountries().includes(defaultCountry)) return null;

  const options = { defaultCountry, extract: false as const };
  let parsed = parsePhoneNumberFromString(value, options);

  // A common paste into a national field is `91…` instead of `+91…`.
  // Let libphonenumber validate both interpretations; don't trim the prefix manually.
  if ((!parsed || !parsed.isValid()) && !value.startsWith('+')) {
    const digits = value.replace(/[\s().-]/g, '');
    if (digits.startsWith(getCountryCallingCode(defaultCountry))) {
      parsed = parsePhoneNumberFromString(`+${digits}`, { extract: false });
    }
  }

  if (!parsed?.isValid() || !parsed.country || parsed.ext) return null;
  return {
    country: parsed.country,
    countryCallingCode: parsed.countryCallingCode,
    e164: parsed.number,
    national: parsed.nationalNumber,
    displayNational: parsed.formatNational(),
  };
}

export function countryOptions(locale = 'en'): CountryOption[] {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  return getCountries()
    .map((code) => ({
      code,
      callingCode: getCountryCallingCode(code),
      label: names.of(code) ?? code,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}
