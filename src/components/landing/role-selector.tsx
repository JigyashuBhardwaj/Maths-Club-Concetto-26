"use client";

import Link from "next/link";
import { useState } from "react";

import { loginPath, ROLES, type RoleId } from "@/lib/roles";

function Arrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** The three role entries. Clicking keeps the row in its highlighted state while the route loads. */
export function RoleSelector() {
  const [selected, setSelected] = useState<RoleId | null>(null);

  return (
    <nav className="panel" aria-label="Select your role">
      {ROLES.map((role) => (
        <Link
          key={role.id}
          href={loginPath(role.id)}
          data-role={role.id}
          className={selected === role.id ? "role is-selected" : "role"}
          onClick={() => setSelected(role.id)}
        >
          <span className="dot" />
          <span className="label">{role.label}</span>
          <Arrow />
        </Link>
      ))}
    </nav>
  );
}
