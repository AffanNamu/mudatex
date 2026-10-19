import { useMemo } from 'react';
import { ErrorBanner, Loading, PageHeader } from '../components/ui';
import { useLoad } from '../lib/hooks';

interface User { id: string; email: string; displayName: string; status: string }
interface Membership { id: string; userId: string; roleKey: string; scopeType: string; scopeId: string | null; scopeCountry: string | null; validUntil: string | null }
interface Role { id: string; key: string; name: string; permissions: string[] }

export function Access() {
  const users = useLoad<User[]>('/v1/users');
  const memberships = useLoad<Membership[]>('/v1/memberships');
  const roles = useLoad<Role[]>('/v1/roles');
  const locations = useLoad<{ id: string; name: string }[]>('/v1/locations');
  const entities = useLoad<{ id: string; name: string }[]>('/v1/legal-entities');
  const names = useMemo(() => new Map([...(locations.data ?? []), ...(entities.data ?? [])].map((x) => [x.id, x.name])), [locations.data, entities.data]);
  const roleBy = useMemo(() => new Map((roles.data ?? []).map((r) => [r.key, r])), [roles.data]);
  const byUser = useMemo(() => {
    const m = new Map<string, Membership[]>();
    for (const x of memberships.data ?? []) m.set(x.userId, [...(m.get(x.userId) ?? []), x]);
    return m;
  }, [memberships.data]);
  const scopeLabel = (m: Membership) => m.scopeType === 'group' ? 'whole organization' : m.scopeType === 'country' ? `country ${m.scopeCountry}` : `${m.scopeType.replace('_', ' ')} ${names.get(m.scopeId ?? '') ?? ''}`.trim();

  return (
    <>
      <PageHeader title="People & access" />
      <ErrorBanner error={users.error ?? memberships.error ?? roles.error} />
      {users.loading ? <Loading what="people" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">People and what they can do</caption>
            <thead><tr><th scope="col">Person</th><th scope="col">Status</th><th scope="col">Access</th></tr></thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <th scope="row">{u.displayName}<div className="muted small">{u.email}</div></th>
                  <td><span className={`chip ${u.status === 'active' ? 'chip-ok' : 'chip-warn'}`}>{u.status}</span></td>
                  <td>
                    {(byUser.get(u.id) ?? []).map((m) => (
                      <div key={m.id}>
                        <strong title={(roleBy.get(m.roleKey)?.permissions ?? []).join(', ')}>{roleBy.get(m.roleKey)?.name ?? m.roleKey}</strong>
                        <span className="muted"> · {scopeLabel(m)}{m.validUntil ? ` · until ${new Date(m.validUntil).toLocaleDateString()}` : ''}</span>
                      </div>
                    ))}
                    {!byUser.get(u.id)?.length && <span className="muted">No access</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">This view is read-only. Roles are granted through the API for now.</p>
    </>
  );
}
