import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout';
import { Loading, Notice } from './components/ui';
import { useAuth } from './lib/auth';
import { Access } from './pages/Access';
import { Catalogue } from './pages/Catalogue';
import { Home } from './pages/Home';
import { Inventory } from './pages/Inventory';
import { Login } from './pages/Login';
import { Payments } from './pages/Payments';
import { Pos } from './pages/Pos';
import { Procurement } from './pages/Procurement';
import { Returns } from './pages/Returns';

/** Hides a page the person cannot use. This is a courtesy: the server refuses the requests regardless. */
function Needs({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <Notice tone="warn">You do not have access to this page.</Notice>;
}

export function App() {
  const { session, loading } = useAuth();
  if (loading) return <div className="center"><Loading what="your session" /></div>;
  if (!session) return <Routes><Route path="*" element={<Login />} /></Routes>;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="pos" element={<Needs permission="pos.sell"><Pos /></Needs>} />
        <Route path="purchasing" element={<Needs permission="procurement.read"><Procurement /></Needs>} />
        <Route path="returns" element={<Needs permission="pos.refund"><Returns /></Needs>} />
        <Route path="payments" element={<Needs permission="pos.payment.verify"><Payments /></Needs>} />
        <Route path="catalogue" element={<Needs permission="catalog.read"><Catalogue /></Needs>} />
        <Route path="inventory" element={<Needs permission="inventory.read"><Inventory /></Needs>} />
        <Route path="access" element={<Needs permission="iam.manage"><Access /></Needs>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
