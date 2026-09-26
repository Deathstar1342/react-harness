import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({ title, titleId, children, onClose, busy = false, className = "" }: {
  title: string; titleId: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className={`workspace-dialog ${className}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}>
    <div className="dialog-heading">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label={`Close ${title}`}><X size={18} /></button>
    </div>
    {children}
  </dialog>;
}
