"use client";

import { useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { homeForRole, type PrincipalRole } from "@/lib/auth/access";
import { postJson } from "@/lib/auth/client";
import { loginFailureMessage } from "@/lib/auth/login-messages";
import { participantLoginSchema, staffLoginSchema } from "@/lib/contracts/auth";
import type { RoleId } from "@/lib/roles";

interface LoginFormProps {
  role: RoleId;
  /** Replaced in tests; the default does a full page load so the freshly set cookie is what the server sees. */
  navigate?: (url: string) => void;
}

type FieldName = "teamLoginId" | "password" | "admissionNo" | "username";
type FieldErrors = Partial<Record<FieldName, string>>;

const REQUIRED: Record<FieldName, string> = {
  teamLoginId: "Enter your Team Login ID.",
  admissionNo: "Enter your admission number.",
  username: "Enter your username.",
  password: "Enter your password.",
};
const TOO_LONG: Record<FieldName, string> = {
  teamLoginId: "That Team Login ID is too long.",
  admissionNo: "That admission number is too long.",
  username: "That username is too long.",
  password: "That password is too long.",
};

const defaultNavigate = (url: string) => window.location.assign(url);
const KNOWN_ROLES: readonly string[] = ["PARTICIPANT", "ADMIN", "SUPER_ADMIN"];

/** Client-side validation for a friendlier message only; the server validates again and is the authority. */
function validate(input: unknown, schema: typeof participantLoginSchema | typeof staffLoginSchema) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { data: parsed.data, errors: {} as FieldErrors };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const name = issue.path[0] as FieldName | undefined;
    if (!name || errors[name]) continue;
    errors[name] = issue.code === "too_big" ? TOO_LONG[name] : REQUIRED[name];
  }
  return { data: null, errors };
}

/**
 * The sign-in form for one role page. Participants send team login ID + password + admission number to
 * `/api/auth/participant/login`; staff send username + password to `/api/auth/staff/login`. The page never decides
 * who the person is: after success it goes to the home of the role the SERVER reports, and the protected pages
 * check the session again on the server.
 */
export function LoginForm({ role, navigate = defaultNavigate }: LoginFormProps) {
  const participant = role === "participant";
  const baseId = useId();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return; // a double click / double Enter sends one request
    const form = new FormData(event.currentTarget);
    const text = (name: string) =>
      typeof form.get(name) === "string" ? (form.get(name) as string) : "";

    const input = participant
      ? {
          teamLoginId: text("teamLoginId"),
          password: text("password"),
          admissionNo: text("admissionNo"),
        }
      : { username: text("username"), password: text("password") };
    const checked = validate(input, participant ? participantLoginSchema : staffLoginSchema);
    setFormError(null);
    setErrors(checked.errors);
    if (!checked.data) return;

    inFlight.current = true;
    setBusy(true);
    const result = await postJson<{ role?: unknown }>(
      participant ? "/api/auth/participant/login" : "/api/auth/staff/login",
      checked.data,
    );
    if (result.ok) {
      const serverRole = result.data.role;
      if (typeof serverRole === "string" && KNOWN_ROLES.includes(serverRole)) {
        navigate(homeForRole(serverRole as PrincipalRole));
        return; // stay "busy" while the browser navigates
      }
      setFormError(
        loginFailureMessage(
          { ok: false, status: 200, code: "BAD_RESPONSE" },
          role === "participant" ? "participant" : "staff",
        ),
      );
    } else {
      setFormError(loginFailureMessage(result, participant ? "participant" : "staff"));
    }
    inFlight.current = false;
    setBusy(false);
  }

  const fields: { name: FieldName; label: string; type: string; autoComplete: string }[] =
    participant
      ? [
          { name: "teamLoginId", label: "Team Login ID", type: "text", autoComplete: "username" },
          {
            name: "password",
            label: "Team Password",
            type: "password",
            autoComplete: "current-password",
          },
          { name: "admissionNo", label: "Admission Number", type: "text", autoComplete: "off" },
        ]
      : [
          { name: "username", label: "Username", type: "text", autoComplete: "username" },
          {
            name: "password",
            label: "Password",
            type: "password",
            autoComplete: "current-password",
          },
        ];

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={busy} className="mt-6 grid gap-4 text-left">
      {fields.map((f) => {
        const id = `${baseId}-${f.name}`;
        const error = errors[f.name];
        return (
          <div key={f.name} className="grid gap-1.5">
            <label
              htmlFor={id}
              className="text-[11px] font-semibold tracking-[0.22em] text-ink-dim uppercase"
            >
              {f.label}
            </label>
            <input
              id={id}
              name={f.name}
              type={f.type}
              autoComplete={f.autoComplete}
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              className="h-12 rounded-row border border-line bg-white/5 px-4 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 disabled:opacity-60 aria-[invalid=true]:border-orange"
            />
            {error ? (
              <p id={`${id}-error`} className="text-xs text-[#ffb08a]">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}

      {formError ? (
        <p
          role="alert"
          className="rounded-row border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-ink"
        >
          {formError}
        </p>
      ) : null}

      <Button type="submit" disabled={busy} className="mt-1 w-full">
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
