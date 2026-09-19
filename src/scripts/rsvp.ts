export async function initRsvp(root: HTMLElement): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.PUBLIC_RSVP_MODE === 'mock') {
    (await import('./rsvp-mock')).initRsvp(root);
  } else {
    await (await import('./rsvp-live')).initRsvp(root);
  }
}
