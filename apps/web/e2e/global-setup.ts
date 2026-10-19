import seed from './seed';

export default async function globalSetup() {
  await seed();
}
