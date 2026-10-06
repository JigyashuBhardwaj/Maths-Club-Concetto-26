"use client";

interface DemoBarProps {
  canDecide: boolean;
  onApprove: () => void;
  onDisapprove: () => void;
  onReset: () => void;
}

/** Review-only controls that stand in for the admin until the backend exists. */
export function DemoBar({ canDecide, onApprove, onDisapprove, onReset }: DemoBarProps) {
  return (
    <div className="demo-bar" role="group" aria-label="Demo controls (not part of the real page)">
      <span className="demo-tag">DEMO · simulate admin</span>
      <button type="button" className="demo-btn" disabled={!canDecide} onClick={onApprove}>
        Approve
      </button>
      <button type="button" className="demo-btn" disabled={!canDecide} onClick={onDisapprove}>
        Disapprove
      </button>
      <button type="button" className="demo-btn" onClick={onReset}>
        Reset demo
      </button>
    </div>
  );
}
