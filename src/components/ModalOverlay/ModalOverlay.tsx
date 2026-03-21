import "./ModalOverlay.css";

interface ModalOverlayProps {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}

export function ModalOverlay({ children, onClose, className }: ModalOverlayProps) {
  return (
    <div
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
