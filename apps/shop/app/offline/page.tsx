import Link from 'next/link';

export const metadata = { title: 'You are offline' };

export default function Offline() {
  return (
    <div className="wrap empty">
      <h1>You&apos;re offline</h1>
      <p className="muted">We can&apos;t reach the shop right now. Your basket is saved on this phone and will be here when you&apos;re back online.</p>
      <Link className="btn" href="/">Try again</Link>
    </div>
  );
}
