'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import type { Department } from '@/lib/types';

export function DepartmentTiles({ departments }: { departments: Department[] }) {
  const { c } = useI18n();
  return (
    <div className="tiles">
      {departments.map((d) => (
        <Link className="tile" key={d.slug} href={`/shop?department=${d.slug}`}>
          {d.imageUrl && <img src={d.imageUrl} alt="" loading="lazy" />}
          <span>{c(d, 'name', d.name)}</span>
        </Link>
      ))}
    </div>
  );
}
