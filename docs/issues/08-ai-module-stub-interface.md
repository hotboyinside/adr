# Issue 08 — AI Module Stub Interface

**Type:** AFK
**Blocked by:** Issue 07 (real transcript events must be flowing)
**Priority:** Enables future AI slice

---

## Description

Wire the AI module interface (defined in ADR-001) into the live session loop and implement a no-op stub. After this slice, all the plumbing exists for a real AI implementation to slot in without touching any other layer.

This slice intentionally contains **no AI inference**. It is an architectural seam — a defined integration point that keeps the system honest about where AI belongs.

---

## Interface (as defined in ADR-001)

```typescript
// src/ai/AIModule.ts

export interface TranscriptEvent {
  type: 'partial' | 'final';
  text: string;
  startMs: number;
  endMs: number;
}

export interface SessionContext {
  role: 'interviewer' | 'customer' | 'presenter' | 'default';
  domain?: string;
  participantCount?: number;
}

export interface GeneratedQuestion {
  text: string;
  rationale?: string;       // why this question is relevant
  confidence: number;       // 0.0–1.0
}

export interface AIModule {
  onSessionStart(context: SessionContext): void;
  onTranscript(event: TranscriptEvent): void;
  onSessionEnd(): void;
  // Emits generated questions — consumer attaches a listener
  on(event: 'questions', listener: (questions: GeneratedQuestion[]) => void): this;
}
```

---

## No-Op Stub

```typescript
// src/ai/NoOpAIModule.ts
import { EventEmitter } from 'events';
import type { AIModule, TranscriptEvent, SessionContext } from './AIModule';

export class NoOpAIModule extends EventEmitter implements AIModule {
  onSessionStart(_context: SessionContext): void {}
  onTranscript(_event: TranscriptEvent): void {}
  onSessionEnd(): void {}
}
```

---

## Session Orchestrator

The Electron main process needs a `SessionOrchestrator` that:
1. Holds the current `SessionContext` (role, domain)
2. Receives transcript events from the sidecar
3. Forwards them to the registered `AIModule`
4. Receives `questions` events from the AI module and forwards them to the renderer

```typescript
// src/session/SessionOrchestrator.ts

export class SessionOrchestrator {
  constructor(
    private readonly sidecar: SidecarManager,
    private readonly ai: AIModule,
  ) {
    sidecar.on('message', (msg) => {
      if (msg.type === 'partial' || msg.type === 'final') {
        this.ai.onTranscript(msg);
      }
    });

    ai.on('questions', (questions) => {
      // Forward to renderer via Electron IPC
      mainWindow.webContents.send('ai:questions', questions);
    });
  }

  startSession(context: SessionContext): void {
    this.ai.onSessionStart(context);
    this.sidecar.send('start');
  }

  stopSession(): void {
    this.sidecar.send('stop');
    this.ai.onSessionEnd();
  }
}
```

---

## Renderer: Role Selector + Question Panel

This slice also adds two UI elements to the renderer:

1. **Role selector** — a dropdown shown before starting a session: `Interviewer | Customer | Presenter | Default`
2. **Question panel** — a side panel that will display AI-generated questions (empty for now, ready for Issue AI-01)

```tsx
// renderer/components/QuestionPanel.tsx
// Displays a list of GeneratedQuestion items
// For this slice: renders "No questions yet" placeholder
// For future AI slice: populated via 'ai:questions' IPC event
```

---

## Tasks

- [ ] Commit final `AIModule`, `TranscriptEvent`, `SessionContext`, `GeneratedQuestion` interfaces to `src/ai/AIModule.ts`
- [ ] Implement `NoOpAIModule` in `src/ai/NoOpAIModule.ts`
- [ ] Implement `SessionOrchestrator` in `src/session/SessionOrchestrator.ts`
- [ ] Replace direct sidecar event wiring in `electron/main.ts` with `SessionOrchestrator`
- [ ] Expose `startSession(role)` and `stopSession()` to renderer via context bridge
- [ ] Add `QuestionPanel` component to renderer (placeholder state)
- [ ] Add role selector dropdown to renderer start-session flow
- [ ] Write a unit test for `SessionOrchestrator`:
  - Mock `SidecarManager` that emits a `final` transcript event
  - Assert `AIModule.onTranscript()` is called with the correct payload
  - Assert `NoOpAIModule` emits no `questions` events

---

## Acceptance Criteria

- `AIModule` interface is stable and committed — no changes expected without a new ADR
- `SessionOrchestrator` correctly routes all `final` and `partial` transcript events to the AI module
- `NoOpAIModule` is the registered implementation — no AI calls are made
- Role selector appears in the UI before session start and the selected role is passed to `onSessionStart`
- `QuestionPanel` renders in the UI without errors (placeholder state)
- Unit test for `SessionOrchestrator` passes
- TypeScript compiles with zero errors (`strict: true`)
