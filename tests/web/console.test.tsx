import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StateBadge } from '../../apps/web/src/components/StateBadge.tsx';
import { CandidateView } from '../../apps/web/src/components/CandidateView.tsx';
import { HumanGatePanel } from '../../apps/web/src/components/HumanGatePanel.tsx';
import { Wizard } from '../../apps/web/src/pages/Wizard.tsx';
import type { HumanPosition } from '../../src/human-view.ts';

const POSITION: HumanPosition = {
  id: 'pos_1',
  label: '候选 X',
  summary: 'Use synchronous calls: simpler rollback and testability.',
  claims: [
    {
      id: 'claim_1',
      statement: 'Synchronous calls preserve transactional rollback.',
      type: 'fact',
      evidenceRefs: [],
      confidence: 0.8,
    },
  ],
  unknowns: ['Peak load is not measured'],
  decisionConditions: [],
  confidence: 0.7,
  commitmentHash: 'hash-abc',
  artifactRefs: ['design-a@v1'],
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('StateBadge', () => {
  it('renders icon and text together, not color alone', () => {
    render(<StateBadge state="blind_run" />);
    expect(screen.getByText('▶')).toBeTruthy();
    expect(screen.getByText('盲态运行中')).toBeTruthy();
  });
});

describe('CandidateView', () => {
  it('hides all candidate content before reveal', () => {
    render(<CandidateView positions={[POSITION]} revealed={false} />);
    expect(
      screen.getByText(/候选正文将在全部 Worker 提交并披露后展示/),
    ).toBeTruthy();
    expect(screen.queryByText('Use synchronous calls')).toBeNull();
    expect(screen.queryByText('Synchronous calls preserve transactional rollback.')).toBeNull();
  });

  it('shows anonymous X/Y candidates after reveal', () => {
    render(<CandidateView positions={[POSITION]} revealed />);
    expect(screen.getByText('候选 X')).toBeTruthy();
    expect(screen.getByText(/Use synchronous calls/)).toBeTruthy();
    expect(screen.getByText(/Synchronous calls preserve transactional rollback\./)).toBeTruthy();
  });
});

describe('HumanGatePanel', () => {
  it('shows the decision form only in reviewing/escalated and always lists unresolved conflicts', () => {
    const onSubmit = vi.fn();
    const { unmount } = render(
      <HumanGatePanel
        state="draft"
        unresolvedConflicts={['Load testing evidence is missing']}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.queryByText('提交决策')).toBeNull();
    expect(screen.queryByText('Load testing evidence is missing')).toBeNull();
    unmount();

    render(
      <HumanGatePanel
        state="reviewing"
        unresolvedConflicts={['Load testing evidence is missing']}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText('提交决策')).toBeTruthy();
    expect(screen.getByText(/Load testing evidence is missing/)).toBeTruthy();
  });

  it('submits the selected action with rationale', () => {
    const onSubmit = vi.fn();
    render(
      <HumanGatePanel
        state="escalated"
        unresolvedConflicts={[]}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText('决策理由'), { target: { value: 'Accept candidate X.' } });
    fireEvent.click(screen.getByText('提交决策'));
    expect(onSubmit).toHaveBeenCalledWith({ action: 'approve', rationale: 'Accept candidate X.' });
  });
});

describe('Wizard', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/work-items')) {
          return jsonResponse(400, {
            error: { code: 400, message: 'title is required' },
          });
        }
        return jsonResponse(404, { error: { code: 404, message: 'not found' } });
      }),
    );
  });

  it('shows API validation errors when creating a work item', async () => {
    render(
      <MemoryRouter initialEntries={['/workspaces/prj_1/items/new']}>
        <Routes>
          <Route path="/workspaces/:id/items/new" element={<Wizard />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('创建工作项'));
    await waitFor(() => {
      expect(screen.getByText(/title is required/)).toBeTruthy();
    });
  });
});
