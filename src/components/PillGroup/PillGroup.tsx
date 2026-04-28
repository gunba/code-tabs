import { memo } from "react";
import "./PillGroup.css";

interface PillOption<T extends string> {
  value: T;
  label: string;
}

interface PillGroupProps<T extends string> {
  options: PillOption<T>[];
  selected: T | null;
  onChange: (value: T | null) => void;
  /** Returns a CSS color string for the selected pill. Falls back to var(--accent). */
  colorFn?: (value: T) => string;
  disabled?: boolean;
  className?: string;
}

function PillGroupInner<T extends string>({
  options,
  selected,
  onChange,
  colorFn,
  disabled,
  className,
}: PillGroupProps<T>) {
  return (
    <div
      className={`pill-group${className ? ` ${className}` : ""}${disabled ? " pill-group-disabled" : ""}`}
      role="group"
      aria-disabled={disabled ? true : undefined}
    >
      {options.map((opt) => {
        const isSelected = opt.value === selected;
        const color = isSelected && colorFn ? colorFn(opt.value) : undefined;
        return (
          <button
            key={opt.value}
            className={`pill-option${isSelected ? " pill-option-selected" : ""}`}
            onClick={() => onChange(isSelected ? null : opt.value)}
            disabled={disabled}
            aria-pressed={isSelected}
            type="button"
            style={
              isSelected && color
                ? {
                    borderColor: color,
                    color,
                    background: `color-mix(in srgb, ${color} 10%, transparent)`,
                  }
                : undefined
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export const PillGroup = memo(PillGroupInner) as typeof PillGroupInner;
