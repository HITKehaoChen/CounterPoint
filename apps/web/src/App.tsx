import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import Dashboard from './pages/Dashboard.tsx';
import { Wizard } from './pages/Wizard.tsx';
import WorkspacePage from './pages/WorkspacePage.tsx';
import WorkItemPage from './pages/WorkItemPage.tsx';
import RoundView from './pages/RoundView.tsx';
import PackViewer from './pages/PackViewer.tsx';
import { api } from './api.ts';

export function LegacyProjectRedirect() {
  const { projectId } = useParams();
  return <Navigate to={`/workspaces/${projectId}/items/new`} replace />;
}

export function LegacyDeliberationRedirect() {
  const { id } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    let disposed = false;
    void api
      .getDeliberation(id!)
      .then((view) => {
        if (disposed) return;
        const itemId = view.deliberation.workItemId;
        if (itemId) {
          navigate(`/workspaces/${view.deliberation.projectId}/items/${itemId}/rounds/${id}`, {
            replace: true,
          });
        } else {
          navigate(`/workspaces/${view.deliberation.projectId}`, { replace: true });
        }
      })
      .catch(() => {
        if (!disposed) navigate('/', { replace: true });
      });
    return () => {
      disposed = true;
    };
  }, [id, navigate]);
  return <div className="loading">正在跳转…</div>;
}

export function LegacyPackRedirect() {
  const { id } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    let disposed = false;
    void api
      .getDeliberation(id!)
      .then((view) => {
        if (disposed) return;
        const itemId = view.deliberation.workItemId;
        if (itemId) {
          navigate(
            `/workspaces/${view.deliberation.projectId}/items/${itemId}/rounds/${id}/pack`,
            { replace: true },
          );
        } else {
          navigate(`/workspaces/${view.deliberation.projectId}`, { replace: true });
        }
      })
      .catch(() => {
        if (!disposed) navigate('/', { replace: true });
      });
    return () => {
      disposed = true;
    };
  }, [id, navigate]);
  return <div className="loading">正在跳转…</div>;
}

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="app-brand" href="/">
          Counterpoint 复调
        </a>
        <span className="app-tagline">独立判断，共享证据。</span>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/workspaces/:id" element={<WorkspacePage />} />
          <Route path="/workspaces/:id/items/new" element={<Wizard />} />
          <Route path="/workspaces/:id/items/:itemId" element={<WorkItemPage />} />
          <Route path="/workspaces/:id/items/:itemId/rounds/:roundId" element={<RoundView />} />
          <Route
            path="/workspaces/:id/items/:itemId/rounds/:roundId/pack"
            element={<PackViewer />}
          />
          <Route path="/projects/:projectId/deliberations/new" element={<LegacyProjectRedirect />} />
          <Route path="/deliberations/:id" element={<LegacyDeliberationRedirect />} />
          <Route path="/deliberations/:id/pack" element={<LegacyPackRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
