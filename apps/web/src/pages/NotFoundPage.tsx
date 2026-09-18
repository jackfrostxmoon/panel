import { useEffect } from 'react';
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  useEffect(() => {
    document.title = 'Page not found · Panel Reader';
  }, []);
  return (
    <div className="page state-view" style={{ minHeight: '60vh' }}>
      <h1 className="state-view__title">Page not found</h1>
      <p className="state-view__label">The page you are looking for does not exist.</p>
      <Link to="/" className="btn btn--primary">
        Back to home
      </Link>
    </div>
  );
}
