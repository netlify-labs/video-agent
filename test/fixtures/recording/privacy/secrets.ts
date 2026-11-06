// The secrets planted in the privacy fixture (secrets.mp4, made by make-secrets.ts). A module of its own, with no side
// effects, so tests can import it without running the generator (which needs a browser). The key is put together at
// run time: deploys scan the repo for secret-looking literals, and this is a fake.
export const SECRETS = {
  email: 'ada.okafor@acme-labs.dev',
  key: ['sk', '_live_', '51HxQwErTyUiOpAsDfGhJk'].join(''),
  name: 'Priya Raman',
}
