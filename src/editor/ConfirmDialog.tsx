// src/editor/ConfirmDialog.tsx — a plain-HTML confirm dialog (Stage 5, PR5).
//
// The SDK's ConfirmDialog is a compound Radix component (Dialog +
// portal); PR5 renders dialogs as plain HTML (button + div[role=dialog],
// like AddMenu.tsx) because the Radix portal/focus behaviour cannot be
// stubbed faithfully in the mock host (audit exception, PR5 report).
// Same contract as the ui-design Delete dialogs: title, body, confirm
// label; Cancel closes without acting. Escape closes. The confirm button
// uses the destructive Button variant.

import { Button } from "@hermes/plugin-sdk";

export interface ConfirmDialogProps {
  title: string;
  body: string;
  /** Confirm button label (e.g. "Delete" / "Delete scene"). */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // autoFocus on Cancel: the destructive action is never the default focus.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="p3d-dialog"
    >
      <div className="p3d-dialog-title">{title}</div>
      <div className="p3d-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{body}</div>
      <div className="p3d-dialog-actions">
        <Button autoFocus variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
