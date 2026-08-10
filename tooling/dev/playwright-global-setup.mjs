import { health } from './health.mjs';

export default async function globalSetup() {
  await health({ quiet: true });
}
