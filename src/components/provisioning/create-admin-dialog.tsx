"use client";

import { useId, useRef, useState, type FormEvent } from "react";

import { DialogField } from "@/components/provisioning/dialog-field";
import { NAV_ITEM_CLASS } from "@/components/shell/nav-item-class";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { postJson } from "@/lib/auth/client";
import { createAdminSchema } from "@/lib/contracts/provisioning";
import {
  fieldMessage,
  newIdempotencyKey,
  outcomeUnknown,
  provisioningFailure,
} from "@/lib/provisioning/client";

interface CreateAdminNavProps {
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

type Errors = Record<string, string>;

/**
 * Sidebar entry "Create admin" and its dialog (docs: superadmin home). The browser only collects Username, Password and
 * Retype Password; the role, the active state, the creator and the audit record are decided by the server. Submitting
 * calls `POST /api/super/admins` with an `Idempotency-Key`: a double click or a retry after a lost response returns the
 * stored result instead of creating a second admin. The dialog shows success only after the server confirmed it.
 */
export function CreateAdminNav({ fetchImpl }: CreateAdminNavProps) {
  const titleId = useId();
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const inFlight = useRef(false);
  const keyRef = useRef<{ key: string; fingerprint: string } | null>(null);

  function reset() {
    setErrors({});
    setFormError(null);
    setCreated(null);
    setFormVersion((v) => v + 1);
    keyRef.current = null;
  }

  function close() {
    setOpen(false);
    if (!inFlight.current) reset();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return; // a double click / double Enter sends one request
    const form = new FormData(event.currentTarget);
    const text = (name: string) =>
      typeof form.get(name) === "string" ? (form.get(name) as string) : "";
    const input = {
      username: text("username"),
      password: text("password"),
      confirmPassword: text("confirmPassword"),
    };

    // Friendlier messages only; the server validates again and is the authority.
    const checked = createAdminSchema.safeParse(input);
    setFormError(null);
    if (!checked.success) {
      const next: Errors = {};
      for (const issue of checked.error.issues) {
        const field = String(issue.path[0] ?? "");
        if (field && !next[field]) next[field] = fieldMessage("admin", field);
      }
      setErrors(next);
      return;
    }
    setErrors({});

    const fingerprint = JSON.stringify([
      checked.data.username,
      input.password,
      input.confirmPassword,
    ]);
    if (keyRef.current?.fingerprint !== fingerprint) {
      keyRef.current = { key: newIdempotencyKey(), fingerprint };
    }

    inFlight.current = true;
    setBusy(true);
    const result = await postJson<unknown>("/api/super/admins", checked.data, fetchImpl, {
      "Idempotency-Key": keyRef.current.key,
    });
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      keyRef.current = null;
      setCreated(checked.data.username);
      setFormVersion((v) => v + 1); // clears the password fields
      return;
    }
    // Only an unknown outcome keeps the key, so a retry replays a request that did succeed instead of repeating it.
    if (!outcomeUnknown(result)) keyRef.current = null;
    const failure = provisioningFailure(result, "admin");
    setErrors(failure.fields);
    setFormError(failure.form ?? null);
  }

  const id = (name: string) => `${baseId}-${name}`;

  return (
    <>
      <button type="button" className={NAV_ITEM_CLASS} onClick={() => setOpen(true)}>
        Create admin
      </button>
      <ModalDialog open={open} onClose={close} labelledBy={titleId}>
        {created ? (
          <>
            <div className="dialog-body">
              <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
                Admin created
              </h2>
              <p className="dialog-text" role="status">
                <strong>{created}</strong> can sign in now at the Admin sign-in page with the
                password you entered.
              </p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            key={formVersion}
            onSubmit={onSubmit}
            noValidate
            aria-busy={busy}
            className="flex min-h-0 flex-col"
          >
            <div className="dialog-body">
              <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
                Create a New Admin
              </h2>
              <div className="dialog-scroll grid gap-4 pb-2">
                <DialogField
                  id={id("username")}
                  name="username"
                  label="Username"
                  autoComplete="off"
                  maxLength={64}
                  error={errors.username}
                  disabled={busy}
                />
                <DialogField
                  id={id("password")}
                  name="password"
                  label="Password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={72}
                  error={errors.password}
                  disabled={busy}
                />
                <DialogField
                  id={id("confirmPassword")}
                  name="confirmPassword"
                  label="Retype Password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={72}
                  error={errors.confirmPassword}
                  disabled={busy}
                />
                {formError ? (
                  <p
                    role="alert"
                    className="rounded-row border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-ink"
                  >
                    {formError}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="dialog-actions">
              <button type="submit" className="btn btn-primary disabled:opacity-60" disabled={busy}>
                {busy ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                className="btn disabled:opacity-60"
                onClick={close}
                disabled={busy}
              >
                Go Back
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </>
  );
}
