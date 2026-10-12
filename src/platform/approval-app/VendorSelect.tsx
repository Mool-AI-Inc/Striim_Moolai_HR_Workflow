/** @lifespan PRODUCTION — the vendor picker, with a brand mark on every row.
 *
 * Why this is not a <select>. A native option element can only hold text — no image, no
 * SVG, no markup — so showing a mark beside each vendor means owning the listbox.
 *
 * That trade is only worth making if the replacement is genuinely as accessible as the
 * thing it replaces, so this implements the WAI-ARIA select-only combobox pattern in
 * full: focus stays on the trigger and the active row is tracked with
 * aria-activedescendant, the popup is a real listbox of real options, and every keyboard
 * interaction a native select answers is answered here — arrows, Home/End, Enter, Space,
 * Escape, Tab, and type-ahead.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { VendorIcon } from "./VendorIcon.js";

interface Props {
  label: string;              // visible category name, used for the accessible name
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

export function VendorSelect({ label, value, options, onChange }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.indexOf(value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const baseId = useId();
  const listId = `${baseId}-list`;
  const labelId = `${baseId}-label`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  const choose = useCallback((i: number) => {
    const picked = options[i];
    if (picked !== undefined) { onChange(picked); setActive(i); }
    close();
  }, [options, onChange, close]);

  // Pointer outside the component closes it, the way a native select does.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Keep the active row in view when arrowing through a list taller than the popup.
  // getElementById, not querySelector: useId emits colons, which would need CSS.escape.
  // scrollIntoView is guarded because jsdom does not implement it.
  useEffect(() => {
    if (!open) return;
    const row = document.getElementById(optionId(active));
    row?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps

  function onKeyDown(e: React.KeyboardEvent): void {
    const last = options.length - 1;

    if (!open) {
      // A closed select opens on arrows, Enter, Space or Alt+Down — same as native.
      if (["ArrowDown", "ArrowUp", "Enter", " ", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        setActive(Math.max(0, options.indexOf(value)));
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive((i) => Math.min(last, i + 1)); break;
      case "ArrowUp":   e.preventDefault(); setActive((i) => Math.max(0, i - 1)); break;
      case "Home":      e.preventDefault(); setActive(0); break;
      case "End":       e.preventDefault(); setActive(last); break;
      case "Enter":
      case " ":         e.preventDefault(); choose(active); break;
      case "Escape":    e.preventDefault(); close(); break;
      case "Tab":       setOpen(false); break;   // let focus move on, no refocus
      default:
        // Type-ahead: letters typed within a second are treated as one prefix.
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          typed.current = {
            text: (now - typed.current.at < 1000 ? typed.current.text : "") + e.key.toLowerCase(),
            at: now,
          };
          const hit = options.findIndex((o) => o.toLowerCase().startsWith(typed.current.text));
          if (hit >= 0) setActive(hit);
        }
    }
  }

  return (
    <div className="vendor-select" ref={rootRef}>
      <span id={labelId} className="visually-hidden">{label}</span>
      <button
        type="button"
        ref={buttonRef}
        className="vendor-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${labelId} ${baseId}-value`}
        aria-activedescendant={open ? optionId(active) : undefined}
        onClick={() => { setActive(Math.max(0, options.indexOf(value))); setOpen((o) => !o); }}
        onKeyDown={onKeyDown}
      >
        <VendorIcon vendor={value} />
        <span className="vendor-name" id={`${baseId}-value`}>{value}</span>
        <span className="vendor-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <ul className="vendor-list" id={listId} role="listbox" ref={listRef} aria-labelledby={labelId}>
          {options.map((opt, i) => (
            <li
              key={opt}
              id={optionId(i)}
              role="option"
              aria-selected={opt === value}
              className={`vendor-option${i === active ? " is-active" : ""}${opt === value ? " is-selected" : ""}`}
              // pointerdown, not click: the document handler above fires first otherwise.
              onPointerDown={(e) => { e.preventDefault(); choose(i); }}
              onMouseEnter={() => setActive(i)}
            >
              <VendorIcon vendor={opt} />
              <span className="vendor-name">{opt}</span>
              {opt === value && <span className="vendor-tick" aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
