/**
 * @jest-environment jsdom
 */
// src/__tests__/permission-gate.test.tsx
// Unit tests for PermissionGate component (Issue 10).

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import PermissionGate from '../../renderer/components/PermissionGate';
import type { MacOSPermissionState } from '../permissions/MacOSPermissions';

// ── Stub window.transcribeAPI ─────────────────────────────────────────────────

const mockCheckPermission = jest.fn();
const mockOpenSystemSettings = jest.fn();

beforeEach(() => {
  mockCheckPermission.mockResolvedValue({ permissionState: 'granted' });
  mockOpenSystemSettings.mockResolvedValue(undefined);

  Object.defineProperty(window, 'transcribeAPI', {
    configurable: true,
    value: {
      checkPermission:    mockCheckPermission,
      openSystemSettings: mockOpenSystemSettings,
    },
  });
});

afterEach(() => jest.clearAllMocks());

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderGate(
  permissionState: MacOSPermissionState,
  onPermissionChange = jest.fn(),
) {
  return render(
    <PermissionGate
      permissionState={permissionState}
      onPermissionChange={onPermissionChange}
    >
      <div data-testid="session-ui">Session UI</div>
    </PermissionGate>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PermissionGate', () => {
  it('renders children directly when permission is granted', () => {
    renderGate('granted');
    expect(screen.getByTestId('session-ui')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-denied')).not.toBeInTheDocument();
    expect(screen.queryByTestId('permission-not-determined')).not.toBeInTheDocument();
  });

  it('renders the not-determined prompt when permission is not-determined', () => {
    renderGate('not-determined');
    expect(screen.getByTestId('permission-not-determined')).toBeInTheDocument();
    expect(screen.getByText('Permission needed')).toBeInTheDocument();
    // Children are still rendered inside the prompt (user can still click Start)
    expect(screen.getByTestId('session-ui')).toBeInTheDocument();
  });

  it('renders the denied view when permission is denied', () => {
    renderGate('denied');
    expect(screen.getByTestId('permission-denied')).toBeInTheDocument();
    expect(screen.getByText('Screen Recording permission required')).toBeInTheDocument();
    expect(screen.queryByTestId('session-ui')).not.toBeInTheDocument();
  });

  it('calls openSystemSettings when "Open System Settings" is clicked', async () => {
    renderGate('denied');
    fireEvent.click(screen.getByRole('button', { name: /open system settings/i }));
    await waitFor(() => expect(mockOpenSystemSettings).toHaveBeenCalledTimes(1));
  });

  it('calls checkPermission and updates state when "Check Again" is clicked', async () => {
    mockCheckPermission.mockResolvedValue({ permissionState: 'granted' });
    const onPermissionChange = jest.fn();
    renderGate('denied', onPermissionChange);

    fireEvent.click(screen.getByRole('button', { name: /check again/i }));

    await waitFor(() => {
      expect(mockCheckPermission).toHaveBeenCalledTimes(1);
      expect(onPermissionChange).toHaveBeenCalledWith('granted');
    });
  });

  it('disables "Check Again" button while checking', async () => {
    // Delay the resolution so we can observe the disabled state
    let resolve!: (v: { permissionState: MacOSPermissionState }) => void;
    mockCheckPermission.mockReturnValue(
      new Promise(r => { resolve = r; })
    );

    renderGate('denied');
    const btn = screen.getByRole('button', { name: /check again/i });
    fireEvent.click(btn);

    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Checking…');

    resolve({ permissionState: 'granted' });
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});
