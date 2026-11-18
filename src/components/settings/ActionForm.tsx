'use client';
// Form wrapper for server actions that report {ok, message}. Submits via a transition so a failed
// save keeps what Kayzee typed (React's automatic form reset would otherwise wipe it), and shows
// the result inline. SubmitButton reads the pending state from context.

import { createContext, useActionState, useContext, useTransition, type ReactNode, type FormEvent } from 'react';
import { Button, cx } from '@/components/ui';
import type { ActionResult, FormAction } from './action-result';

const PendingContext = createContext(false);

export function ActionForm({
  action, children, className, messageClassName, hideSuccess = false, id,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  messageClassName?: string;
  /** Suppress the success line (for tiny inline forms whose effect is visible anyway). */
  hideSuccess?: boolean;
  id?: string;
}) {
  const [state, formAction, actionPending] = useActionState<ActionResult, FormData>(action, null);
  const [transitionPending, startTransition] = useTransition();
  const pending = actionPending || transitionPending;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const confirmText = submitter?.dataset.confirm;
    if (confirmText && !window.confirm(confirmText)) return;
    const fd = new FormData(e.currentTarget, submitter ?? undefined);
    startTransition(() => formAction(fd));
  }

  const showMessage = state && (!state.ok || !hideSuccess);
  return (
    <PendingContext.Provider value={pending}>
      <form id={id} action={formAction} onSubmit={onSubmit} className={className} aria-busy={pending}>
        {children}
        {showMessage && (
          <p
            key={state.at}
            role={state.ok ? 'status' : 'alert'}
            className={cx('text-[12px] whitespace-pre-wrap', state.ok ? 'text-good' : 'text-bad', messageClassName)}
          >
            {state.message}
          </p>
        )}
      </form>
    </PendingContext.Provider>
  );
}

export function useFormPending(): boolean {
  return useContext(PendingContext);
}

type ButtonProps = Parameters<typeof Button>[0];

/** Submit button that disables itself while its ActionForm is pending. `confirm` asks first. */
export function SubmitButton({
  children, pendingLabel, confirm, disabled, ...rest
}: ButtonProps & { pendingLabel?: ReactNode; confirm?: string }) {
  const pending = useFormPending();
  return (
    <Button type="submit" {...rest} data-confirm={confirm} disabled={disabled || pending}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
