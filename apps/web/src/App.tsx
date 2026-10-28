import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout';
import { Loading, Notice } from './components/ui';
import { useEffect, useState } from 'react';
import { useAuth } from './lib/auth';
import { linkTokenFromHash } from './lib/identity';
import { Access } from './pages/Access';
import { Accounts } from './pages/accounting/Accounts';
import { Journals } from './pages/accounting/Journals';
import { AccountingLayout } from './pages/accounting/Layout';
import { Periods } from './pages/accounting/Periods';
import { Rates } from './pages/accounting/Rates';
import { TrialBalance } from './pages/accounting/TrialBalance';
import { Catalogue } from './pages/Catalogue';
import { Home } from './pages/Home';
import { Inventory } from './pages/Inventory';
import { Login } from './pages/Login';
import { Payments } from './pages/Payments';
import { Boms } from './pages/manufacturing/Boms';
import { ManufacturingLayout } from './pages/manufacturing/Layout';
import { Quality } from './pages/manufacturing/Quality';
import { WorkOrders } from './pages/manufacturing/WorkOrders';
import { Pos } from './pages/Pos';
import { SetPassword } from './pages/SetPassword';
import { Procurement } from './pages/Procurement';
import { Returns } from './pages/Returns';
import { Collections } from './pages/Collections';
import { Enquiries } from './pages/Enquiries';
import { OfflineExceptions } from './pages/OfflineExceptions';
import { Orders } from './pages/Orders';
import { Quotes } from './pages/Quotes';
import { Reviews } from './pages/Reviews';
import { StandingOrders } from './pages/StandingOrders';
import { Setup } from './pages/Setup';
import { TradeAccounts } from './pages/TradeAccounts';
import { Store } from './pages/Store';
import { Stock } from './pages/stock/Stock';

/** Hides a page the person cannot use. This is a courtesy: the server refuses the requests regardless. */
function Needs({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <Notice tone="warn">You do not have access to this page.</Notice>;
}

export function App() {
  const { session, loading } = useAuth();
  // A one-time token from a reset or invitation email is kept in memory only and removed from the address bar.
  const [linkToken, setLinkToken] = useState(() => linkTokenFromHash(window.location.hash));
  useEffect(() => { if (linkToken) history.replaceState(null, '', window.location.pathname); }, [linkToken]);
  if (linkToken) return <SetPassword linkToken={linkToken} onDone={() => setLinkToken(null)} />;
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
        <Route path="orders" element={<Needs permission="orders.read"><Orders /></Needs>} />
        <Route path="enquiries" element={<Needs permission="enquiries.manage"><Enquiries /></Needs>} />
        <Route path="reviews" element={<Needs permission="reviews.moderate"><Reviews /></Needs>} />
        <Route path="trade" element={<Needs permission="trade.manage"><TradeAccounts /></Needs>} />
        <Route path="standing-orders" element={<Needs permission="trade.manage"><StandingOrders /></Needs>} />
        <Route path="quotes" element={<Needs permission="quotes.manage"><Quotes /></Needs>} />
        <Route path="collections" element={<Needs permission="trade.manage"><Collections /></Needs>} />
        <Route path="till-exceptions" element={<Needs permission="inventory.adjust"><OfflineExceptions /></Needs>} />
        <Route path="store" element={<Needs permission="storefront.manage"><Store /></Needs>} />
        <Route path="setup" element={<Needs permission="org.manage"><Setup /></Needs>} />
        <Route path="catalogue" element={<Needs permission="catalog.read"><Catalogue /></Needs>} />
        <Route path="stock" element={<Needs permission="inventory.read"><Stock /></Needs>} />
        <Route path="inventory" element={<Needs permission="inventory.read"><Inventory /></Needs>} />
        <Route path="accounting" element={<Needs permission="accounting.read"><AccountingLayout /></Needs>}>
          <Route index element={<Navigate to="journals" replace />} />
          <Route path="journals" element={<Journals />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="trial-balance" element={<TrialBalance />} />
          <Route path="periods" element={<Periods />} />
          <Route path="rates" element={<Rates />} />
        </Route>
        <Route path="manufacturing" element={<Needs permission="manufacturing.read"><ManufacturingLayout /></Needs>}>
          <Route index element={<Navigate to="work-orders" replace />} />
          <Route path="work-orders" element={<WorkOrders />} />
          <Route path="boms" element={<Boms />} />
          <Route path="quality" element={<Quality />} />
        </Route>
        <Route path="access" element={<Needs permission="iam.manage"><Access /></Needs>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
