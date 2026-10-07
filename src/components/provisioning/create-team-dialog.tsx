"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";

import { DialogField } from "@/components/provisioning/dialog-field";
import { NAV_ITEM_CLASS } from "@/components/shell/nav-item-class";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { postJson } from "@/lib/auth/client";
import { ADMISSION_NO_PATTERN, createTeamSchema, MEMBER_SLOTS } from "@/lib/contracts/provisioning";
import {
  fieldMessage,
  newIdempotencyKey,
  outcomeUnknown,
  provisioningFailure,
} from "@/lib/provisioning/client";

interface CreateTeamNavProps {
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

type Errors = Record<string, string>;
const SLOTS = [1, 2, 3, 4] as const;

/** Why a member's admission number is not acceptable (browser-side wording only; the server decides). */
function admissionMessage(raw: string, all: readonly string[], index: number): string {
  const n = index + 1;
  const value = raw.trim().toUpperCase();
  if (value === "") return `Enter M${n}'s admission number.`;
  if (!ADMISSION_NO_PATTERN.test(value)) {
    return `M${n}'s admission number may only use letters, numbers and / . _ - (up to 32).`;
  }
  if (all.slice(0, index).some((x) => x.trim().toUpperCase() === value)) {
    return `M${n}'s admission number repeats an earlier member's.`;
  }
  return fieldMessage("team", `admissionNos.${n}`);
}

/**
 * Sidebar entry "Create a team" and its dialog (docs: admin dashboard ui). The browser collects Team ID, Team Name,
 * Login ID, Password, Confirm Password and the four admission numbers. It never sends an admin, owner, role or coin
 * value: the team belongs to the signed-in Admin and gets its initial balance from the database, in one atomic
 * `POST /api/admin/teams` call guarded by an `Idempotency-Key`. Success is shown only after the server confirmed it,
 * and the server-rendered "My teams" list is then refreshed from the database.
 */
export function CreateTeamNav({ fetchImpl }: CreateTeamNavProps) {
  const router = useRouter();
  const titleId = useId();
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; name: string } | null>(null);
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
      teamCode: text("teamCode"),
      name: text("name"),
      loginId: text("loginId"),
      password: text("password"),
      confirmPassword: text("confirmPassword"),
      admissionNos: SLOTS.map((n) => text(`admission${n}`)),
    };

    // Friendlier messages only; the server validates again and is the authority.
    const checked = createTeamSchema.safeParse(input);
    setFormError(null);
    if (!checked.success) {
      const next: Errors = {};
      for (const issue of checked.error.issues) {
        const field = issue.path.map(String).join(".");
        if (!field || next[field]) continue;
        const slot = /^admissionNos\.([1-4])$/.exec(field)?.[1];
        next[field] = slot
          ? admissionMessage(
              input.admissionNos[Number(slot) - 1] ?? "",
              input.admissionNos,
              Number(slot) - 1,
            )
          : issue.path[0] === "admissionNos"
            ? `Enter all ${MEMBER_SLOTS} admission numbers.`
            : fieldMessage("team", field);
      }
      setErrors(next);
      return;
    }
    setErrors({});

    const body = {
      ...checked.data,
      admissionNos: checked.data.admissionNos.map((a) => a.trim()),
    };
    const fingerprint = JSON.stringify(body);
    if (keyRef.current?.fingerprint !== fingerprint) {
      keyRef.current = { key: newIdempotencyKey(), fingerprint };
    }

    inFlight.current = true;
    setBusy(true);
    const result = await postJson<{ team?: { team_code?: unknown; name?: unknown } }>(
      "/api/admin/teams",
      body,
      fetchImpl,
      { "Idempotency-Key": keyRef.current.key },
    );
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      keyRef.current = null;
      const team = result.data.team;
      setCreated({
        code: typeof team?.team_code === "string" ? team.team_code : checked.data.teamCode,
        name: typeof team?.name === "string" ? team.name : checked.data.name,
      });
      setFormVersion((v) => v + 1); // clears the password fields
      router.refresh(); // "My teams" is read from the database on the server
      return;
    }
    // Only an unknown outcome keeps the key, so a retry replays a request that did succeed instead of repeating it.
    if (!outcomeUnknown(result)) keyRef.current = null;
    const failure = provisioningFailure(result, "team");
    setErrors(failure.fields);
    setFormError(failure.form ?? null);
  }

  const id = (name: string) => `${baseId}-${name}`;

  return (
    <>
      <button type="button" className={NAV_ITEM_CLASS} onClick={() => setOpen(true)}>
        Create a team
      </button>
      <ModalDialog open={open} onClose={close} labelledBy={titleId} className="dialog-wide">
        {created ? (
          <>
            <div className="dialog-body">
              <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
                Team created
              </h2>
              <p className="dialog-text" role="status">
                <strong>
                  {created.code} — {created.name}
                </strong>{" "}
                is now in My teams. Its members can sign in with the Team Login ID, the password you
                set and their own admission number.
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
                Create a New Team
              </h2>
              <div className="dialog-scroll grid gap-4 pb-2">
                <div className="grid gap-4 sm:grid-cols-2">
                  <DialogField
                    id={id("teamCode")}
                    name="teamCode"
                    label="Team ID"
                    maxLength={16}
                    error={errors.teamCode}
                    disabled={busy}
                  />
                  <DialogField
                    id={id("name")}
                    name="name"
                    label="Team Name"
                    maxLength={100}
                    error={errors.name}
                    disabled={busy}
                  />
                </div>
                <DialogField
                  id={id("loginId")}
                  name="loginId"
                  label="Login ID"
                  maxLength={64}
                  error={errors.loginId}
                  disabled={busy}
                />
                <div className="grid gap-4 sm:grid-cols-2">
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
                    label="Confirm Password"
                    type="password"
                    autoComplete="new-password"
                    maxLength={72}
                    error={errors.confirmPassword}
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {SLOTS.map((n) => (
                    <DialogField
                      key={n}
                      id={id(`admission${n}`)}
                      name={`admission${n}`}
                      label={`M${n} Admission No.`}
                      maxLength={32}
                      error={
                        errors[`admissionNos.${n}`] ?? (n === 1 ? errors.admissionNos : undefined)
                      }
                      disabled={busy}
                    />
                  ))}
                </div>
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
                {busy ? "Creating…" : "Create Team"}
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
