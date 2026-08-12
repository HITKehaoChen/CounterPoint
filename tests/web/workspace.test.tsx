import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import WorkspacePage from '../../apps/web/src/pages/WorkspacePage.tsx';
import WorkItemPage from '../../apps/web/src/pages/WorkItemPage.tsx';
import { Wizard } from '../../apps/web/src/pages/Wizard.tsx';
import { LegacyDeliberationRedirect } from '../../apps/web/src/App.tsx';
import type { HumanView, HumanWorkItemView } from '../../src/human-view.ts';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const BOARD = {
  board: {
    groups: {
      problem: [],
      requirement: [],
      bug: [
        {
          id: 'wi_1',
          title: 'Ledger call hangs on outage',
          kind: 'bug',
          status: 'investigating',
          updatedAt: '2026-08-12T03:00:00.000Z',
          roundCount: 1,
        },
      ],
      hypothesis: [],
      decision: [],
    },
  },
};

const KNOWLEDGE = {
  knowledge: {
    promotedClaims: [
      {
        workItemId: 'wi_1',
        workItemTitle: 'Ledger call hangs on outage',
        claimId: 'e_1',
        statement: 'The ledger RPC has no timeout.',
      },
    ],
    knowledgeRefs: [
      {
        workItemId: 'wi_1',
        workItemTitle: 'Ledger call hangs on outage',
        ref: { ref: 'evidence:ev_1', scope: 'module', status: 'verified' },
      },
    ],
  },
};

const PROJECT = {
  project: {
    id: 'prj_1',
    name: 'Billing Workspace',
    description: 'Ledger integration',
    sourceBindings: [],
    createdAt: '2026-08-12T00:00:00.000Z',
  },
};

const WORK_ITEM: HumanWorkItemView = {
  id: 'wi_1',
  workspaceId: 'prj_1',
  kind: 'bug',
  title: 'Ledger call hangs on outage',
  description: 'Reproduce: stop ledger, call billing API.',
  ownerId: 'human-owner',
  status: 'investigating',
  templateFields: { reproSteps: '1. stop ledger' },
  currentConclusionRefs: ['position:p_1'],
  knowledgeRefs: [{ ref: 'evidence:ev_1', scope: 'module', status: 'verified' }],
  relations: [{ relation: 'related_to', targetRef: 'wi_2' }],
  entries: [
    {
      id: 'e_1',
      kind: 'claim',
      statement: 'The ledger RPC has no timeout.',
      status: 'promoted',
      evidenceRefs: [],
      author: 'human-owner',
      createdAt: '2026-08-12T01:00:00.000Z',
    },
    {
      id: 'e_2',
      kind: 'update',
      text: 'Reproduced twice.',
      author: 'worker-a',
      createdAt: '2026-08-12T02:00:00.000Z',
    },
  ],
  rounds: [
    {
      deliberationId: 'delib_1',
      state: 'decided',
      createdAt: '2026-08-12T00:30:00.000Z',
      decidedAt: '2026-08-12T01:00:00.000Z',
      recommendation: 'candidate_a',
    },
  ],
  version: 2,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T03:00:00.000Z',
};

const ROUND_VIEW = {
  deliberation: { projectId: 'prj_1', workItemId: 'wi_1', state: 'decided' },
} as unknown as HumanView;

function mockFetch(routes: Array<{ match: (url: string) => boolean; body: unknown; status?: number }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      for (const route of routes) {
        if (route.match(url)) return jsonResponse(route.status ?? 200, route.body);
      }
      return jsonResponse(404, { error: { code: 404, message: `not found: ${url}` } });
    }),
  );
}

describe('WorkspacePage', () => {
  it('renders the work item board grouped by kind with links', async () => {
    mockFetch([
      { match: (url) => url.endsWith('/api/projects/prj_1'), body: PROJECT },
      { match: (url) => url.includes('/work-items'), body: BOARD },
      { match: (url) => url.endsWith('/knowledge'), body: KNOWLEDGE },
    ]);
    render(
      <MemoryRouter initialEntries={['/workspaces/prj_1']}>
        <Routes>
          <Route path="/workspaces/:id" element={<WorkspacePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Billing Workspace')).toBeTruthy();
    expect(screen.getByText('Ledger call hangs on outage')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Ledger call hangs on outage/ });
    expect(link.getAttribute('href')).toContain('/workspaces/prj_1/items/wi_1');
    expect(screen.getByText('决策档案')).toBeTruthy();
    expect(screen.getByText('知识')).toBeTruthy();
    expect(screen.getByText('The ledger RPC has no timeout.')).toBeTruthy();
  });
});

describe('WorkItemPage', () => {
  it('shows overview, collaboration stream, knowledge and round history', async () => {
    mockFetch([
      { match: (url) => url.endsWith('/api/work-items/wi_1'), body: { workItem: WORK_ITEM } },
    ]);
    render(
      <MemoryRouter initialEntries={['/workspaces/prj_1/items/wi_1']}>
        <Routes>
          <Route path="/workspaces/:id/items/:itemId" element={<WorkItemPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Ledger call hangs on outage')).toBeTruthy();
    expect(screen.getByText('当前结论')).toBeTruthy();
    expect(screen.getAllByText('The ledger RPC has no timeout.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Reproduced twice.')).toBeTruthy();
    expect(screen.getByText('evidence:ev_1')).toBeTruthy();
    const roundLink = screen.getByRole('link', { name: /delib_1/ });
    expect(roundLink.getAttribute('href')).toContain('/rounds/delib_1');
    expect(screen.getByText('发起深度研究')).toBeTruthy();
    expect(screen.getByText('邀请 Agent 分析')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加关联' })).toBeTruthy();
  });
});

describe('New WorkItem Wizard', () => {
  it('switches template fields by kind', () => {
    render(
      <MemoryRouter initialEntries={['/workspaces/prj_1/items/new']}>
        <Routes>
          <Route path="/workspaces/:id/items/new" element={<Wizard />} />
        </Routes>
      </MemoryRouter>,
    );
    const kindSelect = screen.getByLabelText('类型');
    fireEvent.change(kindSelect, { target: { value: 'bug' } });
    expect(screen.getByText('复现步骤')).toBeTruthy();
    fireEvent.change(kindSelect, { target: { value: 'hypothesis' } });
    expect(screen.getByText('预测')).toBeTruthy();
  });
});

describe('LegacyDeliberationRedirect', () => {
  it('redirects an old deliberation URL into the workspace item round URL', async () => {
    mockFetch([
      {
        match: (url) => url.endsWith('/api/deliberations/delib_1'),
        body: ROUND_VIEW,
      },
    ]);
    function Probe() {
      const location = useLocation();
      return <div data-testid="probe">{location.pathname}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/deliberations/delib_1']}>
        <Routes>
          <Route path="/deliberations/:id" element={<LegacyDeliberationRedirect />} />
          <Route
            path="/workspaces/:projectId/items/:itemId/rounds/:roundId"
            element={<Probe />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toContain(
        '/workspaces/prj_1/items/wi_1/rounds/delib_1',
      );
    });
  });
});
