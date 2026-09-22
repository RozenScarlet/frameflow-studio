import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function Modal({ children, className, onClose, label, labelledBy }) {
  const ref = useRef(null); const callback = useRef(onClose); callback.current = onClose;
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement;
    const cancel = event => { event.preventDefault(); callback.current(); };
    dialog.addEventListener('cancel', cancel); dialog.showModal();
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); previous?.focus?.(); };
  }, []);
  return createPortal(<dialog ref={ref} className={className} aria-label={label} aria-labelledby={labelledBy}>{children}</dialog>, document.body);
}
