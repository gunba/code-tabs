import { useEffect, useRef } from "react";
import "./ModalOverlay.css";

interface ModalOverlayProps {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}

// [MO-01] Shared modal wrapper: fixed overlay, z-100, frosted glass, blocks keys except Esc/Ctrl+,
export function ModalOverlay({ children, onClose, className }: ModalOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => { overlayRef.current?.focus(); }, []);

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        // Let Escape and Ctrl+, propagate to global handler
        if (e.key === "Escape") return;
        if (e.ctrlKey && e.key === ",") return;
        // Stop all other keys from reaching the global shortcut handler
        e.stopPropagation();
      }}
    >
      <div className={`modal-content${className ? ` ${className}` : ""}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
