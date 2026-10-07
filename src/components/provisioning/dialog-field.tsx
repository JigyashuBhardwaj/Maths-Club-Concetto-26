import type { HTMLInputTypeAttribute } from "react";

interface DialogFieldProps {
  id: string;
  name: string;
  label: string;
  type?: HTMLInputTypeAttribute;
  autoComplete?: string;
  maxLength?: number;
  error?: string;
  disabled?: boolean;
}

/** One labelled input of a provisioning dialog, styled like the sign-in form's fields. */
export function DialogField({
  id,
  name,
  label,
  type = "text",
  autoComplete = "off",
  maxLength,
  error,
  disabled,
}: DialogFieldProps) {
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={id}
        className="text-[11px] font-semibold tracking-[0.22em] text-ink-dim uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="h-11 rounded-row border border-line bg-white/5 px-4 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 disabled:opacity-60 aria-[invalid=true]:border-orange"
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-[#ffb08a]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
