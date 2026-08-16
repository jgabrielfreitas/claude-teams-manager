import { useCallback } from 'react';
import { client } from '../api';
import { useCatalog } from './catalog';
import { useAction } from './toasts';

/**
 * Auto mode: the run never stops to ask you.
 *
 * It is one idea made of two settings — `autoApproveAll` grants every
 * permission, `autoAnswerQuestions` answers every question with an instruction
 * to decide and state the assumption. Flipping only one leaves the run stopping
 * for the other half, which is exactly the confusion this toggle removes, so
 * the pair moves together here and the individual switches stay in Settings for
 * anyone who genuinely wants one and not the other.
 *
 * Both flags live in the core; this only reads them from settings and patches
 * them back.
 */

export interface AutoMode {
  /** Both halves on: nothing will interrupt a run. */
  on: boolean;
  /** Exactly one half on — the run still stops for the other. */
  partial: boolean;
  autoApproveAll: boolean;
  autoAnswerQuestions: boolean;
  set: (on: boolean) => void;
}

/** What auto mode actually does, said the same way everywhere it is offered. */
export const AUTO_MODE_CONSEQUENCE =
  'Permissions are granted automatically and an agent’s question is answered with an ' +
  'instruction to decide for itself and state the assumption. Nothing will stop to ask you.';

export function useAutoMode(): AutoMode {
  const { settings, reload } = useCatalog();
  const act = useAction();

  const autoApproveAll = settings.autoApproveAll;
  const autoAnswerQuestions = settings.autoAnswerQuestions;

  const set = useCallback(
    (on: boolean) => {
      void act(
        async () => {
          await client.updateSettings({ autoApproveAll: on, autoAnswerQuestions: on });
          reload();
        },
        on ? `Auto mode on. ${AUTO_MODE_CONSEQUENCE}` : 'Auto mode off — runs will ask you again.',
      );
    },
    [act, reload],
  );

  return {
    on: autoApproveAll && autoAnswerQuestions,
    partial: autoApproveAll !== autoAnswerQuestions,
    autoApproveAll,
    autoAnswerQuestions,
    set,
  };
}

/**
 * The quick toggle in the app chrome, so a risky setting can be turned off
 * mid-run without navigating away — and so it is visible while it is on.
 */
export function AutoModeToggle() {
  const auto = useAutoMode();
  const state = auto.on ? 'on' : auto.partial ? 'partial' : 'off';

  return (
    <button
      type="button"
      className={`auto-mode auto-mode-${state}`}
      aria-pressed={auto.on}
      onClick={() => auto.set(!auto.on)}
      title={
        auto.on
          ? `Auto mode is ON. ${AUTO_MODE_CONSEQUENCE} Click to turn it off.`
          : auto.partial
            ? `Half on: ${auto.autoApproveAll ? 'approvals are automatic, questions still stop the run' : 'questions are automatic, approvals still stop the run'}. Click to turn both on.`
            : `Auto mode is off — runs stop for approvals and questions. ${AUTO_MODE_CONSEQUENCE}`
      }
    >
      <span className="auto-mode-switch" aria-hidden>
        <span className="auto-mode-knob" />
      </span>
      <span className="auto-mode-label">Auto mode</span>
      <span className="auto-mode-state">{state === 'partial' ? 'half on' : state}</span>
    </button>
  );
}

/**
 * The standing warning while auto mode is on. Deliberately not only a label:
 * the consequence is spelled out, because nobody remembers what a switch meant
 * an hour after flipping it.
 */
export function AutoModeBanner() {
  const auto = useAutoMode();
  if (!auto.on) return null;

  return (
    <div className="auto-mode-banner" role="status">
      <span className="dot busy" />
      <span>
        <strong>Auto mode is on.</strong> {AUTO_MODE_CONSEQUENCE}
      </span>
      <button type="button" className="btn btn-sm right" onClick={() => auto.set(false)}>
        Turn off
      </button>
    </div>
  );
}
