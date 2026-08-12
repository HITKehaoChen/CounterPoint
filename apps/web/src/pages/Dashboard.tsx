import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '../../../../src/schemas.ts';
import { api } from '../api.ts';

export default function Dashboard() {
  const [workspaces, setWorkspaces] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const result = await api.listProjects();
      setWorkspaces(result.projects);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createWorkspace = async () => {
    if (!name.trim()) {
      setError('工作空间名称必填');
      return;
    }
    setBusy(true);
    try {
      await api.createProject({ name, description: description.trim() || undefined });
      setName('');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dashboard">
      <section className="panel">
        <h2>新建工作空间</h2>
        <p className="muted">工作空间是长期存在的项目现实容器，里面承载所有工作项。</p>
        <div className="form-row">
          <label>
            名称
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label>
            说明
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
            />
          </label>
        </div>
        <button
          className="button button-primary"
          disabled={busy}
          onClick={() => void createWorkspace()}
        >
          创建工作空间
        </button>
      </section>

      {error && <div className="error-banner">{error}</div>}

      <h2>工作空间</h2>
      {workspaces.length === 0 && <p className="muted">暂无工作空间，先创建一个开始。</p>}
      <div className="project-grid">
        {workspaces.map((workspace) => (
          <article key={workspace.id} className="project-card">
            <header className="project-card-head">
              <h3>{workspace.name}</h3>
              {workspace.archivedAt && <span className="status-tag">已归档</span>}
            </header>
            {workspace.description && <p>{workspace.description}</p>}
            <p className="muted">
              数据源 {workspace.sourceBindings.length} 个 · 创建于{' '}
              {new Date(workspace.createdAt).toLocaleDateString()}
            </p>
            <Link className="button button-primary" to={`/workspaces/${workspace.id}`}>
              进入工作空间
            </Link>
            <Link className="button" to={`/workspaces/${workspace.id}/items/new`}>
              新建工作项
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
}
