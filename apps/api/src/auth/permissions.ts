/** Every permission a role may hold. Roles are validated against this list. */
export const PERMISSIONS = [
  'org.read',
  'org.manage',
  'iam.manage',
  'catalog.read',
  'catalog.write',
  'audit.read',
  'inventory.read',
  'inventory.receive',
  'inventory.issue',
  'inventory.transfer',
  'inventory.reserve',
  'inventory.split',
  'inventory.adjust',
  'inventory.adjust.approve',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);
