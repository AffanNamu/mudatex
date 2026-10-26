import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="wrap empty">
      <h1>We couldn&apos;t find that</h1>
      <p className="muted">It may have sold out or moved.</p>
      <Link className="btn" href="/shop">Browse the shop</Link>
    </div>
  );
}
